/**
 * Headless render orchestration: a .seam file → mp4, entirely in-process.
 *
 *   compile/resolve (@seam/core) → per frame: buildRenderList (@seam/compositor)
 *   → decode active frames (mediabunny) → composite (Dawn) → read back
 *   → encode (mediabunny) → mux mp4.
 *
 * Work in progress: video only (clip drawables). Text/graphic/static/audio
 * providers are added incrementally; unsupported drawables hard-error by name.
 */
import { readFileSync } from "node:fs";
import { dirname } from "node:path";
import {
  DEFAULT_CANVAS_HEIGHT,
  DEFAULT_CANVAS_WIDTH,
  compileSeamFile,
  parseSeamFile,
  resolveComposition,
  resolveSpatial,
} from "@seam/core";
import type {
  ResolvedChild,
  ResolvedClip,
  ResolvedGraphic,
  ResolvedStatic,
} from "@seam/core";
import { Compositor, buildRenderList } from "@seam/compositor";
import {
  createGraphicFrameRenderer,
  type GraphicFrameRenderer,
} from "./graphic/frameRenderer.js";
import {
  Output,
  Mp4OutputFormat,
  FilePathTarget,
  VideoSampleSource,
  AudioBufferSource,
  VideoSample,
  QUALITY_VERY_LOW,
  QUALITY_LOW,
  QUALITY_MEDIUM,
  QUALITY_HIGH,
  QUALITY_VERY_HIGH,
  type Quality,
} from "mediabunny";
import { createGpuDevice } from "./gpu.js";
import { NodeBackend } from "./NodeBackend.js";
import { FrameSource, collectDrawables } from "./frameSource.js";
import { renderAudioMix, timelineHasAudio } from "./audio.js";
import type { AudioBuffer as NWAudioBuffer } from "node-web-audio-api";

/** Encode quality presets (video + audio bitrate). Each maps to a mediabunny
 *  `Quality` — a subjective tier whose actual bitrate scales with resolution ×
 *  frame rate, not a fixed kbps. */
export type QualityPreset =
  | "very-low"
  | "low"
  | "medium"
  | "high"
  | "very-high";

export const QUALITY_PRESETS: Record<QualityPreset, Quality> = {
  "very-low": QUALITY_VERY_LOW,
  low: QUALITY_LOW,
  medium: QUALITY_MEDIUM,
  high: QUALITY_HIGH,
  "very-high": QUALITY_VERY_HIGH,
};

export const DEFAULT_QUALITY: QualityPreset = "high";

export interface RenderOptions {
  fps?: number;
  width?: number;
  height?: number;
  /** Encode quality tier for video + audio (default `"high"`). */
  quality?: QualityPreset;
  /** Readback ring depth — how many frames' GPU→CPU readbacks stay in flight
   *  at once (default 3 / triple-buffered). Higher keeps the GPU fed but uses
   *  more staging memory. */
  bufferCount?: number;
  /** Source proxy swaps (`--proxy ORIGINAL:REPLACEMENT`): any node whose
   *  `source` exactly equals a key renders the mapped value instead. Verbatim
   *  match, no path resolution. */
  proxies?: Map<string, string>;
  onProgress?: (frame: number, total: number) => void;
}

export interface RenderResult {
  output: string;
  frames: number;
  width: number;
  height: number;
  duration: number;
}

/** Swap clip/static/audio `source`s that exactly equal a proxy key, recursing
 *  compositions. Verbatim match, mutates the (local) resolved tree in place —
 *  mirrors the MLT path so probe/decode/audio all see the replacement. */
function applyProxies(children: ResolvedChild[], proxies: Map<string, string>): void {
  if (proxies.size === 0) return;
  for (const child of children) {
    if (child.type === "clip" || child.type === "static" || child.type === "audio") {
      const replacement = proxies.get(child.source);
      if (replacement != null) child.source = replacement;
    } else if (child.type === "composition") {
      applyProxies(child.children, proxies);
    }
  }
}

/** Collect clip + static nodes (recursing compositions) so their dimensions
 *  can be warmed up before the frame loop's buildRenderList needs them. */
function collectMediaNodes(
  children: ResolvedChild[],
  clips: Set<ResolvedClip>,
  statics: Set<ResolvedStatic>,
  graphics: Set<ResolvedGraphic>,
): void {
  for (const child of children) {
    if (child.type === "clip") clips.add(child);
    else if (child.type === "static") statics.add(child);
    else if (child.type === "graphic") graphics.add(child);
    else if (child.type === "composition")
      collectMediaNodes(child.children, clips, statics, graphics);
  }
}

export async function renderSeamToFile(
  seamPath: string,
  outPath: string,
  options: RenderOptions = {},
): Promise<RenderResult> {
  const fps = options.fps ?? 30;

  // ── compile + resolve (mirrors the CLI/MLT path) ──
  const json = readFileSync(seamPath, "utf-8");
  const parsed = parseSeamFile(json);
  if (!parsed.success) {
    throw new Error(`seam validation failed:\n  ${parsed.errors.join("\n  ")}`);
  }
  const { doc, errors } = compileSeamFile(parsed.data);
  if (errors.length > 0) {
    throw new Error(
      `seam compile failed:\n  ${errors.map((e) => `${e.source}: ${e.message}`).join("\n  ")}`,
    );
  }
  const temporal = resolveComposition(doc);
  const width =
    options.width ?? (temporal.contentWidth as number | undefined) ?? DEFAULT_CANVAS_WIDTH;
  const height =
    options.height ?? (temporal.contentHeight as number | undefined) ?? DEFAULT_CANVAS_HEIGHT;
  const timeline = resolveSpatial(temporal, width, height);
  // Swap proxied sources before anything reads them (decode, audio, graphics).
  if (options.proxies) applyProxies(timeline.children, options.proxies);
  const basePath = dirname(seamPath);

  // Optional phase timing (SEAM_NEXT_TIMING=1) — startup work happens before
  // the first frame logs, so this attributes that latency.
  let lastMark = Date.now();
  const mark = (label: string): void => {
    if (!process.env.SEAM_NEXT_TIMING) return;
    const now = Date.now();
    process.stderr.write(`[timing] ${label}: ${((now - lastMark) / 1000).toFixed(1)}s\n`);
    lastMark = now;
  };
  mark("compile+resolve");

  // Graphics render on demand inside the loop (no disk pre-pass). Track the
  // per-node renderers so we can release their Map pools at the end.
  const graphicRenderers = new Map<ResolvedGraphic, GraphicFrameRenderer>();
  try {
    // Kick off the audio mix concurrently with the frame loop instead of
    // blocking on it up front. The OpenLayers map path used to install global
    // jsdom DOM shims (Event/EventTarget) that broke node-web-audio-api's
    // OfflineAudioContext, which forced audio to run as an isolated pass before
    // anything else; maps now render via @seam/map with no global shims, so the
    // offline mix can render on its own thread while the GPU frame loop runs.
    // We only need the structural presence of audio synchronously (to declare
    // the muxer's audio track before output.start()); the rendered buffer is
    // folded in after the frame loop. Settle into an object so a decode error
    // can't surface as an unhandledRejection during the loop — it's re-thrown
    // when we await below.
    const hasAudio = timelineHasAudio(timeline);
    const audioMixSettled: Promise<
      { buf: NWAudioBuffer | null } | { err: unknown }
    > = hasAudio
      ? renderAudioMix(timeline, basePath, timeline.duration).then(
          (buf) => ({ buf }),
          (err) => ({ err }),
        )
      : Promise.resolve({ buf: null });

    // ── GPU + frame source ──
    const bufferCount = options.bufferCount ?? 3;
    const device = await createGpuDevice();
    const backend = new NodeBackend(device, bufferCount);
    const compositor = new Compositor<ReturnType<FrameSource["get"]>>(backend);
    compositor.init();
    compositor.resize(width, height);

    // Warm up media dims so getIntrinsicSize resolves during buildRenderList:
    // clips by source (video dims), statics decoded once, graphics set up
    // (cheap — the per-frame render is deferred to the loop).
    const clipNodes = new Set<ResolvedClip>();
    const staticNodes = new Set<ResolvedStatic>();
    const graphicNodes = new Set<ResolvedGraphic>();
    collectMediaNodes(timeline.children, clipNodes, staticNodes, graphicNodes);
    for (const g of graphicNodes) {
      graphicRenderers.set(
        g,
        await createGraphicFrameRenderer(g, { mapBasePath: basePath }),
      );
    }
    const frameSource = new FrameSource(basePath, graphicRenderers);
    for (const clip of clipNodes) await frameSource.openSource(clip.source);
    for (const node of staticNodes) await frameSource.openStatic(node);
    mark("gpu+warmup");

    // ── encoder + muxer ──
    const output = new Output({
      format: new Mp4OutputFormat(),
      target: new FilePathTarget(outPath),
    });
    const quality = QUALITY_PRESETS[options.quality ?? DEFAULT_QUALITY];
    const videoSource = new VideoSampleSource({ codec: "avc", bitrate: quality });
    output.addVideoTrack(videoSource, { frameRate: fps });
    const audioSource = hasAudio
      ? new AudioBufferSource({ codec: "aac", bitrate: quality })
      : null;
    if (audioSource) output.addAudioTrack(audioSource);
    await output.start();

    // ── frame loop (triple-buffered readback) ──
    // Each compositor.render() submits the frame's GPU work + starts its
    // readback without blocking; we only drain (await + encode) the oldest
    // frame once the ring is full, so the GPU stays fed instead of stalling on
    // one mapAsync per frame. Frames drain FIFO, so `encoded` is the frame index.
    const total = Math.max(1, Math.round(timeline.duration * fps));
    let encoded = 0;
    const encodeNext = async (pixels: Uint8Array): Promise<void> => {
      const sample = new VideoSample(pixels, {
        format: "RGBA",
        codedWidth: width,
        codedHeight: height,
        timestamp: encoded / fps,
        duration: 1 / fps,
      });
      await videoSource.add(sample);
      sample.close();
      encoded++;
      options.onProgress?.(encoded, total);
    };

    for (let i = 0; i < total; i++) {
      // Keep a free ring slot before submitting the next frame.
      while (backend.inFlightCount >= bufferCount) {
        await encodeNext(await backend.drainOldest());
      }
      const t = i / fps;
      const commands = buildRenderList(timeline, t, width, height, (clip) =>
        frameSource.intrinsicSize(clip),
      );
      await frameSource.prepare(collectDrawables(commands));
      await compositor.render(commands, (clip) => frameSource.get(clip));
    }
    // Drain the tail.
    while (backend.inFlightCount > 0) {
      await encodeNext(await backend.drainOldest());
    }
    mark("frame loop");

    // Fold in the audio mix that rendered alongside the frame loop. The await
    // here is just the residual — the mix has usually finished mid-loop.
    const audioResult = await audioMixSettled;
    if ("err" in audioResult) throw audioResult.err;
    if (audioSource && audioResult.buf) await audioSource.add(audioResult.buf);
    mark("audio residual");

    await output.finalize();
    frameSource.dispose();
    compositor.dispose();
    backend.dispose();

    return {
      output: outPath,
      frames: total,
      width,
      height,
      duration: timeline.duration,
    };
  } finally {
    for (const r of graphicRenderers.values()) await r.dispose();
  }
}

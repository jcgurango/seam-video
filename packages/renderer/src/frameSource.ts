/**
 * Per-tick frame provider for the headless render loop.
 *
 * The compositor's `getFrame(clip)` is synchronous, but decoding a video frame
 * (mediabunny) is async. So each tick we (1) async-decode every drawable active
 * at time `t` into a cache via {@link prepare}, then (2) the compositor pulls
 * frames synchronously via {@link get}.
 *
 * Currently implements clip (video) decode. Other drawable types hard-error by
 * name until their providers are wired (text/graphic reuse @seam/renderer's
 * rasterizers; static images/video freeze-frames come next).
 */
import { isAbsolute, join } from "node:path";
import { registerMediabunnyServer } from "@mediabunny/server";
import {
  Input,
  FilePathSource,
  ALL_FORMATS,
  VideoSampleSink,
  type InputVideoTrack,
  type Rotation,
  type VideoSample,
} from "mediabunny";
import { layoutText, drawTextLayout } from "@seam/core";
import type {
  ResolvedClip,
  ResolvedGraphic,
  ResolvedStatic,
  ResolvedText,
} from "@seam/core";
import { installCanvasShim } from "./text/canvasShim.js";
import type { GraphicFrameRenderer } from "./graphic/frameRenderer.js";
import { createCanvas, loadImage, type SKRSContext2D } from "@napi-rs/canvas";
import type { RenderCommand, DrawCommand } from "@seam/compositor";
import type { NodeFrame } from "./NodeBackend.js";

let serverRegistered = false;
function ensureServer(): void {
  if (!serverRegistered) {
    registerMediabunnyServer();
    serverRegistered = true;
  }
}

type Drawable = DrawCommand["clip"];

interface SourceEntry {
  track: InputVideoTrack;
  sink: VideoSampleSink;
  // Display dims (rotation-adjusted) — the orientation we bake into the
  // uploaded texture, and the intrinsic size objectFit sees.
  width: number;
  height: number;
  rotation: Rotation; // clockwise degrees from the container metadata
}

/** Forward decode cursor for a clip — streams source samples in order instead
 *  of re-seeking per frame (random-access getSample is ~11× slower). */
interface ClipCursor {
  iter: AsyncIterator<VideoSample>;
  current: VideoSample | null; // last sample with timestamp <= needed time
  pending: VideoSample | null; // one-frame lookahead (timestamp in the future)
  frame: NodeFrame | null; // cached RGBA of `current`
  lastTime: number; // last requested source time (detect backward jumps)
  rotation: Rotation;
}

const EPS = 1e-4;

export class FrameSource {
  private readonly basePath: string;
  private readonly sources = new Map<string, SourceEntry>();
  private readonly cache = new Map<object, NodeFrame | null>();
  private readonly clipCursors = new Map<ResolvedClip, ClipCursor>();
  // Statics decode once (fixed sourceTime / image) — cached for the run.
  private readonly statics = new Map<ResolvedStatic, NodeFrame | null>();
  private readonly staticDims = new Map<ResolvedStatic, { w: number; h: number }>();
  private textReady = false;

  // Graphics render on demand via @seam/renderer's fabric/OpenLayers renderer
  // (no disk pre-pass) — one renderer per graphic node, set up once.
  private readonly graphicRenderers: Map<ResolvedGraphic, GraphicFrameRenderer>;

  constructor(
    basePath: string,
    graphicRenderers?: Map<ResolvedGraphic, GraphicFrameRenderer>,
  ) {
    ensureServer();
    this.basePath = basePath;
    this.graphicRenderers = graphicRenderers ?? new Map();
  }

  private resolvePath(src: string): string {
    return isAbsolute(src) ? src : join(this.basePath, src);
  }

  /** Open (once) a video source and learn its coded dimensions. */
  async openSource(src: string): Promise<SourceEntry> {
    let entry = this.sources.get(src);
    if (!entry) {
      const input = new Input({
        source: new FilePathSource(this.resolvePath(src)),
        formats: ALL_FORMATS,
      });
      const track = await input.getPrimaryVideoTrack();
      if (!track) throw new Error(`renderer: no video track in "${src}"`);
      const sink = new VideoSampleSink(track);
      // mediabunny demuxes the rotation metadata (no ffprobe needed). Display
      // dims already account for it; we bake the rotation into the texture.
      entry = {
        track,
        sink,
        width: track.displayWidth,
        height: track.displayHeight,
        rotation: track.rotation,
      };
      this.sources.set(src, entry);
    }
    return entry;
  }

  /** Decode + cache a static node up front so its intrinsic size is known
   *  before buildRenderList runs (statics don't change over time). */
  async openStatic(node: ResolvedStatic): Promise<void> {
    if (!this.statics.has(node)) {
      this.statics.set(node, await this.decodeStatic(node));
    }
  }

  /** Intrinsic (display) size for objectFit, consumed by buildRenderList. */
  intrinsicSize(node: ResolvedClip | ResolvedStatic): { w: number; h: number } | null {
    if (node.type === "static") return this.staticDims.get(node) ?? null;
    const entry = this.sources.get(node.source);
    if (!entry) return null;
    // A 90/270 pre-transform orientation swaps the display dims objectFit sees.
    return node.orientation === 90 || node.orientation === 270
      ? { w: entry.height, h: entry.width }
      : { w: entry.width, h: entry.height };
  }

  /** Async-decode every active drawable into the per-tick cache, addressing
   *  each by its own `drawTime` (container-local elapsed). */
  async prepare(jobs: DrawableJob[]): Promise<void> {
    this.cache.clear();
    for (const { node, drawTime, contentW, contentH } of jobs) {
      this.cache.set(node, await this.decode(node, drawTime, contentW, contentH));
    }
  }

  /** Synchronous lookup for the compositor (after {@link prepare}). */
  get(node: Drawable): NodeFrame | null {
    return this.cache.get(node) ?? null;
  }

  private async decode(
    node: Drawable,
    drawTime: number,
    contentW?: number,
    contentH?: number,
  ): Promise<NodeFrame | null> {
    if (node.type === "clip") {
      return this.decodeClip(node, drawTime);
    }

    if (node.type === "static") {
      let frame = this.statics.get(node);
      if (frame === undefined) {
        frame = await this.decodeStatic(node);
        this.statics.set(node, frame);
      }
      return frame;
    }

    if (node.type === "text") {
      return this.renderText(node, drawTime, contentW, contentH);
    }

    if (node.type === "graphic") {
      return this.loadGraphicFrame(node, drawTime, contentW, contentH);
    }

    throw new Error(
      `renderer: no frame provider for "${(node as { type: string }).type}" yet`,
    );
  }

  /** Render the graphic on demand at its container-local elapsed `drawTime`,
   *  at the per-frame inner-canvas size (`contentW`/`contentH`) sampled by the
   *  compositor. */
  private async loadGraphicFrame(
    node: ResolvedGraphic,
    drawTime: number,
    contentW?: number,
    contentH?: number,
  ): Promise<NodeFrame | null> {
    const renderer = this.graphicRenderers.get(node);
    if (!renderer) {
      throw new Error("renderer: no renderer for graphic node");
    }
    const f = await renderer.renderAt(Math.max(0, drawTime), contentW, contentH);
    return { data: f.data, width: f.width, height: f.height };
  }

  /** Decode a clip frame by advancing a forward sample cursor to the needed
   *  source time (no per-frame re-seek). `drawTime` is the clip's container-local
   *  elapsed time (nesting already folded in by the compositor). */
  private async decodeClip(node: ResolvedClip, drawTime: number): Promise<NodeFrame | null> {
    const entry = await this.openSource(node.source);
    const sourceTime = node.sourceIn + Math.max(0, drawTime) * node.speed;

    let cursor = this.clipCursors.get(node);
    // Create, or restart on a backward jump (the forward iterator can't rewind).
    if (!cursor || sourceTime < cursor.lastTime - EPS) {
      if (cursor) closeCursor(cursor);
      cursor = {
        iter: entry.sink.samples(Math.max(0, sourceTime))[Symbol.asyncIterator](),
        current: null,
        pending: null,
        frame: null,
        lastTime: sourceTime,
        // Fold the authored pre-transform orientation onto the container's
        // metadata rotation — both bake into the decoded pixels.
        rotation: addRotation(entry.rotation, node.orientation),
      };
      this.clipCursors.set(node, cursor);
    }
    cursor.lastTime = sourceTime;

    // Advance so `current` is the latest sample with timestamp <= sourceTime.
    let advanced = false;
    for (;;) {
      if (cursor.pending) {
        if (cursor.pending.timestamp <= sourceTime + EPS) {
          cursor.current?.close();
          cursor.current = cursor.pending;
          cursor.pending = null;
          advanced = true;
          continue;
        }
        break; // lookahead is in the future — current is correct
      }
      const res = await cursor.iter.next();
      if (res.done) break;
      if (res.value.timestamp <= sourceTime + EPS) {
        cursor.current?.close();
        cursor.current = res.value;
        advanced = true;
      } else {
        cursor.pending = res.value;
        break;
      }
    }

    if (!cursor.current) return null;
    if (advanced || !cursor.frame) {
      cursor.frame = await sampleToFrame(cursor.current, cursor.rotation);
    }
    return cursor.frame;
  }

  /** Release decoder resources held by open clip cursors. */
  dispose(): void {
    for (const cursor of this.clipCursors.values()) closeCursor(cursor);
    this.clipCursors.clear();
  }

  /** Decode a static: try as an image first, fall back to a video freeze
   *  frame at `sourceTime` (mirrors the preview's StaticStore). */
  private async decodeStatic(node: ResolvedStatic): Promise<NodeFrame | null> {
    const path = this.resolvePath(node.source);
    try {
      const img = await loadImage(path);
      const canvas = createCanvas(img.width, img.height);
      const ctx = canvas.getContext("2d");
      ctx.drawImage(img, 0, 0);
      const id = ctx.getImageData(0, 0, img.width, img.height);
      this.staticDims.set(node, { w: img.width, h: img.height });
      return { data: id.data, width: img.width, height: img.height };
    } catch {
      // Not a decodable image — treat as a video and freeze at sourceTime.
      const entry = await this.openSource(node.source);
      const sample = await entry.sink.getSample(node.sourceTime);
      if (!sample) {
        this.staticDims.set(node, { w: entry.width, h: entry.height });
        return null;
      }
      const frame = await sampleToFrame(sample, entry.rotation);
      sample.close();
      this.staticDims.set(node, { w: frame.width, h: frame.height });
      return frame;
    }
  }

  /** Rasterize a text node at output time `t` via the same Skia + Pretext
   *  layout the CLI uses (@seam/renderer's text path), to RGBA. */
  private renderText(
    node: ResolvedText,
    drawTime: number,
    contentW?: number,
    contentH?: number,
  ): NodeFrame {
    if (!this.textReady) {
      installCanvasShim(); // fonts + OffscreenCanvas polyfill (idempotent)
      this.textReady = true;
    }
    // Inner canvas: the compositor's per-frame sampled size (animatable),
    // falling back to the resolver's baked t=0 value for static text.
    const w = contentW ?? node.intrinsicWidth ?? 0;
    const h = contentH ?? node.intrinsicHeight ?? 0;
    const W = Math.max(1, Math.round(w));
    const H = Math.max(1, Math.round(h));
    const localT = Math.max(0, drawTime);
    const canvas = createCanvas(W, H);
    const ctx = canvas.getContext("2d") as SKRSContext2D;
    drawTextLayout(
      ctx as unknown as OffscreenCanvasRenderingContext2D,
      layoutText(node, localT, W, H),
    );
    const id = ctx.getImageData(0, 0, W, H);
    return { data: id.data, width: W, height: H };
  }
}

/** Convert a decoded VideoSample to a display-oriented RGBA frame. */
async function sampleToFrame(
  sample: VideoSample,
  rotation: Rotation,
): Promise<NodeFrame> {
  const cw = sample.codedWidth;
  const ch = sample.codedHeight;
  const coded = new Uint8Array(sample.allocationSize({ format: "RGBA" }));
  await sample.copyTo(coded, { format: "RGBA" });
  return rotateRGBA(coded, cw, ch, rotation);
}

/** Sum two clockwise quarter-turn rotations, wrapping to 0/90/180/270. */
function addRotation(a: Rotation, b: Rotation = 0): Rotation {
  return (((a + b) % 360 + 360) % 360) as Rotation;
}

/** Close any samples and the iterator held by a clip cursor. */
function closeCursor(cursor: ClipCursor): void {
  cursor.current?.close();
  cursor.pending?.close();
  cursor.iter.return?.(undefined);
  cursor.current = null;
  cursor.pending = null;
  cursor.frame = null;
}

/**
 * Bake a clockwise rotation (0/90/180/270) into an RGBA buffer, returning the
 * display-oriented frame. `copyTo` yields coded (unrotated) pixels; the
 * container's rotation metadata says how to orient them for display, and for
 * 90/270 the dimensions swap. Square-pixel assumption (PAR ignored).
 */
function rotateRGBA(
  src: Uint8Array,
  w: number,
  h: number,
  rotation: Rotation,
): NodeFrame {
  if (rotation === 0) return { data: src, width: w, height: h };

  const swap = rotation === 90 || rotation === 270;
  const dw = swap ? h : w;
  const dh = swap ? w : h;
  const dst = new Uint8Array(dw * dh * 4);

  for (let dy = 0; dy < dh; dy++) {
    for (let dx = 0; dx < dw; dx++) {
      let sx: number;
      let sy: number;
      if (rotation === 90) {
        sx = dy;
        sy = h - 1 - dx;
      } else if (rotation === 180) {
        sx = w - 1 - dx;
        sy = h - 1 - dy;
      } else {
        // 270
        sx = w - 1 - dy;
        sy = dx;
      }
      const s = (sy * w + sx) * 4;
      const d = (dy * dw + dx) * 4;
      dst[d] = src[s];
      dst[d + 1] = src[s + 1];
      dst[d + 2] = src[s + 2];
      dst[d + 3] = src[s + 3];
    }
  }
  return { data: dst, width: dw, height: dh };
}

/** A drawable plus its container-local elapsed time, for {@link FrameSource.prepare}.
 *  `contentW`/`contentH` carry the per-frame inner-canvas size for text/graphic
 *  (sampled by the compositor against live parent dims). */
export interface DrawableJob {
  node: Drawable;
  drawTime: number;
  contentW?: number;
  contentH?: number;
}

/** Collect every drawable a render-command tree will draw, with its drawTime
 *  (recurse groups). */
export function collectDrawables(commands: RenderCommand[]): DrawableJob[] {
  const out: DrawableJob[] = [];
  const walk = (cmds: RenderCommand[]): void => {
    for (const cmd of cmds) {
      if (cmd.type === "draw")
        out.push({
          node: cmd.clip,
          drawTime: cmd.drawTime,
          contentW: cmd.contentW,
          contentH: cmd.contentH,
        });
      else if (cmd.type === "group") walk(cmd.children);
    }
  };
  walk(commands);
  return out;
}

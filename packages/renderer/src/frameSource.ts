/**
 * Per-tick frame provider for the headless render loop.
 *
 * The compositor's `getFrame(clip)` is synchronous, but decoding a video frame
 * (mediabunny) is async. So each tick we (1) async-decode every drawable active
 * at time `t` into a cache via {@link prepare}, then (2) the compositor pulls
 * frames synchronously via {@link get}.
 *
 * Providers: clip (mediabunny forward cursor), static (image via Skia, else a
 * video freeze frame), text (Skia + Pretext layout), map (@seam/map on Skia via
 * {@link MapRasterizer}). Shapes (`rect`/`circle`) never reach here — the
 * compositor rasterizes them analytically.
 */
import { registerMediabunnyServer } from "@mediabunny/server";
import {
  Input,
  ALL_FORMATS,
  EncodedPacketSink,
  VideoSampleSink,
  type InputVideoTrack,
  type Rotation,
  type VideoSample,
} from "mediabunny";
import { layoutText, drawTextLayout, clipSourceTime } from "@seam/core";
import type {
  ResolvedClip,
  ResolvedMap,
  ResolvedStatic,
  ResolvedText,
} from "@seam/core";
import { installCanvasShim } from "./text/canvasShim.js";
import { MapRasterizer } from "./mapRasterizer.js";
import { createCanvas, loadImage, type SKRSContext2D } from "@napi-rs/canvas";
import type { RenderCommand, DrawCommand } from "@seam/compositor";
import type { NodeFrame } from "./NodeBackend.js";
import { HdrToSdrConverter, isHdrSample } from "./hdrToSdr.js";
import { HdrToSdrGpu } from "./hdrToSdrGpu.js";
import { openMediaSource, resolveSourcePath } from "./mediaInput.js";
import { rasterizeSvg } from "./svgImage.js";
import { classifyStatic } from "./staticKind.js";
import type { BlockStores } from "@seam/media-source";

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
  // Packet metadata access (no decode) — used to decide whether a forward
  // jump crosses a keyframe, i.e. whether re-seeking beats advancing.
  packetSink: EncodedPacketSink;
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
  // HDR (HLG/PQ-tagged) sources tone-map to SDR on the way to RGBA; created
  // on the first HDR sample, one per cursor (the converters are sequential).
  hdr: HdrToSdrConverter | null;
  hdrGpu: HdrToSdrGpu | null;
}

/** Backward decode window for a reversed clip (`reverse: true`). Decoders
 *  only run forward, so stepping back one frame means decoding from the
 *  keyframe behind it; instead each refill decodes keyframe → target once and
 *  keeps the LAST `REVERSE_WINDOW` decoded samples, which then serve that many
 *  backward steps for free. Amortized cost per output frame ≈ GOP/(2·window)
 *  decodes; memory = `REVERSE_WINDOW` decoded samples. */
interface ReverseCursor {
  samples: VideoSample[]; // ascending by timestamp
  /** Source time the window was filled for: `samples` holds every sample in
   *  `[samples[0].timestamp, filledFor]`. */
  filledFor: number;
  shown: VideoSample | null; // sample `frame` was converted from
  frame: NodeFrame | null;
  rotation: Rotation;
  hdr: HdrToSdrConverter | null;
  hdrGpu: HdrToSdrGpu | null;
}

/** The HDR converters a decode cursor owns (see {@link sampleToFrame}). */
interface HdrHolder {
  hdr: HdrToSdrConverter | null;
  hdrGpu: HdrToSdrGpu | null;
}

const REVERSE_WINDOW = 12;

const EPS = 1e-4;

/** Forward jumps shorter than this always advance sequentially, skipping the
 *  keyframe lookup — at 1× playback the per-tick jump is a single frame and
 *  the cursor's drain loop is already optimal. */
const SEEK_CHECK_MIN_JUMP = 0.25;

export class FrameSource {
  private readonly basePath: string;
  private readonly sources = new Map<string, SourceEntry>();
  /** Remote block-cache registry shared with the planner + audio mix. */
  private readonly stores: BlockStores | undefined;
  private readonly cache = new Map<object, NodeFrame | null>();
  private readonly clipCursors = new Map<ResolvedClip, ClipCursor>();
  private readonly reverseCursors = new Map<ResolvedClip, ReverseCursor>();
  // Statics decode once (fixed sourceTime / image) — cached for the run.
  private readonly statics = new Map<ResolvedStatic, NodeFrame | null>();
  private readonly staticDims = new Map<ResolvedStatic, { w: number; h: number }>();
  private textReady = false;

  // Maps rasterize on demand (no disk pre-pass); the rasterizer's tile pool
  // stays warm across frames and is closed in dispose().
  private readonly maps: MapRasterizer;
  /** The compositor's device, when frames may be handed over as textures. */
  private readonly device: GPUDevice | undefined;

  /**
   * `device` — the device the compositor's backend renders on. With it, HDR
   * clip frames are tone-mapped on the GPU and returned as textures
   * (`NodeFrame.view`, no CPU pixels); without it everything is CPU RGBA.
   */
  constructor(basePath: string, stores?: BlockStores, device?: GPUDevice) {
    ensureServer();
    this.basePath = basePath;
    this.stores = stores;
    this.device = device;
    this.maps = new MapRasterizer(basePath);
  }

  /** Absolute path for a local source; an `http(s)://` URL passes through
   *  (static images fetch it via `loadImage`, videos via `openMediaSource`). */
  private resolvePath(src: string): string {
    return resolveSourcePath(src, this.basePath);
  }

  /** Open (once) a video source and learn its coded dimensions. */
  async openSource(src: string): Promise<SourceEntry> {
    let entry = this.sources.get(src);
    if (!entry) {
      const input = new Input({
        source: openMediaSource(src, this.basePath, this.stores),
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
        packetSink: new EncodedPacketSink(track),
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

    if (node.type === "map") {
      return this.renderMap(node, drawTime, contentW, contentH);
    }

    throw new Error(
      `renderer: no frame provider for "${(node as { type: string }).type}"`,
    );
  }

  /** Rasterize the basemap at map-local `drawTime`, at the per-frame
   *  inner-canvas size (`contentW`/`contentH`) sampled by the compositor. */
  private renderMap(
    node: ResolvedMap,
    drawTime: number,
    contentW?: number,
    contentH?: number,
  ): Promise<NodeFrame> {
    const w = contentW ?? node.intrinsicWidth ?? 1;
    const h = contentH ?? node.intrinsicHeight ?? 1;
    return this.maps.render(node, drawTime, w, h);
  }

  /** Decode a clip frame by advancing a forward sample cursor to the needed
   *  source time (no per-frame re-seek). `drawTime` is the clip's container-local
   *  elapsed time (nesting already folded in by the compositor). */
  private async decodeClip(node: ResolvedClip, drawTime: number): Promise<NodeFrame | null> {
    const entry = await this.openSource(node.source);
    const sourceTime = clipSourceTime(node, Math.max(0, drawTime));
    if (node.reverse) return this.decodeReverse(node, entry, sourceTime);

    let cursor = this.clipCursors.get(node);
    // A large forward jump (high `speed` / short `duration`) crossing a
    // keyframe: re-seeking decodes only from that keyframe, while advancing
    // would decode every skipped sample (at 100× that's the entire source).
    // Same-GOP jumps keep advancing — a re-seek there would re-decode from
    // the keyframe *behind* the cursor. The keyframe lookup is metadata-only.
    if (cursor && sourceTime >= cursor.lastTime - EPS) {
      const pos = cursor.current?.timestamp ?? cursor.lastTime;
      if (sourceTime - pos >= SEEK_CHECK_MIN_JUMP) {
        const key = await entry.packetSink.getKeyPacket(sourceTime, {
          metadataOnly: true,
        });
        if (key !== null && key.timestamp > pos + EPS) {
          closeCursor(cursor);
          this.clipCursors.delete(node);
          cursor = undefined;
        }
      }
    }
    // Create, or restart on a backward jump (the forward iterator can't rewind).
    if (!cursor || sourceTime < cursor.lastTime - EPS) {
      if (cursor) closeCursor(cursor);
      cursor = {
        iter: entry.sink.samples(Math.max(0, sourceTime))[Symbol.asyncIterator](),
        current: null,
        pending: null,
        frame: null,
        lastTime: sourceTime,
        hdr: null,
        hdrGpu: null,
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
      cursor.frame = await sampleToFrame(cursor.current, cursor.rotation, cursor, this.device);
    }
    return cursor.frame;
  }

  /** Frame for a reversed clip: the latest sample ≤ `sourceTime`, served from
   *  a window of decoded samples that is refilled (keyframe → target) only
   *  when the playhead steps below it. Same sample selection as the forward
   *  cursor, so a reversed clip shows exactly the frames the forward one
   *  does, in the opposite order. */
  private async decodeReverse(
    node: ResolvedClip,
    entry: SourceEntry,
    sourceTime: number,
  ): Promise<NodeFrame | null> {
    let cursor = this.reverseCursors.get(node);
    if (!cursor) {
      cursor = {
        samples: [],
        filledFor: -Infinity,
        shown: null,
        frame: null,
        hdr: null,
        hdrGpu: null,
        rotation: addRotation(entry.rotation, node.orientation),
      };
      this.reverseCursors.set(node, cursor);
    }
    const t = Math.max(0, sourceTime);
    const covered =
      cursor.samples.length > 0 &&
      t <= cursor.filledFor + EPS &&
      t >= cursor.samples[0].timestamp - EPS;
    if (!covered) {
      for (const s of cursor.samples) s.close();
      cursor.samples = [];
      cursor.shown = null;
      cursor.frame = null;
      cursor.filledFor = t;
      // `samples(t0)` starts at the sample containing t0 (decoding from the
      // keyframe behind it internally); starting at that keyframe hands us
      // the whole GOP prefix to keep the tail of.
      const key = await entry.packetSink.getKeyPacket(t, { metadataOnly: true });
      const iter = entry.sink.samples(Math.max(0, key?.timestamp ?? t))[Symbol.asyncIterator]();
      try {
        for (;;) {
          const res = await iter.next();
          if (res.done) break;
          if (res.value.timestamp > t + EPS) {
            res.value.close();
            break;
          }
          cursor.samples.push(res.value);
          if (cursor.samples.length > REVERSE_WINDOW) cursor.samples.shift()!.close();
        }
      } finally {
        await iter.return?.(undefined);
      }
    }

    let pick: VideoSample | null = null;
    for (const s of cursor.samples) {
      if (s.timestamp > t + EPS) break;
      pick = s;
    }
    if (!pick) return null;
    if (pick !== cursor.shown || !cursor.frame) {
      cursor.frame = await sampleToFrame(pick, cursor.rotation, cursor, this.device);
      cursor.shown = pick;
    }
    return cursor.frame;
  }

  /** Release decoder resources held by open clip cursors + map archives. */
  async dispose(): Promise<void> {
    for (const cursor of this.clipCursors.values()) closeCursor(cursor);
    this.clipCursors.clear();
    for (const cursor of this.reverseCursors.values()) {
      for (const s of cursor.samples) s.close();
      cursor.hdr?.dispose();
      cursor.hdrGpu?.dispose();
    }
    this.reverseCursors.clear();
    await this.maps.dispose();
  }

  /** Decode a static. The kind comes from the file's leading bytes (a
   *  remote source has no extension to go by): SVG → Cairo, raster → Skia,
   *  anything else → a video freeze frame at `sourceTime` (mirrors the
   *  preview's StaticStore). */
  private async decodeStatic(node: ResolvedStatic): Promise<NodeFrame | null> {
    const path = this.resolvePath(node.source);
    const kind = await classifyStatic(path);
    if (kind === "svg") {
      const svg = await rasterizeSvg(path);
      this.staticDims.set(node, { w: svg.width, h: svg.height });
      return svg;
    }
    if (kind === "raster") {
      const img = await loadImage(path);
      const canvas = createCanvas(img.width, img.height);
      const ctx = canvas.getContext("2d");
      ctx.drawImage(img, 0, 0);
      const id = ctx.getImageData(0, 0, img.width, img.height);
      this.staticDims.set(node, { w: img.width, h: img.height });
      return { data: id.data, width: img.width, height: img.height };
    }
    const entry = await this.openSource(node.source);
    const sample = await entry.sink.getSample(node.sourceTime);
    if (!sample) {
      this.staticDims.set(node, { w: entry.width, h: entry.height });
      return null;
    }
    // One-shot: a freeze frame decodes once, so the HDR converter (if the
    // source needs one) lives only for this call — on the CPU, since a GPU
    // frame's texture would have to outlive it.
    const holder: HdrHolder = { hdr: null, hdrGpu: null };
    try {
      const frame = await sampleToFrame(sample, entry.rotation, holder);
      this.staticDims.set(node, { w: frame.width, h: frame.height });
      return frame;
    } finally {
      sample.close();
      holder.hdr?.dispose();
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

/** Convert a decoded VideoSample to a display-oriented frame. HDR-tagged
 *  samples (HLG/PQ) are tone-mapped to SDR BT.709 by the converters in
 *  `holder`, created on demand and owned by the caller: on the GPU when a
 *  `device` is given (the frame comes back as a texture, rotation included),
 *  else in TypeScript. Everything else takes mediabunny's plain RGBA
 *  conversion. */
async function sampleToFrame(
  sample: VideoSample,
  rotation: Rotation,
  holder: HdrHolder,
  device?: GPUDevice,
): Promise<NodeFrame> {
  const cw = sample.codedWidth;
  const ch = sample.codedHeight;
  let coded: Uint8Array;
  if (isHdrSample(sample)) {
    holder.hdr ??= new HdrToSdrConverter();
    if (device) {
      const pic = await holder.hdr.readPicture(sample);
      if (pic) {
        holder.hdrGpu ??= new HdrToSdrGpu(device);
        return holder.hdrGpu.convert(pic, rotation);
      }
    }
    coded = await holder.hdr.toRgba(sample);
  } else {
    coded = new Uint8Array(sample.allocationSize({ format: "RGBA" }));
    await sample.copyTo(coded, { format: "RGBA" });
  }
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
  cursor.hdr?.dispose();
  cursor.hdr = null;
  cursor.hdrGpu?.dispose();
  cursor.hdrGpu = null;
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
export function rotateRGBA(
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
 *  `contentW`/`contentH` carry the per-frame inner-canvas size for text/map
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

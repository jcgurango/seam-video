import type {
  ResolvedChild,
  ResolvedStatic,
  ResolvedTimeline,
} from "@seam/core";
import { CanvasSink } from "mediabunny";
import { SNIFF_BYTES, sniffStaticKind, type StaticKind } from "@seam/media-source";
import type { MediaStore } from "./MediaStore.js";
import { resolveSource } from "../components/resolveSource.js";

/**
 * Per-static-node frame cache. Each `ResolvedStatic` decodes its
 * single frame once and the resulting canvas is held for the
 * lifetime of the store. Image sources go through `createImageBitmap`
 * + an offscreen canvas; video sources reuse the shared `MediaStore`
 * to seek a `CanvasSink` to `sourceTime` and grab the first frame.
 *
 * Each canvas's identity is stable across frames so the WebGPU
 * `TextureManager` only allocates one GPU texture per node.
 */
export class StaticStore {
  private bitmaps = new Map<ResolvedStatic, HTMLCanvasElement | OffscreenCanvas>();
  private sizes = new Map<ResolvedStatic, { w: number; h: number }>();
  /** Fires when a static's frame has finished decoding so the render
   *  loop can repaint while paused. */
  onFrameAvailable: (() => void) | null = null;

  async setTimeline(
    timeline: ResolvedTimeline,
    basePath: string,
    mediaStore: MediaStore,
  ): Promise<void> {
    this.dispose();
    const nodes = collectStaticNodes(timeline.children);
    if (nodes.length === 0) return;

    await Promise.all(
      nodes.map(async (node) => {
        const url = resolveSource(node.source, basePath);
        try {
          // Classify by content: blob: and remote (`…/file?token=…`) urls
          // carry no extension, so the name says nothing.
          const kind = sniffStaticKind(await readHead(url));
          const result = await decodeStaticFrame(url, kind, node.sourceTime, mediaStore);
          if (!result) return;
          this.bitmaps.set(node, result.canvas);
          this.sizes.set(node, { w: result.width, h: result.height });
          this.onFrameAvailable?.();
        } catch (err) {
          console.error(`Static node failed to decode "${node.source}":`, err);
        }
      }),
    );
  }

  getFrame(node: ResolvedStatic): HTMLCanvasElement | OffscreenCanvas | null {
    return this.bitmaps.get(node) ?? null;
  }

  getIntrinsicSize(node: ResolvedStatic): { w: number; h: number } | null {
    return this.sizes.get(node) ?? null;
  }

  dispose(): void {
    this.bitmaps.clear();
    this.sizes.clear();
  }
}

function collectStaticNodes(children: ResolvedChild[]): ResolvedStatic[] {
  const out: ResolvedStatic[] = [];
  walk(children);
  return out;

  function walk(arr: ResolvedChild[]) {
    for (const c of arr) {
      if (c.type === "static") out.push(c);
      else if (c.type === "composition") walk(c.children);
    }
  }
}

/** First `SNIFF_BYTES` of a url: a bounded Range for http (Seam Cloud
 *  honours it), and only the first body chunk otherwise — a blob: video
 *  answers 200 with the whole file, which we cancel after one read. */
async function readHead(url: string): Promise<Uint8Array> {
  const res = await fetch(url, { headers: { Range: `bytes=0-${SNIFF_BYTES - 1}` } });
  if (!res.ok) throw new Error(`static source ${res.status} ${res.statusText}`);
  if (!res.body) return new Uint8Array(0);
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let got = 0;
  while (got < SNIFF_BYTES) {
    const { value, done } = await reader.read();
    if (done) break;
    chunks.push(value);
    got += value.length;
  }
  await reader.cancel().catch(() => {});
  const out = new Uint8Array(Math.min(got, SNIFF_BYTES));
  let off = 0;
  for (const c of chunks) {
    const n = Math.min(c.length, out.length - off);
    out.set(c.subarray(0, n), off);
    off += n;
    if (off >= out.length) break;
  }
  return out;
}

async function decodeStaticFrame(
  url: string,
  kind: StaticKind,
  sourceTime: number,
  mediaStore: MediaStore,
): Promise<{ canvas: OffscreenCanvas; width: number; height: number } | null> {
  if (kind === "svg") {
    // Chrome's createImageBitmap rejects some perfectly valid SVGs
    // ("The source image could not be decoded") that an <img> renders fine,
    // so SVG goes through an HTMLImageElement and is rasterized at its
    // intrinsic size — the same size Skia's loadImage uses in the renderer.
    const response = await fetch(url);
    const blob = await response.blob();
    const svgBlob = blob.type === "image/svg+xml" ? blob : new Blob([blob], { type: "image/svg+xml" });
    const objectUrl = URL.createObjectURL(svgBlob);
    try {
      const img = new Image();
      await new Promise<void>((resolve, reject) => {
        img.onload = () => resolve();
        img.onerror = () => reject(new Error("SVG <img> failed to load"));
        img.src = objectUrl;
      });
      const width = img.naturalWidth;
      const height = img.naturalHeight;
      if (!width || !height) throw new Error("SVG has no intrinsic size (needs width/height or a viewBox)");
      const canvas = new OffscreenCanvas(width, height);
      const ctx = canvas.getContext("2d");
      if (!ctx) return null;
      ctx.drawImage(img, 0, 0, width, height);
      return { canvas, width, height };
    } finally {
      URL.revokeObjectURL(objectUrl);
    }
  }
  if (kind === "raster") {
    const response = await fetch(url);
    const blob = await response.blob();
    // `imageOrientation: "from-image"` applies EXIF Orientation so camera
    // JPEGs (stored landscape + rotate flag) decode to their displayed
    // portrait dims. This must be explicit: the default varies by engine,
    // and the CLI render path (melt qimage + ffprobe) always honors EXIF —
    // so without this, preview and render disagree on a rotated photo's
    // dimensions, throwing off objectFit/translation.
    const bitmap = await createImageBitmap(blob, {
      imageOrientation: "from-image",
    });
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      bitmap.close();
      return null;
    }
    ctx.drawImage(bitmap, 0, 0);
    const width = bitmap.width;
    const height = bitmap.height;
    bitmap.close();
    return { canvas, width, height };
  }

  // Video source: pull a single decoded frame at `sourceTime` via
  // the same mediabunny pipeline the playback path uses.
  const videoTrack = await mediaStore.getVideoTrack(url);
  if (!videoTrack || !(await videoTrack.canDecode())) return null;
  const sink = new CanvasSink(videoTrack, { poolSize: 1 });
  const iter = sink.canvases(sourceTime);
  const result = await iter.next();
  await iter.return?.();
  if (!result.value) return null;
  const { canvas: src } = result.value;
  const width = src.width;
  const height = src.height;
  // Copy out of the pool so the bitmap survives sink disposal.
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  ctx.drawImage(src as CanvasImageSource, 0, 0);
  return { canvas, width, height };
}

import type {
  ResolvedChild,
  ResolvedStatic,
  ResolvedTimeline,
} from "@seam/core";
import { CanvasSink } from "mediabunny";
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
        // Classify by the original `source` field rather than the resolved
        // url, because web-platform urls are opaque blob: URIs without an
        // extension and would always fall through to the video path.
        const isImage = isImageSource(node.source);
        try {
          const result = await decodeStaticFrame(
            url,
            isImage,
            node.sourceTime,
            mediaStore,
          );
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

const IMAGE_EXTS = new Set([
  "png", "jpg", "jpeg", "webp", "gif", "bmp", "avif", "tif", "tiff", "svg",
]);

function isImageSource(source: string): boolean {
  const dot = source.lastIndexOf(".");
  if (dot < 0) return false;
  const ext = source.slice(dot + 1).split(/[?#]/)[0].toLowerCase();
  return IMAGE_EXTS.has(ext);
}

async function decodeStaticFrame(
  url: string,
  isImage: boolean,
  sourceTime: number,
  mediaStore: MediaStore,
): Promise<{ canvas: OffscreenCanvas; width: number; height: number } | null> {
  if (isImage) {
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

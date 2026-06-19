// Per-graphic, on-demand frame renderer. Same setup as raster.ts's
// rasterizeNode (precompute playback + clip playbacks + a Map pool), but
// instead of writing a PNG sequence to disk up front it renders one frame to
// RGBA on demand. Lets the WebGPU renderer pull graphic frames inside its
// loop (like text), eliminating the disk-shaped pre-pass MLT required.

import type { ResolvedGraphic } from "@seam/core";
import {
  precomputeGraphicPlayback,
  snapshotAt,
  treeAt,
  isStatic,
  type GraphicPlayback,
} from "./playback.js";
import { renderSnapshotToRgba, type GraphicContext } from "./render.js";
import {
  precomputeClipPlayback,
  type ClipDefLike,
  type ClipPlayback,
} from "./clip.js";
import { createTileSourcePool } from "./map-tiles.js";
import { isAbsolute, join } from "node:path";

function asNumber(v: unknown, fallback: number): number {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return fallback;
}

function imageSrcToFileUrl(src: string, basePath: string | undefined): string {
  if (/^(data:|https?:|blob:|file:)/i.test(src)) return src;
  const abs = isAbsolute(src) ? src : basePath ? join(basePath, src) : src;
  return `file:///${abs.replace(/^\/+/, "")}`;
}

/** Deep-clone a graphic's frames/clip-frames, rewriting every Image `src` to a
 *  `file://` URL (fabric/node hangs on bare paths). */
function rewriteImageSrcs(value: unknown, basePath: string | undefined): unknown {
  if (Array.isArray(value)) return value.map((v) => rewriteImageSrcs(v, basePath));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] =
        k === "src" && typeof v === "string"
          ? imageSrcToFileUrl(v, basePath)
          : rewriteImageSrcs(v, basePath);
    }
    return out;
  }
  return value;
}

export interface GraphicFrame {
  data: Uint8ClampedArray;
  width: number;
  height: number;
}

export interface GraphicFrameRenderer {
  readonly width: number;
  readonly height: number;
  /** Render the graphic at composition-local time `localT` (seconds since the
   *  graphic's start) to RGBA. `contentW`/`contentH` override the inner-canvas
   *  size per-frame (animatable contentWidth); absent → the baked size.
   *  Consecutive identical frames (same time AND size) are deduped. */
  renderAt(localT: number, contentW?: number, contentH?: number): Promise<GraphicFrame>;
  /** Release the Map tile pool (closes pmtiles file handles). */
  dispose(): Promise<void>;
}

/** Build an on-demand frame renderer for one resolved graphic. The setup
 *  (fill defaults, precompute keyframes, clip playbacks, Map pool) runs once;
 *  the expensive per-frame fabric/OpenLayers render happens lazily in
 *  {@link GraphicFrameRenderer.renderAt}. */
export async function createGraphicFrameRenderer(
  node: ResolvedGraphic,
  opts: { mapBasePath?: string },
): Promise<GraphicFrameRenderer> {
  // Baked design size: the resolver's t=0 intrinsic (default = 100% of parent).
  // The per-frame `renderAt(contentW, contentH)` overrides this when the inner
  // canvas animates. `asNumber` only catches pre-resolve / hand-built nodes.
  const width = Math.max(1, Math.round(node.intrinsicWidth ?? asNumber(node.contentWidth, 1080)));
  const height = Math.max(1, Math.round(node.intrinsicHeight ?? asNumber(node.contentHeight, 1920)));
  const mapBasePath = opts.mapBasePath;

  // Resolve every Image src to a file:// URL up front (fabric/node hangs on
  // bare paths).
  const frames = rewriteImageSrcs(node.frames, mapBasePath) as ReadonlyArray<
    ReadonlyArray<unknown>
  >;
  const playback: GraphicPlayback = await precomputeGraphicPlayback({
    duration: typeof node.duration === "number" ? node.duration : undefined,
    loop: node.loop,
    frames,
  });

  const clipDefs = new Map<string, ClipDefLike>();
  const clipPlaybacks = new Map<string, ClipPlayback>();
  for (const c of node.clips ?? []) {
    const def: ClipDefLike = {
      id: c.id,
      duration: c.duration,
      loop: c.loop,
      contentWidth: c.contentWidth,
      contentHeight: c.contentHeight,
      frames: rewriteImageSrcs(c.frames, mapBasePath) as ReadonlyArray<
        ReadonlyArray<unknown>
      >,
    };
    clipDefs.set(c.id, def);
    clipPlaybacks.set(c.id, await precomputeClipPlayback(def));
  }

  const mapPool = createTileSourcePool(mapBasePath);
  const baseContext: Omit<GraphicContext, "outerT"> = {
    outerFrames: frames,
    clipPlaybacks,
    clipDefs,
    mapBasePath,
    mapPool,
  };

  // A clip's internal sub-animation rides `outerT` (not the outer snapshot), so
  // snapshot-signature dedup is only safe when the graphic defines no clips.
  const dedup = clipPlaybacks.size === 0;
  const staticFast = isStatic(playback) && clipPlaybacks.size === 0;
  let lastSig: string | null = null;
  let lastFrame: GraphicFrame | null = null;
  let lastW = 0;
  let lastH = 0;

  const renderAtSize = async (
    t: number,
    w: number,
    h: number,
  ): Promise<GraphicFrame> => {
    const snap = snapshotAt(playback, t);
    const tree = treeAt(playback, t);
    const { data } = await renderSnapshotToRgba(snap, tree, {
      contentWidth: w,
      contentHeight: h,
      context: { ...baseContext, outerT: t },
    });
    return { data, width: w, height: h };
  };

  return {
    width,
    height,
    async renderAt(
      localT: number,
      contentW?: number,
      contentH?: number,
    ): Promise<GraphicFrame> {
      // Live inner-canvas size (animatable contentWidth) — falls back to the
      // baked design size. Size is part of the dedup key so a static scene on
      // an animating canvas still re-rasterizes.
      const w = Math.max(1, Math.round(contentW ?? width));
      const h = Math.max(1, Math.round(contentH ?? height));
      if (staticFast) {
        if (lastFrame && lastW === w && lastH === h) return lastFrame;
        lastFrame = await renderAtSize(0, w, h);
        lastW = w;
        lastH = h;
        return lastFrame;
      }
      const t = Math.max(0, localT);
      if (dedup) {
        const snap = snapshotAt(playback, t);
        const tree = treeAt(playback, t);
        const sig = `${w}x${h} ` + JSON.stringify(tree) + " " + JSON.stringify(snap);
        if (sig === lastSig && lastFrame) return lastFrame;
        const { data } = await renderSnapshotToRgba(snap, tree, {
          contentWidth: w,
          contentHeight: h,
          context: { ...baseContext, outerT: t },
        });
        lastSig = sig;
        lastFrame = { data, width: w, height: h };
        lastW = w;
        lastH = h;
        return lastFrame;
      }
      lastFrame = await renderAtSize(t, w, h);
      lastW = w;
      lastH = h;
      return lastFrame;
    },
    async dispose(): Promise<void> {
      await mapPool.dispose();
    },
  };
}

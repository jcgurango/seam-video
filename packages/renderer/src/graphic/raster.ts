// Walk a resolved timeline and rasterize every graphic node to disk so
// MLT/ffmpeg can ingest them via image-sequence producers. Static
// graphics become one PNG; animated graphics become a numbered sequence.
// Mirrors `text/textRaster.ts`'s shape so the MLT builder can treat the
// two pipelines identically downstream.

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type {
  ResolvedChild,
  ResolvedComposition,
  ResolvedGraphic,
  ResolvedTimeline,
} from "@seam/core";
import {
  precomputeGraphicPlayback,
  snapshotAt,
  isStatic,
} from "./playback.js";
import { renderSnapshotToPng, type GraphicContext } from "./render.js";
import {
  precomputeClipPlayback,
  type ClipDefLike,
  type ClipPlayback,
} from "./clip.js";
import { MapPool } from "./map-render.js";

export interface GraphicRasterEntry {
  /** Either a single PNG path (static) or a `printf`-style sequence
   *  pattern (animated, e.g. `graphic-3-%04d.png`). */
  path: string;
  isAnimated: boolean;
  /** 1 for static, frame count for animated. */
  frameCount: number;
  /** Pixel dims actually rendered. */
  width: number;
  height: number;
  /** Output-time window — when the graphic is on the parent timeline. */
  timelineStart: number;
  timelineEnd: number;
}

export type GraphicRasterMap = Map<ResolvedGraphic, GraphicRasterEntry>;

export async function rasterizeAllGraphics(
  timeline: ResolvedTimeline,
  outDir: string,
  fps: number,
  /** Base directory for resolving relative Map source paths
   *  (e.g. pmtiles files). Typically the directory of the .seam file. */
  mapBasePath?: string,
): Promise<GraphicRasterMap> {
  const nodes = collectGraphicNodes(timeline.children);
  if (nodes.length === 0) return new Map();
  await mkdir(outDir, { recursive: true });
  const map: GraphicRasterMap = new Map();
  let i = 0;
  for (const node of nodes) {
    map.set(node, await rasterizeNode(node, outDir, fps, i++, mapBasePath));
  }
  return map;
}

async function rasterizeNode(
  node: ResolvedGraphic,
  outDir: string,
  fps: number,
  index: number,
  mapBasePath: string | undefined,
): Promise<GraphicRasterEntry> {
  const W = Math.max(1, Math.round(asNumber(node.contentWidth, 1080)));
  const H = Math.max(1, Math.round(asNumber(node.contentHeight, 1920)));
  const meta = {
    width: W,
    height: H,
    timelineStart: node.timelineStart,
    timelineEnd: node.timelineEnd,
  };

  const playback = await precomputeGraphicPlayback({
    duration: typeof node.duration === "number" ? node.duration : undefined,
    loop: node.loop,
    frames: node.frames as ReadonlyArray<ReadonlyArray<unknown>>,
  });

  // Sub-clip context: every clip definition gets its filled snapshots
  // precomputed once, then reused at each output frame to evaluate its
  // local time and produce the per-tick snap.
  const clipDefs = new Map<string, ClipDefLike>();
  const clipPlaybacks = new Map<string, ClipPlayback>();
  for (const c of node.clips ?? []) {
    const def: ClipDefLike = {
      id: c.id,
      duration: c.duration,
      loop: c.loop,
      contentWidth: c.contentWidth,
      contentHeight: c.contentHeight,
      frames: c.frames as ReadonlyArray<ReadonlyArray<unknown>>,
    };
    clipDefs.set(c.id, def);
    clipPlaybacks.set(c.id, await precomputeClipPlayback(def));
  }
  // One pool per graphic — every Map at the same path-id across this
  // graphic's frames shares a single mbgl.Map instance. Drained after
  // the last frame is written so the GL context doesn't outlive the
  // rasterization run.
  const mapPool = new MapPool();
  const baseContext: Omit<GraphicContext, "outerT"> = {
    outerFrames: node.frames as ReadonlyArray<ReadonlyArray<unknown>>,
    clipPlaybacks,
    clipDefs,
    mapBasePath,
    mapPool,
  };

  try {
    // Single keyframe + no clips → static fast path.
    if (isStatic(playback) && clipPlaybacks.size === 0) {
      const path = join(outDir, `graphic-${index}.png`);
      await writeFrame(playback, 0, W, H, path, baseContext);
      return { path, isAnimated: false, frameCount: 1, ...meta };
    }

    const duration = node.timelineEnd - node.timelineStart;
    const frameCount = Math.max(1, Math.ceil(duration * fps));
    for (let f = 0; f < frameCount; f++) {
      const t = f / fps;
      const framePath = join(
        outDir,
        `graphic-${index}-${String(f).padStart(4, "0")}.png`,
      );
      await writeFrame(playback, t, W, H, framePath, baseContext);
    }
    return {
      path: join(outDir, `graphic-${index}-%04d.png`),
      isAnimated: true,
      frameCount,
      ...meta,
    };
  } finally {
    await mapPool.releaseAll();
  }
}

async function writeFrame(
  playback: Awaited<ReturnType<typeof precomputeGraphicPlayback>>,
  t: number,
  width: number,
  height: number,
  path: string,
  baseContext: Omit<GraphicContext, "outerT">,
): Promise<void> {
  const snap = snapshotAt(playback, t);
  const tree = playback.filledFrames[0]?.tree ?? [];
  const png = await renderSnapshotToPng(snap, tree, {
    contentWidth: width,
    contentHeight: height,
    context: { ...baseContext, outerT: t },
  });
  await writeFile(path, png);
}

function asNumber(v: unknown, fallback: number): number {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return fallback;
}

function collectGraphicNodes(children: ResolvedChild[]): ResolvedGraphic[] {
  const out: ResolvedGraphic[] = [];
  walk(children);
  return out;
  function walk(arr: ResolvedChild[]) {
    for (const c of arr) {
      if (c.type === "graphic") out.push(c);
      else if (c.type === "composition") {
        walk((c as ResolvedComposition).children);
      }
    }
  }
}

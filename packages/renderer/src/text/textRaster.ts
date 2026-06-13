// Walk a resolved timeline and rasterize every text node to PNGs on
// disk so ffmpeg can pull them in via `-i`. Static text becomes one PNG;
// animated text becomes a numbered sequence (one PNG per output frame
// for the node's lifetime).
//
// Layout uses `@chenglou/pretext` against an @napi-rs/canvas
// measureText, and rendering writes glyphs to that same canvas — same
// engine measures + draws so per-fragment x coordinates land on
// glyphs, not gaps. See FILE-FORMAT.md > Animation for which fields
// drive per-frame regeneration.

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  layoutText,
  drawTextLayout,
  textHasAnimatedStyle,
} from "@seam/core";
import type { ResolvedChild, ResolvedText, ResolvedTimeline } from "@seam/core";
import { createCanvas, type SKRSContext2D } from "@napi-rs/canvas";
import { installCanvasShim } from "./canvasShim.js";
import type { OnRasterProgress } from "../graphic/raster.js";

export interface TextRasterEntry {
  /** Either a single PNG path (static) or a `printf`-style sequence
   *  pattern (animated, e.g. `text-3-%04d.png`). */
  path: string;
  isAnimated: boolean;
  /** 1 for static, frame count for animated. */
  frameCount: number;
  width: number;
  height: number;
  /** Output-time window — when the text is on the parent timeline,
   *  in absolute seconds. Carried so the ffmpeg builder doesn't have
   *  to re-derive it. */
  timelineStart: number;
  timelineEnd: number;
}

export type TextRasterMap = Map<ResolvedText, TextRasterEntry>;

/** Rasterize every text node in the resolved timeline. Static nodes
 *  produce one PNG; animated nodes produce one PNG per output frame
 *  over the node's lifetime. Returns a map keyed by ResolvedText so
 *  the ffmpeg builder can wire each node's PNGs into the filter graph. */
export async function rasterizeAllText(
  timeline: ResolvedTimeline,
  outDir: string,
  fps: number,
  onProgress?: OnRasterProgress,
): Promise<TextRasterMap> {
  installCanvasShim();
  const nodes = collectTextNodes(timeline.children);
  if (nodes.length === 0) return new Map();
  await mkdir(outDir, { recursive: true });
  const map: TextRasterMap = new Map();
  for (let i = 0; i < nodes.length; i++) {
    map.set(
      nodes[i],
      await rasterizeNode(nodes[i], outDir, fps, i, nodes.length, onProgress),
    );
  }
  return map;
}

async function rasterizeNode(
  node: ResolvedText,
  outDir: string,
  fps: number,
  index: number,
  total: number,
  onProgress: OnRasterProgress | undefined,
): Promise<TextRasterEntry> {
  // Spatial pass collapses contentWidth/Height to a pixel number.
  const W = Math.max(1, Math.round(node.contentWidth as number));
  const H = Math.max(1, Math.round(node.contentHeight as number));
  const meta = {
    width: W,
    height: H,
    timelineStart: node.timelineStart,
    timelineEnd: node.timelineEnd,
  };

  if (!textHasAnimatedStyle(node)) {
    onProgress?.({ index, total, animated: false, frame: 1, frameCount: 1 });
    const path = join(outDir, `text-${index}.png`);
    await writeFrame(node, 0, W, H, path);
    return { path, isAnimated: false, frameCount: 1, ...meta };
  }

  const duration = node.timelineEnd - node.timelineStart;
  const frameCount = Math.max(1, Math.ceil(duration * fps));
  for (let f = 0; f < frameCount; f++) {
    onProgress?.({ index, total, animated: true, frame: f + 1, frameCount });
    const t = f / fps;
    const framePath = join(
      outDir,
      `text-${index}-${String(f).padStart(4, "0")}.png`,
    );
    await writeFrame(node, t, W, H, framePath);
  }
  return {
    path: join(outDir, `text-${index}-%04d.png`),
    isAnimated: true,
    frameCount,
    ...meta,
  };
}

async function writeFrame(
  node: ResolvedText,
  t: number,
  width: number,
  height: number,
  path: string,
): Promise<void> {
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext("2d") as SKRSContext2D;
  drawTextLayout(
    ctx as unknown as OffscreenCanvasRenderingContext2D,
    layoutText(node, t),
  );
  await writeFile(path, canvas.toBuffer("image/png"));
}

function collectTextNodes(children: ResolvedChild[]): ResolvedText[] {
  const out: ResolvedText[] = [];
  walk(children);
  return out;
  function walk(arr: ResolvedChild[]) {
    for (const c of arr) {
      if (c.type === "text") out.push(c);
      else if (c.type === "composition") walk(c.children);
    }
  }
}

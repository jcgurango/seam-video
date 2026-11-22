// The captions overlay renderer — one implementation for both hosts.
//
// For a surface at its inner time `t`: the phrases on screen there
// (`activeCues`), each laid out with core's text layout in the surface's
// inner canvas using the surface's style (+ speaker override + the caption's
// own), drawn bottom first. Shares the layout code with the `text` node —
// not the primitive.

import {
  drawTextLayout,
  layoutText,
  type CanvasLike,
  type OverlayRasterizer,
  type RasterHost,
  type ResolvedText,
  type SurfaceView,
} from "@seam/core";
import { activeCues, cueStyle, surfaceStyle, type CaptionCue } from "../collect.js";
import type { CaptionStyle } from "../index.js";

interface Entry {
  canvas: CanvasLike;
  /** What is currently drawn on it — skip identical redraws. */
  cues: CaptionCue[];
  style: unknown;
  width: number;
  height: number;
}

/** A cue as the text layout sees it: a one-run text node filling the canvas. */
function textNodeFor(cue: CaptionCue, style: CaptionStyle): ResolvedText {
  return {
    type: "text",
    runs: [{ text: cue.text }],
    timelineStart: 0,
    timelineEnd: Math.max(cue.end - cue.start, 0),
    ...style,
  } as ResolvedText;
}

const sameCues = (a: CaptionCue[], b: CaptionCue[]) =>
  a.length === b.length && a.every((cue, i) => cue === b[i]);

export function createCaptionsRasterizer(host: RasterHost): OverlayRasterizer {
  // One canvas per surface (keyed by its children array, stable for a
  // resolved timeline).
  let entries = new WeakMap<object, Entry>();
  // Scratch for the second and later phrases on screen at once.
  let scratch: CanvasLike | null = null;

  return {
    draw(surface: SurfaceView, t: number, w: number, h: number): CanvasLike | null {
      const cues = activeCues(surface, t);
      if (cues.length === 0) return null;
      const W = Math.max(1, Math.round(w));
      const H = Math.max(1, Math.round(h));
      const style = surface.ext?.captionStyle;

      let entry = entries.get(surface.children);
      if (!entry) {
        entry = { canvas: host.createCanvas(W, H), cues: [], style: undefined, width: W, height: H };
        entries.set(surface.children, entry);
      } else if (
        entry.width === W &&
        entry.height === H &&
        entry.style === style &&
        sameCues(entry.cues, cues)
      ) {
        return entry.canvas;
      }
      if (entry.width !== W || entry.height !== H) {
        entry.canvas.width = W;
        entry.canvas.height = H;
        entry.width = W;
        entry.height = H;
      }
      entry.cues = cues;
      entry.style = style;

      const ctx = entry.canvas.getContext("2d") as OffscreenCanvasRenderingContext2D | null;
      if (!ctx) return null;
      const base = surfaceStyle(surface);
      cues.forEach((cue, i) => {
        const layout = layoutText(textNodeFor(cue, cueStyle(base, cue)), 0, W, H);
        if (i === 0) {
          // Clears the canvas, then draws.
          drawTextLayout(ctx, layout);
          return;
        }
        // `drawTextLayout` clears its target, so later phrases go through a
        // scratch canvas and are composited on top.
        if (!scratch) scratch = host.createCanvas(W, H);
        if (scratch.width !== W || scratch.height !== H) {
          scratch.width = W;
          scratch.height = H;
        }
        const sctx = scratch.getContext("2d") as OffscreenCanvasRenderingContext2D | null;
        if (!sctx) return;
        drawTextLayout(sctx, layout);
        ctx.drawImage(scratch as unknown as CanvasImageSource, 0, 0);
      });
      return entry.canvas;
    },

    clear(): void {
      entries = new WeakMap();
    },

    dispose(): void {
      entries = new WeakMap();
      scratch = null;
    },
  };
}

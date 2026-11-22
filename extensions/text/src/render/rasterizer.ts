// The `text` node's rasterizer — one implementation for both hosts.
//
// Lays the node out (Pretext, the same engine that measures and draws) on
// its inner canvas and draws it. A canvas is kept per node: static text is
// drawn once and redrawn only when its inner canvas changes size; text with
// any keyframed style is redrawn when the node-local time moves.

import {
  extensionContentSpan,
  type CanvasLike,
  type ExtensionNodeView,
  type NodeRasterizer,
  type RasterHost,
} from "@seam/core";
import { normalizeTextRuns, type ResolvedText } from "../index.js";
import { drawTextLayout } from "./textCanvas.js";
import { layoutText, measureText, textHasAnimatedStyle, type TextLayoutInput } from "./textLayout.js";

interface Entry {
  canvas: CanvasLike;
  input: TextLayoutInput;
  animated: boolean;
  /** What is on the canvas now. */
  lastT: number;
  lastW: number;
  lastH: number;
  /** The last measurement (`wrap: false`), and the time it was taken at. */
  measured?: { t: number; width: number; height: number };
}

/** The node as the layout sees it. Its keyframes run over the node's full
 *  span, also when a composition window cut into it. */
export function textLayoutInput(node: ExtensionNodeView): TextLayoutInput {
  const text = node as unknown as ResolvedText;
  return {
    runs: normalizeTextRuns(text.text ?? ""),
    fontFamily: text.fontFamily,
    fontSize: text.fontSize,
    color: text.color,
    fontWeight: text.fontWeight,
    fontStyle: text.fontStyle,
    textDecoration: text.textDecoration,
    letterHeight: text.letterHeight,
    backgroundColor: text.backgroundColor,
    backgroundPadding: text.backgroundPadding,
    strokeColor: text.strokeColor,
    strokeWidth: text.strokeWidth,
    lineHeight: text.lineHeight,
    textAlign: text.textAlign,
    verticalAlign: text.verticalAlign,
    padding: text.padding,
    wrap: text.wrap,
    duration: extensionContentSpan(node).duration,
  };
}

export function createTextRasterizer(host: RasterHost): NodeRasterizer {
  let entries = new WeakMap<ExtensionNodeView, Entry>();

  /** The node's entry, created on first sight (its canvas sized later). */
  const entryFor = (node: ExtensionNodeView): Entry => {
    let entry = entries.get(node);
    if (!entry) {
      const input = textLayoutInput(node);
      entry = {
        canvas: host.createCanvas(1, 1),
        input,
        animated: textHasAnimatedStyle(input),
        lastT: NaN,
        lastW: 0,
        lastH: 0,
      };
      entries.set(node, entry);
    }
    return entry;
  };

  return {
    measure(node, drawTime) {
      const entry = entryFor(node);
      const t = Math.max(0, drawTime);
      const last = entry.measured;
      // Static text measures once; animated text again when its time moves.
      if (last && (!entry.animated || Math.abs(t - last.t) < 0.001)) {
        return { width: last.width, height: last.height };
      }
      const size = measureText(entry.input, t);
      entry.measured = { t, ...size };
      return size;
    },

    draw(node, drawTime, width, height): CanvasLike | null {
      const W = Math.max(1, Math.round(width));
      const H = Math.max(1, Math.round(height));
      const t = Math.max(0, drawTime);

      const entry = entryFor(node);
      if (
        entry.lastW === W &&
        entry.lastH === H &&
        // Static text never changes with time; animated text is skipped only
        // when the clock has not moved (~1 ms).
        (entry.animated ? Math.abs(t - entry.lastT) < 0.001 : !Number.isNaN(entry.lastT))
      ) {
        return entry.canvas;
      }

      if (entry.canvas.width !== W || entry.canvas.height !== H) {
        entry.canvas.width = W; // resizing clears the canvas
        entry.canvas.height = H;
      }
      const ctx = entry.canvas.getContext("2d") as OffscreenCanvasRenderingContext2D | null;
      if (!ctx) return null;
      drawTextLayout(ctx, layoutText(entry.input, t, W, H));
      entry.lastT = t;
      entry.lastW = W;
      entry.lastH = H;
      return entry.canvas;
    },

    clear(): void {
      entries = new WeakMap();
    },

    dispose(): void {
      entries = new WeakMap();
    },
  };
}

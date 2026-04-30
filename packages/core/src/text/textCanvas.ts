// Render a TextLayoutResult onto a 2D canvas context. Works with both
// browser OffscreenCanvas and Node node-canvas (when shimmed) — same
// engine that measured the layout also draws it, so glyph positions
// can't drift from the per-fragment x coordinates we computed.

import type { TextLayoutResult } from "./textLayout.js";

type Ctx2D =
  | CanvasRenderingContext2D
  | OffscreenCanvasRenderingContext2D;

/** Draw a text layout into a 2D context. The context is expected to
 *  already point at a surface sized to `layout.width × layout.height`;
 *  this clears it first so animated re-renders start from a clean slate. */
export function drawTextLayout(
  ctx: Ctx2D,
  layout: TextLayoutResult,
): void {
  ctx.clearRect(0, 0, layout.width, layout.height);

  // Pass 1: per-fragment background rects.
  for (const r of layout.rects) {
    ctx.fillStyle = r.fill;
    ctx.fillRect(r.x, r.y, r.width, r.height);
  }

  // Pass 2: glyph fragments. `textBaseline = "alphabetic"` matches the
  // SVG default (the baseline is `glyph.y`). Stroke goes first when
  // present so fill draws on top — same as `paint-order: stroke fill`
  // in SVG land, where the stroke outline frames the glyph.
  ctx.textBaseline = "alphabetic";
  for (const g of layout.glyphs) {
    ctx.font = g.font;
    if (g.stroke && g.strokeWidth > 0) {
      ctx.strokeStyle = g.stroke;
      ctx.lineWidth = g.strokeWidth;
      // `lineJoin = "round"` keeps thick strokes from sprouting spikes
      // at sharp corners — same default visual feel as SVG strokes.
      ctx.lineJoin = "round";
      ctx.miterLimit = 2;
      ctx.strokeText(g.text, g.x, g.y);
    }
    ctx.fillStyle = g.fill;
    ctx.fillText(g.text, g.x, g.y);
  }
}

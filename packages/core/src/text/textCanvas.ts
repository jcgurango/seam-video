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
    // Drive the variable-font `wght` axis explicitly. Browsers infer it from
    // `font-weight`, but @napi-rs/canvas (Skia) ignores the axis and renders our
    // variable CJK fallback at its Thin (100) default for any non-bold weight —
    // so normal CJK came out far too light in the renderer. Setting it to match
    // the font string's weight is a no-op for static faces and for browsers, so
    // both surfaces stay in sync.
    (ctx as { fontVariationSettings?: string }).fontVariationSettings =
      `'wght' ${g.weight}`;
    // `letterHeight` stretches glyphs vertically about the baseline. Scale
    // around `g.y` so the baseline stays put and letters grow up/down.
    const scaled = g.scaleY !== 1;
    if (scaled) {
      ctx.save();
      ctx.translate(0, g.y);
      ctx.scale(1, g.scaleY);
      ctx.translate(0, -g.y);
    }
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
    // Decoration rides the same vertical scale as the glyphs (its `y` is in
    // unscaled baseline-relative space), in the text fill colour.
    if (g.decoration) {
      ctx.fillRect(
        g.x,
        g.decoration.y - g.decoration.thickness / 2,
        g.decoration.width,
        g.decoration.thickness,
      );
    }
    if (scaled) ctx.restore();
  }
}

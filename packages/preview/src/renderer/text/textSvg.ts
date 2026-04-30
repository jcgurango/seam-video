// Render a ResolvedText node to an SVG string. Uses @chenglou/pretext
// for line-breaking and width measurement; the rest is just stamping
// <text>/<tspan>/<rect> elements at the positions Pretext gives us.
//
// Browser-only: Pretext relies on canvas measureText + DOM calibration.
// The renderer (Node-side ffmpeg path) needs a different code path.

import {
  prepareRichInline,
  walkRichInlineLineRanges,
  materializeRichInlineLineRange,
  type RichInlineItem,
  type RichInlineLineRange,
} from "@chenglou/pretext/rich-inline";
import type { ResolvedText, TextRun, TextPadding } from "@seam/core";

const DEFAULT_FONT_FAMILY = "sans-serif";
const DEFAULT_FONT_SIZE = 16;
const DEFAULT_COLOR = "black";

interface PaddingBox {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

function expandPadding(p: TextPadding | undefined): PaddingBox {
  if (p == null) return { top: 0, right: 0, bottom: 0, left: 0 };
  if (typeof p === "number") return { top: p, right: p, bottom: p, left: p };
  if (p.length === 2) return { top: p[0], right: p[1], bottom: p[0], left: p[1] };
  return { top: p[0], right: p[1], bottom: p[2], left: p[3] };
}

function cssFontShorthand(
  run: TextRun,
  defaults: ResolvedText
): string {
  const family = run.fontFamily ?? defaults.fontFamily ?? DEFAULT_FONT_FAMILY;
  const size = run.fontSize ?? defaults.fontSize ?? DEFAULT_FONT_SIZE;
  const weight = run.fontWeight ?? defaults.fontWeight;
  // Family with spaces gets quoted to keep the shorthand parser happy.
  const familyToken = /\s/.test(family) ? `"${family}"` : family;
  return `${weight ? `${weight} ` : ""}${size}px ${familyToken}`;
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function escapeAttr(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
}

interface RunStyle {
  fontFamily: string;
  fontSize: number;
  color: string;
  fontWeight: string | null;
  backgroundColor: string | null;
  backgroundPadding: PaddingBox;
  strokeColor: string | null;
  strokeWidth: number;
}

function resolveRunStyle(run: TextRun, defaults: ResolvedText): RunStyle {
  return {
    fontFamily: run.fontFamily ?? defaults.fontFamily ?? DEFAULT_FONT_FAMILY,
    fontSize: run.fontSize ?? defaults.fontSize ?? DEFAULT_FONT_SIZE,
    color: run.color ?? defaults.color ?? DEFAULT_COLOR,
    fontWeight: run.fontWeight ?? defaults.fontWeight ?? null,
    backgroundColor: run.backgroundColor ?? defaults.backgroundColor ?? null,
    backgroundPadding: expandPadding(
      run.backgroundPadding ?? defaults.backgroundPadding
    ),
    strokeColor: run.strokeColor ?? defaults.strokeColor ?? null,
    strokeWidth: run.strokeWidth ?? defaults.strokeWidth ?? 0,
  };
}

export function textToSvg(node: ResolvedText): string {
  const W = node.contentWidth;
  const H = node.contentHeight;
  const fontSize = node.fontSize ?? DEFAULT_FONT_SIZE;
  const lineHeight = node.lineHeight && node.lineHeight > 0
    ? node.lineHeight
    : Math.round(fontSize * 1.2);

  // Inner box: shrunk from the SVG canvas by `padding` so backgrounds
  // and strokes that hang past the layout extents don't clip the SVG
  // edge. Layout (line wrapping, alignment) operates in this inset
  // rect; we offset the rendered output by (innerX, innerY).
  const pad = expandPadding(node.padding);
  const innerW = Math.max(0, W - pad.left - pad.right);
  const innerH = Math.max(0, H - pad.top - pad.bottom);
  const innerX = pad.left;
  const innerY = pad.top;

  // Pre-resolve each run's style so we can read it cheaply per fragment.
  const styles: RunStyle[] = node.runs.map((run) => resolveRunStyle(run, node));

  // Convert runs to Pretext items. `extraWidth` carries the horizontal
  // padding component so layout math accounts for it.
  const items: RichInlineItem[] = node.runs.map((run, i) => {
    const style = styles[i];
    return {
      text: run.text,
      font: cssFontShorthand(run, node),
      extraWidth: style.backgroundPadding.left + style.backgroundPadding.right,
    };
  });

  const prepared = prepareRichInline(items);
  const rawLines: RichInlineLineRange[] = [];
  walkRichInlineLineRanges(prepared, innerW, (line) => {
    rawLines.push(line);
  });
  const lines = rawLines.map((line) =>
    materializeRichInlineLineRange(prepared, line)
  );

  // Vertical placement, in inner-box coordinates.
  const totalHeight = lines.length * lineHeight;
  const verticalAlign = node.verticalAlign ?? "top";
  let yLineTop: number;
  switch (verticalAlign) {
    case "top":
      yLineTop = innerY;
      break;
    case "center":
      yLineTop = innerY + (innerH - totalHeight) / 2;
      break;
    case "bottom":
      yLineTop = innerY + innerH - totalHeight;
      break;
  }

  const textAlign = node.textAlign ?? "center";
  const parts: string[] = [];

  for (const line of lines) {
    const lineTop = yLineTop;
    yLineTop += lineHeight;
    // Baseline within the line box: place text so the leading goes
    // half above and half below the glyph block, then push to the
    // baseline. ~0.8 × fontSize is a fine approximation.
    const baseline = lineTop + (lineHeight - fontSize) / 2 + fontSize * 0.8;

    let x: number;
    switch (textAlign) {
      case "left":
        x = innerX;
        break;
      case "center":
        x = innerX + (innerW - line.width) / 2;
        break;
      case "right":
        x = innerX + innerW - line.width;
        break;
    }

    // Pass 1: backgrounds. Emit per-fragment rects (we don't try to
    // merge contiguous same-style fragments; per-fragment is simpler
    // and visually identical for most text).
    let bgX = x;
    for (const frag of line.fragments) {
      bgX += frag.gapBefore;
      const style = styles[frag.itemIndex];
      if (style.backgroundColor) {
        const padTop = style.backgroundPadding.top;
        const padBottom = style.backgroundPadding.bottom;
        // Vertical padding hangs above/below the glyph block but does
        // *not* affect line height per the spec.
        const rectY = lineTop + (lineHeight - fontSize) / 2 - padTop;
        const rectH = fontSize + padTop + padBottom;
        parts.push(
          `<rect x="${bgX.toFixed(3)}" y="${rectY.toFixed(3)}" width="${frag.occupiedWidth.toFixed(3)}" height="${rectH.toFixed(3)}" fill="${escapeAttr(style.backgroundColor)}"/>`
        );
      }
      bgX += frag.occupiedWidth;
    }

    // Pass 2: text. Each fragment is its own <text> so per-run styling
    // is straightforward (no shared <text> + per-tspan font shifting).
    let tx = x;
    for (const frag of line.fragments) {
      tx += frag.gapBefore;
      const style = styles[frag.itemIndex];
      const padLeft = style.backgroundPadding.left;
      // Glyphs sit inside the padded fragment; offset by the left
      // padding so the text isn't drawn flush against the rect edge.
      const textX = tx + padLeft;
      const attrs: string[] = [
        `x="${textX.toFixed(3)}"`,
        `y="${baseline.toFixed(3)}"`,
        `font-family="${escapeAttr(style.fontFamily)}"`,
        `font-size="${style.fontSize}"`,
      ];
      if (style.fontWeight) attrs.push(`font-weight="${escapeAttr(style.fontWeight)}"`);
      attrs.push(`fill="${escapeAttr(style.color)}"`);
      if (style.strokeWidth > 0) {
        attrs.push(
          `stroke="${escapeAttr(style.strokeColor ?? "black")}"`,
          `stroke-width="${style.strokeWidth}"`,
          `stroke-opacity="1"`,
          `paint-order="stroke fill markers"`
        );
      }
      parts.push(
        `<text ${attrs.join(" ")}>${escapeXml(frag.text)}</text>`
      );
      tx += frag.occupiedWidth;
    }
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">${parts.join("")}</svg>`;
}

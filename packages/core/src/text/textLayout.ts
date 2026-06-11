// Lay out a ResolvedText node at a given local time. Pure logic — no
// rendering. The output is a list of rects (backgrounds) and glyph
// fragments (text + style) at concrete pixel positions, ready for any
// backend that can draw rects + text. Same module is shared by the
// browser preview (OffscreenCanvas) and the Node renderer (node-canvas)
// so layout and render use the same engine — no measurement drift.
//
// Layout requires a 2D Canvas context for `measureText` (via Pretext).
// In browsers that's automatic; in Node, shim `OffscreenCanvas` with
// node-canvas before importing this module.

import {
  prepareRichInline,
  walkRichInlineLineRanges,
  materializeRichInlineLineRange,
  type RichInlineItem,
  type RichInlineLineRange,
} from "@chenglou/pretext/rich-inline";
import type { ResolvedText } from "../resolved-types.js";
import type { TextRun, TextPadding, Keyframed } from "../types.js";
import {
  isKeyframed,
  sampleNumber,
  sampleColor,
  samplePadding,
} from "../animation/keyframes.js";
import { withFallbackFamilies } from "./fallbackFonts.js";

// Liberation Sans is bundled with the renderer (and should be loaded
// in the browser preview too) so the same layout decisions land on
// every machine. Falling back to "sans-serif" — the OS-default — was
// the prior cause of glyph metric drift between dev/CI/editor.
const DEFAULT_FONT_FAMILY = "Liberation Sans";
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

// Sampler shorthands. Each style field is either a static value or a
// keyframe array; sample at the node-local time `t` against the node's
// duration `d` (used to resolve "%" time expressions).

function sN(v: Keyframed<number> | undefined, d: number, t: number): number | undefined {
  if (v == null) return undefined;
  return sampleNumber(v, t, d);
}

function sC(v: Keyframed<string> | undefined, d: number, t: number): string | undefined {
  if (v == null) return undefined;
  return sampleColor(v, t, d);
}

function sP(v: Keyframed<TextPadding> | undefined, d: number, t: number): TextPadding | undefined {
  if (v == null) return undefined;
  return samplePadding(v, t, d);
}

function cssFontShorthand(
  run: TextRun,
  defaults: ResolvedText,
  duration: number,
  t: number,
): string {
  const family = run.fontFamily ?? defaults.fontFamily ?? DEFAULT_FONT_FAMILY;
  const size = sN(run.fontSize, duration, t)
    ?? sN(defaults.fontSize, duration, t)
    ?? DEFAULT_FONT_SIZE;
  const weight = run.fontWeight ?? defaults.fontWeight;
  // Family with spaces gets quoted to keep the shorthand parser happy.
  // Append the CJK/emoji fallbacks so Pretext *measures* against the same
  // fonts the draw pass renders — otherwise CJK/emoji measure as tofu and
  // line-breaking / fragment widths drift from the drawn glyphs.
  const familyToken = withFallbackFamilies(
    /\s/.test(family) ? `"${family}"` : family,
  );
  return `${weight ? `${weight} ` : ""}${size}px ${familyToken}`;
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

function resolveRunStyle(
  run: TextRun,
  defaults: ResolvedText,
  duration: number,
  t: number,
): RunStyle {
  return {
    fontFamily: run.fontFamily ?? defaults.fontFamily ?? DEFAULT_FONT_FAMILY,
    fontSize: sN(run.fontSize, duration, t)
      ?? sN(defaults.fontSize, duration, t)
      ?? DEFAULT_FONT_SIZE,
    color: sC(run.color, duration, t)
      ?? sC(defaults.color, duration, t)
      ?? DEFAULT_COLOR,
    fontWeight: run.fontWeight ?? defaults.fontWeight ?? null,
    backgroundColor: sC(run.backgroundColor, duration, t)
      ?? sC(defaults.backgroundColor, duration, t)
      ?? null,
    backgroundPadding: expandPadding(
      sP(run.backgroundPadding, duration, t)
        ?? sP(defaults.backgroundPadding, duration, t)
    ),
    strokeColor: sC(run.strokeColor, duration, t)
      ?? sC(defaults.strokeColor, duration, t)
      ?? null,
    strokeWidth: sN(run.strokeWidth, duration, t)
      ?? sN(defaults.strokeWidth, duration, t)
      ?? 0,
  };
}

/** True when any text-style field on the node or its runs is animated.
 *  Lets the rasteriser skip per-frame regeneration when the text is static. */
export function textHasAnimatedStyle(node: ResolvedText): boolean {
  const styleKeys = [
    "fontSize", "color", "backgroundColor", "backgroundPadding",
    "strokeColor", "strokeWidth", "lineHeight",
  ] as const;
  const obj = node as unknown as Record<string, unknown>;
  for (const k of styleKeys) {
    if (isKeyframed(obj[k] as never)) return true;
  }
  for (const run of node.runs) {
    const ro = run as unknown as Record<string, unknown>;
    for (const k of styleKeys) {
      if (isKeyframed(ro[k] as never)) return true;
    }
  }
  return false;
}

export interface TextRect {
  x: number;
  y: number;
  width: number;
  height: number;
  fill: string;
}

export interface TextGlyph {
  /** x in canvas pixels, where text starts (post-padding inset). */
  x: number;
  /** Baseline y, for `textBaseline = "alphabetic"`. */
  y: number;
  text: string;
  /** CSS font shorthand suitable for `ctx.font` ("bold 16px sans-serif"). */
  font: string;
  fill: string;
  /** Stroke is drawn first when present (mimics SVG `paint-order: stroke fill`). */
  stroke: string | null;
  strokeWidth: number;
}

export interface TextLayoutResult {
  /** SVG/canvas extents (matches `node.contentWidth/Height`). */
  width: number;
  height: number;
  /** Background rects, drawn before glyphs. */
  rects: TextRect[];
  /** Text fragments, drawn after rects. */
  glyphs: TextGlyph[];
}

/** Produce a backend-agnostic layout for a ResolvedText at node-local
 *  time `t` (seconds since the node became active). The values returned
 *  are in the SVG canvas's coordinate space (origin top-left). */
export function layoutText(node: ResolvedText, t: number = 0): TextLayoutResult {
  // contentWidth/Height are widened to Length on the resolved-types so
  // they can carry the authored value through the resolve pass. The
  // spatial pass collapses them to pixel numbers before layout runs.
  const W = node.contentWidth as number;
  const H = node.contentHeight as number;
  const duration = node.timelineEnd - node.timelineStart;
  const fontSize = sN(node.fontSize, duration, t) ?? DEFAULT_FONT_SIZE;
  const lineHeightSampled = sN(node.lineHeight, duration, t);
  const lineHeight = lineHeightSampled && lineHeightSampled > 0
    ? lineHeightSampled
    : Math.round(fontSize * 1.2);

  // Inner box: shrunk from the canvas by `padding` so backgrounds and
  // strokes hanging past the layout extents don't clip the canvas edge.
  const pad = expandPadding(node.padding);
  const innerW = Math.max(0, W - pad.left - pad.right);
  const innerH = Math.max(0, H - pad.top - pad.bottom);
  const innerX = pad.left;
  const innerY = pad.top;

  // Pre-resolve each run's style so we can read it cheaply per fragment.
  const styles: RunStyle[] = node.runs.map((run) => resolveRunStyle(run, node, duration, t));

  // Split runs by "\n" into paragraphs. Pretext's rich-inline API
  // collapses all whitespace (including `\n`) into spaces, so to
  // honour hard breaks we lay out each paragraph independently and
  // stack their lines. Each piece keeps a back-pointer to its source
  // run so fragment styles still resolve through the original
  // `styles[runIndex]` lookup.
  type Piece = { runIndex: number; text: string };
  const paragraphs: Piece[][] = [[]];
  for (let i = 0; i < node.runs.length; i++) {
    const parts = node.runs[i].text.split("\n");
    for (let p = 0; p < parts.length; p++) {
      if (p > 0) paragraphs.push([]);
      if (parts[p].length > 0) {
        paragraphs[paragraphs.length - 1].push({ runIndex: i, text: parts[p] });
      }
    }
  }

  const lines: ReturnType<typeof materializeRichInlineLineRange>[] = [];
  const EMPTY_CURSOR = { itemIndex: 0, segmentIndex: 0, graphemeIndex: 0 };
  for (const paragraph of paragraphs) {
    if (paragraph.length === 0) {
      // Hard break with no text in between — one blank line of vertical
      // space, no fragments to render.
      lines.push({ fragments: [], width: 0, end: EMPTY_CURSOR });
      continue;
    }
    const items: RichInlineItem[] = paragraph.map((piece) => {
      const style = styles[piece.runIndex];
      return {
        text: piece.text,
        font: cssFontShorthand(node.runs[piece.runIndex], node, duration, t),
        extraWidth: style.backgroundPadding.left + style.backgroundPadding.right,
      };
    });
    const prepared = prepareRichInline(items);
    const ranges: RichInlineLineRange[] = [];
    walkRichInlineLineRanges(prepared, innerW, (range) => {
      ranges.push(range);
    });
    for (const range of ranges) {
      const materialized = materializeRichInlineLineRange(prepared, range);
      // Rewrite each fragment's per-paragraph `itemIndex` to the
      // global run index so the outer style lookup keeps working.
      for (const frag of materialized.fragments) {
        (frag as { itemIndex: number }).itemIndex =
          paragraph[frag.itemIndex].runIndex;
      }
      lines.push(materialized);
    }
  }

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
  const rects: TextRect[] = [];
  const glyphs: TextGlyph[] = [];

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

    // Pass 1: backgrounds. One rect per fragment (we don't merge
    // contiguous same-style fragments; per-fragment is simpler and
    // visually identical for most text).
    let bgX = x;
    for (const frag of line.fragments) {
      bgX += frag.gapBefore;
      const style = styles[frag.itemIndex];
      if (style.backgroundColor) {
        const padTop = style.backgroundPadding.top;
        const padBottom = style.backgroundPadding.bottom;
        // Vertical padding hangs above/below the glyph block but does
        // *not* affect line height.
        const rectY = lineTop + (lineHeight - fontSize) / 2 - padTop;
        const rectH = fontSize + padTop + padBottom;
        rects.push({
          x: bgX,
          y: rectY,
          width: frag.occupiedWidth,
          height: rectH,
          fill: style.backgroundColor,
        });
      }
      bgX += frag.occupiedWidth;
    }

    // Pass 2: glyph fragments. One entry per fragment so each can carry
    // its own font/colour/stroke without sharing state.
    let tx = x;
    for (const frag of line.fragments) {
      tx += frag.gapBefore;
      const style = styles[frag.itemIndex];
      const padLeft = style.backgroundPadding.left;
      // Glyphs sit inside the padded fragment; offset by the left
      // padding so the text isn't drawn flush against the rect edge.
      const textX = tx + padLeft;
      const fontWeight = style.fontWeight;
      const familyToken = withFallbackFamilies(
        /\s/.test(style.fontFamily)
          ? `"${style.fontFamily}"`
          : style.fontFamily,
      );
      const font = `${fontWeight ? `${fontWeight} ` : ""}${style.fontSize}px ${familyToken}`;
      glyphs.push({
        x: textX,
        y: baseline,
        text: frag.text,
        font,
        fill: style.color,
        stroke: style.strokeWidth > 0 ? (style.strokeColor ?? "black") : null,
        strokeWidth: style.strokeWidth,
      });
      tx += frag.occupiedWidth;
    }
  }

  return { width: W as number, height: H as number, rects, glyphs };
}

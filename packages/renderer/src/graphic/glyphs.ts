// Local SDF glyph generation for the native maplibre renderer.
//
// @maplibre/maplibre-gl-native has no local-font path (unlike maplibre-gl
// in the browser, which can rasterize labels itself with TinySDF). It only
// knows how to fetch `{fontstack}/{range}.pbf` glyph PBFs over the request
// callback. So to drop the external glyph server we synthesize those PBFs
// on the fly from the bundled Liberation Sans, using the exact same TinySDF
// algorithm + metric calibration maplibre-gl uses for its own local glyphs
// (see glyph_manager.ts `_drawGlyph`). That keeps CLI renders metrically
// consistent with the preview, which renders the same labels locally.
//
// CJK (and anything Liberation lacks) falls through Skia's system font
// fallback when the glyph is drawn to canvas — i.e. "whatever's installed",
// which is acceptable for our use case.

import TinySDF from "@mapbox/tiny-sdf";
import { createCanvas } from "@napi-rs/canvas";
import { withFallbackFamilies } from "@seam/core";
import { installFonts, LIBERATION_SANS_FAMILY } from "../text/fonts.js";

// TinySDF picks OffscreenCanvas / document.createElement by default; neither
// exists in node, so back it with @napi-rs/canvas (Skia), which the renderer
// already uses for text rasterization. The bundled fonts are registered
// there via installFonts(). Map labels are single-channel SDF, so emoji
// come through as monochrome silhouettes (the colour COLR table is lost
// when TinySDF reads the alpha channel) — same as the browser map.
class NodeTinySDF extends TinySDF {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  _createCanvas(size: number): any {
    return createCanvas(size, size);
  }
}

// Generation parameters. buffer/radius/cutoff match maplibre's shader
// expectations for server glyphs (SDF_PX = 8, GLYPH_PBF_BORDER = 3) and
// fontnik's defaults, so the SDFs read correctly in the native renderer.
const FONT_SIZE = 24;
const BUFFER = 3;
const RADIUS = 8;
const CUTOFF = 0.25;

// Calibration constants copied from maplibre-gl's glyph_manager `_drawGlyph`.
// TinySDF's "top" is the baseline-to-glyph-top distance; server (fontnik)
// glyphs measure "top" from an origin above the em box. These adjustments
// translate TinySDF metrics into the server convention the native renderer
// consumes — and, because maplibre-gl applies the identical adjustment to
// its local glyphs, keep CLI and preview labels aligned.
const TOP_ADJUSTMENT = 27.5;
const LEFT_ADJUSTMENT = 0.5;

interface EncodedGlyph {
  id: number;
  bitmap: Uint8Array;
  width: number;
  height: number;
  left: number;
  top: number;
  advance: number;
}

interface Variant {
  weight: "normal" | "bold";
  style: "normal" | "italic";
}

/** Pick the Liberation Sans variant for a requested font stack. The stack
 *  name (e.g. "Noto Sans Bold") only tells us weight/style — we always
 *  render with Liberation Sans (Skia falls back per-glyph for scripts it
 *  lacks). */
function variantFromStack(fontstack: string): Variant {
  const s = fontstack.toLowerCase();
  return {
    weight: /bold|semibold|black|heavy/.test(s) ? "bold" : "normal",
    style: /italic|oblique/.test(s) ? "italic" : "normal",
  };
}

const sdfCache = new Map<string, NodeTinySDF>();

function getSdf(v: Variant): NodeTinySDF {
  const key = `${v.weight}|${v.style}`;
  let sdf = sdfCache.get(key);
  if (!sdf) {
    sdf = new NodeTinySDF({
      fontSize: FONT_SIZE,
      buffer: BUFFER,
      radius: RADIUS,
      cutoff: CUTOFF,
      fontFamily: withFallbackFamilies(LIBERATION_SANS_FAMILY),
      fontWeight: v.weight,
      fontStyle: v.style,
    });
    sdfCache.set(key, sdf);
  }
  return sdf;
}

/** C0/C1 control codepoints and surrogates: invisible and/or unrepresentable
 *  as a string the Skia text API will accept (it throws on NUL/controls). */
function isUnprintable(id: number): boolean {
  return (
    id <= 0x1f ||
    (id >= 0x7f && id <= 0x9f) ||
    (id >= 0xd800 && id <= 0xdfff)
  );
}

function drawGlyph(sdf: NodeTinySDF, id: number): EncodedGlyph | null {
  if (isUnprintable(id)) return null;
  let char: string;
  try {
    char = String.fromCodePoint(id);
  } catch {
    return null;
  }
  let g: ReturnType<TinySDF["draw"]>;
  try {
    g = sdf.draw(char);
  } catch {
    // Skia rejects the odd codepoint (unpaired surrogate, etc.) — skip it.
    return null;
  }
  const advance = Math.round(g.glyphAdvance);
  const hasInk = g.glyphWidth > 0 && g.glyphHeight > 0;
  if (!hasInk) {
    // Whitespace / nonspacing — emit metrics with an empty bitmap so the
    // shaper still advances (skip truly-absent, zero-advance codepoints).
    if (advance <= 0) return null;
    return { id, bitmap: new Uint8Array(0), width: 0, height: 0, left: 0, top: 0, advance };
  }
  return {
    id,
    bitmap: Uint8Array.from(g.data),
    width: Math.round(g.glyphWidth),
    height: Math.round(g.glyphHeight),
    left: Math.round(g.glyphLeft + LEFT_ADJUSTMENT),
    top: Math.round(g.glyphTop - TOP_ADJUSTMENT),
    advance,
  };
}

// Generated ranges are cached by variant + range (the font is always
// Liberation Sans, so the requested stack name is irrelevant beyond
// weight/style). Native maplibre also caches per-map, but several map
// instances each hold their own request callback, so dedupe here too.
const rangeCache = new Map<string, Uint8Array>();

/** Build a glyph-range PBF (the `{fontstack}/{range}.pbf` payload) for the
 *  given codepoint window [start, end] from Liberation Sans. `start`/`end`
 *  are the inclusive 256-codepoint range bounds maplibre requests. */
export function generateGlyphRangePBF(
  fontstack: string,
  start: number,
  end: number,
): Uint8Array {
  installFonts();
  const variant = variantFromStack(fontstack);
  const cacheKey = `${variant.weight}|${variant.style}|${start}-${end}`;
  const cached = rangeCache.get(cacheKey);
  if (cached) return cached;

  const sdf = getSdf(variant);
  const glyphs: EncodedGlyph[] = [];
  for (let id = start; id <= end; id++) {
    const glyph = drawGlyph(sdf, id);
    if (glyph) glyphs.push(glyph);
  }
  const pbf = encodeGlyphsPBF(fontstack, `${start}-${end}`, glyphs);
  rangeCache.set(cacheKey, pbf);
  return pbf;
}

// ── Minimal protobuf encoder for the glyphs message ─────────────────
//
// glyphs.proto (Mapbox/MapLibre SDF glyph format):
//   message glyph    { uint32 id=1; bytes bitmap=2; uint32 width=3;
//                      uint32 height=4; sint32 left=5; sint32 top=6;
//                      uint32 advance=7; }
//   message fontstack{ string name=1; string range=2; repeated glyph=3; }
//   message glyphs   { repeated fontstack stacks=1; }

const WIRE_VARINT = 0;
const WIRE_BYTES = 2;

function writeVarint(out: number[], value: number): void {
  // Codepoint ids can exceed 2^31, so step with division rather than >>>.
  let v = value;
  while (v > 0x7f) {
    out.push((v & 0x7f) | 0x80);
    v = Math.floor(v / 128);
  }
  out.push(v & 0x7f);
}

function writeTag(out: number[], field: number, wire: number): void {
  writeVarint(out, field * 8 + wire);
}

function writeVarintField(out: number[], field: number, value: number): void {
  writeTag(out, field, WIRE_VARINT);
  writeVarint(out, value);
}

function writeSint32Field(out: number[], field: number, value: number): void {
  writeTag(out, field, WIRE_VARINT);
  // zigzag encode so small negatives stay small
  writeVarint(out, ((value << 1) ^ (value >> 31)) >>> 0);
}

function writeBytesField(
  out: number[],
  field: number,
  bytes: ArrayLike<number>,
): void {
  writeTag(out, field, WIRE_BYTES);
  writeVarint(out, bytes.length);
  for (let i = 0; i < bytes.length; i++) out.push(bytes[i]);
}

function writeStringField(out: number[], field: number, str: string): void {
  writeBytesField(out, field, new TextEncoder().encode(str));
}

function encodeGlyph(g: EncodedGlyph): number[] {
  const out: number[] = [];
  writeVarintField(out, 1, g.id);
  if (g.bitmap.length) writeBytesField(out, 2, g.bitmap);
  writeVarintField(out, 3, g.width);
  writeVarintField(out, 4, g.height);
  writeSint32Field(out, 5, g.left);
  writeSint32Field(out, 6, g.top);
  writeVarintField(out, 7, g.advance);
  return out;
}

function encodeGlyphsPBF(
  name: string,
  range: string,
  glyphs: EncodedGlyph[],
): Uint8Array {
  const fontstack: number[] = [];
  writeStringField(fontstack, 1, name);
  writeStringField(fontstack, 2, range);
  for (const g of glyphs) writeBytesField(fontstack, 3, encodeGlyph(g));

  const top: number[] = [];
  writeBytesField(top, 1, fontstack);
  return Uint8Array.from(top);
}

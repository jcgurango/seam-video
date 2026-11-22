// Mapbox-GL style evaluation, headless. Uses @maplibre/maplibre-gl-style-spec
// (no WebGL) for filters + property expressions, so the bundled OSM Bright
// style's legacy filters, {base,stops} functions, and modern expressions all
// "just work". Pure: no canvas, no I/O.

import {
  featureFilter,
  normalizePropertyExpression,
  v8 as styleSpec,
} from "@maplibre/maplibre-gl-style-spec";
import { withFallbackFamilies } from "@seam/core";

// The bundled body font; map labels resolve to its weight/style variants plus
// the CJK + emoji fallbacks (registered by each host). Matches the renderer's
// LIBERATION_SANS_FAMILY and the preview's mapLabelFontStack.
const LABEL_BASE_FAMILY = "Liberation Sans";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyLayer = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Evaluator = (globals: any, feature: any) => any;

export { featureFilter };

/** Build an evaluator for a paint/layout property value (constant, legacy
 *  {stops} function, or expression) against its spec. `specKey` is the
 *  style-spec section, e.g. "paint_fill", "layout_symbol". Falls back to a
 *  constant on failure. */
export function makeEvaluator(
  specKey: string,
  prop: string,
  value: unknown,
  fallback: unknown,
): Evaluator {
  if (value === undefined) return () => fallback;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const spec = (styleSpec as any)[specKey]?.[prop];
  if (!spec) return () => value ?? fallback;
  let expr: { evaluate: Evaluator };
  try {
    // normalizePropertyExpression handles all three legacy/modern forms.
    expr = normalizePropertyExpression(value, spec);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(`[map] ${specKey}/${prop} expr error`, err);
    return () => fallback;
  }
  return (globals, feature) => {
    try {
      return expr.evaluate(globals, feature);
    } catch {
      return fallback;
    }
  };
}

export function paintEvaluator(
  layerType: string,
  prop: string,
  value: unknown,
  fallback: unknown,
): Evaluator {
  return makeEvaluator(`paint_${layerType}`, prop, value, fallback);
}

/** maplibre Color → canvas-ready rgba() string. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function colorToCss(c: any): string {
  if (c == null) return "rgba(0,0,0,0)";
  if (typeof c === "string") return c;
  if (typeof c.toString === "function" && c.r !== undefined) return c.toString();
  return String(c);
}

/** Resolve a legacy token text-field ("{name:latin}\n{name:nonlatin}") against
 *  a feature's properties → lines (newline-split, tokens substituted, empties
 *  and exact duplicates dropped). Non-string (expression) fields yield []. */
export function resolveTextField(
  field: unknown,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  props: Record<string, any>,
): string[] {
  if (typeof field !== "string") return [];
  const raw = field.replace(/\{([^}]+)\}/g, (_, key: string) => {
    const v = props[key];
    return v === undefined || v === null ? "" : String(v);
  });
  const lines: string[] = [];
  for (const line of raw.split("\n")) {
    const t = line.trim();
    if (t && !lines.includes(t)) lines.push(t);
  }
  return lines;
}

/** Build a canvas font string from a layer's text-font + size. The original
 *  font names (e.g. "Noto Sans Bold") only convey weight/style — we derive
 *  those as CSS keywords and resolve against the single base family, which
 *  both hosts register with all four faces (regular/bold/italic/bolditalic)
 *  under one name. Then append the CJK + emoji fallbacks for per-glyph
 *  coverage. No per-glyph shaping — the comma-list lets the rasterizer
 *  (Cairo/Skia or the browser) fall back for kanji etc. */
export function buildLabelFont(textFont: unknown, size: number): string {
  const stack = Array.isArray(textFont) ? textFont.join(" ").toLowerCase() : "";
  const bold = /bold|semibold|black|heavy|medium/.test(stack);
  const italic = /italic|oblique/.test(stack);
  const families = withFallbackFamilies(`"${LABEL_BASE_FAMILY}"`);
  return `${italic ? "italic " : ""}${bold ? "bold " : ""}${size}px ${families}`;
}

export function clamp01(v: unknown): number {
  const n = typeof v === "number" ? v : 1;
  return n < 0 ? 0 : n > 1 ? 1 : n;
}

export function clampNum(v: unknown, fallback: number): number {
  return typeof v === "number" && isFinite(v) ? v : fallback;
}

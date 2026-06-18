// Map themes. "light" is the bundled OSM Bright style verbatim. "dark" is
// derived from it by an HSL color transform (no second style JSON to maintain)
// — a dark basemap with a purple cast: near-black purple land, dark indigo
// water, muted lavender roads, light-lavender labels with dark halos.
//
// Only color paint properties are touched; geometry, widths, dashes, fonts,
// and layer structure are untouched. The transform handles the three value
// forms OSM Bright uses: constant color strings, legacy {stops:[[z,color]]}
// functions, and (defensively) color literals inside expression arrays.

export type MapTheme = "light" | "dark";

const PURPLE_H = 280;

interface HSLA {
  h: number; // 0..360
  s: number; // 0..1
  l: number; // 0..1
  a: number; // 0..1
}

/** Return the style for a theme. "light" is the input untouched; "dark" is a
 *  deep-cloned, color-transformed copy. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function applyTheme(style: any, theme: MapTheme): any {
  if (theme !== "dark") return style;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const out = JSON.parse(JSON.stringify(style)) as any;
  for (const layer of out.layers ?? []) {
    const paint = layer.paint;
    if (!paint) continue;
    const water = isWater(layer);
    mapProp(paint, "background-color", (c) => fillColor(c, false));
    mapProp(paint, "fill-color", (c) => fillColor(c, water));
    mapProp(paint, "fill-outline-color", (c) => fillColor(c, water));
    mapProp(paint, "line-color", (c) => lineColor(c, water));
    mapProp(paint, "text-color", textColor);
    mapProp(paint, "text-halo-color", haloColor);
  }
  return out;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function isWater(layer: any): boolean {
  const sl = layer["source-layer"];
  if (sl === "water" || sl === "waterway") return true;
  return /water|ocean|river|lake/i.test(String(layer.id ?? ""));
}

// ── per-role color transforms (operate in HSL) ──────────────────────

function fillColor(c: HSLA, water: boolean): HSLA {
  if (water) {
    return {
      h: lerpHue(c.h, 250, 0.45), // keep an indigo lean
      s: clamp(0.28 + c.s * 0.2, 0, 0.55),
      l: clamp(0.14 + (1 - c.l) * 0.05, 0.1, 0.22),
      a: c.a,
    };
  }
  return {
    h: lerpHue(c.h, PURPLE_H, 0.75),
    s: clamp(0.22 + c.s * 0.15, 0, 0.45),
    l: clamp(0.105 + (1 - c.l) * 0.06, 0.07, 0.2),
    a: c.a,
  };
}

function lineColor(c: HSLA, water: boolean): HSLA {
  if (water) {
    return { h: lerpHue(c.h, 250, 0.4), s: clamp(c.s * 0.7 + 0.1, 0, 0.5), l: clamp(0.35 + c.l * 0.2, 0.25, 0.6), a: c.a };
  }
  // Keep roads readable on the dark base: lift to a mid lightness (preserving
  // the casing<fill ordering via the origin lightness), dim saturation, and
  // tint subtly purple. White casings → lavender-gray; amber majors stay warm.
  return {
    h: lerpHue(c.h, PURPLE_H, 0.15),
    s: clamp(c.s * 0.7, 0, 0.5),
    l: clamp(0.28 + c.l * 0.28, 0.18, 0.72),
    a: c.a,
  };
}

function textColor(c: HSLA): HSLA {
  return {
    h: lerpHue(c.h, PURPLE_H, 0.3),
    s: clamp(0.05 + c.s * 0.4, 0, 0.35),
    l: clamp(0.72 + (1 - c.l) * 0.18, 0.7, 0.95),
    a: c.a,
  };
}

function haloColor(c: HSLA): HSLA {
  // Light text needs a dark halo to read; ignore the (usually white) original.
  return { h: PURPLE_H, s: 0.25, l: 0.08, a: c.a };
}

// ── value-form walker ───────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function mapProp(paint: any, key: string, fn: (c: HSLA) => HSLA): void {
  if (paint[key] === undefined) return;
  paint[key] = mapColorValue(paint[key], fn);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function mapColorValue(value: any, fn: (c: HSLA) => HSLA): any {
  if (typeof value === "string") {
    const c = parseColor(value);
    return c ? hslaToCss(fn(c)) : value;
  }
  if (Array.isArray(value)) {
    return value.map((v) => mapColorValue(v, fn));
  }
  if (value && typeof value === "object" && Array.isArray(value.stops)) {
    return {
      ...value,
      stops: value.stops.map((s: [number, unknown]) => [s[0], mapColorValue(s[1], fn)]),
    };
  }
  return value;
}

// ── color parsing / HSL ─────────────────────────────────────────────

function parseColor(str: string): HSLA | null {
  const s = str.trim().toLowerCase();
  let m: RegExpExecArray | null;
  if ((m = /^#([0-9a-f]{3,8})$/.exec(s))) {
    const hex = m[1];
    const exp =
      hex.length === 3 || hex.length === 4
        ? hex.split("").map((ch) => ch + ch).join("")
        : hex;
    const r = parseInt(exp.slice(0, 2), 16);
    const g = parseInt(exp.slice(2, 4), 16);
    const b = parseInt(exp.slice(4, 6), 16);
    const a = exp.length === 8 ? parseInt(exp.slice(6, 8), 16) / 255 : 1;
    return rgbToHsl(r, g, b, a);
  }
  if ((m = /^rgba?\(([^)]+)\)$/.exec(s))) {
    const p = m[1].split(",").map((x) => x.trim());
    const r = num(p[0]), g = num(p[1]), b = num(p[2]);
    const a = p[3] !== undefined ? num(p[3]) : 1;
    return rgbToHsl(r, g, b, a);
  }
  if ((m = /^hsla?\(([^)]+)\)$/.exec(s))) {
    const p = m[1].split(",").map((x) => x.trim());
    const h = num(p[0]);
    const sv = num(p[1]) / 100;
    const l = num(p[2]) / 100;
    const a = p[3] !== undefined ? num(p[3]) : 1;
    return { h: ((h % 360) + 360) % 360, s: sv, l, a };
  }
  return null;
}

function num(s: string): number {
  return parseFloat(s.replace("%", ""));
}

function rgbToHsl(r: number, g: number, b: number, a: number): HSLA {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const l = (max + min) / 2;
  let h = 0, s = 0;
  const d = max - min;
  if (d !== 0) {
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    switch (max) {
      case r: h = (g - b) / d + (g < b ? 6 : 0); break;
      case g: h = (b - r) / d + 2; break;
      default: h = (r - g) / d + 4; break;
    }
    h *= 60;
  }
  return { h, s, l, a };
}

function hslaToCss(c: HSLA): string {
  const { r, g, b } = hslToRgb(c.h, c.s, c.l);
  const a = Math.round(c.a * 1000) / 1000;
  return `rgba(${r}, ${g}, ${b}, ${a})`;
}

function hslToRgb(h: number, s: number, l: number): { r: number; g: number; b: number } {
  h = ((h % 360) + 360) % 360 / 360;
  let r: number, g: number, b: number;
  if (s === 0) {
    r = g = b = l;
  } else {
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    r = hue2rgb(p, q, h + 1 / 3);
    g = hue2rgb(p, q, h);
    b = hue2rgb(p, q, h - 1 / 3);
  }
  return { r: Math.round(r * 255), g: Math.round(g * 255), b: Math.round(b * 255) };
}

function hue2rgb(p: number, q: number, t: number): number {
  if (t < 0) t += 1;
  if (t > 1) t -= 1;
  if (t < 1 / 6) return p + (q - p) * 6 * t;
  if (t < 1 / 2) return q;
  if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
  return p;
}

function lerpHue(a: number, b: number, t: number): number {
  const d = ((b - a + 540) % 360) - 180;
  return ((a + d * t) % 360 + 360) % 360;
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

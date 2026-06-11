// Browser-side counterpart to the renderer's `installFonts()`.
// Loads the same four Liberation Sans TTFs that the Node renderer uses
// via the FontFace API, so preview and final render share metrics
// (without depending on whatever `sans-serif` happens to mean on the
// host machine).
//
// The `?url` suffix tells Vite to emit each TTF as a hashed asset and
// hand back its URL, which then lands on the document via FontFace.
// Idempotent — safe to call from multiple app entry points.

import regularUrl from "./fonts/LiberationSans-Regular.ttf?url";
import boldUrl from "./fonts/LiberationSans-Bold.ttf?url";
import italicUrl from "./fonts/LiberationSans-Italic.ttf?url";
import boldItalicUrl from "./fonts/LiberationSans-BoldItalic.ttf?url";
import notoCjkUrl from "./fonts/NotoSans-CJK-JP.ttf?url";
import openmojiUrl from "./fonts/OpenMoji.ttf?url";
import { CJK_FALLBACK_FAMILY, EMOJI_FALLBACK_FAMILY } from "@seam/core";

const FAMILY = "Liberation Sans";

interface Variant {
  url: string;
  weight: string;
  style: "normal" | "italic";
}

const VARIANTS: Variant[] = [
  { url: regularUrl, weight: "normal", style: "normal" },
  { url: boldUrl, weight: "bold", style: "normal" },
  { url: italicUrl, weight: "normal", style: "italic" },
  { url: boldItalicUrl, weight: "bold", style: "italic" },
];

let promise: Promise<void> | null = null;

export function loadLiberationSans(): Promise<void> {
  if (promise) return promise;
  promise = (async () => {
    const faces = VARIANTS.map((v) =>
      new FontFace(FAMILY, `url(${v.url})`, {
        weight: v.weight,
        style: v.style,
      }).load(),
    );
    const loaded = await Promise.all(faces);
    for (const face of loaded) document.fonts.add(face);
  })();
  return promise;
}

// ── Fallback fonts (CJK + emoji) ───────────────────────────────────
//
// Registered under the same family names @seam/core appends to every
// font string (text nodes, graphic text, map labels). With these in
// document.fonts, the browser falls back per-glyph to the bundled fonts
// instead of whatever the host has — so CJK and emoji match the renderer
// (emoji render in colour here via the browser's COLR/SVG support). The
// CJK file is a large variable font, so this is fire-and-forget: text
// drawn before it resolves reflows once it loads, same as any web font.

let fallbackPromise: Promise<void> | null = null;

export function loadFallbackFonts(): Promise<void> {
  if (fallbackPromise) return fallbackPromise;
  fallbackPromise = (async () => {
    const faces = await Promise.all([
      new FontFace(CJK_FALLBACK_FAMILY, `url(${notoCjkUrl})`).load(),
      new FontFace(EMOJI_FALLBACK_FAMILY, `url(${openmojiUrl})`).load(),
    ]);
    for (const face of faces) document.fonts.add(face);
  })();
  return fallbackPromise;
}

// ── Map label fonts ────────────────────────────────────────────────
//
// With no `glyphs` URL on the style, maplibre-gl rasterizes every label
// locally via TinySDF, using the layer's `text-font` name as the CSS font
// family (and sniffing bold/italic out of that name). It does NOT consult
// the weight/style descriptors of a FontFace — only the family name. So to
// force Liberation Sans (rather than the host's `sans-serif`) we register a
// distinct family per variant whose NAME carries the weight/style, and
// rewrite each layer's `text-font` to the matching name (see
// `mapLabelFontStack`). These names mirror what the native renderer
// resolves server-side, keeping preview and final render consistent.

/** The `text-font` stack to use for a given style layer's original stack.
 *  The original names (e.g. "Noto Sans Bold") only tell us weight/style; we
 *  map to the matching Liberation Sans variant, then append the CJK + emoji
 *  fallbacks so maplibre's TinySDF (which builds a CSS family list from this
 *  stack) falls back per-glyph just like text nodes do. */
export function mapLabelFontStack(stack: string[] | string): string[] {
  const s = (Array.isArray(stack) ? stack.join(" ") : stack).toLowerCase();
  const bold = /bold|semibold|black|heavy/.test(s);
  const italic = /italic|oblique/.test(s);
  let family = "Liberation Sans";
  if (bold) family += " Bold";
  if (italic) family += " Italic";
  return [family, CJK_FALLBACK_FAMILY, EMOJI_FALLBACK_FAMILY];
}

interface AliasFace {
  family: string;
  url: string;
  descriptors: FontFaceDescriptors;
}

// Per-variant alias families. Each carries the weight/style descriptor that
// matches the request maplibre's TinySDF makes (bold/italic sniffed from the
// family name), so the browser doesn't synthesize faux-bold/italic on top of
// an already-bold/italic TTF.
const MAP_LABEL_FACES: AliasFace[] = [
  { family: "Liberation Sans Bold", url: boldUrl, descriptors: { weight: "bold" } },
  { family: "Liberation Sans Italic", url: italicUrl, descriptors: { style: "italic" } },
  {
    family: "Liberation Sans Bold Italic",
    url: boldItalicUrl,
    descriptors: { weight: "bold", style: "italic" },
  },
];

let mapLabelPromise: Promise<void> | null = null;

/** Register the Liberation Sans alias families used by map labels. Includes
 *  the base regular family via loadLiberationSans(). Idempotent. */
export function loadMapLabelFonts(): Promise<void> {
  if (mapLabelPromise) return mapLabelPromise;
  mapLabelPromise = (async () => {
    await Promise.all([loadLiberationSans(), loadFallbackFonts()]);
    const faces = MAP_LABEL_FACES.map((f) =>
      new FontFace(f.family, `url(${f.url})`, f.descriptors).load(),
    );
    const loaded = await Promise.all(faces);
    for (const face of loaded) document.fonts.add(face);
  })();
  return mapLabelPromise;
}

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
// ol-mapbox-style renders labels with canvas text (no glyph PBFs). It runs
// each layer's `text-font` through mapbox-to-css-font, which splits the
// weight/style keywords off the END of the name — so "Liberation Sans Bold"
// becomes `bold …px "Liberation Sans"`. That resolves against the base
// "Liberation Sans" family with real weight/style faces (loadLiberationSans),
// then falls through per-glyph to the CJK + emoji families — same chain as
// text nodes, and no font CDN fetch since they're all in document.fonts.

/** The `text-font` stack to substitute for a style layer's original stack.
 *  The original names (e.g. "Noto Sans Bold") only convey weight/style; we
 *  map to the matching Liberation Sans variant name (mapbox-to-css-font then
 *  re-derives the weight/style from it) and append the CJK + emoji fallbacks
 *  for per-glyph coverage. */
export function mapLabelFontStack(stack: string[] | string): string[] {
  const s = (Array.isArray(stack) ? stack.join(" ") : stack).toLowerCase();
  const bold = /bold|semibold|black|heavy/.test(s);
  const italic = /italic|oblique/.test(s);
  let family = "Liberation Sans";
  if (bold) family += " Bold";
  if (italic) family += " Italic";
  return [family, CJK_FALLBACK_FAMILY, EMOJI_FALLBACK_FAMILY];
}

let mapLabelPromise: Promise<void> | null = null;

/** Ensure the families map labels resolve to are in document.fonts: the
 *  Liberation Sans weight/style faces plus the CJK + emoji fallbacks.
 *  Idempotent. */
export function loadMapLabelFonts(): Promise<void> {
  if (mapLabelPromise) return mapLabelPromise;
  mapLabelPromise = Promise.all([
    loadLiberationSans(),
    loadFallbackFonts(),
  ]).then(() => undefined);
  return mapLabelPromise;
}

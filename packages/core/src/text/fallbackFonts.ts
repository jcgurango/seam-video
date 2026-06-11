// Shared font-fallback definitions. These family names are the single
// source of truth: the renderer registers TTFs under exactly these names
// (@napi-rs/canvas + node-canvas), the browser preview/editor register
// matching FontFaces, and every `ctx.font` string (text nodes, graphic
// text, map labels) appends them after the primary family. That way an
// emoji or CJK glyph the primary font lacks falls through to the same
// bundled font on every surface — renderer and preview alike.
//
// V1 ships the Japanese CJK variant (Noto Sans CJK JP) and OpenMoji.
// CJK is monochrome outlines (consistent everywhere); emoji render in
// colour wherever the backend supports COLR/SVG (text nodes + all of
// preview), and as monochrome silhouettes where it doesn't (map SDF, and
// the node-canvas graphic export).

export const CJK_FALLBACK_FAMILY = "Noto Sans CJK JP";
export const EMOJI_FALLBACK_FAMILY = "OpenMoji";

/** Fallback families, in priority order, appended after any primary font. */
export const FALLBACK_FONT_FAMILIES = [
  CJK_FALLBACK_FAMILY,
  EMOJI_FALLBACK_FAMILY,
] as const;

/** Quote a family name for a CSS `font` string if it contains whitespace. */
function quoteFamily(family: string): string {
  return /\s/.test(family) ? `"${family}"` : family;
}

/** Build a CSS font-family list: the primary family followed by the CJK +
 *  emoji fallbacks. Skips a fallback already present (e.g. a node that
 *  authored `OpenMoji` directly) so we never duplicate. Accepts either a
 *  single family or an existing comma list as the primary. */
export function withFallbackFamilies(primary: string): string {
  const present = new Set(
    primary
      .split(",")
      .map((f) => f.trim().replace(/^["']|["']$/g, "").toLowerCase()),
  );
  const extra = FALLBACK_FONT_FAMILIES.filter(
    (f) => !present.has(f.toLowerCase()),
  ).map(quoteFamily);
  return extra.length ? `${primary}, ${extra.join(", ")}` : primary;
}

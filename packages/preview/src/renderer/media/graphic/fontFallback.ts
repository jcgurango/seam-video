// Graphic-text font fallback for the browser preview (fabric browser build).
//
// Mirrors the renderer's fontFallback.ts: patch FabricText so every font
// declaration it builds — measuring and drawing — appends the CJK + emoji
// fallback families after the authored family. fabric passes a comma-list
// `fontFamily` through verbatim, so the browser falls back per-glyph. The
// actual TTFs are registered via fonts.ts's `loadFallbackFonts` (document.
// fonts); here we only ensure fabric asks for them.

import { FabricText } from "fabric";
import { withFallbackFamilies } from "@seam/core";

let patched = false;

/** Patch fabric's font declaration so graphic text falls back to CJK/emoji.
 *  Idempotent; call once before any graphic renders. */
export function installGraphicFontFallback(): void {
  if (patched) return;
  patched = true;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const proto: any = (FabricText as any)?.prototype;
  if (!proto || proto.__seamFallbackPatched) return;
  const orig = proto._getFontDeclaration;
  if (typeof orig !== "function") return;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  proto._getFontDeclaration = function (style: any, forMeasuring?: boolean) {
    const s = style ?? {};
    const base = s.fontFamily ?? this.fontFamily;
    if (!base) return orig.call(this, style, forMeasuring);
    return orig.call(
      this,
      { ...s, fontFamily: withFallbackFamilies(base) },
      forMeasuring,
    );
  };
  proto.__seamFallbackPatched = true;
}

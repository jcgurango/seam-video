// Graphic-text font fallback for the renderer (fabric/node → node-canvas).
//
// Two halves:
//   1. Register the bundled TTFs with node-canvas (Cairo's own registry,
//      separate from @napi-rs/canvas).
//   2. Patch FabricText so every font declaration it builds — for both
//      measuring and drawing — appends the CJK + emoji fallback families
//      after the authored family. fabric passes a comma-list `fontFamily`
//      through verbatim (it only quotes single names), so the canvas does
//      per-glyph fallback. Centralizing it here means we don't have to walk
//      every text node in the graphic tree, and measurement stays in sync
//      with rendering (fabric caches widths from the same declaration).
//
// Cairo can't rasterize colour fonts, so emoji here are monochrome — see
// fonts.ts. CJK matches the preview.

import { FabricText } from "fabric/node";
import { withFallbackFamilies } from "@seam/core";
import { registerNodeCanvasFonts } from "../text/fonts.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function patchFontDeclaration(TextClass: any): void {
  const proto = TextClass?.prototype;
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

let installed = false;

/** Register fonts with node-canvas and patch fabric's font declaration so
 *  graphic text falls back to CJK/emoji. Idempotent; call before any
 *  graphic is rasterized. */
export function installGraphicFontFallback(): void {
  if (installed) return;
  installed = true;
  registerNodeCanvasFonts();
  patchFontDeclaration(FabricText);
}

// Bundle Liberation Sans (a metric-compatible Helvetica/Arial clone)
// as the renderer's default font, so output is identical regardless
// of which system fonts happen to be installed. Without this, every
// host machine resolves "sans-serif" to whatever the OS picked, and
// glyph metrics drift between dev laptop, CI, and the editor user.
//
// The TTFs live next to this file at build time and inside `dist/`
// at run time — `import.meta.url` walks back from either to the
// `fonts/liberation-sans/` directory shipped with the package.

import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { GlobalFonts } from "@napi-rs/canvas";

export const LIBERATION_SANS_FAMILY = "Liberation Sans";

interface FontVariant {
  file: string;
  weight: string;
  style: "normal" | "italic";
}

const VARIANTS: FontVariant[] = [
  { file: "LiberationSans-Regular.ttf", weight: "normal", style: "normal" },
  { file: "LiberationSans-Bold.ttf", weight: "bold", style: "normal" },
  { file: "LiberationSans-Italic.ttf", weight: "normal", style: "italic" },
  { file: "LiberationSans-BoldItalic.ttf", weight: "bold", style: "italic" },
];

let installed = false;

/** Register the bundled Liberation Sans TTFs with @napi-rs/canvas's
 *  global font set. Idempotent — safe to call from multiple entry
 *  points. Must run before any text rasterization. */
export function installLiberationSans(): void {
  if (installed) return;
  installed = true;

  // Source layout: this file is `packages/renderer/src/text/fonts.ts`,
  // fonts live at `packages/renderer/fonts/liberation-sans/`.
  // Built layout: this file is `packages/renderer/dist/text/fonts.js`,
  // fonts live at the same `packages/renderer/fonts/liberation-sans/`.
  // Both resolve to the same place by walking up two directories.
  const here = dirname(fileURLToPath(import.meta.url));
  const fontsDir = resolve(here, "..", "..", "fonts", "liberation-sans");

  for (const v of VARIANTS) {
    const path = resolve(fontsDir, v.file);
    GlobalFonts.registerFromPath(path, LIBERATION_SANS_FAMILY);
  }
}

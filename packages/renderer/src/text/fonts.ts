// Bundle the renderer's fonts so output is identical regardless of which
// system fonts happen to be installed:
//   - Liberation Sans (metric-compatible Helvetica/Arial clone) as the
//     default body font;
//   - Noto Sans CJK JP + OpenMoji as universal CJK / emoji fallbacks
//     (see @seam/core's fallbackFonts — the family names must match).
//
// Two font systems consume these:
//   - @napi-rs/canvas (Skia) `GlobalFonts` drives text-node rasterization
//     — and renders OpenMoji in colour via its COLR table.
//   - node-canvas (Cairo) backs fabric/node for graphic rendering and has
//     its OWN registry, so the same TTFs must be registered there too
//     (`registerNodeCanvasFonts`). Cairo can't do colour fonts, so emoji
//     in graphic exports come out as monochrome silhouettes — a known V1
//     limitation; everything else matches the browser preview.
//
// The TTFs live at `packages/renderer/fonts/**`, reachable from either
// `src/` or `dist/` by walking up two directories.

import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { GlobalFonts } from "@napi-rs/canvas";
import { registerFont } from "canvas";
import {
  CJK_FALLBACK_FAMILY,
  EMOJI_FALLBACK_FAMILY,
} from "@seam/core";

export const LIBERATION_SANS_FAMILY = "Liberation Sans";

interface FontFile {
  /** Path relative to the package `fonts/` dir. */
  file: string;
  family: string;
}

// Every face we register, under the family name used in font strings.
// Weight/style are read from each TTF's own metadata by the canvas libs.
const FONT_FILES: FontFile[] = [
  { file: "liberation-sans/LiberationSans-Regular.ttf", family: LIBERATION_SANS_FAMILY },
  { file: "liberation-sans/LiberationSans-Bold.ttf", family: LIBERATION_SANS_FAMILY },
  { file: "liberation-sans/LiberationSans-Italic.ttf", family: LIBERATION_SANS_FAMILY },
  { file: "liberation-sans/LiberationSans-BoldItalic.ttf", family: LIBERATION_SANS_FAMILY },
  { file: "noto-cjk-jp/NotoSans-CJK-JP.ttf", family: CJK_FALLBACK_FAMILY },
  { file: "openmoji/OpenMoji.ttf", family: EMOJI_FALLBACK_FAMILY },
];

function fontsDir(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "fonts");
}

let skiaInstalled = false;

/** Register the bundled fonts with @napi-rs/canvas's global font set
 *  (text-node rasterization + map TinySDF). Idempotent — safe to call from
 *  multiple entry points. Must run before any text rasterization. */
export function installFonts(): void {
  if (skiaInstalled) return;
  skiaInstalled = true;
  const dir = fontsDir();
  for (const f of FONT_FILES) {
    GlobalFonts.registerFromPath(resolve(dir, f.file), f.family);
  }
}

let nodeCanvasInstalled = false;

/** Register the bundled fonts with node-canvas (Cairo), which backs
 *  fabric/node for graphic rendering. Separate registry from @napi-rs's,
 *  so this must run before any graphic is rasterized. Idempotent. */
export function registerNodeCanvasFonts(): void {
  if (nodeCanvasInstalled) return;
  nodeCanvasInstalled = true;
  const dir = fontsDir();
  for (const f of FONT_FILES) {
    registerFont(resolve(dir, f.file), { family: f.family });
  }
}

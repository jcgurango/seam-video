// HTML → SVG via satori. Pure-JS wrapper used by both the editor preview
// (renders the SVG inline) and the FFmpeg renderer (rasterizes via resvg).
//
// Font loading is intentionally NOT done here so the package stays neutral
// to its host environment. Use the companion entries:
//
//   import { loadDefaultFonts } from "@seam/html-renderer/node-fonts";
//   import { loadDefaultFonts } from "@seam/html-renderer/browser-fonts";

import satori, { type Font } from "satori";
import { html as satoriHtml } from "satori-html";

export interface HtmlToSvgOptions {
  fonts: Font[];
}

export async function htmlToSvg(
  source: string,
  width: number,
  height: number,
  opts: HtmlToSvgOptions
): Promise<string> {
  if (!opts.fonts || opts.fonts.length === 0) {
    throw new Error(
      "htmlToSvg: at least one font is required. Use loadDefaultFonts() from " +
        "@seam/html-renderer/node-fonts or /browser-fonts."
    );
  }
  // satori-html returns its own VNode structure; satori accepts it but its
  // typings are JSX/ReactNode-shaped, so cast at the boundary.
  const tree = satoriHtml(source) as unknown as Parameters<typeof satori>[0];
  return await satori(tree, { width, height, fonts: opts.fonts });
}

export type { Font } from "satori";

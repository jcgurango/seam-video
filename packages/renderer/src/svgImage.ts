/**
 * SVG statics rasterize through node-canvas (Cairo + librsvg), not Skia's
 * `loadImage`: @napi-rs/canvas's SVG path silently drops embedded
 * `<image href="data:…">` content (a comment-card export keeps its avatar
 * there), while librsvg renders images, text and clip paths. Fonts come from
 * the same node-canvas registrations the graphic path uses
 * (`registerNodeCanvasFonts`). Intrinsic size = the SVG's width/height, the
 * size the preview's <img> path rasterizes at too.
 */
import { createCanvas as createCairoCanvas, loadImage as loadCairoImage } from "canvas";
import { registerNodeCanvasFonts } from "./text/fonts.js";

export async function rasterizeSvg(
  pathOrUrl: string,
): Promise<{ data: Uint8ClampedArray; width: number; height: number }> {
  registerNodeCanvasFonts();
  const img = await loadCairoImage(pathOrUrl);
  const width = img.naturalWidth || img.width;
  const height = img.naturalHeight || img.height;
  if (!width || !height) throw new Error(`SVG "${pathOrUrl}" has no intrinsic size`);
  const canvas = createCairoCanvas(width, height);
  const ctx = canvas.getContext("2d");
  ctx.drawImage(img, 0, 0, width, height);
  const id = ctx.getImageData(0, 0, width, height);
  return { data: id.data, width, height };
}

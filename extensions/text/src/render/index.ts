// `@seam/extension-text/render` — the Text extension WITH its rasterizer,
// for hosts that draw (the preview, the renderer, the editor), plus the
// layout engine itself for extensions that set text of their own (Captions).
//
// Layout needs a 2D canvas for `measureText` (through Pretext): automatic in
// a browser; in Node the host installs an `OffscreenCanvas` shim and its
// fonts before the first draw.

import type { NodeTypeDef, SeamExtension } from "@seam/core";
import { text as pureText, textNode as pureTextNode } from "../index.js";
import { createTextRasterizer } from "./rasterizer.js";

export * from "../index.js";
export { createTextRasterizer, textLayoutInput } from "./rasterizer.js";
export { drawTextLayout } from "./textCanvas.js";
export {
  layoutText,
  measureText,
  textHasAnimatedStyle,
  type TextGlyph,
  type TextLayoutInput,
  type TextLayoutResult,
  type TextRect,
} from "./textLayout.js";

/** `text` with its rasterizer attached. */
export const textNode: NodeTypeDef = { ...pureTextNode, rasterizer: createTextRasterizer };

/** The Text extension, able to draw. */
export const text: SeamExtension = { ...pureText, nodes: [textNode] };

export default text;

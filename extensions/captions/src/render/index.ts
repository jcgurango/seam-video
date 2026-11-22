// `@seam/extension-captions/render` — the Captions extension WITH its overlay
// renderer, for hosts that draw (the preview, the editor, the renderer /
// CLI). Pure consumers use `@seam/extension-captions`.

import type { SeamExtension } from "@seam/core";
import { captions as pureCaptions, captionsOverlay } from "../index.js";
import { createCaptionsRasterizer } from "./rasterizer.js";

export { createCaptionsRasterizer } from "./rasterizer.js";
export * from "../index.js";

/** The Captions extension with its overlay renderer attached. */
export const captions: SeamExtension = {
  ...pureCaptions,
  overlays: [{ ...captionsOverlay, rasterizer: createCaptionsRasterizer }],
};

export default captions;

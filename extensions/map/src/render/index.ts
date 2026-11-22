// `@seam/extension-map/render` — the Map extension WITH its rasterizer, for
// hosts that draw (the preview, the editor, the renderer / CLI). Pure
// consumers (validate / resolve / lay out) use `@seam/extension-map`, which
// never loads pmtiles, the vector-tile decoder or the style evaluator.

import type { SeamExtension } from "@seam/core";
import { map as pureMap, mapNode } from "../index.js";
import { createMapRasterizer } from "./rasterizer.js";

export { createMapRasterizer } from "./rasterizer.js";
export {
  TileSource,
  TileSourcePool,
  type TileProvider,
  type DecodedTile,
  type HeaderInfo,
} from "./tile-source.js";
export { drawBasemap, drawPaths, type MapPathInput } from "./rasterize.js";
export { applyTheme } from "./theme.js";
export { buildLabelFont } from "./style.js";
export * from "../index.js";

/** The Map extension with its rasterizer attached. */
export const map: SeamExtension = {
  ...pureMap,
  nodes: [{ ...mapNode, rasterizer: createMapRasterizer }],
};

export default map;

import { createSeam } from "@seam/core";
import { adjustments } from "@seam/extension-adjustments";
// The render entry: Captions WITH its overlay renderer.
import { captions } from "@seam/extension-captions/render";
// The render entry: the Map extension WITH its rasterizer (this host draws).
import { map } from "@seam/extension-map/render";

/** The CLI's Seam instance: core plus the extensions this host installs.
 *  Every command validates / compiles / resolves / renders through it. */
export const seam = createSeam([adjustments, map, captions]);

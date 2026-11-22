import { createSeam } from "@seam/core";
import { adjustments } from "@seam/extension-adjustments";
// The render entry: Captions WITH its overlay renderer.
import { captions } from "@seam/extension-captions/render";
// The render entry: the Map extension WITH its rasterizer (this host draws).
import { map } from "@seam/extension-map/render";

/** The preview app's Seam instance: core plus the extensions this host installs.
 *  Shared by the main process (validate / compile / resolve) and the
 *  renderer process (the compositor's shader is built for this extension set). */
export const seam = createSeam([adjustments, map, captions]);

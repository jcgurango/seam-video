import { createSeam } from "@seam/core";
import { adjustments } from "@seam/extension-adjustments";

/** The preview app's Seam instance: core plus the extensions this host installs.
 *  Shared by the main process (validate / compile / resolve) and the
 *  renderer process (the compositor's shader is built for this extension set). */
export const seam = createSeam([adjustments]);

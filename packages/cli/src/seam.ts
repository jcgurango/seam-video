import { createSeam } from "@seam/core";
import { adjustments } from "@seam/extension-adjustments";

/** The CLI's Seam instance: core plus the extensions this host installs.
 *  Every command validates / compiles / resolves / renders through it. */
export const seam = createSeam([adjustments]);

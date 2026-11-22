import { ElectronPlatform } from "./electron.js";
import { WebPlatform } from "./web.js";
import type { Platform } from "./types.js";
import type { Seam } from "@seam/core";

export type { Platform, PlatformKind, ActionName, OpenResult } from "./types.js";
export { ElectronPlatform } from "./electron.js";
export { WebPlatform } from "./web.js";

/**
 * Auto-detect which platform to use. If `window.seamApi` is present (Electron
 * preload bridge), use ElectronPlatform; otherwise assume we're in a browser
 * and use WebPlatform.
 */
export function detectPlatform(seam: Seam): Platform {
  if (typeof window !== "undefined" && (window as any).seamApi) {
    return new ElectronPlatform(seam);
  }
  return new WebPlatform(seam);
}

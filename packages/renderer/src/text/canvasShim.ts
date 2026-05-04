// Pretext (and our textLayout) reaches for `OffscreenCanvas` for
// `measureText`. Browsers have it natively; Node doesn't. We polyfill it
// with @napi-rs/canvas so the same layout code can run server-side and
// produce identical line-break decisions to the browser preview.
//
// Also bundles Liberation Sans as the default font so output is
// metric-stable across machines (host fonts no longer leak into the
// render).
//
// Idempotent: callable from any entry point that needs text rasterization.

import { createCanvas } from "@napi-rs/canvas";
import { installLiberationSans } from "./fonts.js";

let installed = false;

export function installCanvasShim(): void {
  if (installed) return;
  installed = true;
  installLiberationSans();
  if (typeof (globalThis as { OffscreenCanvas?: unknown }).OffscreenCanvas === "undefined") {
    // Pretext only calls `new OffscreenCanvas(w, h).getContext('2d')` and
    // then `measureText`. @napi-rs/canvas's `Canvas` exposes a
    // browser-compatible context, so a thin constructor proxy is enough.
    (globalThis as { OffscreenCanvas?: unknown }).OffscreenCanvas =
      class OffscreenCanvas {
        constructor(w: number, h: number) {
          return createCanvas(w, h) as unknown as OffscreenCanvas;
        }
      };
  }
}

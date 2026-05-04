// Browser-side counterpart to the renderer's `installLiberationSans()`.
// Loads the same four Liberation Sans TTFs that the Node renderer uses
// via the FontFace API, so preview and final render share metrics
// (without depending on whatever `sans-serif` happens to mean on the
// host machine).
//
// The `?url` suffix tells Vite to emit each TTF as a hashed asset and
// hand back its URL, which then lands on the document via FontFace.
// Idempotent — safe to call from multiple app entry points.

import regularUrl from "./fonts/LiberationSans-Regular.ttf?url";
import boldUrl from "./fonts/LiberationSans-Bold.ttf?url";
import italicUrl from "./fonts/LiberationSans-Italic.ttf?url";
import boldItalicUrl from "./fonts/LiberationSans-BoldItalic.ttf?url";

const FAMILY = "Liberation Sans";

interface Variant {
  url: string;
  weight: string;
  style: "normal" | "italic";
}

const VARIANTS: Variant[] = [
  { url: regularUrl, weight: "normal", style: "normal" },
  { url: boldUrl, weight: "bold", style: "normal" },
  { url: italicUrl, weight: "normal", style: "italic" },
  { url: boldItalicUrl, weight: "bold", style: "italic" },
];

let promise: Promise<void> | null = null;

export function loadLiberationSans(): Promise<void> {
  if (promise) return promise;
  promise = (async () => {
    const faces = VARIANTS.map((v) =>
      new FontFace(FAMILY, `url(${v.url})`, {
        weight: v.weight,
        style: v.style,
      }).load(),
    );
    const loaded = await Promise.all(faces);
    for (const face of loaded) document.fonts.add(face);
  })();
  return promise;
}

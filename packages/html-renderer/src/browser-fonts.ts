// Browser/Vite loader for the bundled Liberation Sans family. The four
// `new URL(..., import.meta.url)` references are the pattern Vite recognises
// when scanning node_modules, so the TTFs get emitted as bundled assets and
// these end up as fetchable URLs at runtime.

import type { Font } from "satori";

const REGULAR_URL = new URL(
  "../assets/LiberationSans-Regular.ttf",
  import.meta.url
);
const BOLD_URL = new URL(
  "../assets/LiberationSans-Bold.ttf",
  import.meta.url
);
const ITALIC_URL = new URL(
  "../assets/LiberationSans-Italic.ttf",
  import.meta.url
);
const BOLD_ITALIC_URL = new URL(
  "../assets/LiberationSans-BoldItalic.ttf",
  import.meta.url
);

interface FontSpec {
  url: URL;
  weight: 400 | 700;
  style: "normal" | "italic";
}

const FAMILY = "Liberation Sans";

const SPECS: FontSpec[] = [
  { url: REGULAR_URL, weight: 400, style: "normal" },
  { url: BOLD_URL, weight: 700, style: "normal" },
  { url: ITALIC_URL, weight: 400, style: "italic" },
  { url: BOLD_ITALIC_URL, weight: 700, style: "italic" },
];

let cached: Promise<Font[]> | null = null;

export function loadDefaultFonts(): Promise<Font[]> {
  if (!cached) {
    cached = Promise.all(
      SPECS.map(async (spec): Promise<Font> => {
        const res = await fetch(spec.url.href);
        if (!res.ok) {
          throw new Error(
            `Failed to fetch ${spec.url.href}: ${res.status} ${res.statusText}`
          );
        }
        const data = await res.arrayBuffer();
        return { name: FAMILY, data, weight: spec.weight, style: spec.style };
      })
    );
  }
  return cached;
}

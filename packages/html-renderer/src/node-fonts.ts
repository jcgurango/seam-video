// Node-only loader for the bundled Liberation Sans family. The renderer
// CLI uses this to feed satori without going to the network.

import { readFile } from "node:fs/promises";
import type { Font } from "satori";

const ASSETS_DIR = new URL("../assets/", import.meta.url);

interface FontSpec {
  file: string;
  weight: 400 | 700;
  style: "normal" | "italic";
}

const FAMILY = "Liberation Sans";

const SPECS: FontSpec[] = [
  { file: "LiberationSans-Regular.ttf", weight: 400, style: "normal" },
  { file: "LiberationSans-Bold.ttf", weight: 700, style: "normal" },
  { file: "LiberationSans-Italic.ttf", weight: 400, style: "italic" },
  { file: "LiberationSans-BoldItalic.ttf", weight: 700, style: "italic" },
];

let cached: Promise<Font[]> | null = null;

export function loadDefaultFonts(): Promise<Font[]> {
  if (!cached) {
    cached = Promise.all(
      SPECS.map(async (spec): Promise<Font> => {
        const buf = await readFile(new URL(spec.file, ASSETS_DIR));
        return {
          name: FAMILY,
          data: buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
          weight: spec.weight,
          style: spec.style,
        };
      })
    );
  }
  return cached;
}

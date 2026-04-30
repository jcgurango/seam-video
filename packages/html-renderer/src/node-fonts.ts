// Node-only loader for the bundled Liberation Sans family. The renderer
// CLI uses this to feed satori without going to the network. Also
// initialises satori's yoga WASM (the standalone build needs an explicit
// init() call before any rendering happens).

import { readFile } from "node:fs/promises";
import { init as initYoga, type Font } from "@jcgurango/satori/standalone";

const ASSETS_DIR = new URL("../assets/", import.meta.url);
const YOGA_WASM_URL = new URL("yoga.wasm", ASSETS_DIR);

let yogaInitPromise: Promise<void> | null = null;
function ensureYoga(): Promise<void> {
  if (!yogaInitPromise) {
    yogaInitPromise = (async () => {
      const buf = await readFile(YOGA_WASM_URL);
      const ab = buf.buffer.slice(
        buf.byteOffset,
        buf.byteOffset + buf.byteLength
      );
      await initYoga(ab);
    })();
  }
  return yogaInitPromise;
}

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
    cached = (async () => {
      // satori's standalone bundle needs yoga's WASM loaded before any
      // render call; we kick that off in parallel with reading the font
      // files.
      const [, ...fonts] = await Promise.all<Font | void>([
        ensureYoga(),
        ...SPECS.map(async (spec): Promise<Font> => {
          const buf = await readFile(new URL(spec.file, ASSETS_DIR));
          return {
            name: FAMILY,
            data: buf.buffer.slice(
              buf.byteOffset,
              buf.byteOffset + buf.byteLength
            ),
            weight: spec.weight,
            style: spec.style,
          };
        }),
      ]);
      return fonts as Font[];
    })();
  }
  return cached;
}

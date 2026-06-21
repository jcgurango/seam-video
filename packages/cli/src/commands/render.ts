import { resolve } from "node:path";
import { renderSeamToFile, QUALITY_PRESETS, type QualityPreset } from "@seam/renderer";

interface RenderOptions {
  output?: string;
  fps?: string;
  width?: string;
  height?: string;
  quality?: string;
  proxy?: string[];
}

/** Validate the `--quality` value against the known presets. */
function parseQuality(value: string | undefined): QualityPreset | undefined {
  if (value == null) return undefined;
  if (value in QUALITY_PRESETS) return value as QualityPreset;
  throw new Error(
    `Invalid --quality "${value}": expected one of ${Object.keys(QUALITY_PRESETS).join(", ")}.`,
  );
}

/** Parse `--proxy ORIGINAL:REPLACEMENT` strings (split on the first ':')
 *  into an exact-match source→replacement map. */
function parseProxies(specs: string[] | undefined): Map<string, string> {
  const map = new Map<string, string>();
  for (const spec of specs ?? []) {
    const sep = spec.indexOf(":");
    if (sep <= 0 || sep === spec.length - 1) {
      throw new Error(
        `Invalid --proxy "${spec}": expected ORIGINAL:REPLACEMENT (split on the first ':').`,
      );
    }
    map.set(spec.slice(0, sep), spec.slice(sep + 1));
  }
  return map;
}

export async function renderCommand(file: string, options: RenderOptions) {
  const filePath = resolve(file);
  const fps = options.fps ? parseInt(options.fps, 10) : 30;
  const outputPath = options.output ?? filePath.replace(/\.seam$/, ".mp4");

  try {
    const proxies = parseProxies(options.proxy);
    const quality = parseQuality(options.quality);
    const res = await renderSeamToFile(filePath, outputPath, {
      fps,
      width: options.width ? parseInt(options.width, 10) : undefined,
      height: options.height ? parseInt(options.height, 10) : undefined,
      quality,
      proxies,
      onProgress: (f, total) => {
        if (process.stderr.isTTY) {
          process.stderr.write(`\r  frame ${f}/${total}\x1b[K`);
        }
      },
    });
    if (process.stderr.isTTY) process.stderr.write("\n");
    console.log(
      `Done → ${res.output} (${res.frames} frames, ${res.duration.toFixed(1)}s, ${res.width}×${res.height})`,
    );
  } catch (err) {
    console.error(
      `\nRender failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    process.exit(1);
  }
}

import { resolve } from "node:path";
import {
  renderSeamToFile,
  QUALITY_PRESETS,
  type AgcOptions,
  type QualityPreset,
} from "@seam/renderer";

interface RenderOptions {
  output?: string;
  fps?: string;
  width?: string;
  height?: string;
  quality?: string;
  proxy?: string[];
  /** `--agc` → true; `--agc -16` → "-16". */
  agc?: boolean | string;
}

/** Parse `--agc [lufs]`: bare = platform defaults (−14 LUFS / −1 dBTP), a
 *  number overrides the integrated target. */
function parseAgc(value: boolean | string | undefined): AgcOptions | undefined {
  if (value == null || value === false) return undefined;
  if (value === true) return {};
  const target = Number(value);
  if (!Number.isFinite(target) || target > -5 || target < -40) {
    throw new Error(`Invalid --agc "${value}": expected a loudness target in LUFS between -40 and -5 (e.g. -14).`);
  }
  return { targetLufs: target };
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
    const agc = parseAgc(options.agc);
    const res = await renderSeamToFile(filePath, outputPath, {
      fps,
      width: options.width ? parseInt(options.width, 10) : undefined,
      height: options.height ? parseInt(options.height, 10) : undefined,
      quality,
      proxies,
      agc,
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
    if (res.loudness) {
      const l = res.loudness;
      const db = (x: number, unit: string) => (Number.isFinite(x) ? `${x.toFixed(1)} ${unit}` : "silence");
      console.log(
        `AGC: ${db(l.inputLufs, "LUFS")} → ${db(l.outputLufs, "LUFS")} integrated, ` +
          `true peak ${db(l.inputTruePeakDbtp, "dBTP")} → ${db(l.outputTruePeakDbtp, "dBTP")}; ` +
          `rider ${l.riderMinDb >= 0 ? "+" : ""}${l.riderMinDb.toFixed(1)}…${l.riderMaxDb >= 0 ? "+" : ""}${l.riderMaxDb.toFixed(1)} dB, ` +
          `trim ${l.trimDb >= 0 ? "+" : ""}${l.trimDb.toFixed(1)} dB, limiter ${l.limiterReductionDb.toFixed(1)} dB`,
      );
    } else if (agc) {
      console.log("AGC: no audio in this render.");
    }
  } catch (err) {
    console.error(
      `\nRender failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    process.exit(1);
  }
}

import { readFileSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { parseSeamFile, resolveComposition, resolveSpatial } from "@seam/core";
import {
  buildFfmpegArgs,
  buildFfmpegCommand,
  checkFfmpeg,
  rasterizeAllText,
  renderWithFfmpeg,
} from "@seam/renderer";

interface RenderOptions {
  output?: string;
  fps?: string;
  width?: string;
  height?: string;
  dryRun?: boolean;
}

/** Quote an argv element for safe display as a shell command. */
function shellQuote(arg: string): string {
  if (arg === "") return "''";
  if (/^[A-Za-z0-9_./:=,@%+-]+$/.test(arg)) return arg;
  return `'${arg.replace(/'/g, "'\\''")}'`;
}

export async function renderCommand(file: string, options: RenderOptions) {
  const filePath = resolve(file);
  const fps = options.fps ? parseInt(options.fps, 10) : 30;
  const dryRun = !!options.dryRun;

  if (!dryRun) checkFfmpeg();

  const json = readFileSync(filePath, "utf-8");
  const result = parseSeamFile(json);
  if (!result.success) {
    console.error("Validation errors:");
    for (const err of result.errors) {
      console.error(`  - ${err}`);
    }
    process.exit(1);
  }

  const temporal = resolveComposition(result.data);

  const width = options.width ? parseInt(options.width, 10) : (temporal.contentWidth ?? 1920);
  const height = options.height ? parseInt(options.height, 10) : (temporal.contentHeight ?? 1080);
  const timeline = resolveSpatial(temporal, width, height);
  const outputPath = options.output ?? filePath.replace(/\.seam$/, ".mp4");
  const basePath = dirname(filePath);

  // Sidecar dir holds the filter_complex script we hand to ffmpeg via
  // -filter_complex_script. The filter goes through a file so we don't
  // trip Windows' 8191-char argv limit on non-trivial compositions.
  // Cleaned up after success or failure unless --dry-run is set.
  const assetsDir = `${filePath}-rendered`;
  await mkdir(assetsDir, { recursive: true });
  const filterScriptPath = join(assetsDir, "filter.txt");

  try {
    // Rasterize text nodes to PNGs in the assets dir before building
    // the filter graph. Static text → one PNG; animated text → a
    // numbered sequence at the output fps.
    const textDir = join(assetsDir, "text");
    const textRasters = await rasterizeAllText(timeline, textDir, fps);

    const command = buildFfmpegCommand(timeline, outputPath, {
      fps,
      width,
      height,
      basePath,
      textRasters,
    });

    if (dryRun) {
      // Write the filter file too so the printed command can actually
      // run as-is.
      await writeFile(filterScriptPath, command.filterComplex, "utf-8");
      const args = buildFfmpegArgs(command, { filterScriptPath });
      console.log("# dry run — would invoke:");
      console.log(["ffmpeg", ...args].map(shellQuote).join(" "));
      console.log(`\n# assets left in: ${assetsDir}`);
      return;
    }

    console.log(`Rendering to ${outputPath}...`);
    const renderResult = await renderWithFfmpeg(command, outputPath, {
      filterScriptPath,
    });

    if (renderResult.success) {
      console.log(`Done in ${renderResult.duration.toFixed(1)}s → ${outputPath}`);
    } else {
      // ffmpeg's stderr was streamed live as it ran, so we don't repeat it.
      console.error(`\nffmpeg failed (exited after ${renderResult.duration.toFixed(1)}s).`);
      process.exit(1);
    }
  } finally {
    if (!dryRun) {
      try {
        await rm(assetsDir, { recursive: true, force: true });
      } catch {
        // Best-effort cleanup; if the dir doesn't exist anymore that's fine.
      }
    }
  }
}

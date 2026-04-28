import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { parseSeamFile, resolveComposition, resolveSpatial } from "@seam/core";
import {
  buildFfmpegArgs,
  buildFfmpegCommand,
  checkFfmpeg,
  cleanupHtmlAssets,
  prerenderHtmlAssets,
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
  const width = options.width ? parseInt(options.width, 10) : 1920;
  const height = options.height ? parseInt(options.height, 10) : 1080;
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
  const timeline = resolveSpatial(temporal, width, height);
  const outputPath = options.output ?? filePath.replace(/\.seam$/, ".mp4");
  const basePath = dirname(filePath);

  // Pre-render any html nodes to PNGs in a sidecar dir; cleaned up at the end
  // regardless of success so we don't leave stale assets behind. With
  // --dry-run we keep the dir so it can be inspected (and the printed
  // ffmpeg command can be run manually).
  const assetsDir = `${filePath}-rendered`;
  const htmlAssets = await prerenderHtmlAssets(timeline, assetsDir);

  try {
    const command = buildFfmpegCommand(timeline, outputPath, {
      fps,
      width,
      height,
      basePath,
      htmlAssets: htmlAssets.byNode,
    });

    if (dryRun) {
      const args = buildFfmpegArgs(command);
      console.log("# dry run — would invoke:");
      console.log(["ffmpeg", ...args].map(shellQuote).join(" "));
      if (htmlAssets.byNode.size > 0) {
        console.log(`\n# html assets left in: ${assetsDir}`);
      }
      return;
    }

    console.log(`Rendering to ${outputPath}...`);
    const renderResult = await renderWithFfmpeg(command, outputPath);

    if (renderResult.success) {
      console.log(`Done in ${renderResult.duration.toFixed(1)}s → ${outputPath}`);
    } else {
      console.error("ffmpeg failed:");
      console.error(renderResult.stderr);
      process.exit(1);
    }
  } finally {
    if (!dryRun) await cleanupHtmlAssets(assetsDir);
  }
}

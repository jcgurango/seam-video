import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseSeamFile, resolveComposition } from "@seam/core";
import { buildFfmpegCommand, checkFfmpeg, renderWithFfmpeg } from "@seam/renderer";

export async function renderCommand(
  file: string,
  options: { output?: string; fps?: string; width?: string; height?: string }
) {
  const filePath = resolve(file);
  const fps = options.fps ? parseInt(options.fps, 10) : 30;
  const width = options.width ? parseInt(options.width, 10) : 1920;
  const height = options.height ? parseInt(options.height, 10) : 1080;

  checkFfmpeg();

  const json = readFileSync(filePath, "utf-8");
  const result = parseSeamFile(json);
  if (!result.success) {
    console.error("Validation errors:");
    for (const err of result.errors) {
      console.error(`  - ${err}`);
    }
    process.exit(1);
  }

  const timeline = resolveComposition(result.data);
  const outputPath = options.output ?? filePath.replace(/\.seam$/, ".mp4");
  const command = buildFfmpegCommand(timeline, outputPath, { fps, width, height });

  console.log(`Rendering to ${outputPath}...`);
  const renderResult = await renderWithFfmpeg(command, outputPath);

  if (renderResult.success) {
    console.log(`Done in ${renderResult.duration.toFixed(1)}s → ${outputPath}`);
  } else {
    console.error("ffmpeg failed:");
    console.error(renderResult.stderr);
    process.exit(1);
  }
}

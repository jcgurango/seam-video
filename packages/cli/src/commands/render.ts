import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseSeamFile, resolveComposition } from "@seam/core";
import { buildMlt, serializeToXml } from "@seam/renderer";

export function renderCommand(
  file: string,
  options: { output?: string; fps?: string; width?: string; height?: string }
) {
  const filePath = resolve(file);
  const fps = options.fps ? parseInt(options.fps, 10) : 30;
  const width = options.width ? parseInt(options.width, 10) : 1920;
  const height = options.height ? parseInt(options.height, 10) : 1080;

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
  const mltDoc = buildMlt(timeline, { fps, width, height });
  const xml = serializeToXml(mltDoc);

  const outputPath = options.output ?? filePath.replace(/\.seam$/, ".mlt");
  writeFileSync(outputPath, xml, "utf-8");
  console.log(`Rendered MLT XML to ${outputPath}`);
}

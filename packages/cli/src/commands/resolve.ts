import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseSeamFile, resolveComposition, resolveSpatial } from "@seam/core";

export interface ResolveOptions {
  output?: string;
  width?: string;
  height?: string;
  spatial?: boolean;
  pretty?: boolean;
}

export async function resolveCommand(file: string, options: ResolveOptions) {
  const filePath = resolve(file);
  const width = options.width ? parseInt(options.width, 10) : 1920;
  const height = options.height ? parseInt(options.height, 10) : 1080;
  const applySpatial = options.spatial !== false;

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
  const timeline = applySpatial
    ? resolveSpatial(temporal, width, height)
    : temporal;

  const out = options.pretty !== false
    ? JSON.stringify(timeline, null, 2)
    : JSON.stringify(timeline);

  if (options.output) {
    writeFileSync(resolve(options.output), out);
  } else {
    process.stdout.write(out + "\n");
  }
}

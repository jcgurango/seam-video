import { readFileSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { parseSeamFile, resolveComposition, resolveSpatial } from "@seam/core";
import {
  buildMeltArgs,
  buildMltDocument,
  checkMelt,
  rasterizeAllText,
  renderWithMelt,
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

  if (!dryRun) checkMelt();

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

  // Sidecar dir holds the rasterized text PNGs and the MLT XML we hand
  // to melt. Lives next to the .seam so paths inside the XML are easy
  // to inspect; cleaned up after success unless --dry-run is set.
  const assetsDir = `${filePath}-rendered`;
  await mkdir(assetsDir, { recursive: true });
  const scriptPath = join(assetsDir, "project.mlt");

  try {
    // Rasterize text nodes to PNGs in the assets dir before building
    // the MLT document — the document references each PNG by absolute
    // path, so the files have to exist when melt parses the project.
    const textDir = join(assetsDir, "text");
    const textRasters = await rasterizeAllText(timeline, textDir, fps);

    const { xml, limitations } = buildMltDocument(timeline, {
      fps,
      width,
      height,
      basePath,
      textRasters,
    });

    // Always surface translation limitations. They're not fatal —
    // most just mean a feature was silently dropped — but the user
    // needs to know which fields didn't round-trip.
    if (limitations.length > 0) {
      console.warn(`MLT translation notes (${limitations.length}):`);
      // Same field+detail often repeats across many nodes (e.g. each
      // animated text logs the same "PNG sequence not yet bridged").
      // Group by detail to keep the report short.
      const grouped = new Map<string, number>();
      for (const lim of limitations) {
        const key = `${lim.node}.${lim.field}: ${lim.detail}`;
        grouped.set(key, (grouped.get(key) ?? 0) + 1);
      }
      for (const [key, count] of grouped) {
        console.warn(`  ${count > 1 ? `[${count}×] ` : ""}${key}`);
      }
    }

    // Pass canvas dims to melt so the output matches the seam doc's
    // declared size — without these flags, MLT's first producer wins
    // (a portrait clip would otherwise pull the whole render
    // portrait, ignoring the project's own contentWidth/Height).
    const meltOpts = { scriptPath, width, height, fps };

    if (dryRun) {
      await writeFile(scriptPath, xml, "utf-8");
      const args = buildMeltArgs(scriptPath, outputPath, meltOpts);
      console.log("# dry run — would invoke:");
      console.log(["melt", ...args].map(shellQuote).join(" "));
      console.log(`\n# assets left in: ${assetsDir}`);
      return;
    }

    console.log(`Rendering to ${outputPath}...`);
    const renderResult = await renderWithMelt(xml, outputPath, meltOpts);

    if (renderResult.success) {
      console.log(`Done in ${renderResult.duration.toFixed(1)}s → ${outputPath}`);
    } else {
      console.error(`\nmelt failed (exited after ${renderResult.duration.toFixed(1)}s).`);
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

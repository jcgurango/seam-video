#!/usr/bin/env node
import { fileURLToPath } from "node:url";
import { dirname, resolve as resolvePath } from "node:path";
import { existsSync } from "node:fs";
import { Command } from "commander";
import { DEFAULT_CANVAS_HEIGHT, DEFAULT_CANVAS_WIDTH } from "@seam/core";
import { renderCommand } from "./commands/render.js";
import { previewCommand } from "./commands/preview.js";
import { resolveCommand } from "./commands/resolve.js";

// In the published CLI, @seam/renderer is bundled into this file, so its
// source-relative font/style lookups no longer resolve. The build vendors the
// renderer's `fonts/` and `osm-bright/` next to this bundle; point the renderer
// at them. In dev (tsx from source) there are no sibling assets, so we leave
// the env unset and the renderer falls back to its own package-relative paths.
const selfDir = dirname(fileURLToPath(import.meta.url));
if (!process.env.SEAM_RENDERER_ASSETS && existsSync(resolvePath(selfDir, "fonts"))) {
  process.env.SEAM_RENDERER_ASSETS = selfDir;
}

const program = new Command();

program
  .name("seam")
  .description("Seam Video - flowing video editing tool")
  .version("0.1.0");

program
  .command("render <file>")
  .description("Render a .seam file to mp4")
  .option("-o, --output <path>", "Output file path")
  .option("--fps <number>", "Frames per second", "30")
  .option("--width <number>", "Output width in pixels")
  .option("--height <number>", "Output height in pixels")
  .option(
    "--quality <preset>",
    "Encode quality tier (video + audio): very-low | low | medium | high | very-high. Subjective tier — actual bitrate scales with resolution × fps.",
    "high",
  )
  .option(
    "--proxy <ORIGINAL:REPLACEMENT>",
    "Swap a source path before rendering: any node whose `source` exactly equals ORIGINAL renders REPLACEMENT instead. Matched verbatim (no path resolution); split on the first ':'. Repeatable.",
    (val: string, acc: string[]) => {
      acc.push(val);
      return acc;
    },
    [] as string[],
  )
  .action(renderCommand);

program
  .command("preview <file>")
  .description("Open an Electron preview of a .seam file")
  .action(previewCommand);

program
  .command("resolve <file>")
  .description("Print the resolved timeline JSON for a .seam file")
  .option("-o, --output <path>", "Write to file instead of stdout")
  .option(
    "--width <number>",
    "Canvas width in pixels",
    String(DEFAULT_CANVAS_WIDTH),
  )
  .option(
    "--height <number>",
    "Canvas height in pixels",
    String(DEFAULT_CANVAS_HEIGHT),
  )
  .option("--no-spatial", "Skip spatial resolution (temporal layout only)")
  .option("--no-pretty", "Emit minified JSON")
  .action(resolveCommand);

// parseAsync (not parse) so async command actions are awaited and their
// rejections surface here with full detail, rather than becoming an unhandled
// promise rejection that crashes with no context.
program.parseAsync(process.argv).catch((err) => {
  console.error("\nseam: command failed");
  console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
  process.exit(1);
});

#!/usr/bin/env node
import { Command } from "commander";
import { renderCommand } from "./commands/render.js";
import { previewCommand } from "./commands/preview.js";
import { resolveCommand } from "./commands/resolve.js";

const program = new Command();

program
  .name("seam")
  .description("Seam Video - flowing video editing tool")
  .version("0.1.0");

program
  .command("render <file>")
  .description("Render a .seam file to mp4 via ffmpeg")
  .option("-o, --output <path>", "Output file path")
  .option("--fps <number>", "Frames per second", "30")
  .option("--width <number>", "Output width in pixels", "1920")
  .option("--height <number>", "Output height in pixels", "1080")
  .action(renderCommand);

program
  .command("preview <file>")
  .description("Open an Electron preview of a .seam file")
  .action(previewCommand);

program
  .command("resolve <file>")
  .description("Print the resolved timeline JSON for a .seam file")
  .option("-o, --output <path>", "Write to file instead of stdout")
  .option("--width <number>", "Canvas width in pixels", "1920")
  .option("--height <number>", "Canvas height in pixels", "1080")
  .option("--no-spatial", "Skip spatial resolution (temporal layout only)")
  .option("--no-pretty", "Emit minified JSON")
  .action(resolveCommand);

program.parse();

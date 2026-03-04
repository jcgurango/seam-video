#!/usr/bin/env node
import { Command } from "commander";
import { renderCommand } from "./commands/render.js";
import { previewCommand } from "./commands/preview.js";

const program = new Command();

program
  .name("seam")
  .description("Seam Video - flowing video editing tool")
  .version("0.1.0");

program
  .command("render <file>")
  .description("Render a .seam file to MLT XML")
  .option("-o, --output <path>", "Output file path")
  .option("--fps <number>", "Frames per second", "30")
  .option("--width <number>", "Output width in pixels", "1920")
  .option("--height <number>", "Output height in pixels", "1080")
  .action(renderCommand);

program
  .command("preview <file>")
  .description("Open an Electron preview of a .seam file")
  .action(previewCommand);

program.parse();

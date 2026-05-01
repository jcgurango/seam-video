import { execFileSync, spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";
import type { FfmpegCommand } from "./ffmpeg-builder.js";

export interface RenderResult {
  success: boolean;
  outputPath: string;
  stderr: string;
  duration: number;
}

export interface RenderOptions {
  /**
   * If provided, the filter graph is written to this path and ffmpeg is
   * invoked with `-filter_complex_script <path>` instead of inlining the
   * full graph on the command line. This sidesteps the platform argv
   * length limit (Windows: 8191 chars) for non-trivial compositions, and
   * makes large filter graphs easier to inspect.
   */
  filterScriptPath?: string;
}

export function checkFfmpeg(): void {
  try {
    execFileSync("ffmpeg", ["-version"], { stdio: "pipe" });
  } catch {
    throw new Error(
      "ffmpeg not found. Install ffmpeg and make sure it is on your PATH."
    );
  }
}

/**
 * Convert a built FfmpegCommand into the exact argv list the runner will
 * pass to ffmpeg. Exposed so callers (e.g. the CLI's --dry-run mode) can
 * preview or log the invocation.
 *
 * When `options.filterScriptPath` is set the filter graph is referenced
 * via `-filter_complex_script` rather than inlined; it is the caller's
 * responsibility to write `command.filterComplex` to that path before
 * invoking ffmpeg. `renderWithFfmpeg` does that for you.
 */
export function buildFfmpegArgs(
  command: FfmpegCommand,
  options: RenderOptions = {}
): string[] {
  const args: string[] = ["-y"];

  for (const input of command.inputs) {
    if (input.flags) args.push(...input.flags);
    args.push("-i", input.path);
  }

  if (options.filterScriptPath) {
    args.push("-filter_complex_script", options.filterScriptPath);
  } else {
    args.push("-filter_complex", command.filterComplex);
  }
  args.push(...command.outputArgs);

  return args;
}

export async function renderWithFfmpeg(
  command: FfmpegCommand,
  outputPath: string,
  options: RenderOptions = {}
): Promise<RenderResult> {
  if (options.filterScriptPath) {
    await writeFile(options.filterScriptPath, command.filterComplex, "utf-8");
  }
  const args = buildFfmpegArgs(command, options);
  const start = Date.now();

  return new Promise((resolve) => {
    // spawn (not execFile) so we can stream ffmpeg's stderr — the
    // `frame=… time=… speed=…` progress line — to the parent process
    // while it runs, instead of waiting for the whole render to finish.
    // We still capture stderr text so callers can include it in error
    // reporting.
    const child = spawn("ffmpeg", args, { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";

    child.stderr.setEncoding("utf-8");
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
      process.stderr.write(chunk);
    });
    // Drain stdout to avoid backpressure even though ffmpeg shouldn't
    // write to it under our flag set.
    child.stdout.on("data", () => {});

    child.on("error", (err) => {
      const duration = (Date.now() - start) / 1000;
      resolve({
        success: false,
        outputPath,
        stderr: `${stderr}${stderr ? "\n" : ""}${String(err)}`,
        duration,
      });
    });

    child.on("close", (code) => {
      const duration = (Date.now() - start) / 1000;
      resolve({
        success: code === 0,
        outputPath,
        stderr,
        duration,
      });
    });
  });
}

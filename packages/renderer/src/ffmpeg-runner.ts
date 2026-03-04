import { execFileSync, execFile } from "node:child_process";
import type { FfmpegCommand } from "./ffmpeg-builder.js";

export interface RenderResult {
  success: boolean;
  outputPath: string;
  stderr: string;
  duration: number;
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

export function renderWithFfmpeg(
  command: FfmpegCommand,
  outputPath: string
): Promise<RenderResult> {
  return new Promise((resolve) => {
    const args: string[] = ["-y"];

    for (const input of command.inputs) {
      args.push("-i", input);
    }

    args.push("-filter_complex", command.filterComplex);
    args.push(...command.outputArgs);

    const start = Date.now();

    execFile("ffmpeg", args, { maxBuffer: 50 * 1024 * 1024 }, (error, _stdout, stderr) => {
      const duration = (Date.now() - start) / 1000;
      resolve({
        success: !error,
        outputPath,
        stderr: stderr ?? "",
        duration,
      });
    });
  });
}

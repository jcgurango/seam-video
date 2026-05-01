import { execFileSync, spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";

export interface RenderResult {
  success: boolean;
  outputPath: string;
  stderr: string;
  duration: number;
}

export interface MeltRenderOptions {
  /** Path to write the MLT XML to. The runner writes this file before
   *  invoking `melt`. Caller chooses the path so it lives next to the
   *  rest of the render's sidecar assets (PNGs, etc.). */
  scriptPath: string;
  /** Video codec for the avformat consumer (default `libx264`). */
  vcodec?: string;
  /** Audio codec for the avformat consumer (default `aac`). The
   *  audio reaches melt via a pre-rendered ffmpeg-mixed file
   *  referenced as a producer in the MLT graph; this is just the
   *  encode codec for the final mp4 mux. */
  acodec?: string;
  /** Output canvas dimensions. Should mirror what was passed to
   *  `buildMltDocument` — for the typical case this is the seam doc's
   *  `contentWidth`/`contentHeight` (the project's natural size). When
   *  set, both the `-profile` flag and the avformat consumer args
   *  carry these dims so MLT doesn't silently adopt the first
   *  producer's size (e.g. a portrait phone clip would otherwise
   *  flip a landscape project to portrait). */
  width?: number;
  height?: number;
  fps?: number;
  /** Extra `key=value` strings appended to the consumer args. */
  consumerArgs?: string[];
}

export function checkMelt(): void {
  try {
    execFileSync("melt", ["-version"], { stdio: "pipe" });
  } catch {
    throw new Error(
      "melt not found. Install MLT (e.g. `brew install mlt` on macOS) and ensure `melt` is on your PATH.",
    );
  }
}

/** Build the argv list passed to `melt`. Exposed so the CLI's
 *  `--dry-run` mode can print the exact invocation it would have run.
 *
 *  When `width`/`height`/`fps` are set, both `-profile` (a one-shot
 *  inline profile string) and the consumer's own `width`/`height`
 *  args are emitted. The inline `<profile>` element in the XML is
 *  advisory only — without these flags melt happily picks the first
 *  producer's intrinsic size, which silently flips a landscape
 *  project to portrait if the first clip is a phone video. The
 *  caller should pass the seam doc's resolved canvas size (typically
 *  `contentWidth`/`contentHeight`) so output orientation matches the
 *  project rather than the first asset. */
export function buildMeltArgs(
  scriptPath: string,
  outputPath: string,
  options: MeltRenderOptions,
): string[] {
  const args: string[] = ["-progress"];
  if (options.width != null && options.height != null) {
    const fps = options.fps ?? 30;
    // melt's -profile accepts a colon-separated `WxH/numDen` form for
    // ad-hoc profiles, no need to ship a profile file.
    args.push("-profile", `${options.width}x${options.height}/${fps}:1`);
  }
  args.push(
    scriptPath,
    "-consumer",
    `avformat:${outputPath}`,
    `vcodec=${options.vcodec ?? "libx264"}`,
    `acodec=${options.acodec ?? "aac"}`,
  );
  if (options.width != null) args.push(`width=${options.width}`);
  if (options.height != null) args.push(`height=${options.height}`);
  if (options.fps != null) {
    args.push(`frame_rate_num=${options.fps}`, `frame_rate_den=1`);
  }
  if (options.consumerArgs) args.push(...options.consumerArgs);
  return args;
}

export async function renderWithMelt(
  xml: string,
  outputPath: string,
  options: MeltRenderOptions,
): Promise<RenderResult> {
  await writeFile(options.scriptPath, xml, "utf-8");
  const args = buildMeltArgs(options.scriptPath, outputPath, options);
  const start = Date.now();

  return new Promise((resolve) => {
    // Stream stderr live so the user sees melt's progress lines (one
    // per frame, very chatty — but matches what `ffmpeg` was doing).
    const child = spawn("melt", args, { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    child.stderr.setEncoding("utf-8");
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
      process.stderr.write(chunk);
    });
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
      resolve({ success: code === 0, outputPath, stderr, duration });
    });
  });
}

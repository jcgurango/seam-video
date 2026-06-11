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

/** Path of the sidecar melt profile file written next to the script. */
export function meltProfilePath(scriptPath: string): string {
  return scriptPath.replace(/\.mlt$/, "") + ".profile";
}

/** Content of a melt profile file (the canonical `key=value` format melt
 *  ships its named profiles in — square pixels, BT.709). melt does NOT
 *  parse ad-hoc `-profile WxH/fps` strings (it silently falls back to its
 *  default dv_pal profile, whose 16:15 SAR then stretches the output, e.g.
 *  1080×1920 displaying as 1152×1920); only a real profile *file* or a
 *  named profile is honored. */
export function buildMeltProfile(width: number, height: number, fps: number): string {
  return [
    `description=seam ${width}x${height} ${fps}fps`,
    `frame_rate_num=${fps}`,
    `frame_rate_den=1`,
    `width=${width}`,
    `height=${height}`,
    `progressive=1`,
    `sample_aspect_num=1`,
    `sample_aspect_den=1`,
    `display_aspect_num=${width}`,
    `display_aspect_den=${height}`,
    `colorspace=709`,
    "",
  ].join("\n");
}

/** Write the sidecar profile file for a render (when dims are known).
 *  Both `renderWithMelt` and the CLI's `--dry-run` call this so the
 *  printed/executed `melt` invocation has its `-profile` file on disk. */
export async function writeMeltProfile(options: MeltRenderOptions): Promise<void> {
  if (options.width == null || options.height == null) return;
  await writeFile(
    meltProfilePath(options.scriptPath),
    buildMeltProfile(options.width, options.height, options.fps ?? 30),
    "utf-8",
  );
}

/** Build the argv list passed to `melt`. Exposed so the CLI's
 *  `--dry-run` mode can print the exact invocation it would have run.
 *
 *  When `width`/`height` are set, melt is pointed at a sidecar `-profile`
 *  *file* (written by `writeMeltProfile`) and the consumer's `width`/
 *  `height` args are also emitted. melt's profile must be forced this way:
 *  the inline `<profile>` in the XML isn't adopted as the active profile
 *  (so the default dv_pal SAR/colorspace leak), and ad-hoc `-profile WxH`
 *  strings silently fall back to dv_pal too. The caller should pass the
 *  seam doc's resolved canvas size (typically `contentWidth`/`Height`) so
 *  output orientation + pixel aspect match the project, not the first
 *  asset. */
export function buildMeltArgs(
  scriptPath: string,
  outputPath: string,
  options: MeltRenderOptions,
): string[] {
  const args: string[] = ["-progress"];
  if (options.width != null && options.height != null) {
    args.push("-profile", meltProfilePath(scriptPath));
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
  await writeMeltProfile(options);
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

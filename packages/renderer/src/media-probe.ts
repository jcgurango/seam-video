// Probe a media file's *display* pixel dimensions via ffprobe.
//
// Why the MLT builder needs this: the core layout resolver can't know a
// clip's intrinsic size (it does no I/O), so it falls back to the parent
// box for `naturalWidth/Height`. That makes every clip's spatial rect
// equal the parent rect, and qtblend then stretches the source to fill
// it — so `objectFit: "cover" | "center"` are indistinguishable from
// "fit". Handing the builder the real intrinsic size lets it compute the
// correct (possibly oversized) natural rect; qtblend reads the native
// source frame and clips the overflow at the output frame boundary, which
// is exactly cover/center.
//
// "Display" dimensions means we account for sample-aspect-ratio (non-square
// pixels) and rotation side-data, mirroring how a decoder presents frames
// to the preview. ffprobe ships with ffmpeg, already a hard dependency
// (see ffmpeg-audio.ts), so this adds no new external tool.

import { execFileSync, execFile } from "node:child_process";
import { resolve } from "node:path";

export interface IntrinsicSize {
  width: number;
  height: number;
}

/** Map of absolute source path → display dimensions. Built up front by the
 *  caller (CLI) and handed to `buildMltDocument` via `options.intrinsicSizes`. */
export type IntrinsicSizeMap = Map<string, IntrinsicSize>;

export function checkFfprobe(): void {
  try {
    execFileSync("ffprobe", ["-version"], { stdio: "pipe" });
  } catch {
    throw new Error(
      "ffprobe not found. Install ffmpeg (which bundles ffprobe) and make sure it is on your PATH.",
    );
  }
}

interface ProbeStream {
  width?: number;
  height?: number;
  sample_aspect_ratio?: string;
  tags?: { rotate?: string };
  side_data_list?: Array<{ rotation?: number; side_data_type?: string }>;
}

interface ProbeFrame {
  width?: number;
  height?: number;
  side_data_list?: Array<{ rotation?: number; side_data_type?: string }>;
}

/** First numeric `rotation` in a side_data list (the Display Matrix entry). */
function rotationFromSideData(
  list: Array<{ rotation?: number }> | undefined,
): number | undefined {
  return list?.find((s) => s.rotation != null)?.rotation;
}

/** Compute display dimensions from coded dims + SAR + rotation. A 90/270
 *  turn swaps the axes; SAR widens the stored width to its display width. */
function displaySize(
  w: number,
  h: number,
  sar: string | undefined,
  rotation: number,
): IntrinsicSize {
  let displayW = w;
  if (sar && sar !== "1:1" && sar !== "0:1") {
    const [num, den] = sar.split(":").map(Number);
    if (Number.isFinite(num) && Number.isFinite(den) && num > 0 && den > 0) {
      displayW = (w * num) / den;
    }
  }
  const displayH = h;
  const norm = ((Math.round(rotation) % 360) + 360) % 360;
  return norm === 90 || norm === 270
    ? { width: displayH, height: displayW }
    : { width: displayW, height: displayH };
}

/** Probe one file. Returns null if ffprobe fails or has no usable video
 *  stream — the builder then falls back to its parent-size rect. */
export async function probeIntrinsicSize(absPath: string): Promise<IntrinsicSize | null> {
  // Read the first frame too: for camera JPEGs the rotation lives in EXIF
  // Orientation, which ffmpeg surfaces as a Display Matrix in *frame*
  // side_data (not the stream's), and melt's qimage / the browser's
  // createImageBitmap both auto-apply it — so the display size we hand the
  // layout engine must reflect that swap or cover/translation diverge from
  // the preview. `-read_intervals "%+#1"` decodes only the first frame.
  const args = [
    "-v",
    "error",
    "-select_streams",
    "v:0",
    "-read_intervals",
    "%+#1",
    "-show_entries",
    "stream=width,height,sample_aspect_ratio:stream_tags=rotate:stream_side_data=rotation:frame=width,height:frame_side_data=rotation",
    "-of",
    "json",
    absPath,
  ];
  let stdout: string;
  try {
    stdout = await new Promise<string>((res, rej) => {
      execFile("ffprobe", args, { encoding: "utf-8" }, (err, out) => {
        if (err) rej(err);
        else res(out);
      });
    });
  } catch {
    return null;
  }
  try {
    const json = JSON.parse(stdout) as {
      streams?: ProbeStream[];
      frames?: ProbeFrame[];
    };
    const stream = json.streams?.[0];
    const frame = json.frames?.[0];
    // Prefer the frame's coded dims (identical to the stream's, but present
    // even for odd image producers); fall back to the stream.
    const w = frame?.width ?? stream?.width;
    const h = frame?.height ?? stream?.height;
    const sar = stream?.sample_aspect_ratio;
    if (w == null || h == null || w <= 0 || h <= 0) return null;
    // Rotation precedence: frame Display Matrix (EXIF for images, propagated
    // matrix for video) → stream Display Matrix → legacy `rotate` tag.
    const rotation =
      rotationFromSideData(frame?.side_data_list) ??
      rotationFromSideData(stream?.side_data_list) ??
      (stream?.tags?.rotate != null ? Number(stream.tags.rotate) : 0);
    return displaySize(w, h, sar, rotation);
  } catch {
    return null;
  }
}

/** Probe many sources in parallel, deduped, into an `IntrinsicSizeMap`
 *  keyed by absolute path. `basePath` resolves relative `source` strings the
 *  same way the MLT builder does (`resolve(basePath, relPath)`). Sources that
 *  fail to probe are simply absent from the map. */
export async function probeIntrinsicSizes(
  relPaths: Iterable<string>,
  basePath?: string,
): Promise<IntrinsicSizeMap> {
  const map: IntrinsicSizeMap = new Map();
  const unique = new Set<string>();
  for (const rel of relPaths) {
    unique.add(basePath ? resolve(basePath, rel) : rel);
  }
  await Promise.all(
    [...unique].map(async (abs) => {
      const size = await probeIntrinsicSize(abs);
      if (size) map.set(abs, size);
    }),
  );
  return map;
}

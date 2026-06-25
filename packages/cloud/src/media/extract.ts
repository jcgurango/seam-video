/**
 * Server-side media metadata extraction — the headless mirror of the web
 * editor's `mediaThumbs.ts`. Same three operations, run on the Node side when
 * media is uploaded:
 *
 *   - thumbnail (downscaled JPEG): image, or a video's first frame
 *   - natural duration (video/audio)
 *   - capture date: EXIF DateTimeOriginal (JPEG) / container metadata (AV)
 *
 * Decode uses mediabunny (`@mediabunny/server`/NodeAV) + `@napi-rs/canvas`,
 * the same stack as `@seam/renderer`. `draw()`/`toCanvasImageSource()` don't
 * work headlessly, so video frames go through `copyTo({format:"RGBA"})` and
 * rotation is baked in via a canvas transform (matching the renderer).
 */
import { registerMediabunnyServer } from "@mediabunny/server";
import {
  Input,
  FilePathSource,
  ALL_FORMATS,
  VideoSampleSink,
  type Rotation,
  type VideoSample,
} from "mediabunny";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import type { MediaKind } from "../types.js";

/** Longest edge of a generated thumbnail, in px (matches the editor). */
const THUMB_MAX_EDGE = 256;
const THUMB_QUALITY = 0.8;
const EXIF_SCAN_BYTES = 256 * 1024;

let serverRegistered = false;
function ensureServer(): void {
  if (!serverRegistered) {
    registerMediabunnyServer();
    serverRegistered = true;
  }
}

const VIDEO_EXT = ["mp4", "mov", "m4v", "webm", "mkv", "avi"];
const AUDIO_EXT = ["mp3", "wav", "m4a", "aac", "ogg", "flac"];
// svg counts as an image (uploadable + storable), but the Immich handoff
// deliberately excludes it — see isImmichEligible.
const IMAGE_EXT = ["jpg", "jpeg", "png", "gif", "webp", "bmp", "heic", "heif", "svg"];

/** Classify a media kind by filename extension (mirrors the editor). */
export function classifyByName(name: string): MediaKind | null {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  if (ext === "pmtiles") return "pmtiles";
  if (VIDEO_EXT.includes(ext)) return "video";
  if (AUDIO_EXT.includes(ext)) return "audio";
  if (IMAGE_EXT.includes(ext)) return "image";
  return null;
}

export interface ExtractResult {
  width?: number;
  height?: number;
  /** Seconds, video/audio only. */
  duration?: number;
  /** Epoch ms. */
  captureDate?: number;
  /** Downscaled JPEG, or undefined for kinds/files without a still. */
  thumb?: Buffer;
}

/**
 * Extract every derivable field for a media file already saved to `path`. Pure
 * best-effort: any sub-step that fails is simply omitted (logged, not thrown),
 * so a partially-decodable file still uploads.
 *
 * `buffer` (the in-memory upload bytes) is used for the EXIF scan to avoid a
 * re-read; falls back to reading `path` when absent.
 */
export async function extractMediaInfo(
  path: string,
  kind: MediaKind,
  buffer?: Buffer
): Promise<ExtractResult> {
  if (kind === "image") return extractImage(path, buffer);
  if (kind === "video") return extractVideo(path);
  if (kind === "audio") return extractAudio(path);
  return {}; // pmtiles — nothing to extract
}

async function extractImage(
  path: string,
  buffer?: Buffer
): Promise<ExtractResult> {
  const result: ExtractResult = {};
  try {
    // loadImage applies EXIF orientation, matching the editor's
    // `imageOrientation: "from-image"` and the renderer's StaticStore.
    const img = await loadImage(path);
    result.width = img.width;
    result.height = img.height;
    const t = drawScaledToJpeg(img, img.width, img.height);
    if (t) result.thumb = t;
  } catch (err) {
    warn("image thumbnail", path, err);
  }
  try {
    const bytes = buffer ?? (await (await import("node:fs/promises")).readFile(path));
    const date = parseExifDate(bytes);
    if (date != null) result.captureDate = date;
  } catch (err) {
    warn("image EXIF", path, err);
  }
  return result;
}

async function extractVideo(path: string): Promise<ExtractResult> {
  ensureServer();
  const result: ExtractResult = {};
  const input = new Input({ source: new FilePathSource(path), formats: ALL_FORMATS });

  try {
    const d = await input.computeDuration();
    if (Number.isFinite(d) && d > 0) result.duration = d;
  } catch (err) {
    warn("video duration", path, err);
  }
  try {
    const date = await containerCaptureDate(input);
    if (date != null) result.captureDate = date;
  } catch (err) {
    warn("video metadata", path, err);
  }
  try {
    const track = await input.getPrimaryVideoTrack();
    if (track && (await track.canDecode())) {
      // Display dims account for rotation already.
      result.width = track.displayWidth;
      result.height = track.displayHeight;
      const sink = new VideoSampleSink(track);
      const sample = await sink.getSample(0);
      if (sample) {
        const t = videoSampleToThumb(
          sample.codedWidth,
          sample.codedHeight,
          track.rotation,
          await sampleRgba(sample)
        );
        if (t) result.thumb = t;
        sample.close();
      }
    }
  } catch (err) {
    warn("video thumbnail", path, err);
  }
  return result;
}

async function extractAudio(path: string): Promise<ExtractResult> {
  ensureServer();
  const result: ExtractResult = {};
  const input = new Input({ source: new FilePathSource(path), formats: ALL_FORMATS });
  try {
    const d = await input.computeDuration();
    if (Number.isFinite(d) && d > 0) result.duration = d;
  } catch (err) {
    warn("audio duration", path, err);
  }
  try {
    const date = await containerCaptureDate(input);
    if (date != null) result.captureDate = date;
  } catch (err) {
    warn("audio metadata", path, err);
  }
  return result;
}

/** Capture date from container tags (Apple QuickTime key first, then date). */
async function containerCaptureDate(input: Input): Promise<number | undefined> {
  const tags = await input.getMetadataTags();
  const apple = tags.raw?.["com.apple.quicktime.creationdate"];
  if (typeof apple === "string") {
    const t = Date.parse(apple);
    if (Number.isFinite(t)) return t;
  }
  if (tags.date instanceof Date) {
    const t = tags.date.getTime();
    if (Number.isFinite(t)) return t;
  }
  return undefined;
}

async function sampleRgba(sample: VideoSample): Promise<Uint8Array> {
  const buf = new Uint8Array(sample.allocationSize({ format: "RGBA" }));
  await sample.copyTo(buf, { format: "RGBA" });
  return buf;
}

/**
 * Build a rotation-corrected, downscaled JPEG thumbnail from coded RGBA pixels.
 * `copyTo` yields coded (pre-rotation) pixels; we draw them into a
 * display-oriented thumbnail canvas with the container rotation applied.
 */
function videoSampleToThumb(
  codedW: number,
  codedH: number,
  rotation: Rotation,
  rgba: Uint8Array
): Buffer | null {
  if (!(codedW > 0 && codedH > 0)) return null;
  const full = createCanvas(codedW, codedH);
  const fctx = full.getContext("2d");
  const id = fctx.createImageData(codedW, codedH);
  id.data.set(rgba);
  fctx.putImageData(id, 0, 0);

  const swap = rotation === 90 || rotation === 270;
  const dispW = swap ? codedH : codedW;
  const dispH = swap ? codedW : codedH;
  const scale = Math.min(1, THUMB_MAX_EDGE / Math.max(dispW, dispH));
  const tw = Math.max(1, Math.round(dispW * scale));
  const th = Math.max(1, Math.round(dispH * scale));

  const thumb = createCanvas(tw, th);
  const ctx = thumb.getContext("2d");
  ctx.translate(tw / 2, th / 2);
  ctx.rotate((rotation * Math.PI) / 180);
  ctx.drawImage(full, (-codedW * scale) / 2, (-codedH * scale) / 2, codedW * scale, codedH * scale);
  return thumb.toBuffer("image/jpeg", THUMB_QUALITY);
}

/** Downscale an already-oriented image source to a JPEG buffer. */
function drawScaledToJpeg(
  src: Awaited<ReturnType<typeof loadImage>>,
  srcW: number,
  srcH: number
): Buffer | null {
  if (!(srcW > 0 && srcH > 0)) return null;
  const scale = Math.min(1, THUMB_MAX_EDGE / Math.max(srcW, srcH));
  const w = Math.max(1, Math.round(srcW * scale));
  const h = Math.max(1, Math.round(srcH * scale));
  const canvas = createCanvas(w, h);
  const ctx = canvas.getContext("2d");
  ctx.drawImage(src, 0, 0, w, h);
  return canvas.toBuffer("image/jpeg", THUMB_QUALITY);
}

function warn(what: string, path: string, err: unknown): void {
  console.warn(`[seam-cloud] extract ${what} failed for ${path}:`, err);
}

// ── Minimal JPEG/EXIF DateTimeOriginal reader (ported from the editor) ──────
// APP1 → TIFF header → IFD0 → ExifIFD (0x8769) → DateTimeOriginal (0x9003).

function parseExifDate(bytes: Uint8Array): number | undefined {
  const view = new DataView(bytes.buffer, bytes.byteOffset, Math.min(bytes.byteLength, EXIF_SCAN_BYTES));
  if (view.byteLength < 4 || view.getUint16(0) !== 0xffd8) return undefined; // not JPEG

  let off = 2;
  while (off + 4 <= view.byteLength) {
    if (view.getUint8(off) !== 0xff) break;
    const marker = view.getUint8(off + 1);
    if (marker === 0xda || marker === 0xd9) break; // SOS / EOI
    const segLen = view.getUint16(off + 2);
    if (segLen < 2) break;
    const segStart = off + 4;
    if (marker === 0xe1 && segStart + 6 <= view.byteLength) {
      if (
        view.getUint32(segStart) === 0x45786966 && // "Exif"
        view.getUint16(segStart + 4) === 0x0000
      ) {
        return parseTiffForDate(view, segStart + 6);
      }
    }
    off = segStart + (segLen - 2);
  }
  return undefined;
}

function parseTiffForDate(view: DataView, tiff: number): number | undefined {
  if (tiff + 8 > view.byteLength) return undefined;
  const bom = view.getUint16(tiff);
  const le = bom === 0x4949;
  if (!le && bom !== 0x4d4d) return undefined;
  const u16 = (p: number) => view.getUint16(p, le);
  const u32 = (p: number) => view.getUint32(p, le);

  const ifd0 = tiff + u32(tiff + 4);
  const exifIfdPtr = findTagValueOffset(view, ifd0, 0x8769, u16, u32);
  if (exifIfdPtr == null) return undefined;
  const exifIfd = tiff + exifIfdPtr;

  const strOff = findTagValueOffset(view, exifIfd, 0x9003, u16, u32);
  if (strOff == null) return undefined;
  const start = tiff + strOff;
  if (start + 19 > view.byteLength) return undefined;
  let s = "";
  for (let i = 0; i < 19; i++) s += String.fromCharCode(view.getUint8(start + i));
  const m = s.match(/^(\d{4}):(\d{2}):(\d{2}) (\d{2}):(\d{2}):(\d{2})/);
  if (!m) return undefined;
  const [, Y, Mo, D, h, mi, se] = m.map(Number) as unknown as number[];
  const t = new Date(Y, Mo - 1, D, h, mi, se).getTime();
  return Number.isFinite(t) ? t : undefined;
}

function findTagValueOffset(
  view: DataView,
  ifd: number,
  tag: number,
  u16: (p: number) => number,
  u32: (p: number) => number
): number | undefined {
  if (ifd + 2 > view.byteLength) return undefined;
  const count = u16(ifd);
  for (let i = 0; i < count; i++) {
    const entry = ifd + 2 + i * 12;
    if (entry + 12 > view.byteLength) break;
    if (u16(entry) === tag) return u32(entry + 8);
  }
  return undefined;
}

// Web media-bin helpers: one-time thumbnail generation, capture-date
// extraction, and natural-duration probing for files stored in OPFS clips/.
// All pure functions over a File — the WebPlatform owns caching the results
// in OPFS (thumbnails/ + media-index.json).

import { Input, BlobSource, ALL_FORMATS, CanvasSink } from "mediabunny";
import type { MediaKind } from "./useImport.js";

/** Longest edge of a generated thumbnail, in px. Small enough to keep the
 *  grid cheap, big enough to stay crisp on hi-dpi. */
const THUMB_MAX_EDGE = 256;
const THUMB_TYPE = "image/jpeg";
const THUMB_QUALITY = 0.8;

export interface ThumbnailResult {
  blob: Blob;
  width: number;
  height: number;
}

/**
 * Render a downscaled JPEG thumbnail for an image (any raster format) or a
 * video's first frame. Returns null for kinds without a still (audio/pmtiles)
 * or on decode failure — callers fall back to a kind icon.
 */
export async function generateThumbnail(
  file: File,
  kind: MediaKind,
): Promise<ThumbnailResult | null> {
  try {
    if (kind === "image") {
      // `imageOrientation: "from-image"` applies EXIF orientation, matching
      // StaticStore / the CLI render so a rotated photo thumbnails upright.
      const bitmap = await createImageBitmap(file, {
        imageOrientation: "from-image",
      });
      try {
        return await drawScaled(bitmap, bitmap.width, bitmap.height);
      } finally {
        bitmap.close();
      }
    }
    if (kind === "video") {
      const input = new Input({
        source: new BlobSource(file),
        formats: ALL_FORMATS,
      });
      const track = await input.getPrimaryVideoTrack();
      if (!track || !(await track.canDecode())) return null;
      const sink = new CanvasSink(track, { poolSize: 1 });
      // First decodable frame at/after t=0.
      const iter = sink.canvases(0);
      const res = await iter.next();
      await iter.return?.();
      if (!res.value) return null;
      const src = res.value.canvas as CanvasImageSource & {
        width: number;
        height: number;
      };
      return await drawScaled(src, src.width, src.height);
    }
    return null; // audio / pmtiles → no still
  } catch (err) {
    console.warn(`generateThumbnail(${kind}) failed for ${file.name}`, err);
    return null;
  }
}

async function drawScaled(
  src: CanvasImageSource,
  srcW: number,
  srcH: number,
): Promise<ThumbnailResult | null> {
  if (!(srcW > 0 && srcH > 0)) return null;
  const scale = Math.min(1, THUMB_MAX_EDGE / Math.max(srcW, srcH));
  const w = Math.max(1, Math.round(srcW * scale));
  const h = Math.max(1, Math.round(srcH * scale));
  const canvas = new OffscreenCanvas(w, h);
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  ctx.drawImage(src, 0, 0, w, h);
  const blob = await canvas.convertToBlob({
    type: THUMB_TYPE,
    quality: THUMB_QUALITY,
  });
  return { blob, width: srcW, height: srcH };
}

/**
 * Natural duration in seconds for video/audio (via mediabunny), or undefined
 * for stills / on failure.
 */
export async function probeDurationSeconds(
  file: File,
  kind: MediaKind,
): Promise<number | undefined> {
  if (kind !== "video" && kind !== "audio") return undefined;
  try {
    const input = new Input({
      source: new BlobSource(file),
      formats: ALL_FORMATS,
    });
    const d = await input.computeDuration();
    return Number.isFinite(d) && d > 0 ? d : undefined;
  } catch (err) {
    console.warn(`probeDurationSeconds failed for ${file.name}`, err);
    return undefined;
  }
}

/**
 * Best-effort capture date (epoch ms): EXIF DateTimeOriginal for JPEGs,
 * container metadata for video/audio (preferring Apple's QuickTime capture
 * key over the generic normalized date). Undefined when unavailable — the
 * caller falls back to date-added for sorting.
 */
export async function extractCaptureDate(
  file: File,
  kind: MediaKind,
): Promise<number | undefined> {
  try {
    if (kind === "image") return await parseExifDate(file);
    if (kind === "video" || kind === "audio") {
      const input = new Input({
        source: new BlobSource(file),
        formats: ALL_FORMATS,
      });
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
    }
  } catch (err) {
    console.warn(`extractCaptureDate(${kind}) failed for ${file.name}`, err);
  }
  return undefined;
}

// ── Minimal JPEG/EXIF DateTimeOriginal reader ────────────────────────
//
// No dependency: scan APP1 → TIFF header → IFD0 → ExifIFD (0x8769) →
// DateTimeOriginal (0x9003, ASCII "YYYY:MM:DD HH:MM:SS", local time).

const EXIF_SCAN_BYTES = 256 * 1024;

async function parseExifDate(file: File): Promise<number | undefined> {
  const buf = await file.slice(0, EXIF_SCAN_BYTES).arrayBuffer();
  const view = new DataView(buf);
  if (view.byteLength < 4 || view.getUint16(0) !== 0xffd8) return undefined; // not JPEG

  // Walk APP marker segments looking for APP1 "Exif\0\0".
  let off = 2;
  while (off + 4 <= view.byteLength) {
    if (view.getUint8(off) !== 0xff) break;
    const marker = view.getUint8(off + 1);
    // Standalone markers (RSTn, SOI/EOI) have no length; SOS (0xDA) starts
    // scan data — stop before then.
    if (marker === 0xda || marker === 0xd9) break;
    const segLen = view.getUint16(off + 2);
    if (segLen < 2) break;
    const segStart = off + 4;
    if (marker === 0xe1 && segStart + 6 <= view.byteLength) {
      // "Exif\0\0"
      if (
        view.getUint32(segStart) === 0x45786966 &&
        view.getUint16(segStart + 4) === 0x0000
      ) {
        return parseTiffForDate(view, segStart + 6);
      }
    }
    off = segStart + (segLen - 2);
  }
  return undefined;
}

function parseTiffForDate(
  view: DataView,
  tiff: number,
): number | undefined {
  if (tiff + 8 > view.byteLength) return undefined;
  const bom = view.getUint16(tiff);
  const le = bom === 0x4949; // "II" little-endian; "MM" (0x4D4D) big-endian
  if (!le && bom !== 0x4d4d) return undefined;
  const u16 = (p: number) => view.getUint16(p, le);
  const u32 = (p: number) => view.getUint32(p, le);

  const ifd0 = tiff + u32(tiff + 4);
  const exifIfdPtr = findTagValueOffset(view, tiff, ifd0, 0x8769, u16, u32);
  if (exifIfdPtr == null) return undefined;
  const exifIfd = tiff + exifIfdPtr;

  // DateTimeOriginal (0x9003): ASCII "YYYY:MM:DD HH:MM:SS\0".
  const strOff = findTagValueOffset(view, tiff, exifIfd, 0x9003, u16, u32);
  if (strOff == null) return undefined;
  const start = tiff + strOff;
  if (start + 19 > view.byteLength) return undefined;
  let s = "";
  for (let i = 0; i < 19; i++) s += String.fromCharCode(view.getUint8(start + i));
  // "2024:06:14 10:30:00" → local Date
  const m = s.match(/^(\d{4}):(\d{2}):(\d{2}) (\d{2}):(\d{2}):(\d{2})/);
  if (!m) return undefined;
  const [, Y, Mo, D, h, mi, se] = m.map(Number) as unknown as number[];
  const d = new Date(Y, Mo - 1, D, h, mi, se);
  const t = d.getTime();
  return Number.isFinite(t) ? t : undefined;
}

/**
 * Find an IFD entry by tag and return its value as an offset relative to the
 * TIFF header. For pointer tags (ExifIFD) this is the sub-IFD offset; for the
 * date string it's where the inline 4-byte value field stores the data
 * offset. Returns null if the tag is absent.
 */
function findTagValueOffset(
  view: DataView,
  tiff: number,
  ifd: number,
  tag: number,
  u16: (p: number) => number,
  u32: (p: number) => number,
): number | undefined {
  if (ifd + 2 > view.byteLength) return undefined;
  const count = u16(ifd);
  for (let i = 0; i < count; i++) {
    const entry = ifd + 2 + i * 12;
    if (entry + 12 > view.byteLength) break;
    if (u16(entry) === tag) {
      // Pointer/long tags store the offset (relative to TIFF) in the value
      // field; ASCII strings >4 bytes likewise store an offset there.
      return u32(entry + 8);
    }
  }
  return undefined;
}

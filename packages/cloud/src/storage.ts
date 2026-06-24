import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { env } from "./env.js";

/**
 * On-disk layout under DATA_DIR:
 *
 *   media/<userId>/<mediaId>          raw media bytes (any kind)
 *   thumbnails/<userId>/<mediaId>.jpg cached thumbnails (optional)
 *   projects/<userId>/<projectId>.seam  project documents (JSON)
 *
 * Files are addressed by opaque id, not by their (user-supplied, collidable)
 * filename — the original filename lives in the DB row.
 */
const MEDIA_DIR = path.join(env.dataDir, "media");
const THUMBS_DIR = path.join(env.dataDir, "thumbnails");
const PROJECTS_DIR = path.join(env.dataDir, "projects");

export function mediaPath(userId: string, id: string): string {
  return path.join(MEDIA_DIR, userId, id);
}
export function thumbPath(userId: string, id: string): string {
  return path.join(THUMBS_DIR, userId, `${id}.jpg`);
}
export function projectPath(userId: string, id: string): string {
  return path.join(PROJECTS_DIR, userId, `${id}.seam`);
}

async function writeFile(filePath: string, data: Buffer): Promise<void> {
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  await fsp.writeFile(filePath, data);
}

export async function saveMedia(
  userId: string,
  id: string,
  data: Buffer
): Promise<void> {
  await writeFile(mediaPath(userId, id), data);
}

export async function saveThumb(
  userId: string,
  id: string,
  data: Buffer
): Promise<void> {
  await writeFile(thumbPath(userId, id), data);
}

export async function saveProject(
  userId: string,
  id: string,
  data: Buffer
): Promise<void> {
  await writeFile(projectPath(userId, id), data);
}

export async function deleteMedia(userId: string, id: string): Promise<void> {
  await Promise.all([
    fsp.rm(mediaPath(userId, id), { force: true }),
    fsp.rm(thumbPath(userId, id), { force: true }),
  ]);
}

export async function deleteProject(userId: string, id: string): Promise<void> {
  await fsp.rm(projectPath(userId, id), { force: true });
}

/**
 * Build a streaming web Response for a file, or null if it doesn't exist.
 * Honors a `Range` header (returns `206 Partial Content`) so mediabunny's
 * `UrlSource` can do byte-range reads instead of downloading the whole file —
 * the foundation of cloud media streaming. Always advertises `Accept-Ranges`.
 */
export function fileResponse(
  filePath: string,
  contentType: string,
  rangeHeader?: string | null
): Response | null {
  if (!fs.existsSync(filePath)) return null;
  const size = fs.statSync(filePath).size;
  const baseHeaders: Record<string, string> = {
    "content-type": contentType,
    "accept-ranges": "bytes",
  };

  const range = rangeHeader ? parseRange(rangeHeader, size) : null;
  if (range === "invalid") {
    return new Response(null, {
      status: 416,
      headers: { ...baseHeaders, "content-range": `bytes */${size}` },
    });
  }

  if (range) {
    const { start, end } = range;
    const stream = Readable.toWeb(
      fs.createReadStream(filePath, { start, end })
    ) as ReadableStream;
    return new Response(stream, {
      status: 206,
      headers: {
        ...baseHeaders,
        "content-range": `bytes ${start}-${end}/${size}`,
        "content-length": String(end - start + 1),
      },
    });
  }

  const stream = Readable.toWeb(fs.createReadStream(filePath)) as ReadableStream;
  return new Response(stream, {
    headers: { ...baseHeaders, "content-length": String(size) },
  });
}

/**
 * Parse a single-range `Range: bytes=…` header against `size`. Returns the
 * inclusive byte range, `null` for no/unsupported range (caller serves full),
 * or `"invalid"` for an unsatisfiable range (caller returns 416). Only the
 * first range of a multi-range request is honored.
 */
function parseRange(
  header: string,
  size: number
): { start: number; end: number } | null | "invalid" {
  const m = /^bytes=(\d*)-(\d*)/.exec(header.trim());
  if (!m) return null;
  const [, rawStart, rawEnd] = m;
  if (rawStart === "" && rawEnd === "") return null;

  let start: number;
  let end: number;
  if (rawStart === "") {
    // Suffix range: last N bytes.
    const suffix = Number(rawEnd);
    if (suffix <= 0) return "invalid";
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(rawStart);
    end = rawEnd === "" ? size - 1 : Math.min(Number(rawEnd), size - 1);
  }
  if (start > end || start >= size) return "invalid";
  return { start, end };
}

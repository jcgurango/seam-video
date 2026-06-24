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

/** Build a streaming web Response for a file, or null if it doesn't exist. */
export function fileResponse(
  filePath: string,
  contentType: string
): Response | null {
  if (!fs.existsSync(filePath)) return null;
  const size = fs.statSync(filePath).size;
  const stream = Readable.toWeb(
    fs.createReadStream(filePath)
  ) as ReadableStream;
  return new Response(stream, {
    headers: {
      "content-type": contentType,
      "content-length": String(size),
    },
  });
}

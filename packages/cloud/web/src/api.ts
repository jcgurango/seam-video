import { createAuthClient } from "better-auth/react";

/** Same-origin auth client (server mounts better-auth at /api/auth). */
export const authClient = createAuthClient();

export type MediaKind = "video" | "audio" | "image" | "pmtiles";
export type MediaSort = "date" | "added" | "used";

export interface MediaRecord {
  id: string;
  filename: string;
  kind: MediaKind;
  contentType: string | null;
  size: number;
  addedAt: number;
  lastUsedAt: number | null;
  captureDate: number | null;
  width: number | null;
  height: number | null;
  duration: number | null;
  probed: boolean;
  hasThumb: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface Page<T> {
  items: T[];
  page: number;
  pageSize: number;
  total: number;
}

const VIDEO = ["mp4", "mov", "m4v", "webm", "mkv", "avi"];
const AUDIO = ["mp3", "wav", "m4a", "aac", "ogg", "flac"];
const IMAGE = ["jpg", "jpeg", "png", "gif", "webp", "bmp", "heic"];

export function classifyByName(name: string): MediaKind | null {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  if (ext === "pmtiles") return "pmtiles";
  if (VIDEO.includes(ext)) return "video";
  if (AUDIO.includes(ext)) return "audio";
  if (IMAGE.includes(ext)) return "image";
  return null;
}

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`${res.status}: ${body}`);
  }
  return res.json() as Promise<T>;
}

export async function listMedia(
  page: number,
  pageSize: number,
  sort: MediaSort
): Promise<Page<MediaRecord>> {
  const q = new URLSearchParams({
    page: String(page),
    pageSize: String(pageSize),
    sort,
  });
  return json(await fetch(`/api/media?${q}`, { credentials: "include" }));
}

export async function uploadMedia(file: File): Promise<MediaRecord> {
  const kind = classifyByName(file.name) ?? "image";
  const form = new FormData();
  form.append("file", file);
  form.append("meta", JSON.stringify({ kind, addedAt: Date.now() }));
  return json(
    await fetch("/api/media", {
      method: "POST",
      body: form,
      credentials: "include",
    })
  );
}

export async function deleteMedia(id: string): Promise<void> {
  await fetch(`/api/media/${id}`, {
    method: "DELETE",
    credentials: "include",
  });
}

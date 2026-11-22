import { useCallback } from "react";
import { useTimeline } from "@seam/preview";
import type { Seam, SeamFile, Clip, Audio, Static, Child, RegisteredNodeType } from "@seam/core";
import { dirname, isAbsolute, relative } from "./pathUtils.js";
import type { Platform } from "./platform/index.js";
import { useSeam } from "./seamContext.js";

const VIDEO_EXTENSIONS = [".mp4", ".mov", ".webm", ".mkv", ".avi", ".m4v"];
const AUDIO_EXTENSIONS = [
  ".mp3",
  ".wav",
  ".ogg",
  ".m4a",
  ".aac",
  ".flac",
  ".opus",
];
const IMAGE_EXTENSIONS = [
  ".png",
  ".jpg",
  ".jpeg",
  ".webp",
  ".gif",
  ".bmp",
  ".avif",
  ".tif",
  ".tiff",
];

export type MediaKind = "video" | "audio" | "image" | "pmtiles";

/** DataTransfer type carrying prebuilt `Child[]` JSON when an existing OPFS
 *  clip is dragged from the media browser onto the timeline. Distinct from an
 *  OS file drop (`"Files"`), which goes through the import path instead. */
export const SOURCE_DRAG_MIME = "application/x-seam-source";

/** How long an imported image holds on the timeline by default. Same rough
 *  convention as most NLEs — a five-second still is long enough to read but
 *  short enough that no one will mistake it for a freeze bug. Exported so the
 *  media browser can build the same node for an existing image source. */
export const IMAGE_DEFAULT_DURATION_S = 5;

/** How long a node imported through an extension (a `.pmtiles` → the Map
 *  extension's `map`) holds by default — like a still. The author sets its
 *  real length, camera and so on afterwards. */
const NODE_DEFAULT_DURATION_S = 5;

const extensionOf = (name: string): string => {
  const dot = name.lastIndexOf(".");
  return dot < 0 ? "" : name.slice(dot + 1).toLowerCase();
};

/** The extension node type that imports files named like `name` (its
 *  `NodeTypeDef.import.extensions`), or null. */
export function importerFor(seam: Seam, name: string): RegisteredNodeType | null {
  const ext = extensionOf(name);
  if (!ext) return null;
  for (const def of seam.nodeTypes.values()) {
    if (def.import?.extensions.includes(ext)) return def;
  }
  return null;
}

/** True when a file of this name is read by byte range straight from storage
 *  (a multi-GB map archive) — it must never be loaded whole or given a blob
 *  URL. */
export function isByteRangeFile(seam: Seam, name: string): boolean {
  return importerFor(seam, name)?.import?.byteRange === true;
}

/** Classify by filename extension alone. Used both by `classifyMediaFile`
 *  (with a MIME fallback) and by the media browser, which only has the
 *  stored OPFS filename to go on. */
export function classifyByName(name: string): MediaKind | null {
  const n = name.toLowerCase();
  if (n.endsWith(".pmtiles")) return "pmtiles";
  if (VIDEO_EXTENSIONS.some((ext) => n.endsWith(ext))) return "video";
  if (AUDIO_EXTENSIONS.some((ext) => n.endsWith(ext))) return "audio";
  if (IMAGE_EXTENSIONS.some((ext) => n.endsWith(ext))) return "image";
  return null;
}

function classifyMediaFile(file: File): MediaKind | null {
  const byName = classifyByName(file.name);
  if (byName) return byName;
  if (file.type.startsWith("video/")) return "video";
  if (file.type.startsWith("audio/")) return "audio";
  if (file.type.startsWith("image/")) return "image";
  return null;
}

function probeDuration(file: File, kind: MediaKind): Promise<number> {
  return new Promise((res, reject) => {
    const url = URL.createObjectURL(file);
    const el =
      kind === "video"
        ? document.createElement("video")
        : document.createElement("audio");
    el.preload = "metadata";
    el.onloadedmetadata = () => {
      res(el.duration);
      URL.revokeObjectURL(url);
      el.remove();
    };
    el.onerror = () => {
      URL.revokeObjectURL(url);
      el.remove();
      reject(new Error(`Could not read metadata for ${file.name}`));
    };
    el.src = url;
  });
}

function toRelativeSource(absPath: string, baseDir: string): string {
  const rel = relative(baseDir, absPath);
  if (!rel.startsWith("..") && !isAbsolute(rel)) return rel;
  return absPath;
}

function findInsertionIndex(seam: Seam, doc: SeamFile, currentTime: number): number {
  if ((doc.children ?? []).length === 0) return 0;
  const resolved = seam.resolveComposition(doc);
  const boundaries = [0, ...resolved.children.map((c) => c.timelineEnd)];
  let bestIdx = 0;
  let bestDist = Math.abs(currentTime - boundaries[0]);
  for (let i = 1; i < boundaries.length; i++) {
    const dist = Math.abs(currentTime - boundaries[i]);
    if (dist < bestDist) {
      bestDist = dist;
      bestIdx = i;
    }
  }
  return bestIdx;
}

/** Classify each file, probe duration where needed, store via the
 *  platform, and build a Child node per file. Unrecognised files are
 *  skipped. Caller decides where to place the returned nodes. */
export async function buildItemsFromFiles(
  seam: Seam,
  fileList: FileList | File[],
  platform: Platform,
  baseDir: string | null,
): Promise<Child[]> {
  const classified = Array.from(fileList)
    .map((file) => ({ file, kind: classifyMediaFile(file) }))
    .filter((e): e is { file: File; kind: MediaKind } => e.kind !== null);
  if (classified.length === 0) return [];

  const newChildren: Child[] = [];
  for (const { file, kind } of classified) {
    // Images and pmtiles have no temporal source — skip the probe and
    // use the default duration. probeDuration on a non-AV blob would
    // just fail anyway.
    const duration =
      kind === "image"
        ? IMAGE_DEFAULT_DURATION_S
        : kind === "pmtiles"
          ? NODE_DEFAULT_DURATION_S
          : await probeDuration(file, kind);
    const stored = await platform.importClip(file);
    // On Electron, `stored` is an absolute path; collapse to relative if
    // it lives under the .seam file's directory. On Web, it's already
    // just a filename inside clips/ and stays as-is.
    const source =
      platform.kind === "electron" && baseDir && isAbsolute(stored)
        ? toRelativeSource(stored, baseDir)
        : stored;
    const item = buildItemFromSource(seam, kind, source, duration);
    if (item) newChildren.push(item);
  }
  return newChildren;
}

/** Build the timeline Child for an already-stored media `source` of a known
 *  `kind`. `duration` is the natural length: for video/audio it's the probed
 *  source duration (→ `out`), for an image / extension-imported file the
 *  display hold. Shared by
 *  the file importer and the media browser's drag-to-timeline. */
export function buildItemFromSource(
  seam: Seam,
  kind: MediaKind,
  source: string,
  duration: number,
): Child | null {
  switch (kind) {
    case "video":
      return { type: "clip", source, in: 0, out: duration } satisfies Clip;
    case "audio":
      return { type: "audio", source, in: 0, out: duration } satisfies Audio;
    case "image":
      return { type: "static", source, duration } satisfies Static;
    default: {
      // Not core media: the node comes from whichever extension imports
      // this kind of file (the Map extension, for a pmtiles archive). Null
      // when no installed extension does.
      const importer = importerFor(seam, source)?.import;
      return importer ? (importer.create(source, { duration }) as unknown as Child) : null;
    }
  }
}

export function useImport(
  doc: SeamFile,
  filePath: string | null,
  onDocumentChange: (doc: SeamFile) => void,
  platform: Platform
): (files: FileList | File[], insertIndex?: number) => Promise<void> {
  const seam = useSeam();
  const { currentTime } = useTimeline();

  return useCallback(
    async (fileList: FileList | File[], insertIndex?: number) => {
      const baseDir = filePath ? dirname(filePath) : null;
      const newChildren = await buildItemsFromFiles(seam, fileList, platform, baseDir);
      if (newChildren.length === 0) return;

      // Cursor-based callers pass `insertIndex` (computed via the same
      // reorder snap math); the file picker / fallback path falls back
      // to the nearest playhead boundary.
      const insertAt = insertIndex ?? findInsertionIndex(seam, doc, currentTime);
      const merged = [...(doc.children ?? [])];
      merged.splice(insertAt, 0, ...newChildren);
      onDocumentChange({ ...doc, children: merged });
    },
    [doc, filePath, currentTime, onDocumentChange, platform]
  );
}

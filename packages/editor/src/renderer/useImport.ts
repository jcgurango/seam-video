import { useCallback } from "react";
import { useTimeline } from "@seam/preview";
import { resolveComposition } from "@seam/core";
import type { SeamFile, Clip, Audio, Static, Child, Graphic } from "@seam/core";
import { dirname, isAbsolute, relative } from "./pathUtils.js";
import type { Platform } from "./platform/index.js";

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

/** Sensible default for a pmtiles drop — 5s static map. Authors can
 *  then animate camera + paths in the graphic JSON. */
const PMTILES_DEFAULT_DURATION = 5;
/** Default map view. Authors should set their own; 0,0 just centers
 *  somewhere visible until they update it. */
const PMTILES_DEFAULT_VIEW = { latitude: 0, longitude: 0, zoom: 1 };

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

function findInsertionIndex(doc: SeamFile, currentTime: number): number {
  if ((doc.children ?? []).length === 0) return 0;
  const resolved = resolveComposition(doc);
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
          ? PMTILES_DEFAULT_DURATION
          : await probeDuration(file, kind);
    const stored = await platform.importClip(file);
    // On Electron, `stored` is an absolute path; collapse to relative if
    // it lives under the .seam file's directory. On Web, it's already
    // just a filename inside clips/ and stays as-is.
    const source =
      platform.kind === "electron" && baseDir && isAbsolute(stored)
        ? toRelativeSource(stored, baseDir)
        : stored;
    newChildren.push(buildItemFromSource(kind, source, duration));
  }
  return newChildren;
}

/** Build the timeline Child for an already-stored media `source` of a known
 *  `kind`. `duration` is the natural length: for video/audio it's the probed
 *  source duration (→ `out`), for image/pmtiles the display hold. Shared by
 *  the file importer and the media browser's drag-to-timeline. */
export function buildItemFromSource(
  kind: MediaKind,
  source: string,
  duration: number,
): Child {
  switch (kind) {
    case "video":
      return { type: "clip", source, in: 0, out: duration } satisfies Clip;
    case "audio":
      return { type: "audio", source, in: 0, out: duration } satisfies Audio;
    case "pmtiles":
      return makeMapGraphic(source, duration);
    case "image":
      return { type: "static", source, duration } satisfies Static;
  }
}

/** A graphic with a single Map element filling the canvas, ready for
 *  the author to set lat/lng/zoom. Static (one keyframe) for now —
 *  refining the editing experience comes later.
 *
 *  fabric defaults `originX`/`originY` to `"center"`, so `left`/`top`
 *  specify the center of the Map. To fill a 1080×1920 canvas we center
 *  the 1080×1920 Map at (540, 960). Authoring `left: 0, top: 0` would
 *  put the center at the canvas origin and clip three quarters of the
 *  Map off-screen. */
function makeMapGraphic(source: string, duration: number): Graphic {
  const W = 1080;
  const H = 1920;
  return {
    type: "graphic",
    duration,
    contentWidth: W,
    contentHeight: H,
    frames: [
      [
        0,
        [
          {
            id: "map",
            type: "Map",
            source,
            left: W / 2,
            top: H / 2,
            width: W,
            height: H,
            latitude: PMTILES_DEFAULT_VIEW.latitude,
            longitude: PMTILES_DEFAULT_VIEW.longitude,
            zoom: PMTILES_DEFAULT_VIEW.zoom,
          },
        ],
      ],
    ],
  };
}

export function useImport(
  doc: SeamFile,
  filePath: string | null,
  onDocumentChange: (doc: SeamFile) => void,
  platform: Platform
): (files: FileList | File[], insertIndex?: number) => Promise<void> {
  const { currentTime } = useTimeline();

  return useCallback(
    async (fileList: FileList | File[], insertIndex?: number) => {
      const baseDir = filePath ? dirname(filePath) : null;
      const newChildren = await buildItemsFromFiles(fileList, platform, baseDir);
      if (newChildren.length === 0) return;

      // Cursor-based callers pass `insertIndex` (computed via the same
      // reorder snap math); the file picker / fallback path falls back
      // to the nearest playhead boundary.
      const insertAt = insertIndex ?? findInsertionIndex(doc, currentTime);
      const merged = [...(doc.children ?? [])];
      merged.splice(insertAt, 0, ...newChildren);
      onDocumentChange({ ...doc, children: merged });
    },
    [doc, filePath, currentTime, onDocumentChange, platform]
  );
}

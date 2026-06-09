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

/** How long an imported image holds on the timeline by default. Same
 *  rough convention as most NLEs — a five-second still is long enough
 *  to read but short enough that no one will mistake it for a freeze
 *  bug. */
const IMAGE_DEFAULT_DURATION = 5;

type MediaKind = "video" | "audio" | "image" | "pmtiles";

/** Sensible default for a pmtiles drop — 5s static map. Authors can
 *  then animate camera + paths in the graphic JSON. */
const PMTILES_DEFAULT_DURATION = 5;
/** Default map view. Authors should set their own; 0,0 just centers
 *  somewhere visible until they update it. */
const PMTILES_DEFAULT_VIEW = { latitude: 0, longitude: 0, zoom: 1 };

function classifyMediaFile(file: File): MediaKind | null {
  const name = file.name.toLowerCase();
  if (name.endsWith(".pmtiles")) return "pmtiles";
  if (VIDEO_EXTENSIONS.some((ext) => name.endsWith(ext))) return "video";
  if (AUDIO_EXTENSIONS.some((ext) => name.endsWith(ext))) return "audio";
  if (IMAGE_EXTENSIONS.some((ext) => name.endsWith(ext))) return "image";
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
  if (doc.children.length === 0) return 0;
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
        ? IMAGE_DEFAULT_DURATION
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
    if (kind === "video") {
      const node: Clip = { type: "clip", source, in: 0, out: duration };
      newChildren.push(node);
    } else if (kind === "audio") {
      const node: Audio = { type: "audio", source, in: 0, out: duration };
      newChildren.push(node);
    } else if (kind === "pmtiles") {
      newChildren.push(makeMapGraphic(source, duration));
    } else {
      const node: Static = { type: "static", source, duration };
      newChildren.push(node);
    }
  }
  return newChildren;
}

/** A graphic with a single Map element filling the canvas, ready for
 *  the author to set lat/lng/zoom. Static (one keyframe) for now —
 *  refining the editing experience comes later. */
function makeMapGraphic(source: string, duration: number): Graphic {
  return {
    type: "graphic",
    duration,
    contentWidth: 1080,
    contentHeight: 1920,
    frames: [
      [
        0,
        [
          {
            id: "map",
            type: "Map",
            source,
            left: 0,
            top: 0,
            width: 1080,
            height: 1920,
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
      const merged = [...doc.children];
      merged.splice(insertAt, 0, ...newChildren);
      onDocumentChange({ ...doc, children: merged });
    },
    [doc, filePath, currentTime, onDocumentChange, platform]
  );
}

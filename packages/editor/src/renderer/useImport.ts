import { useCallback } from "react";
import { useTimeline } from "@seam/preview";
import { resolveComposition } from "@seam/core";
import type { SeamFile, Clip, Audio, Child } from "@seam/core";
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

type MediaKind = "video" | "audio";

function classifyMediaFile(file: File): MediaKind | null {
  const name = file.name.toLowerCase();
  if (VIDEO_EXTENSIONS.some((ext) => name.endsWith(ext))) return "video";
  if (AUDIO_EXTENSIONS.some((ext) => name.endsWith(ext))) return "audio";
  // Fall back to the browser-supplied MIME type when the extension is missing
  // or unfamiliar — picks up things like webm/ogg used for audio-only.
  if (file.type.startsWith("video/")) return "video";
  if (file.type.startsWith("audio/")) return "audio";
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

export function useImport(
  doc: SeamFile,
  filePath: string | null,
  onDocumentChange: (doc: SeamFile) => void,
  platform: Platform
): (files: FileList | File[]) => Promise<void> {
  const { currentTime } = useTimeline();

  return useCallback(
    async (fileList: FileList | File[]) => {
      const classified = Array.from(fileList)
        .map((file) => ({ file, kind: classifyMediaFile(file) }))
        .filter(
          (e): e is { file: File; kind: MediaKind } => e.kind !== null
        );
      if (classified.length === 0) return;

      const baseDir = filePath ? dirname(filePath) : null;
      const newChildren: Child[] = [];
      for (const { file, kind } of classified) {
        const duration = await probeDuration(file, kind);
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
        } else {
          const node: Audio = { type: "audio", source, in: 0, out: duration };
          newChildren.push(node);
        }
      }

      const insertAt = findInsertionIndex(doc, currentTime);
      const merged = [...doc.children];
      merged.splice(insertAt, 0, ...newChildren);
      onDocumentChange({ ...doc, children: merged });
    },
    [doc, filePath, currentTime, onDocumentChange, platform]
  );
}

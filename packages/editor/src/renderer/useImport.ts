import { useCallback } from "react";
import { useTimeline } from "@seam/preview";
import { resolveComposition } from "@seam/core";
import type { SeamFile, Clip } from "@seam/core";
import { dirname, isAbsolute, relative } from "./pathUtils.js";
import type { Platform } from "./platform/index.js";

const VIDEO_EXTENSIONS = [".mp4", ".mov", ".webm", ".mkv", ".avi", ".m4v"];

function isVideoFile(name: string): boolean {
  return VIDEO_EXTENSIONS.some((ext) => name.toLowerCase().endsWith(ext));
}

function probeDuration(file: File): Promise<number> {
  return new Promise((res, reject) => {
    const url = URL.createObjectURL(file);
    const video = document.createElement("video");
    video.preload = "metadata";
    video.onloadedmetadata = () => {
      res(video.duration);
      URL.revokeObjectURL(url);
      video.remove();
    };
    video.onerror = () => {
      URL.revokeObjectURL(url);
      video.remove();
      reject(new Error(`Could not read metadata for ${file.name}`));
    };
    video.src = url;
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
      const files = Array.from(fileList).filter((f) => isVideoFile(f.name));
      if (files.length === 0) return;

      const baseDir = filePath ? dirname(filePath) : null;
      const newClips: Clip[] = [];
      for (const file of files) {
        const duration = await probeDuration(file);
        const stored = await platform.importClip(file);
        // On Electron, `stored` is an absolute path; collapse to relative if
        // it lives under the .seam file's directory. On Web, it's already
        // just a filename inside clips/ and stays as-is.
        const source =
          platform.kind === "electron" && baseDir && isAbsolute(stored)
            ? toRelativeSource(stored, baseDir)
            : stored;
        newClips.push({ type: "clip", source, in: 0, out: duration });
      }

      const insertAt = findInsertionIndex(doc, currentTime);
      const newChildren = [...doc.children];
      newChildren.splice(insertAt, 0, ...newClips);
      onDocumentChange({ ...doc, children: newChildren });
    },
    [doc, filePath, currentTime, onDocumentChange, platform]
  );
}

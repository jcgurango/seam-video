// Editor-side container for the fabric frame editor. Binds a graphic node's
// keyframe `frames[frameIndex][1]` (the fabric-object scene) to the live
// document: it reads the authored objects out of the doc at `graphicPath`,
// hands them to `<FrameEditorCanvas>` (from @seam/preview, which owns fabric +
// the production Map/source machinery), and writes edited objects back through
// `onDocumentChange`. The JSON editor and the right-pane preview both update
// from that same doc, so all three stay in sync.

import React, { useCallback, useMemo } from "react";
import { X } from "lucide-react";
import { FrameEditorCanvas } from "@seam/preview";
import { DEFAULT_CANVAS_WIDTH, DEFAULT_CANVAS_HEIGHT } from "@seam/core";
import type { SeamFile, Graphic } from "@seam/core";
import { parsePath, getNodeAtPath } from "./nodePath.js";
import { setFrameObjects } from "./keyframeEdit.js";
import { classifyByName } from "./useImport.js";
import { dirname, isAbsolute, relative } from "./pathUtils.js";
import type { Platform } from "./platform/index.js";

export interface FrameEditorTarget {
  /** Path key of the graphic node whose frame we're editing (`children.3`). */
  graphicPath: string;
  /** Index into the graphic's `frames` array. */
  frameIndex: number;
}

/** Coerce a graphic content dim to a pixel number for the editor canvas
 *  (frames author plain numbers; a percentage `Length` has no parent here). */
function dim(value: unknown, fallback: number): number {
  return typeof value === "number" && value > 0 ? value : fallback;
}

export default function FrameEditorPane({
  document: doc,
  target,
  onDocumentChange,
  filePath,
  platform,
  onClose,
}: {
  document: SeamFile;
  target: FrameEditorTarget;
  onDocumentChange: (doc: SeamFile) => void;
  filePath: string | null;
  platform: Platform;
  onClose: () => void;
}) {
  const path = useMemo(() => parsePath(target.graphicPath), [target.graphicPath]);

  const graphic = useMemo<Graphic | null>(() => {
    const node = getNodeAtPath(doc, path);
    return node && node.type === "graphic" ? node : null;
  }, [doc, path]);

  const frame = graphic?.frames?.[target.frameIndex];
  const objects = useMemo<unknown[]>(
    () => (Array.isArray(frame) ? ((frame[1] as unknown[]) ?? []) : []),
    [frame],
  );

  const basePath = filePath ? dirname(filePath) : "";

  const handleChange = useCallback(
    (next: unknown[]) => {
      onDocumentChange(setFrameObjects(doc, path, target.frameIndex, next));
    },
    [doc, path, target.frameIndex, onDocumentChange],
  );

  // Store a dropped file via the platform (OPFS on web → a filename source)
  // and report its kind so the canvas can place an Image or Map. Only the
  // graphic-meaningful kinds (image, pmtiles) are accepted; video/audio drops
  // belong on the timeline, not inside a frame.
  const handleImportFile = useCallback(
    async (file: File): Promise<{ source: string; kind: "image" | "pmtiles" } | null> => {
      // SVGs import as rasters (fabric loads them into an <img>) — keep them
      // alongside the other image formats. Other graphic-meaningful kinds are
      // image + pmtiles; video/audio belong on the timeline, not in a frame.
      const isSvg =
        file.name.toLowerCase().endsWith(".svg") || file.type === "image/svg+xml";
      const kind = isSvg ? "image" : classifyByName(file.name);
      if (kind !== "image" && kind !== "pmtiles") return null;
      const stored = await platform.importClip(file);
      // Electron returns an absolute path; collapse to relative when it lives
      // under the .seam file's dir (web returns a bare OPFS filename already).
      let source = stored;
      if (platform.kind === "electron" && basePath && isAbsolute(stored)) {
        const rel = relative(basePath, stored);
        if (!rel.startsWith("..") && !isAbsolute(rel)) source = rel;
      }
      return { source, kind };
    },
    [platform, basePath],
  );

  return (
    <div
      style={{
        flex: "1 1 0",
        minWidth: 0,
        minHeight: 0,
        display: "flex",
        flexDirection: "column",
        background: "#000",
        borderRight: "1px solid #333",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: "4px 8px",
          background: "#1a1a1a",
          borderBottom: "1px solid #333",
          flexShrink: 0,
          fontSize: 11,
          color: "#aaa",
        }}
      >
        <span style={{ fontFamily: "ui-monospace, monospace" }}>
          {target.graphicPath} · frame {target.frameIndex}
        </span>
        {!graphic && (
          <span style={{ color: "#e0a050" }}>(graphic not found — closing)</span>
        )}
        <button
          onClick={onClose}
          title="Close frame editor"
          style={{
            marginLeft: "auto",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            width: 22,
            height: 22,
            background: "#2a2a2a",
            border: "none",
            borderRadius: 4,
            color: "#ddd",
            cursor: "pointer",
          }}
        >
          <X size={14} />
        </button>
      </div>
      {graphic && frame ? (
        <FrameEditorCanvas
          objects={objects}
          contentWidth={dim(graphic.contentWidth, DEFAULT_CANVAS_WIDTH)}
          contentHeight={dim(graphic.contentHeight, DEFAULT_CANVAS_HEIGHT)}
          basePath={basePath}
          onChange={handleChange}
          onImportFile={handleImportFile}
        />
      ) : (
        <div style={{ flex: 1, minHeight: 0 }} />
      )}
    </div>
  );
}

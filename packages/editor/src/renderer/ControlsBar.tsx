import React, { useCallback, useEffect, useRef } from "react";
import { useTimeline } from "@seam/preview";
import { resolveComposition, resolveOverlay } from "@seam/core";
import type { SeamFile, Clip, Child, RefChild } from "@seam/core";
import {
  Play,
  Pause,
  SkipBack,
  Repeat,
  Scissors,
  FolderOpen,
  Trash2,
  Undo2,
  Redo2,
  ArrowLeft,
  LogIn,
} from "lucide-react";
import { useImport } from "./useImport.js";
import type { View } from "./views.js";
import type { Platform } from "./platform/index.js";

interface ControlsBarProps {
  document: SeamFile;
  filePath: string | null;
  selectedIndices: number[];
  onSelectionChange: (indices: number[]) => void;
  onDocumentChange: (doc: SeamFile) => void;
  onUndo: () => void;
  onRedo: () => void;
  canUndo: boolean;
  canRedo: boolean;
  view: View;
  platform: Platform;
  onExit: (viewTime: number) => void;
  onEnterClip: (rootIndex: number, currentParentTime: number) => void;
}

// ── Slice logic ──────────────────────────────────────────────────────

function clipBaseSpeed(clip: {
  in: number;
  out: number;
  speed?: number;
  duration?: number;
}): number {
  if (clip.duration != null) return (clip.out - clip.in) / clip.duration;
  return clip.speed ?? 1;
}

/** Pick a ref name not yet used in the given refs dict. */
function uniqueRefName(refs: Record<string, Child> | undefined, base: string): string {
  if (!refs) return `${base}_1`;
  let i = 1;
  while (refs[`${base}_${i}`] != null) i++;
  return `${base}_${i}`;
}

function sliceAtPlayhead(doc: SeamFile, currentTime: number): SeamFile | null {
  const resolved = resolveComposition(doc);
  const children = doc.children;

  let targetIdx = -1;
  let timelineStart = 0;

  for (let i = 0; i < resolved.children.length; i++) {
    const rc = resolved.children[i];
    if (currentTime > rc.timelineStart && currentTime < rc.timelineEnd) {
      targetIdx = i;
      timelineStart = rc.timelineStart;
      break;
    }
  }

  if (targetIdx === -1) return null;

  const child = children[targetIdx];
  if (child.type === "empty") return null;

  const offset = currentTime - timelineStart;
  const newChildren = [...children];

  // Clip: split via source in/out.
  if (child.type === "clip") {
    const speed = clipBaseSpeed(child);
    const splitSource = child.in + offset * speed;
    const { duration: _d, ...base } = child;
    const first: Clip = { ...base, out: splitSource };
    const second: Clip = { ...base, in: splitSource };
    newChildren.splice(targetIdx, 1, first, second);
    return { ...doc, children: newChildren };
  }

  // Ref: already a shared definition; just split the window.
  if (child.type === "ref") {
    // The ref's in/out windows the def's resolved duration. Resolve the
    // current document with the ref expanded to find the effective duration.
    const effectiveDuration =
      resolved.children[targetIdx].timelineEnd -
      resolved.children[targetIdx].timelineStart;
    const refIn = child.in ?? 0;
    const refOut = child.out ?? refIn + effectiveDuration;
    const splitPoint = refIn + offset;
    const first: RefChild = { ...child, in: refIn, out: splitPoint };
    const second: RefChild = { ...child, in: splitPoint, out: refOut };
    newChildren.splice(targetIdx, 1, first, second);
    return { ...doc, children: newChildren };
  }

  // Composition or overlay: promote to a ref before splitting so both
  // halves share a single underlying definition.
  if (child.type === "composition" || child.type === "overlay") {
    const innerDuration =
      child.type === "composition"
        ? resolveComposition(child).duration
        : resolveOverlay(child).duration;
    const childIn = child.in ?? 0;
    const childOut = child.out ?? innerDuration;
    const splitPoint = childIn + offset;

    // Strip the child's own `in`/`out`/`flex` before making it a ref def;
    // those lived on the original child as its usage-level window. The
    // definition itself should be "naked" so ref siblings can window it.
    const {
      in: _i,
      out: _o,
      flex: _f,
      overflow: _ov,
      underflow: _uf,
      ...defBase
    } = child as typeof child & { flex?: number };
    const def = defBase as Child;

    const refName = uniqueRefName(doc.refs, "split");
    const newRefs = { ...(doc.refs ?? {}), [refName]: def };

    const first: RefChild = {
      type: "ref",
      source: refName,
      in: childIn,
      out: splitPoint,
    };
    const second: RefChild = {
      type: "ref",
      source: refName,
      in: splitPoint,
      out: childOut,
    };
    newChildren.splice(targetIdx, 1, first, second);

    return { ...doc, refs: newRefs, children: newChildren };
  }

  return null;
}

// ── Styles ───────────────────────────────────────────────────────────

const BAR_STYLE: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  gap: 4,
  padding: "8px 16px",
  background: "#2a2a2a",
  borderTop: "1px solid #333",
};

const BTN_STYLE: React.CSSProperties = {
  background: "none",
  border: "1px solid #555",
  color: "#fff",
  borderRadius: 6,
  cursor: "pointer",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  width: 44,
  height: 44,
  padding: 0,
  flexShrink: 0,
};

const BTN_ACTIVE: React.CSSProperties = {
  ...BTN_STYLE,
  background: "#4a9eff",
  borderColor: "#4a9eff",
};

const SEPARATOR: React.CSSProperties = {
  width: 1,
  height: 28,
  background: "#444",
  margin: "0 8px",
  flexShrink: 0,
};

const TIME_STYLE: React.CSSProperties = {
  color: "#999",
  fontSize: 13,
  fontFamily: "monospace",
  minWidth: 110,
  textAlign: "center",
  flexShrink: 0,
};

const ICON_SIZE = 20;

// ── Component ────────────────────────────────────────────────────────

export default function ControlsBar({
  document: doc,
  filePath,
  selectedIndices,
  onSelectionChange,
  onDocumentChange,
  onUndo,
  onRedo,
  canUndo,
  canRedo,
  view,
  onExit,
  onEnterClip,
  platform,
}: ControlsBarProps) {
  const {
    currentTime,
    totalDuration,
    isPlaying,
    loop,
    play,
    pause,
    restart,
    seek,
    setLoop,
  } = useTimeline();

  const fileInputRef = useRef<HTMLInputElement>(null);
  const importFiles = useImport(doc, filePath, onDocumentChange, platform);

  // ── Slice ──────────────────────────────────────────────────────

  const handleSlice = useCallback(() => {
    const nextDoc = sliceAtPlayhead(doc, currentTime);
    if (nextDoc) onDocumentChange(nextDoc);
  }, [doc, currentTime, onDocumentChange]);

  // S key shortcut (disabled in non-root views)
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (view.type !== "root") return;
      if (e.key === "s" && !e.ctrlKey && !e.metaKey && !e.altKey) {
        handleSlice();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [handleSlice, view]);

  // Escape to exit a nested view
  useEffect(() => {
    if (view.type === "root") return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onExit(currentTime);
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [view, currentTime, onExit]);

  // ── Import ─────────────────────────────────────────────────────

  const handleImportClick = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  const handleFileInput = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      if (e.target.files && e.target.files.length > 0) {
        importFiles(e.target.files);
        e.target.value = "";
      }
    },
    [importFiles]
  );

  // ── Scrub bar ──────────────────────────────────────────────────

  const progress = totalDuration > 0 ? (currentTime / totalDuration) * 100 : 0;

  const handleScrub = (e: React.MouseEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const pct = (e.clientX - rect.left) / rect.width;
    seek(pct * totalDuration);
  };

  // ── Render ─────────────────────────────────────────────────────

  return (
    <div>
      {/* Scrub bar */}
      <div
        onClick={handleScrub}
        style={{
          height: 4,
          background: "#444",
          cursor: "pointer",
          position: "relative",
        }}
      >
        <div
          style={{
            position: "absolute",
            height: "100%",
            width: `${progress}%`,
            background: "#4a9eff",
          }}
        />
      </div>

      {/* Button bar */}
      <div style={BAR_STYLE}>
        {/* Transport */}
        <button onClick={restart} style={BTN_STYLE} title="Restart">
          <SkipBack size={ICON_SIZE} />
        </button>
        <button
          onClick={isPlaying ? pause : play}
          style={BTN_STYLE}
          title={isPlaying ? "Pause" : "Play"}
        >
          {isPlaying ? <Pause size={ICON_SIZE} /> : <Play size={ICON_SIZE} />}
        </button>
        <button
          onClick={() => setLoop(!loop)}
          style={loop ? BTN_ACTIVE : BTN_STYLE}
          title="Loop"
        >
          <Repeat size={ICON_SIZE} />
        </button>

        {/* Time display */}
        <span style={TIME_STYLE}>
          {currentTime.toFixed(1)}s / {totalDuration.toFixed(1)}s
        </span>

        <div style={SEPARATOR} />

        {/* Undo / Redo */}
        <button
          onClick={onUndo}
          style={{ ...BTN_STYLE, opacity: canUndo ? 1 : 0.3 }}
          disabled={!canUndo}
          title="Undo (Ctrl+Z)"
        >
          <Undo2 size={ICON_SIZE} />
        </button>
        <button
          onClick={onRedo}
          style={{ ...BTN_STYLE, opacity: canRedo ? 1 : 0.3 }}
          disabled={!canRedo}
          title="Redo (Ctrl+Shift+Z)"
        >
          <Redo2 size={ICON_SIZE} />
        </button>

        <div style={SEPARATOR} />

        {/* Edit tools */}
        {view.type === "root" ? (
          <>
            <button onClick={handleSlice} style={BTN_STYLE} title="Slice (S)">
              <Scissors size={ICON_SIZE} />
            </button>
            <button
              onClick={() => {
                const clipIdx = [...selectedIndices]
                  .sort((a, b) => a - b)
                  .find((i) => doc.children[i]?.type === "clip");
                if (clipIdx != null) onEnterClip(clipIdx, currentTime);
              }}
              style={{
                ...BTN_STYLE,
                opacity: selectedIndices.some(
                  (i) => doc.children[i]?.type === "clip"
                )
                  ? 1
                  : 0.3,
              }}
              disabled={
                !selectedIndices.some((i) => doc.children[i]?.type === "clip")
              }
              title="Enter clip (double-click)"
            >
              <LogIn size={ICON_SIZE} />
            </button>
            <button
              onClick={() => {
                if (selectedIndices.length > 0) {
                  const sortedDesc = [...selectedIndices].sort((a, b) => b - a);
                  const newChildren = [...doc.children];
                  for (const i of sortedDesc) newChildren.splice(i, 1);
                  onDocumentChange({ ...doc, children: newChildren });
                  onSelectionChange([]);
                }
              }}
              style={{
                ...BTN_STYLE,
                opacity: selectedIndices.length > 0 ? 1 : 0.3,
              }}
              disabled={selectedIndices.length === 0}
              title="Delete (Del)"
            >
              <Trash2 size={ICON_SIZE} />
            </button>
            <button onClick={handleImportClick} style={BTN_STYLE} title="Import">
              <FolderOpen size={ICON_SIZE} />
            </button>
          </>
        ) : (
          <button
            onClick={() => onExit(currentTime)}
            style={BTN_STYLE}
            title="Back (Esc)"
          >
            <ArrowLeft size={ICON_SIZE} />
          </button>
        )}
        <input
          ref={fileInputRef}
          type="file"
          accept="video/*"
          multiple
          onChange={handleFileInput}
          style={{ display: "none" }}
        />
      </div>
    </div>
  );
}

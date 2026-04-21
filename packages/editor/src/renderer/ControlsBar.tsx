import React, { useCallback, useEffect, useRef } from "react";
import { useTimeline } from "@seam/preview";
import { resolveComposition } from "@seam/core";
import type { SeamFile, Clip, Child, Composition } from "@seam/core";
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
} from "lucide-react";
import { useImport } from "./useImport.js";
import type { View } from "./views.js";
import type { Platform } from "./platform/index.js";

interface ControlsBarProps {
  document: SeamFile;
  filePath: string | null;
  selectedIndex: number | null;
  onSelect: (index: number | null) => void;
  onDocumentChange: (doc: SeamFile) => void;
  onUndo: () => void;
  onRedo: () => void;
  canUndo: boolean;
  canRedo: boolean;
  view: View;
  platform: Platform;
  onExit: (viewTime: number) => void;
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

function sliceAtPlayhead(doc: SeamFile, currentTime: number): Child[] | null {
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

  if (child.type === "clip") {
    const speed = clipBaseSpeed(child);
    const splitSource = child.in + offset * speed;
    const { duration: _d, ...base } = child;
    const first: Clip = { ...base, out: splitSource };
    const second: Clip = { ...base, in: splitSource };
    newChildren.splice(targetIdx, 1, first, second);
    return newChildren;
  }

  if (child.type === "composition" || child.type === "overlay") {
    const innerDuration = resolveComposition(child as Composition).duration;
    const childIn = child.in ?? 0;
    const childOut = child.out ?? innerDuration;
    const splitPoint = childIn + offset;
    const first = { ...child, in: childIn, out: splitPoint } as typeof child;
    const second = { ...child, in: splitPoint, out: childOut } as typeof child;
    newChildren.splice(targetIdx, 1, first, second);
    return newChildren;
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
  selectedIndex,
  onSelect,
  onDocumentChange,
  onUndo,
  onRedo,
  canUndo,
  canRedo,
  view,
  onExit,
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
    const newChildren = sliceAtPlayhead(doc, currentTime);
    if (newChildren) {
      onDocumentChange({ ...doc, children: newChildren });
    }
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
                if (selectedIndex != null) {
                  const newChildren = [...doc.children];
                  newChildren.splice(selectedIndex, 1);
                  onDocumentChange({ ...doc, children: newChildren });
                  onSelect(null);
                }
              }}
              style={{
                ...BTN_STYLE,
                opacity: selectedIndex != null ? 1 : 0.3,
              }}
              disabled={selectedIndex == null}
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

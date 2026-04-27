import React, { useRef, useMemo, useCallback, useState, useEffect } from "react";
import { useTimeline } from "@seam/preview";
import type { ResolvedTimeline, ResolvedChild, SeamFile, Clip } from "@seam/core";
import { useImport } from "./useImport.js";
import type { View } from "./views.js";
import type { History } from "./useHistory.js";
import type { Platform } from "./platform/index.js";

export interface TimelinePanelProps {
  timeline: ResolvedTimeline;
  document?: SeamFile;
  /**
   * The document corresponding to `timeline` (i.e. after any view-level
   * unwrapping, like entering a composition). Used to resolve block labels
   * and to separate `children` vs `attachments` on the timeline.
   */
  viewDocument?: SeamFile;
  filePath?: string | null;
  isMobile: boolean;
  selectedIndices: number[];
  onSelectionChange: (indices: number[]) => void;
  /** Mobile long-press triggers this to enter multi-select mode with index added. */
  onMultiSelectStart: (index: number) => void;
  /** True while mobile multi-select mode is active; taps toggle membership. */
  multiSelectMode: boolean;
  onDocumentChange?: (doc: SeamFile) => void;
  view: View;
  onEnterClip: (rootIndex: number, currentParentTime: number) => void;
  history: History<SeamFile>;
  platform: Platform;
}

const ROW_HEIGHT = 32;
const ROW_GAP = 2;
const RULER_HEIGHT = 24;
const MIN_PX_PER_SEC = 10;
const MAX_PX_PER_SEC = 1000;
const DEFAULT_PX_PER_SEC = 100;
const HANDLE_WIDTH = 10;
const LONG_PRESS_MS = 500;
const LONG_PRESS_SLOP_PX = 6;

interface ChildBlock {
  child: ResolvedChild;
  index: number;
  row: number;
  isAttachment: boolean;
}

/**
 * Greedy row-packer. Items past `attachmentStartIndex` are laid out into a
 * separate band below the children band, each band packed independently —
 * attachments only collide (and thus stack onto a new row) with other
 * attachments, never with the sequential children above them.
 */
function layoutBlocks(
  children: ResolvedChild[],
  attachmentStartIndex: number
): ChildBlock[] {
  const pack = (
    items: { child: ResolvedChild; index: number }[],
    baseRow: number,
    isAttachment: boolean
  ): { blocks: ChildBlock[]; rows: number } => {
    const sorted = [...items].sort(
      (a, b) => a.child.timelineStart - b.child.timelineStart
    );
    const rowEnds: number[] = [];
    const blocks: ChildBlock[] = [];
    for (const { child, index } of sorted) {
      let row = rowEnds.findIndex((end) => end <= child.timelineStart);
      if (row === -1) {
        row = rowEnds.length;
        rowEnds.push(child.timelineEnd);
      } else {
        rowEnds[row] = child.timelineEnd;
      }
      blocks.push({ child, index, row: baseRow + row, isAttachment });
    }
    return { blocks, rows: rowEnds.length };
  };

  const childItems = children
    .slice(0, attachmentStartIndex)
    .map((child, i) => ({ child, index: i }));
  const attachmentItems = children
    .slice(attachmentStartIndex)
    .map((child, i) => ({ child, index: attachmentStartIndex + i }));

  const { blocks: childBlocks, rows: childRows } = pack(childItems, 0, false);
  const { blocks: attachmentBlocks } = pack(
    attachmentItems,
    childRows,
    true
  );
  return [...childBlocks, ...attachmentBlocks];
}

function formatTime(s: number): string {
  const mins = Math.floor(s / 60);
  const secs = s % 60;
  return `${mins}:${secs.toFixed(1).padStart(4, "0")}`;
}

function rulerInterval(pxPerSec: number): number {
  const candidates = [0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60];
  for (const c of candidates) {
    if (c * pxPerSec >= 60) return c;
  }
  return 60;
}

/**
 * For refs, walk through the enclosing scope's `refs` dict until we reach a
 * non-ref child so the editor can label and color split refs by their
 * underlying definition's type (not the resolved "composition" wrapper
 * produced by inlining).
 */
function resolveDocChild<T extends { refs?: Record<string, import("@seam/core").Child> }>(
  child: import("@seam/core").Child,
  scope: T | undefined
): import("@seam/core").Child {
  let cur = child;
  const seen = new Set<string>();
  while (cur.type === "ref") {
    if (seen.has(cur.source)) return cur;
    seen.add(cur.source);
    const def = scope?.refs?.[cur.source];
    if (!def) return cur;
    cur = def;
  }
  return cur;
}

function childLabel(docChild: import("@seam/core").Child | undefined, resolved: ResolvedChild): string {
  if (docChild) {
    if (docChild.type === "clip" || docChild.type === "audio") {
      return (docChild.source ?? "").split("/").pop() || "untitled";
    }
    if (docChild.type === "empty") return "empty";
    return docChild.type;
  }
  // Fallback to resolved tree (shouldn't happen given we always pass docChild)
  if (resolved.type === "clip" || resolved.type === "audio") {
    return (resolved.source ?? "").split("/").pop() || "untitled";
  }
  if (resolved.type === "empty") return "empty";
  return resolved.type;
}

const BLOCK_COLORS: Record<string, { bg: string; border: string }> = {
  clip: { bg: "#3a6ea5", border: "#4a8ed0" },
  audio: { bg: "#3e7a5a", border: "#52a47a" },
  composition: { bg: "#6a5acd", border: "#8470ff" },
  empty: { bg: "#555", border: "#666" },
};

const SELECTED_BORDER = "#ffcc00";

// ── Trim overlay spec (used in clip view) ────────────────────────────

interface TrimOverlay {
  inTime: number;
  outTime: number;
  sourceDuration: number;
  onDragStart: () => void;
  onDrag: (newIn: number, newOut: number) => void;
}

// ── Inner timelines ──────────────────────────────────────────────────

interface InnerProps {
  timeline: ResolvedTimeline;
  /**
   * The document subtree whose `children` and `attachments` correspond 1:1
   * to the first N and remaining entries of `timeline.children` (after the
   * resolver appends resolved attachments to the children array). Used to
   * recover the original document node — the real type of a child when it's
   * a ref, the attachment-vs-child distinction for layout, etc.
   */
  docRoot?: {
    children: import("@seam/core").Child[];
    attachments?: import("@seam/core").Child[];
    refs?: Record<string, import("@seam/core").Child>;
  };
  /**
   * Index into `timeline.children` at which resolved attachments begin. Items
   * before this are sequential children (top band); items from this index
   * onward are attachments (bottom band). When undefined everything is
   * treated as children.
   */
  attachmentStartIndex?: number;
  selectedIndices: number[];
  onSelectionChange: (indices: number[]) => void;
  onMultiSelectStart: (index: number) => void;
  multiSelectMode: boolean;
  onEnter?: (index: number) => void;
  trim?: TrimOverlay;
}

function DesktopTimeline({
  timeline,
  docRoot,
  attachmentStartIndex,
  selectedIndices,
  onSelectionChange,
  onMultiSelectStart,
  multiSelectMode,
  onEnter,
  trim,
}: InnerProps) {
  const { currentTime, totalDuration, isPlaying, seek } = useTimeline();
  const scrollRef = useRef<HTMLDivElement>(null);
  const [pxPerSec, setPxPerSec] = useState(DEFAULT_PX_PER_SEC);

  const splitIndex = attachmentStartIndex ?? timeline.children.length;
  const blocks = useMemo(
    () => layoutBlocks(timeline.children, splitIndex),
    [timeline, splitIndex]
  );
  const rowCount = blocks.length > 0 ? Math.max(...blocks.map((b) => b.row)) + 1 : 1;

  const contentWidth = Math.max(totalDuration * pxPerSec + 200, 200);
  const contentHeight = RULER_HEIGHT + rowCount * (ROW_HEIGHT + ROW_GAP) + ROW_GAP;

  // Attach wheel listener with { passive: false } so preventDefault works
  // (React's onWheel is passive by default).
  useEffect(() => {
    const container = scrollRef.current;
    if (!container) return;
    const onWheel = (e: WheelEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      e.preventDefault();
      const factor = e.deltaY > 0 ? 0.9 : 1.1;
      setPxPerSec((prev) =>
        Math.min(MAX_PX_PER_SEC, Math.max(MIN_PX_PER_SEC, prev * factor))
      );
    };
    container.addEventListener("wheel", onWheel, { passive: false });
    return () => container.removeEventListener("wheel", onWheel);
  }, []);

  const handlePointerDown = useCallback(
    (e: React.PointerEvent) => {
      onSelectionChange([]);
      const container = scrollRef.current;
      if (!container) return;
      const rect = container.getBoundingClientRect();
      const x = e.clientX - rect.left + container.scrollLeft;
      const time = Math.max(0, Math.min(x / pxPerSec, totalDuration));
      seek(time);

      const onMove = (me: PointerEvent) => {
        const mx = me.clientX - rect.left + container.scrollLeft;
        const mt = Math.max(0, Math.min(mx / pxPerSec, totalDuration));
        seek(mt);
      };
      const onUp = () => {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
      };
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
    },
    [pxPerSec, totalDuration, seek, onSelectionChange]
  );

  useEffect(() => {
    if (!isPlaying) return;
    const container = scrollRef.current;
    if (!container) return;
    const playheadX = currentTime * pxPerSec;
    container.scrollLeft = playheadX - container.clientWidth / 2;
  }, [currentTime, pxPerSec, isPlaying]);

  const interval = rulerInterval(pxPerSec);
  const rulerTicks: number[] = [];
  for (let t = 0; t <= totalDuration + interval; t += interval) {
    rulerTicks.push(t);
  }

  const playheadX = currentTime * pxPerSec;

  return (
    <div
      ref={scrollRef}
      onPointerDown={handlePointerDown}
      style={{ flex: 1, overflow: "auto", position: "relative", cursor: "crosshair" }}
    >
      <div style={{ width: contentWidth, height: contentHeight, position: "relative" }}>
        <RulerLayer pxPerSec={pxPerSec} ticks={rulerTicks} />
        <ChildrenLayer
          blocks={blocks}
          pxPerSec={pxPerSec}
          selectedIndices={selectedIndices}
          onSelectionChange={onSelectionChange}
          onMultiSelectStart={onMultiSelectStart}
          multiSelectMode={multiSelectMode}
          onEnter={onEnter}
          docRoot={docRoot}
          attachmentStartIndex={splitIndex}
        />
        {trim && <TrimOverlayLayer trim={trim} pxPerSec={pxPerSec} height={contentHeight} />}
        <Playhead x={playheadX} height={contentHeight} />
      </div>
    </div>
  );
}

function MobileTimeline({
  timeline,
  docRoot,
  attachmentStartIndex,
  selectedIndices,
  onSelectionChange,
  onMultiSelectStart,
  multiSelectMode,
  onEnter,
  trim,
}: InnerProps) {
  const { currentTime, totalDuration, isPlaying, seek } = useTimeline();
  const scrollRef = useRef<HTMLDivElement>(null);
  const [pxPerSec, setPxPerSec] = useState(DEFAULT_PX_PER_SEC);
  const [padding, setPadding] = useState(0);
  const programmaticScroll = useRef(false);

  const splitIndex = attachmentStartIndex ?? timeline.children.length;
  const blocks = useMemo(
    () => layoutBlocks(timeline.children, splitIndex),
    [timeline, splitIndex]
  );
  const rowCount = blocks.length > 0 ? Math.max(...blocks.map((b) => b.row)) + 1 : 1;

  useEffect(() => {
    const container = scrollRef.current;
    if (!container) return;
    const measure = () => setPadding(container.clientWidth / 2);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(container);
    return () => observer.disconnect();
  }, []);

  const contentWidth = padding + totalDuration * pxPerSec + padding;
  const contentHeight = RULER_HEIGHT + rowCount * (ROW_HEIGHT + ROW_GAP) + ROW_GAP;

  useEffect(() => {
    if (!isPlaying) return;
    const container = scrollRef.current;
    if (!container) return;
    programmaticScroll.current = true;
    container.scrollLeft = currentTime * pxPerSec;
  }, [currentTime, pxPerSec, isPlaying]);

  const handleScroll = useCallback(() => {
    if (programmaticScroll.current) {
      programmaticScroll.current = false;
      return;
    }
    if (isPlaying) return;
    const container = scrollRef.current;
    if (!container) return;
    const time = Math.max(0, Math.min(container.scrollLeft / pxPerSec, totalDuration));
    seek(time);
  }, [isPlaying, pxPerSec, totalDuration, seek]);

  // Non-passive wheel listener so Ctrl/Cmd+wheel zoom can preventDefault.
  useEffect(() => {
    const container = scrollRef.current;
    if (!container) return;
    const onWheel = (e: WheelEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      e.preventDefault();
      const factor = e.deltaY > 0 ? 0.9 : 1.1;
      setPxPerSec((prev) =>
        Math.min(MAX_PX_PER_SEC, Math.max(MIN_PX_PER_SEC, prev * factor))
      );
    };
    container.addEventListener("wheel", onWheel, { passive: false });
    return () => container.removeEventListener("wheel", onWheel);
  }, []);

  useEffect(() => {
    const container = scrollRef.current;
    if (!container) return;
    programmaticScroll.current = true;
    container.scrollLeft = currentTime * pxPerSec;
  }, [pxPerSec]); // eslint-disable-line react-hooks/exhaustive-deps

  const interval = rulerInterval(pxPerSec);
  const rulerTicks: number[] = [];
  for (let t = 0; t <= totalDuration + interval; t += interval) {
    rulerTicks.push(t);
  }

  return (
    <div
      ref={scrollRef}
      onScroll={handleScroll}
      style={{ flex: 1, overflow: "auto", position: "relative" }}
    >
      <div style={{ position: "sticky", left: 0, width: "100%", height: 0, zIndex: 4, pointerEvents: "none" }}>
        <Playhead x={padding} height={contentHeight} />
      </div>
      <div style={{ width: contentWidth, height: contentHeight, position: "relative" }}>
        <div style={{ position: "absolute", left: padding, top: 0, right: padding }}>
          <RulerLayer pxPerSec={pxPerSec} ticks={rulerTicks} />
          <ChildrenLayer
            blocks={blocks}
            pxPerSec={pxPerSec}
            selectedIndices={selectedIndices}
            onSelectionChange={onSelectionChange}
            onMultiSelectStart={onMultiSelectStart}
            multiSelectMode={multiSelectMode}
            onEnter={onEnter}
            docRoot={docRoot}
            attachmentStartIndex={splitIndex}
          />
          {trim && <TrimOverlayLayer trim={trim} pxPerSec={pxPerSec} height={contentHeight} />}
        </div>
      </div>
    </div>
  );
}

// ── Shared sub-components ────────────────────────────────────────────

function RulerLayer({ pxPerSec, ticks }: { pxPerSec: number; ticks: number[] }) {
  return (
    <div
      style={{
        position: "sticky",
        top: 0,
        height: RULER_HEIGHT,
        background: "#252525",
        borderBottom: "1px solid #333",
        zIndex: 2,
      }}
    >
      {ticks.map((t) => (
        <div
          key={t}
          style={{
            position: "absolute",
            left: t * pxPerSec,
            top: 0,
            height: RULER_HEIGHT,
            borderLeft: "1px solid #555",
            paddingLeft: 4,
            fontSize: 10,
            color: "#888",
            lineHeight: `${RULER_HEIGHT}px`,
            whiteSpace: "nowrap",
          }}
        >
          {formatTime(t)}
        </div>
      ))}
    </div>
  );
}

function ChildrenLayer({
  blocks,
  pxPerSec,
  selectedIndices,
  onSelectionChange,
  onMultiSelectStart,
  multiSelectMode,
  onEnter,
  docRoot,
  attachmentStartIndex,
}: {
  blocks: ChildBlock[];
  pxPerSec: number;
  selectedIndices: number[];
  onSelectionChange: (indices: number[]) => void;
  onMultiSelectStart: (index: number) => void;
  multiSelectMode: boolean;
  onEnter?: (index: number) => void;
  docRoot?: {
    children: import("@seam/core").Child[];
    attachments?: import("@seam/core").Child[];
    refs?: Record<string, import("@seam/core").Child>;
  };
  attachmentStartIndex: number;
}) {
  return (
    <>
      {blocks.map(({ child, index, row, isAttachment }) => {
        const docChild = isAttachment
          ? docRoot?.attachments?.[index - attachmentStartIndex]
          : docRoot?.children[index];
        const displayChild = docChild
          ? resolveDocChild(docChild, docRoot)
          : undefined;
        return (
          <ChildBlockView
            key={index}
            child={child}
            displayChild={displayChild}
            index={index}
            row={row}
            pxPerSec={pxPerSec}
            isAttachment={isAttachment}
            isSelected={selectedIndices.includes(index)}
            selectedIndices={selectedIndices}
            onSelectionChange={onSelectionChange}
            onMultiSelectStart={onMultiSelectStart}
            multiSelectMode={multiSelectMode}
            onEnter={onEnter}
          />
        );
      })}
    </>
  );
}

function ChildBlockView({
  child,
  displayChild,
  index,
  row,
  pxPerSec,
  isAttachment,
  isSelected,
  selectedIndices,
  onSelectionChange,
  onMultiSelectStart,
  multiSelectMode,
  onEnter,
}: {
  child: ResolvedChild;
  displayChild?: import("@seam/core").Child;
  index: number;
  row: number;
  pxPerSec: number;
  isAttachment: boolean;
  isSelected: boolean;
  selectedIndices: number[];
  onSelectionChange: (indices: number[]) => void;
  onMultiSelectStart: (index: number) => void;
  multiSelectMode: boolean;
  onEnter?: (index: number) => void;
}) {
  const left = child.timelineStart * pxPerSec;
  const width = Math.max((child.timelineEnd - child.timelineStart) * pxPerSec, 2);
  const top = RULER_HEIGHT + ROW_GAP + row * (ROW_HEIGHT + ROW_GAP);
  const label = childLabel(displayChild, child);
  const displayType = displayChild?.type ?? child.type;
  const colors = BLOCK_COLORS[displayType] ?? BLOCK_COLORS.clip;

  // Long-press (touch/pen) now starts mobile multi-select mode and adds this
  // block to the selection. Desktop uses Ctrl/Cmd+click (handled on pointer-up).
  const longPressTimer = useRef<number | null>(null);
  const pointerStart = useRef<{ x: number; y: number } | null>(null);
  const longPressFired = useRef(false);

  const clearLongPress = () => {
    if (longPressTimer.current != null) {
      window.clearTimeout(longPressTimer.current);
      longPressTimer.current = null;
    }
    pointerStart.current = null;
  };

  const toggleMembership = () => {
    if (selectedIndices.includes(index)) {
      onSelectionChange(selectedIndices.filter((i) => i !== index));
    } else {
      onSelectionChange([...selectedIndices, index]);
    }
  };

  const handlePointerDown = (e: React.PointerEvent) => {
    e.stopPropagation();
    longPressFired.current = false;
    if (e.pointerType !== "mouse") {
      pointerStart.current = { x: e.clientX, y: e.clientY };
      longPressTimer.current = window.setTimeout(() => {
        longPressFired.current = true;
        onMultiSelectStart(index);
      }, LONG_PRESS_MS);
    }
  };

  const handlePointerMove = (e: React.PointerEvent) => {
    if (!pointerStart.current) return;
    const dx = e.clientX - pointerStart.current.x;
    const dy = e.clientY - pointerStart.current.y;
    if (Math.hypot(dx, dy) > LONG_PRESS_SLOP_PX) clearLongPress();
  };

  const handlePointerUp = (e: React.PointerEvent) => {
    clearLongPress();
    if (longPressFired.current) return; // long-press handled selection already
    e.stopPropagation();
    const isTouch = e.pointerType !== "mouse";
    const modifier = e.ctrlKey || e.metaKey;
    if (isTouch && multiSelectMode) {
      toggleMembership();
    } else if (!isTouch && modifier) {
      toggleMembership();
    } else {
      // Single select: replace selection, or deselect if this was the only one.
      if (selectedIndices.length === 1 && selectedIndices[0] === index) {
        onSelectionChange([]);
      } else {
        onSelectionChange([index]);
      }
    }
  };

  const handleDoubleClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (onEnter) onEnter(index);
  };

  // Attachments render but are not yet interactive — selection/delete/enter
  // only operate on doc.children indices today.
  const interactiveHandlers = isAttachment
    ? {}
    : {
        onPointerDown: handlePointerDown,
        onPointerMove: handlePointerMove,
        onPointerUp: handlePointerUp,
        onPointerCancel: clearLongPress,
        onDoubleClick: handleDoubleClick,
        onContextMenu: (e: React.MouseEvent) => e.preventDefault(),
      };

  return (
    <div
      {...interactiveHandlers}
      style={{
        position: "absolute",
        left,
        top,
        width,
        height: ROW_HEIGHT,
        background: isSelected ? "#4a7eb8" : colors.bg,
        borderRadius: 3,
        overflow: "hidden",
        display: "flex",
        alignItems: "center",
        paddingLeft: 6,
        paddingRight: 6,
        fontSize: 11,
        color: "#fff",
        whiteSpace: "nowrap",
        boxSizing: "border-box",
        border: `2px solid ${isSelected ? SELECTED_BORDER : colors.border}`,
        cursor: isAttachment ? "default" : "pointer",
        opacity: isAttachment ? 0.85 : 1,
      }}
    >
      <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>
        {label}
      </span>
    </div>
  );
}

function Playhead({ x, height }: { x: number; height: number }) {
  return (
    <>
      <div
        style={{
          position: "absolute",
          left: x,
          top: 0,
          width: 1,
          height,
          background: "#ff4444",
          zIndex: 3,
          pointerEvents: "none",
        }}
      />
      <div
        style={{
          position: "absolute",
          left: x - 5,
          top: 0,
          width: 0,
          height: 0,
          borderLeft: "5px solid transparent",
          borderRight: "5px solid transparent",
          borderTop: "7px solid #ff4444",
          zIndex: 3,
          pointerEvents: "none",
        }}
      />
    </>
  );
}

// ── Trim overlay (clip view) ─────────────────────────────────────────

function TrimOverlayLayer({
  trim,
  pxPerSec,
  height,
}: {
  trim: TrimOverlay;
  pxPerSec: number;
  height: number;
}) {
  const inX = trim.inTime * pxPerSec;
  const outX = trim.outTime * pxPerSec;
  const widthSec = trim.sourceDuration;
  const totalWidth = widthSec * pxPerSec;

  const startDrag = (which: "in" | "out") => (e: React.PointerEvent) => {
    e.stopPropagation();
    trim.onDragStart();
    const startX = e.clientX;
    const startIn = trim.inTime;
    const startOut = trim.outTime;

    const onMove = (me: PointerEvent) => {
      const dx = me.clientX - startX;
      const dt = dx / pxPerSec;
      if (which === "in") {
        const newIn = Math.max(0, Math.min(startOut - 0.05, startIn + dt));
        trim.onDrag(newIn, startOut);
      } else {
        const newOut = Math.max(startIn + 0.05, Math.min(widthSec, startOut + dt));
        trim.onDrag(startIn, newOut);
      }
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  return (
    <>
      {/* Dim regions outside the trim window */}
      <div
        style={{
          position: "absolute",
          left: 0,
          top: RULER_HEIGHT,
          width: inX,
          height: height - RULER_HEIGHT,
          background: "rgba(0,0,0,0.55)",
          zIndex: 2,
          pointerEvents: "none",
        }}
      />
      <div
        style={{
          position: "absolute",
          left: outX,
          top: RULER_HEIGHT,
          width: Math.max(0, totalWidth - outX),
          height: height - RULER_HEIGHT,
          background: "rgba(0,0,0,0.55)",
          zIndex: 2,
          pointerEvents: "none",
        }}
      />

      {/* In handle */}
      <div
        onPointerDown={startDrag("in")}
        style={{
          position: "absolute",
          left: inX - HANDLE_WIDTH / 2,
          top: RULER_HEIGHT,
          width: HANDLE_WIDTH,
          height: height - RULER_HEIGHT,
          background: "#ffcc00",
          borderRadius: 2,
          cursor: "ew-resize",
          zIndex: 5,
          touchAction: "none",
        }}
        title={`In: ${trim.inTime.toFixed(2)}s`}
      />

      {/* Out handle */}
      <div
        onPointerDown={startDrag("out")}
        style={{
          position: "absolute",
          left: outX - HANDLE_WIDTH / 2,
          top: RULER_HEIGHT,
          width: HANDLE_WIDTH,
          height: height - RULER_HEIGHT,
          background: "#ffcc00",
          borderRadius: 2,
          cursor: "ew-resize",
          zIndex: 5,
          touchAction: "none",
        }}
        title={`Out: ${trim.outTime.toFixed(2)}s`}
      />
    </>
  );
}

// ── Clip-view playback constraint ────────────────────────────────────
// Keeps the playhead between in..out: on reaching out, loops to in (if loop)
// or pauses (otherwise). Also snaps the playhead forward if it's before `in`.
function ClipPlaybackConstraint({
  inTime,
  outTime,
}: {
  inTime: number;
  outTime: number;
}) {
  const { currentTime, isPlaying, loop, seek, pause } = useTimeline();
  useEffect(() => {
    if (!isPlaying) return;
    if (currentTime >= outTime) {
      if (loop) seek(inTime);
      else pause();
    } else if (currentTime < inTime) {
      seek(inTime);
    }
  }, [currentTime, isPlaying, loop, inTime, outTime, seek, pause]);
  return null;
}

// ── Root component ───────────────────────────────────────────────────

export default function TimelinePanel({
  timeline,
  document: doc,
  viewDocument,
  filePath,
  isMobile,
  selectedIndices,
  onSelectionChange,
  onMultiSelectStart,
  multiSelectMode,
  onDocumentChange,
  view,
  onEnterClip,
  history,
  platform,
}: TimelinePanelProps) {
  const { currentTime } = useTimeline();
  const [dragOver, setDragOver] = useState(false);
  const emptyDoc: SeamFile = { type: "composition", children: [] };
  const importFiles = useImport(
    doc ?? emptyDoc,
    filePath ?? null,
    onDocumentChange ?? (() => {}),
    platform
  );

  // Delete/Backspace to remove selected children (root view only)
  useEffect(() => {
    if (view.type !== "root") return;
    const handler = (e: KeyboardEvent) => {
      if (
        (e.key === "Delete" || e.key === "Backspace") &&
        selectedIndices.length > 0 &&
        doc &&
        onDocumentChange
      ) {
        e.preventDefault();
        const sortedDesc = [...selectedIndices].sort((a, b) => b - a);
        const newChildren = [...doc.children];
        for (const i of sortedDesc) newChildren.splice(i, 1);
        onDocumentChange({ ...doc, children: newChildren });
        onSelectionChange([]);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [selectedIndices, doc, onDocumentChange, onSelectionChange, view]);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(true);
  }, []);

  const handleDragLeave = useCallback(() => {
    setDragOver(false);
  }, []);

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setDragOver(false);
      if (view.type !== "root") return; // no import in nested views
      if (e.dataTransfer.files.length > 0) {
        importFiles(e.dataTransfer.files);
      }
    },
    [importFiles, view]
  );

  // Build trim overlay if we're in clip view
  const trim: TrimOverlay | undefined = useMemo(() => {
    if (view.type !== "clip" || !doc) return undefined;
    const target = doc.children[view.rootIndex];
    if (!target || target.type !== "clip") return undefined;
    const origClip = target as Clip;

    return {
      inTime: origClip.in,
      outTime: origClip.out,
      sourceDuration: view.sourceDuration,
      onDragStart: () => {
        // Snapshot the current doc as a single undo entry for this drag
        history.pushPast(history.current);
      },
      onDrag: (newIn, newOut) => {
        const updated: Clip = { ...origClip, in: newIn, out: newOut };
        // Strip duration so in/out define the natural length
        const { duration: _d, ...clean } = updated as Clip & { duration?: number };
        const newChildren = [...doc.children];
        newChildren[view.rootIndex] = clean as Clip;
        history.replace({ ...doc, children: newChildren });
      },
    };
  }, [view, doc, history]);

  // Enter handler: double-click / long-press
  const handleEnter = useCallback(
    (index: number) => {
      onEnterClip(index, currentTime);
    },
    [onEnterClip, currentTime]
  );

  // Clip view: the `onEnter` doesn't apply (already inside)
  const onEnterProp = view.type === "root" ? handleEnter : undefined;

  return (
    <div
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
      style={{
        background: "#1e1e1e",
        borderTop: "1px solid #333",
        display: "flex",
        flexDirection: "column",
        minHeight: 120,
        maxHeight: 300,
        userSelect: "none",
        position: "relative",
      }}
    >
      {dragOver && view.type === "root" && (
        <div
          style={{
            position: "absolute",
            inset: 0,
            background: "rgba(74, 158, 255, 0.15)",
            border: "2px dashed #4a9eff",
            borderRadius: 4,
            zIndex: 10,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            color: "#4a9eff",
            fontSize: 14,
            fontWeight: 600,
            pointerEvents: "none",
          }}
        >
          Drop video files to import
        </div>
      )}

      {/* Playback constraint (clip view only) */}
      {trim && <ClipPlaybackConstraint inTime={trim.inTime} outTime={trim.outTime} />}

      {(() => {
        // For root and composition views the panel renders the view-doc's
        // children (+ attachments) as blocks; clip view is driven by the
        // trim overlay instead, so we skip the docRoot split there.
        const panelDoc =
          view.type === "root"
            ? doc
            : view.type === "composition"
              ? viewDocument
              : undefined;
        const splitIndex = panelDoc ? panelDoc.children.length : undefined;
        return isMobile ? (
          <MobileTimeline
            timeline={timeline}
            docRoot={panelDoc}
            attachmentStartIndex={splitIndex}
            selectedIndices={selectedIndices}
            onSelectionChange={onSelectionChange}
            onMultiSelectStart={onMultiSelectStart}
            multiSelectMode={multiSelectMode}
            onEnter={onEnterProp}
            trim={trim}
          />
        ) : (
          <DesktopTimeline
            timeline={timeline}
            docRoot={panelDoc}
            attachmentStartIndex={splitIndex}
            selectedIndices={selectedIndices}
            onSelectionChange={onSelectionChange}
            onMultiSelectStart={onMultiSelectStart}
            multiSelectMode={multiSelectMode}
            onEnter={onEnterProp}
            trim={trim}
          />
        );
      })()}
    </div>
  );
}

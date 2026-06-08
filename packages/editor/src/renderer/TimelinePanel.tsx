import React, { useRef, useMemo, useCallback, useState, useEffect } from "react";
import { useTimeline } from "@seam/preview";
import type {
  ResolvedTimeline,
  ResolvedChild,
  SeamFile,
  Child,
  Clip,
} from "@seam/core";
import { useImport } from "./useImport.js";
import type { View } from "./views.js";
import type { History } from "./useHistory.js";
import type { Platform } from "./platform/index.js";
import { removeSelected } from "./selection.js";
import type { Composition } from "@seam/core";
import {
  ROW_HEIGHT,
  ROW_GAP,
  RULER_HEIGHT,
  type ChildBlock,
} from "./timelineLayout.js";
import AnchorLinesLayer from "./AnchorLinesLayer.js";
import { resizeChild } from "./resizeTool.js";
import { useEvent } from "./useEvent.js";

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

const MIN_PX_PER_SEC = 10;
const MAX_PX_PER_SEC = 1000;
const DEFAULT_PX_PER_SEC = 100;
const HANDLE_WIDTH = 10;
const LONG_PRESS_MS = 500;
const LONG_PRESS_SLOP_PX = 6;
/** Pixels of movement before a mouse press on a child block is treated
 *  as drag-to-reorder rather than a click. */
const REORDER_THRESHOLD_PX = 6;
const REORDER_LINE_COLOR = "#ff4444";

/**
 * Greedy row-packer. Items past `attachmentStartIndex` are laid out into a
 * separate band below the children band, each band packed independently —
 * attachments only collide (and thus stack onto a new row) with other
 * attachments, never with the sequential children above them.
 */
/** Translate a cursor X (in content-coords pixels) into the insertion
 *  index for a reorder. Slot `k` means "insert before child k" (and
 *  `N` means "append after the last child"). Splits each child at its
 *  midpoint — cursor left of the midpoint inserts before, right of it
 *  inserts after — which feels natural for symmetric drag targets. */
function computeInsertionIndex(
  cursorX: number,
  sortedChildBlocks: ChildBlock[],
  pxPerSec: number,
): number {
  for (let k = 0; k < sortedChildBlocks.length; k++) {
    const b = sortedChildBlocks[k];
    const midX = ((b.child.timelineStart + b.child.timelineEnd) / 2) * pxPerSec;
    if (cursorX < midX) return k;
  }
  return sortedChildBlocks.length;
}

/** Move element at `from` to insertion index `to` (slots are between
 *  elements: `0` = before the first, `arr.length` = after the last).
 *  Returns the original array unchanged for no-op moves. */
function reorderChildren<T>(arr: T[], from: number, to: number): T[] {
  if (from === to || from === to - 1) return arr;
  const out = arr.slice();
  const [item] = out.splice(from, 1);
  const insertAt = to > from ? to - 1 : to;
  out.splice(insertAt, 0, item);
  return out;
}

/** X position (content-coords px) of the red line for a given insertion
 *  index. Sequential children play back-to-back, so each boundary is
 *  the start of the child at that index — except the last slot, which
 *  is the end of the final child. */
function insertionIndexToX(
  insertIdx: number,
  sortedChildBlocks: ChildBlock[],
  pxPerSec: number,
): number {
  if (sortedChildBlocks.length === 0) return 0;
  if (insertIdx >= sortedChildBlocks.length) {
    const last = sortedChildBlocks[sortedChildBlocks.length - 1];
    return last.child.timelineEnd * pxPerSec;
  }
  return sortedChildBlocks[insertIdx].child.timelineStart * pxPerSec;
}

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

function childLabel(docChild: import("@seam/core").Child | undefined, resolved: ResolvedChild): string {
  if (docChild) {
    if (docChild.type === "clip" || docChild.type === "audio") {
      return (docChild.source ?? "").split("/").pop() || "untitled";
    }
    if (docChild.type === "text") {
      // Show a single-line preview of the rendered text instead of a
      // full dump of inline runs.
      const flat = typeof docChild.text === "string"
        ? docChild.text
        : docChild.text
            .map((r) => (typeof r === "string" ? r : r.text))
            .join("");
      const stripped = flat.replace(/\s+/g, " ").trim();
      return stripped.length > 24 ? stripped.slice(0, 24) + "…" : stripped || "text";
    }
    if (docChild.type === "empty") return "empty";
    if (docChild.type === "data") return "data";
    return docChild.type;
  }
  // Fallback to resolved tree (shouldn't happen given we always pass docChild)
  if (resolved.type === "clip" || resolved.type === "audio") {
    return (resolved.source ?? "").split("/").pop() || "untitled";
  }
  if (resolved.type === "text") return "text";
  if (resolved.type === "empty") return "empty";
  if (resolved.type === "data") return "data";
  return resolved.type;
}

const BLOCK_COLORS: Record<string, { bg: string; border: string }> = {
  clip: { bg: "#3a6ea5", border: "#4a8ed0" },
  audio: { bg: "#3e7a5a", border: "#52a47a" },
  composition: { bg: "#6a5acd", border: "#8470ff" },
  empty: { bg: "#555", border: "#666" },
  data: { bg: "#7a5a3a", border: "#a47a52" },
  text: { bg: "#a04060", border: "#c45582" },
};

const PRIMARY_BORDER = "#ffcc00";
// Secondary selection: dashed yellow conveys "linked to the primary" — we
// reuse the same hue so it reads as still-selected, but the dashes signal
// that this block is a follower, not the lead.
const SECONDARY_BORDER = "#b8a040";
const SELECTED_BORDER = PRIMARY_BORDER;

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
  /** Provided only in root view, where attachment edits are writable. */
  editHistory?: History<SeamFile>;
  /** Commit a reorder of sequential children: move `from` to be at
   *  insertion index `to` (in the post-removal array). Undefined when
   *  reorder isn't supported in this view. */
  onReorder?: (from: number, to: number) => void;
}

// ── Shared timeline surface (hook + body) ────────────────────────────
//
// Both DesktopTimeline and MobileTimeline boil down to: scroll
// container + playhead + this body. The body is identical between
// them; the shells differ in scroll behaviour, playhead positioning,
// and (Desktop only) the reorder-drag overlay.

interface TimelineSurfaceState {
  pxPerSec: number;
  setPxPerSec: React.Dispatch<React.SetStateAction<number>>;
  splitIndex: number;
  blocks: ChildBlock[];
  rowCount: number;
  contentHeight: number;
  rulerTicks: number[];
}

/** State + effects shared by Desktop and Mobile shells: zoom level,
 *  block layout, content height, ruler ticks, and the Ctrl/Cmd+wheel
 *  zoom listener attached to the scroll container. */
function useTimelineSurfaceState(
  timeline: ResolvedTimeline,
  attachmentStartIndex: number | undefined,
  scrollRef: React.RefObject<HTMLDivElement | null>,
): TimelineSurfaceState {
  const { totalDuration } = useTimeline();
  const [pxPerSec, setPxPerSec] = useState(DEFAULT_PX_PER_SEC);

  const splitIndex = attachmentStartIndex ?? timeline.children.length;
  const blocks = useMemo(
    () => layoutBlocks(timeline.children, splitIndex),
    [timeline, splitIndex],
  );
  const rowCount =
    blocks.length > 0 ? Math.max(...blocks.map((b) => b.row)) + 1 : 1;
  const contentHeight =
    RULER_HEIGHT + rowCount * (ROW_HEIGHT + ROW_GAP) + ROW_GAP;

  // Non-passive wheel listener so Ctrl/Cmd+wheel zoom can preventDefault
  // (React's onWheel is passive by default).
  useEffect(() => {
    const container = scrollRef.current;
    if (!container) return;
    const onWheel = (e: WheelEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      e.preventDefault();
      const factor = e.deltaY > 0 ? 0.9 : 1.1;
      setPxPerSec((prev) =>
        Math.min(MAX_PX_PER_SEC, Math.max(MIN_PX_PER_SEC, prev * factor)),
      );
    };
    container.addEventListener("wheel", onWheel, { passive: false });
    return () => container.removeEventListener("wheel", onWheel);
  }, [scrollRef]);

  const interval = rulerInterval(pxPerSec);
  const rulerTicks: number[] = [];
  for (let t = 0; t <= totalDuration + interval; t += interval) {
    rulerTicks.push(t);
  }

  return {
    pxPerSec,
    setPxPerSec,
    splitIndex,
    blocks,
    rowCount,
    contentHeight,
    rulerTicks,
  };
}

interface TimelineSurfaceProps {
  surface: TimelineSurfaceState;
  timeline: ResolvedTimeline;
  docRoot?: {
    children: import("@seam/core").Child[];
    attachments?: import("@seam/core").Child[];
  };
  selectedIndices: number[];
  onSelectionChange: (indices: number[]) => void;
  onMultiSelectStart: (index: number) => void;
  multiSelectMode: boolean;
  onEnter?: (index: number) => void;
  trim?: TrimOverlay;
  editHistory?: History<SeamFile>;
  /** Index of the child currently being reorder-dragged (fades its
   *  block view). Pass `null` when the shell doesn't support reorder. */
  reorderDragIndex: number | null;
  /** Hand-off callback when a child block's mouse-press passes the
   *  drag threshold. Pass `null` to disable reorder for this shell. */
  onReorderDragStart: ((index: number, e: PointerEvent) => void) | null;
}

/** Body of the timeline: ruler + child blocks + anchor lines + optional
 *  trim overlay. Positioned absolutely within the parent's content box,
 *  so each shell wraps it in its own scroll/padding/playhead layout. */
function TimelineSurface({
  surface,
  timeline,
  docRoot,
  selectedIndices,
  onSelectionChange,
  onMultiSelectStart,
  multiSelectMode,
  onEnter,
  trim,
  editHistory,
  reorderDragIndex,
  onReorderDragStart,
}: TimelineSurfaceProps) {
  const { pxPerSec, splitIndex, blocks, contentHeight, rulerTicks } = surface;
  const { currentTime, seek } = useTimeline();

  // Per-block drag-resize. Stable identity via useEvent so re-renders
  // (and rAF ticks of currentTime) don't churn the prop on every block.
  // The latest editHistory / pxPerSec / currentTime / seek are read
  // inside the closure when a handle is pressed.
  const startResize = useEvent(
    (
      index: number,
      isAttachment: boolean,
      side: "left" | "right",
      e: React.PointerEvent,
    ) => {
      if (!editHistory) return;
      e.stopPropagation();
      e.preventDefault();
      const target = e.currentTarget as Element;
      const pointerId = e.pointerId;
      const startX = e.clientX;
      const initialDoc = editHistory.current;
      const initialTime = currentTime;

      try {
        target.setPointerCapture(pointerId);
      } catch {
        /* element gone — fall back to ambient pointer events */
      }

      // Defer the past-snapshot to the first actual move so a click that
      // doesn't drag at all leaves history clean.
      let pushed = false;

      const onMove = (ev: Event) => {
        const me = ev as PointerEvent;
        if (me.pointerId !== pointerId) return;
        const deltaPx = me.clientX - startX;
        const deltaSec = deltaPx / pxPerSec;
        if (!pushed) {
          editHistory.pushPast(initialDoc);
          pushed = true;
        }
        editHistory.replace(
          resizeChild(initialDoc, index, isAttachment, side, deltaSec),
        );
        if (side === "left") {
          // Best-effort playhead preservation: as the source content shifts
          // (or the trailing siblings shift), keep the visible content under
          // the playhead lined up by translating the playhead by the same
          // delta. Naive, no speed math — same convention as the resize.
          seek(Math.max(0, initialTime - deltaSec));
        }
      };
      const onUp = (ev: Event) => {
        const me = ev as PointerEvent;
        if (me.pointerId !== pointerId) return;
        target.removeEventListener("pointermove", onMove);
        target.removeEventListener("pointerup", onUp);
        target.removeEventListener("pointercancel", onUp);
        try {
          target.releasePointerCapture(pointerId);
        } catch {
          /* ignore */
        }
      };
      target.addEventListener("pointermove", onMove);
      target.addEventListener("pointerup", onUp);
      target.addEventListener("pointercancel", onUp);
    },
  );

  const onResizeDragStart = editHistory ? startResize : null;

  return (
    <>
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
        reorderDragIndex={reorderDragIndex}
        onReorderDragStart={onReorderDragStart}
        onResizeDragStart={onResizeDragStart}
      />
      <AnchorLinesLayer
        selectedIndices={selectedIndices}
        docRoot={docRoot}
        timeline={timeline}
        blocks={blocks}
        pxPerSec={pxPerSec}
        history={editHistory}
      />
      {trim && (
        <TrimOverlayLayer
          trim={trim}
          pxPerSec={pxPerSec}
          height={contentHeight}
        />
      )}
    </>
  );
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
  editHistory,
  onReorder,
}: InnerProps) {
  const { currentTime, totalDuration, isPlaying, seek } = useTimeline();
  const scrollRef = useRef<HTMLDivElement>(null);
  const surface = useTimelineSurfaceState(
    timeline,
    attachmentStartIndex,
    scrollRef,
  );
  const { pxPerSec, blocks, contentHeight } = surface;

  // Reorder drag state. `cursorX` is in content (scroll-relative) px;
  // `grabOffsetX` is how far inside the source block the user grabbed,
  // used to keep the ghost's left edge consistent with the cursor.
  const [reorderDrag, setReorderDrag] = useState<{
    fromIndex: number;
    cursorX: number;
    grabOffsetX: number;
  } | null>(null);

  const contentWidth = Math.max(totalDuration * pxPerSec + 200, 200);

  const handlePointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      const container = scrollRef.current;
      if (!container) return;
      // Capture the pointer on the scroll container so pointerup fires here
      // — not on whatever clip happens to be under the cursor at release —
      // and so children's onPointerUp doesn't run, which would steal the
      // selection. Don't clear the existing selection: the user explicitly
      // built it; scrubbing the playhead shouldn't blow it away.
      const target = e.currentTarget;
      const pointerId = e.pointerId;
      target.setPointerCapture(pointerId);
      const rect = container.getBoundingClientRect();
      const x = e.clientX - rect.left + container.scrollLeft;
      const time = Math.max(0, Math.min(x / pxPerSec, totalDuration));
      seek(time);

      const onMove = (me: PointerEvent) => {
        const mx = me.clientX - rect.left + container.scrollLeft;
        const mt = Math.max(0, Math.min(mx / pxPerSec, totalDuration));
        seek(mt);
      };
      const cleanup = () => {
        target.removeEventListener("pointermove", onMove);
        target.removeEventListener("pointerup", cleanup);
        target.removeEventListener("pointercancel", cleanup);
        try {
          target.releasePointerCapture(pointerId);
        } catch {
          // Already released (e.g. element unmounted) — fine to ignore.
        }
      };
      target.addEventListener("pointermove", onMove);
      target.addEventListener("pointerup", cleanup);
      target.addEventListener("pointercancel", cleanup);
    },
    [pxPerSec, totalDuration, seek]
  );

  useEffect(() => {
    if (!isPlaying) return;
    const container = scrollRef.current;
    if (!container) return;
    const playheadX = currentTime * pxPerSec;
    container.scrollLeft = playheadX - container.clientWidth / 2;
  }, [currentTime, pxPerSec, isPlaying]);

  // ── Drag-to-reorder ────────────────────────────────────────────
  // Sequential child blocks sorted by index, used both to position the
  // red insertion line and to translate cursor X into an insertion
  // index. Attachments don't participate (their anchor semantics would
  // be wrong if reordered).
  const reorderableBlocks = useMemo(
    () =>
      blocks
        .filter((b) => !b.isAttachment)
        .sort((a, b) => a.index - b.index),
    [blocks],
  );

  const startReorderDrag = useCallback(
    (index: number, e: PointerEvent) => {
      if (!onReorder) return;
      const container = scrollRef.current;
      if (!container) return;
      const rect = container.getBoundingClientRect();
      const cursorX = e.clientX - rect.left + container.scrollLeft;
      const block = reorderableBlocks.find((b) => b.index === index);
      const blockLeftX = block ? block.child.timelineStart * pxPerSec : cursorX;
      setReorderDrag({
        fromIndex: index,
        cursorX,
        grabOffsetX: cursorX - blockLeftX,
      });
    },
    [onReorder, reorderableBlocks, pxPerSec],
  );

  // While a reorder is active, follow the cursor on window events
  // (independent of the source block's capture) and commit on release.
  // Cleanup of the window listeners is tied to the React effect's
  // teardown — so a parent unmount or a fresh drag round always wipes
  // the old subscriptions.
  useEffect(() => {
    if (!reorderDrag || !onReorder) return;
    const container = scrollRef.current;
    if (!container) return;
    const dragRef = reorderDrag;

    const cursorXFromEvent = (e: PointerEvent): number => {
      const rect = container.getBoundingClientRect();
      return e.clientX - rect.left + container.scrollLeft;
    };

    const onMove = (e: PointerEvent) => {
      const cursorX = cursorXFromEvent(e);
      setReorderDrag((prev) => (prev ? { ...prev, cursorX } : null));
    };

    const onUp = (e: PointerEvent) => {
      const cursorX = cursorXFromEvent(e);
      const toIndex = computeInsertionIndex(
        cursorX,
        reorderableBlocks,
        pxPerSec,
      );
      const from = dragRef.fromIndex;
      const isNoop = toIndex === from || toIndex === from + 1;
      if (!isNoop) onReorder(from, toIndex);
      setReorderDrag(null);
    };

    const onCancel = () => setReorderDrag(null);

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onCancel);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onCancel);
    };
    // We deliberately don't include `reorderDrag` here — only its
    // *existence* matters for setting up listeners; the cursor updates
    // come through setState. dragRef captures the start state once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reorderDrag !== null, onReorder, reorderableBlocks, pxPerSec]);

  const playheadX = currentTime * pxPerSec;

  // Ghost + insertion-line layout. The ghost mirrors the source
  // block's width and row, but its X follows the cursor offset so the
  // grabbed point stays under the pointer.
  const ghost = (() => {
    if (!reorderDrag) return null;
    const source = reorderableBlocks.find(
      (b) => b.index === reorderDrag.fromIndex,
    );
    if (!source) return null;
    const width = Math.max(
      (source.child.timelineEnd - source.child.timelineStart) * pxPerSec,
      2,
    );
    const top =
      RULER_HEIGHT + ROW_GAP + source.row * (ROW_HEIGHT + ROW_GAP);
    const docChild = docRoot?.children[source.index];
    const label = childLabel(docChild, source.child);
    const displayType = docChild?.type ?? source.child.type;
    const colors = BLOCK_COLORS[displayType] ?? BLOCK_COLORS.clip;
    return {
      left: reorderDrag.cursorX - reorderDrag.grabOffsetX,
      top,
      width,
      label,
      bg: colors.bg,
      border: colors.border,
    };
  })();

  const insertionX = (() => {
    if (!reorderDrag) return null;
    const idx = computeInsertionIndex(
      reorderDrag.cursorX,
      reorderableBlocks,
      pxPerSec,
    );
    const isNoop =
      idx === reorderDrag.fromIndex || idx === reorderDrag.fromIndex + 1;
    if (isNoop) return null;
    return insertionIndexToX(idx, reorderableBlocks, pxPerSec);
  })();

  return (
    <div
      ref={scrollRef}
      onPointerDown={handlePointerDown}
      style={{
        flex: 1,
        overflow: "auto",
        position: "relative",
        cursor: reorderDrag ? "grabbing" : "crosshair",
      }}
    >
      <div style={{ width: contentWidth, height: contentHeight, position: "relative" }}>
        <TimelineSurface
          surface={surface}
          timeline={timeline}
          docRoot={docRoot}
          selectedIndices={selectedIndices}
          onSelectionChange={onSelectionChange}
          onMultiSelectStart={onMultiSelectStart}
          multiSelectMode={multiSelectMode}
          onEnter={onEnter}
          trim={trim}
          editHistory={editHistory}
          reorderDragIndex={reorderDrag?.fromIndex ?? null}
          onReorderDragStart={onReorder ? startReorderDrag : null}
        />
        {ghost && (
          <div
            style={{
              position: "absolute",
              left: ghost.left,
              top: ghost.top,
              width: ghost.width,
              height: ROW_HEIGHT,
              background: ghost.bg,
              border: `2px solid ${ghost.border}`,
              borderRadius: 3,
              opacity: 0.85,
              pointerEvents: "none",
              display: "flex",
              alignItems: "center",
              paddingLeft: 6,
              paddingRight: 6,
              fontSize: 11,
              color: "#fff",
              whiteSpace: "nowrap",
              overflow: "hidden",
              boxSizing: "border-box",
              zIndex: 20,
              boxShadow: "0 2px 8px rgba(0, 0, 0, 0.5)",
            }}
          >
            <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>
              {ghost.label}
            </span>
          </div>
        )}
        {insertionX != null && (
          <div
            style={{
              position: "absolute",
              left: insertionX - 1,
              top: RULER_HEIGHT,
              width: 2,
              height: contentHeight - RULER_HEIGHT,
              background: REORDER_LINE_COLOR,
              pointerEvents: "none",
              zIndex: 19,
            }}
          />
        )}
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
  editHistory,
}: InnerProps) {
  const { currentTime, totalDuration, isPlaying, seek } = useTimeline();
  const scrollRef = useRef<HTMLDivElement>(null);
  const surface = useTimelineSurfaceState(
    timeline,
    attachmentStartIndex,
    scrollRef,
  );
  const { pxPerSec, contentHeight } = surface;
  const [padding, setPadding] = useState(0);
  const programmaticScroll = useRef(false);

  // Mobile shell pads each side with half the container's width so the
  // playhead can sit at the center even at the timeline's start/end.
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

  // Auto-scroll the timeline so the (sticky) playhead stays at the
  // container's left edge during playback. `programmaticScroll` flags
  // the next scroll event so `handleScroll` doesn't echo back into seek.
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

  // Re-snap scroll to the current playhead on zoom so the timeline
  // doesn't drift sideways when the user resizes via Ctrl/Cmd+wheel.
  useEffect(() => {
    const container = scrollRef.current;
    if (!container) return;
    programmaticScroll.current = true;
    container.scrollLeft = currentTime * pxPerSec;
  }, [pxPerSec]); // eslint-disable-line react-hooks/exhaustive-deps

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
          <TimelineSurface
            surface={surface}
            timeline={timeline}
            docRoot={docRoot}
            selectedIndices={selectedIndices}
            onSelectionChange={onSelectionChange}
            onMultiSelectStart={onMultiSelectStart}
            multiSelectMode={multiSelectMode}
            onEnter={onEnter}
            trim={trim}
            editHistory={editHistory}
            reorderDragIndex={null}
            onReorderDragStart={null}
          />
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
  reorderDragIndex,
  onReorderDragStart,
  onResizeDragStart,
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
  };
  attachmentStartIndex: number;
  /** Index of the child currently being reorder-dragged (fades in the
   *  block view). `null` when no drag is in progress. */
  reorderDragIndex: number | null;
  /** Hand-off callback when a child block's mouse-press passes the
   *  drag threshold. `null` disables reorder entirely. */
  onReorderDragStart: ((index: number, e: PointerEvent) => void) | null;
  /** Hand-off when a selected block's resize-handle is pressed. `null`
   *  disables resize entirely (e.g. non-root views without history). */
  onResizeDragStart:
    | ((
        index: number,
        isAttachment: boolean,
        side: "left" | "right",
        e: React.PointerEvent,
      ) => void)
    | null;
}) {
  return (
    <>
      {blocks.map(({ child, index, row, isAttachment }) => {
        const docChild = isAttachment
          ? docRoot?.attachments?.[index - attachmentStartIndex]
          : docRoot?.children[index];
        const displayChild = docChild;
        const isSelected = selectedIndices.includes(index);
        // Only distinguish primary vs secondary when 2+ are selected — a
        // single selection has no "primary" relationship to highlight.
        const isPrimary =
          isSelected &&
          !isAttachment &&
          selectedIndices.length >= 2 &&
          selectedIndices[0] === index;
        // Reorder only applies to sequential children (attachments
        // would lose their anchor semantics on move).
        const blockReorderStart =
          !isAttachment && onReorderDragStart ? onReorderDragStart : null;
        // Resize is gated to non-attachment children for now; the pure
        // tool handles attachments too if we ever turn this on.
        const blockResizeStart =
          !isAttachment && onResizeDragStart ? onResizeDragStart : null;
        return (
          <ChildBlockView
            key={index}
            child={child}
            displayChild={displayChild}
            index={index}
            row={row}
            pxPerSec={pxPerSec}
            isAttachment={isAttachment}
            isSelected={isSelected}
            isPrimary={isPrimary}
            selectedIndices={selectedIndices}
            onSelectionChange={onSelectionChange}
            onMultiSelectStart={onMultiSelectStart}
            multiSelectMode={multiSelectMode}
            onEnter={onEnter}
            isDraggingOut={reorderDragIndex === index}
            onReorderDragStart={blockReorderStart}
            onResizeDragStart={blockResizeStart}
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
  isPrimary,
  selectedIndices,
  onSelectionChange,
  onMultiSelectStart,
  multiSelectMode,
  onEnter,
  isDraggingOut,
  onReorderDragStart,
  onResizeDragStart,
}: {
  child: ResolvedChild;
  displayChild?: import("@seam/core").Child;
  index: number;
  row: number;
  pxPerSec: number;
  isAttachment: boolean;
  isSelected: boolean;
  isPrimary: boolean;
  selectedIndices: number[];
  onSelectionChange: (indices: number[]) => void;
  onMultiSelectStart: (index: number) => void;
  multiSelectMode: boolean;
  onEnter?: (index: number) => void;
  /** True while this block is the source of an active reorder drag —
   *  fade it so the user sees the ghost is the live thing. */
  isDraggingOut: boolean;
  /** When set, mouse-press + drag past the threshold hands off to the
   *  parent's reorder tracker. `null` disables reorder for this block
   *  (e.g. attachments, or views where reordering isn't writable). */
  onReorderDragStart: ((index: number, e: PointerEvent) => void) | null;
  /** When set, pointer-down on a side handle hands off to the parent's
   *  resize tracker. `null` hides the handles. */
  onResizeDragStart:
    | ((
        index: number,
        isAttachment: boolean,
        side: "left" | "right",
        e: React.PointerEvent,
      ) => void)
    | null;
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
  // Mouse-only: drag-to-reorder. `mouseDownPos` records the press
  // origin; `reorderHandedOff` flips true once we transition past the
  // movement threshold so the pointerup that follows doesn't fire a
  // click-to-select.
  const mouseDownPos = useRef<{ x: number; y: number } | null>(null);
  const reorderHandedOff = useRef(false);

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
    reorderHandedOff.current = false;
    if (e.pointerType === "mouse") {
      // Capture so pointermove keeps firing on this block even if the
      // cursor leaves it — that's the only way drag detection can win
      // when the user yanks the pointer fast.
      e.currentTarget.setPointerCapture(e.pointerId);
      mouseDownPos.current = { x: e.clientX, y: e.clientY };
    } else {
      pointerStart.current = { x: e.clientX, y: e.clientY };
      longPressTimer.current = window.setTimeout(() => {
        longPressFired.current = true;
        onMultiSelectStart(index);
      }, LONG_PRESS_MS);
    }
  };

  const handlePointerMove = (e: React.PointerEvent) => {
    if (pointerStart.current) {
      const dx = e.clientX - pointerStart.current.x;
      const dy = e.clientY - pointerStart.current.y;
      if (Math.hypot(dx, dy) > LONG_PRESS_SLOP_PX) clearLongPress();
    }
    if (
      e.pointerType === "mouse" &&
      mouseDownPos.current &&
      !reorderHandedOff.current &&
      onReorderDragStart
    ) {
      const dx = e.clientX - mouseDownPos.current.x;
      const dy = e.clientY - mouseDownPos.current.y;
      if (Math.hypot(dx, dy) > REORDER_THRESHOLD_PX) {
        reorderHandedOff.current = true;
        // Release the capture so DesktopTimeline's window listeners
        // are the sole pointer trackers from here on; the block no
        // longer needs to see further movement.
        try {
          e.currentTarget.releasePointerCapture(e.pointerId);
        } catch {
          // Already released — fine.
        }
        mouseDownPos.current = null;
        onReorderDragStart(index, e.nativeEvent);
      }
    }
  };

  const handlePointerUp = (e: React.PointerEvent) => {
    clearLongPress();
    mouseDownPos.current = null;
    if (reorderHandedOff.current) {
      // Drag took over — DesktopTimeline owns the rest. Don't toggle
      // selection on this click-that-wasn't.
      reorderHandedOff.current = false;
      return;
    }
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

  const interactiveHandlers = {
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
        border: isSelected
          ? isPrimary
            ? `2px solid ${PRIMARY_BORDER}`
            : selectedIndices.length >= 2
              ? `2px dashed ${SECONDARY_BORDER}`
              : `2px solid ${PRIMARY_BORDER}`
          : `2px solid ${colors.border}`,
        cursor: onReorderDragStart ? "grab" : "pointer",
        opacity: isDraggingOut ? 0.3 : isAttachment ? 0.85 : 1,
      }}
    >
      <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>
        {label}
      </span>
      {isSelected && onResizeDragStart && width > 2 * RESIZE_HANDLE_WIDTH && (
        <>
          <ResizeHandle
            side="left"
            onPointerDown={(e) =>
              onResizeDragStart(index, isAttachment, "left", e)
            }
          />
          <ResizeHandle
            side="right"
            onPointerDown={(e) =>
              onResizeDragStart(index, isAttachment, "right", e)
            }
          />
        </>
      )}
    </div>
  );
}

const RESIZE_HANDLE_WIDTH = 8;

/** Translucent 8px grip at the left/right edge of a selected block.
 *  Stops pointer/click propagation so it doesn't trip the block's
 *  selection / reorder / double-click handlers. */
function ResizeHandle({
  side,
  onPointerDown,
}: {
  side: "left" | "right";
  onPointerDown: (e: React.PointerEvent) => void;
}) {
  const stop = (e: React.SyntheticEvent) => e.stopPropagation();
  const base: React.CSSProperties = {
    position: "absolute",
    top: 0,
    bottom: 0,
    width: RESIZE_HANDLE_WIDTH,
    cursor: "ew-resize",
    background: "rgba(255, 255, 255, 0.55)",
    zIndex: 2,
  };
  return (
    <div
      onPointerDown={onPointerDown}
      onClick={stop}
      onDoubleClick={stop}
      style={side === "left" ? { ...base, left: 0 } : { ...base, right: 0 }}
    />
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

  // Delete/Backspace to remove selected blocks — handles both `children` and
  // `attachments` indices. Root view only (nested views have their own UX).
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
        onDocumentChange(removeSelected(doc, selectedIndices));
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
        flex: 1,
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
        // Editing attachments writes to the root doc, so only enable it
        // when we're actually rendering the root view (composition view's
        // doc is a derivation that doesn't propagate back).
        const editHistory = view.type === "root" ? history : undefined;
        // Reorder is only writable in root view (same gating as the
        // delete shortcut) — composition-view edits would need to
        // splice into the nested children inside `doc`, which the
        // current onDocumentChange flow doesn't model.
        const onReorder =
          view.type === "root" && doc && onDocumentChange
            ? (from: number, to: number) => {
                if (from === to || from === to - 1) return;
                const next = reorderChildren(doc.children, from, to);
                onDocumentChange({ ...doc, children: next });
                // Keep the moved child selected so the user can chain
                // edits without re-clicking it.
                const newIndex = to > from ? to - 1 : to;
                onSelectionChange([newIndex]);
              }
            : undefined;
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
            editHistory={editHistory}
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
            editHistory={editHistory}
            onReorder={onReorder}
          />
        );
      })()}
    </div>
  );
}

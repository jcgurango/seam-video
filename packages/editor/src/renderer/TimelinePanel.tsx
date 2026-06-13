import React, { useRef, useMemo, useCallback, useState, useEffect } from "react";
import { useTimeline } from "@seam/preview";
import { ChevronRight, ChevronDown, Boxes } from "lucide-react";
import type {
  BinEntry,
  Child,
  ResolvedTimeline,
  ResolvedChild,
  SeamFile,
} from "@seam/core";
import { buildItemsFromFiles, useImport } from "./useImport.js";
import { attachNewItems } from "./attachTool.js";
import { dirname } from "./pathUtils.js";
import type { History } from "./useHistory.js";
import type { Platform } from "./platform/index.js";
import { removeSelected } from "./selection.js";
import {
  ROW_HEIGHT,
  ROW_GAP,
  RULER_HEIGHT,
  DEPTH_INSET,
  rowTop,
} from "./timelineLayout.js";
import { layoutTree, type TreeBlock, type TreeGroup } from "./timelineTree.js";
import AnchorLinesLayer from "./AnchorLinesLayer.js";
import { resizeChild } from "./resizeTool.js";
import { useEvent } from "./useEvent.js";

export interface TimelinePanelProps {
  timeline: ResolvedTimeline;
  /**
   * The authored document whose `children`/`attachments` correspond to the
   * timeline. When undefined the panel is read-only (e.g. the CC-cut
   * preview) — editing, reorder, attach, delete, and import are all
   * disabled and block labels fall back to the resolved nodes.
   */
  document?: SeamFile;
  filePath?: string | null;
  selectedIndices: number[];
  onSelectionChange: (indices: number[]) => void;
  onDocumentChange?: (doc: SeamFile) => void;
  history: History<SeamFile>;
  platform: Platform;
}

const MIN_PX_PER_SEC = 10;
const MAX_PX_PER_SEC = 1000;
const DEFAULT_PX_PER_SEC = 100;
const HANDLE_WIDTH = 10;
/** Pixels of movement before a mouse press on a child block is treated
 *  as drag-to-reorder rather than a click. */
const REORDER_THRESHOLD_PX = 6;

/** Stable empty bin so `layoutTree`'s memo doesn't bust each render when a
 *  document has no `bin`. */
const EMPTY_BIN: BinEntry[] = [];

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
  sortedChildBlocks: TreeBlock[],
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
  sortedChildBlocks: TreeBlock[],
  pxPerSec: number,
): number {
  if (sortedChildBlocks.length === 0) return 0;
  if (insertIdx >= sortedChildBlocks.length) {
    const last = sortedChildBlocks[sortedChildBlocks.length - 1];
    return last.child.timelineEnd * pxPerSec;
  }
  return sortedChildBlocks[insertIdx].child.timelineStart * pxPerSec;
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
  graphic: { bg: "#b03a8f", border: "#d957b8" },
};

// Window-boundary markers drawn at the left/right edges of an expanded
// composition (its `in`/`out` window), in the composition accent. Overlaid
// (pointer-events: none) so they sit above the clipped content.
const EXP_BOUNDARY_BASE: React.CSSProperties = {
  position: "absolute",
  top: 0,
  bottom: 0,
  width: 2,
  background: BLOCK_COLORS.composition.border,
  opacity: 0.7,
  pointerEvents: "none",
  zIndex: 1,
};
const EXP_BOUNDARY_LEFT: React.CSSProperties = { ...EXP_BOUNDARY_BASE, left: 0 };
const EXP_BOUNDARY_RIGHT: React.CSSProperties = { ...EXP_BOUNDARY_BASE, right: 0 };

const PRIMARY_BORDER = "#ffcc00";
// Secondary selection: dashed yellow conveys "linked to the primary" — we
// reuse the same hue so it reads as still-selected, but the dashes signal
// that this block is a follower, not the lead.
const SECONDARY_BORDER = "#b8a040";
const SELECTED_BORDER = PRIMARY_BORDER;

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
  /** Set of expanded composition addresses (see `timelineTree`). */
  expanded: Set<string>;
  /** Toggle a composition's expanded state by its address. */
  onToggleExpand: (addr: string) => void;
  /** Root document's bin entries — for pairing `binItem` expansions. */
  rootBin: BinEntry[];
  /** Provided only when the panel is editable, where attachment edits are
   *  writable. */
  editHistory?: History<SeamFile>;
  /** Commit a reorder of sequential children: move `from` to be at
   *  insertion index `to` (in the post-removal array). Undefined when
   *  reorder isn't supported. */
  onReorder?: (from: number, to: number) => void;
  /** Index of the single child that's selected AND a valid anchor
   *  target — null otherwise. When non-null and a file is being
   *  dragged, the attach zone appears beneath the blocks. */
  attachIndex?: number | null;
  /** Receives a file drop on the attach zone. The shell computes `side`
   *  from cursor X relative to the playhead. */
  onAttachDrop?: (side: "start" | "end", files: FileList) => void;
  /** Receives a grabbed-clip drop on the attach zone — moves the existing
   *  child at `fromIndex` into the selected anchor's attachments. */
  onAttachExisting?: (side: "start" | "end", fromIndex: number) => void;
  /** Cursor-based file import. `insertIndex` is the slot computed via
   *  the same reorder snap math; omit for the playhead-snap fallback. */
  importFiles?: (
    files: FileList | File[],
    insertIndex?: number,
  ) => Promise<void>;
}

// ── Timeline surface (hook + body) ───────────────────────────────────
//
// The timeline shell boils down to: scroll container + playhead + this
// body. The hook and body are split out so a future mobile shell can
// reuse them with its own scroll/playhead layout.

interface TimelineSurfaceState {
  pxPerSec: number;
  setPxPerSec: React.Dispatch<React.SetStateAction<number>>;
  splitIndex: number;
  /** The root composition body's layout group (nested expansions hang
   *  off its blocks). */
  rootGroup: TreeGroup;
  rowCount: number;
  contentHeight: number;
  rulerTicks: number[];
}

/** State + effects for the timeline shell: zoom level, block layout,
 *  content height, ruler ticks, and the Ctrl/Cmd+wheel zoom listener
 *  attached to the scroll container. */
function useTimelineSurfaceState(
  timeline: ResolvedTimeline,
  attachmentStartIndex: number | undefined,
  authored: { children: Child[]; attachments?: Child[] } | undefined,
  expanded: Set<string>,
  rootBin: BinEntry[],
  scrollRef: React.RefObject<HTMLDivElement | null>,
): TimelineSurfaceState {
  const { totalDuration } = useTimeline();
  const [pxPerSec, setPxPerSec] = useState(DEFAULT_PX_PER_SEC);

  const splitIndex = attachmentStartIndex ?? timeline.children.length;
  const rootGroup = useMemo(
    () => layoutTree(timeline.children, authored, splitIndex, expanded, rootBin),
    [timeline, authored, splitIndex, expanded, rootBin],
  );
  const rowCount = rootGroup.rowCount;
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
    rootGroup,
    rowCount,
    contentHeight,
    rulerTicks,
  };
}

interface TimelineSurfaceProps {
  surface: TimelineSurfaceState;
  timeline: ResolvedTimeline;
  /** The shell's scroll container — used to scrub the playhead (audio
   *  feedback) to the cursor's content time during a resize drag. */
  scrollRef: React.RefObject<HTMLDivElement | null>;
  docRoot?: {
    children: import("@seam/core").Child[];
    attachments?: import("@seam/core").Child[];
  };
  selectedIndices: number[];
  onSelectionChange: (indices: number[]) => void;
  expanded: Set<string>;
  onToggleExpand: (addr: string) => void;
  editHistory?: History<SeamFile>;
  /** Index of the child currently being reorder-dragged (fades its
   *  block view). Pass `null` when the shell doesn't support reorder. */
  reorderDragIndex: number | null;
  /** Hand-off callback when a child block's mouse-press passes the
   *  drag threshold. Pass `null` to disable reorder for this shell. */
  onReorderDragStart: ((index: number, e: PointerEvent) => void) | null;
  /** Content-X (px) of the cursor-snap insertion line during a file
   *  drag. Null hides the insertion ghost. */
  insertionGhostX?: number | null;
  /** True when the attach zone should be rendered (shell-decided based
   *  on dragOver + a clip selection). */
  showAttachZone?: boolean;
  /** Highlight state for the attach zone's two halves. Null when the
   *  cursor isn't over the zone. */
  attachHoverSide?: "start" | "end" | null;
}

/** Body of the timeline: ruler + child blocks + anchor lines. Positioned
 *  absolutely within the parent's content box, so each shell wraps it in
 *  its own scroll/padding/playhead layout. */
function TimelineSurface({
  surface,
  timeline,
  scrollRef,
  docRoot,
  selectedIndices,
  onSelectionChange,
  expanded,
  onToggleExpand,
  editHistory,
  reorderDragIndex,
  onReorderDragStart,
  insertionGhostX,
  showAttachZone,
  attachHoverSide,
}: TimelineSurfaceProps) {
  const { pxPerSec, rootGroup, contentHeight, rulerTicks } = surface;
  const { currentTime, totalDuration, seek } = useTimeline();

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
        // Scrub the playhead to the cursor (same audio feedback as
        // dragging on the timeline) rather than trying to "correct" the
        // playhead to keep content fixed — that fought the user's drag.
        const container = scrollRef.current;
        if (container) {
          const rect = container.getBoundingClientRect();
          const contentX = me.clientX - rect.left + container.scrollLeft;
          seek(Math.max(0, Math.min(contentX / pxPerSec, totalDuration)));
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
      <TimelineGroup
        group={rootGroup}
        yBase={RULER_HEIGHT + ROW_GAP}
        depth={0}
        pxPerSec={pxPerSec}
        selectedIndices={selectedIndices}
        onSelectionChange={onSelectionChange}
        expanded={expanded}
        onToggleExpand={onToggleExpand}
        reorderDragIndex={reorderDragIndex}
        onReorderDragStart={onReorderDragStart}
        onResizeDragStart={onResizeDragStart}
      />
      <AnchorLinesLayer
        selectedIndices={selectedIndices}
        docRoot={docRoot}
        timeline={timeline}
        blocks={rootGroup.blocks}
        pxPerSec={pxPerSec}
        history={editHistory}
      />
      {insertionGhostX != null && (
        <InsertionGhost x={insertionGhostX} height={contentHeight} />
      )}
      {showAttachZone && (
        <AttachZone
          top={contentHeight}
          playheadX={currentTime * pxPerSec}
          hoverSide={attachHoverSide ?? null}
        />
      )}
    </>
  );
}

const ATTACH_ZONE_HEIGHT = 40;

function InsertionGhost({ x, height }: { x: number; height: number }) {
  return (
    <div
      style={{
        position: "absolute",
        left: x - 1,
        top: 0,
        width: 2,
        height,
        background: "#4a9eff",
        boxShadow: "0 0 6px rgba(74, 158, 255, 0.8)",
        zIndex: 8,
        pointerEvents: "none",
      }}
    />
  );
}

/** Display-only strip rendered just below the timeline rows when a
 *  clip is selected and a file is being dragged. The shell owns the
 *  actual drop event — it computes `hoverSide` from cursor X relative
 *  to the playhead and routes the drop to `attachNewItems`. */
function AttachZone({
  top,
  playheadX,
  hoverSide,
}: {
  top: number;
  playheadX: number;
  hoverSide: "start" | "end" | null;
}) {
  return (
    <div
      style={{
        position: "absolute",
        left: 0,
        top: top + 4,
        right: 0,
        height: ATTACH_ZONE_HEIGHT - 4,
        zIndex: 9,
        pointerEvents: "none",
      }}
    >
      {/* Left half: end-anchor */}
      <div
        style={{
          position: "absolute",
          left: 0,
          top: 0,
          width: playheadX,
          height: "100%",
          background:
            hoverSide === "end"
              ? "rgba(255, 204, 0, 0.35)"
              : "rgba(255, 204, 0, 0.12)",
          border: `1px ${hoverSide === "end" ? "solid" : "dashed"} #ffcc00`,
          borderRadius: 3,
          display: "flex",
          alignItems: "center",
          justifyContent: "flex-end",
          paddingRight: 12,
          color: "#ffcc00",
          fontSize: 11,
          fontWeight: 600,
          textShadow: "0 1px 2px rgba(0,0,0,0.6)",
          pointerEvents: "none",
          boxSizing: "border-box",
        }}
      >
        end-anchored ⟧
      </div>
      {/* Right half: start-anchor */}
      <div
        style={{
          position: "absolute",
          left: playheadX,
          top: 0,
          right: 0,
          height: "100%",
          background:
            hoverSide === "start"
              ? "rgba(81, 207, 102, 0.35)"
              : "rgba(81, 207, 102, 0.12)",
          border: `1px ${hoverSide === "start" ? "solid" : "dashed"} #51cf66`,
          borderRadius: 3,
          display: "flex",
          alignItems: "center",
          paddingLeft: 12,
          color: "#51cf66",
          fontSize: 11,
          fontWeight: 600,
          textShadow: "0 1px 2px rgba(0,0,0,0.6)",
          pointerEvents: "none",
          boxSizing: "border-box",
        }}
      >
        ⟦ start-anchored
      </div>
    </div>
  );
}

function DesktopTimeline({
  timeline,
  docRoot,
  attachmentStartIndex,
  selectedIndices,
  onSelectionChange,
  expanded,
  onToggleExpand,
  rootBin,
  editHistory,
  onReorder,
  attachIndex,
  onAttachDrop,
  onAttachExisting,
  importFiles,
}: InnerProps) {
  const { currentTime, totalDuration, isPlaying, seek } = useTimeline();
  const scrollRef = useRef<HTMLDivElement>(null);
  const surface = useTimelineSurfaceState(
    timeline,
    attachmentStartIndex,
    docRoot,
    expanded,
    rootBin,
    scrollRef,
  );
  const { pxPerSec, rootGroup, contentHeight } = surface;
  // Root-level blocks drive reorder / file-insertion snap math.
  const blocks = rootGroup.blocks;

  // Reorder drag state. Cursor is in content (scroll-relative) px and
  // drives the shared insertion ghost (same as a file drag); `cursorY`
  // lets a grabbed clip hit the attach zone too, like a dropped file.
  const [reorderDrag, setReorderDrag] = useState<{
    fromIndex: number;
    cursorX: number;
    cursorY: number;
  } | null>(null);

  // File-drag state. cursorContentX drives the insertion ghost +
  // cursor-based snap; cursorContentY decides attach zone vs main area.
  const [fileDrag, setFileDrag] = useState<{
    cursorContentX: number;
    cursorContentY: number;
  } | null>(null);

  const contentWidth = Math.max(totalDuration * pxPerSec + 200, 200);

  // The attach zone is available during a file drag (drop files as
  // attachments) and during a grabbed-clip drag (re-attach an existing
  // child) — both anchored to the selected clip, as long as the grabbed
  // clip isn't itself the anchor.
  const fileAttachActive =
    fileDrag != null && attachIndex != null && !!onAttachDrop;
  const itemAttachActive =
    reorderDrag != null &&
    attachIndex != null &&
    reorderDrag.fromIndex !== attachIndex &&
    !!onAttachExisting;
  const showAttachZone = fileAttachActive || itemAttachActive;
  const totalContentHeight = contentHeight + (showAttachZone ? ATTACH_ZONE_HEIGHT : 0);

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
      const cursorY = e.clientY - rect.top + container.scrollTop;
      setReorderDrag({ fromIndex: index, cursorX, cursorY });
    },
    [onReorder],
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

    const cursorFromEvent = (e: PointerEvent): { x: number; y: number } => {
      const rect = container.getBoundingClientRect();
      return {
        x: e.clientX - rect.left + container.scrollLeft,
        y: e.clientY - rect.top + container.scrollTop,
      };
    };

    const onMove = (e: PointerEvent) => {
      const { x, y } = cursorFromEvent(e);
      setReorderDrag((prev) =>
        prev ? { ...prev, cursorX: x, cursorY: y } : null,
      );
    };

    const onUp = (e: PointerEvent) => {
      const { x: cursorX, y: cursorY } = cursorFromEvent(e);
      const from = dragRef.fromIndex;
      // Dropping a grabbed clip on the attach zone attaches it to the
      // selected anchor — same handler intent as a dropped file.
      const inAttachZone =
        attachIndex != null &&
        from !== attachIndex &&
        onAttachExisting != null &&
        cursorY >= contentHeight;
      if (inAttachZone) {
        const side = cursorX >= currentTime * pxPerSec ? "start" : "end";
        onAttachExisting(side, from);
      } else {
        const toIndex = computeInsertionIndex(
          cursorX,
          reorderableBlocks,
          pxPerSec,
        );
        const isNoop = toIndex === from || toIndex === from + 1;
        if (!isNoop) onReorder(from, toIndex);
      }
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

  // ── File drag-and-drop ────────────────────────────────────────
  const cursorToContent = (e: React.DragEvent) => {
    const container = scrollRef.current;
    if (!container) return null;
    const rect = container.getBoundingClientRect();
    return {
      x: e.clientX - rect.left + container.scrollLeft,
      y: e.clientY - rect.top + container.scrollTop,
    };
  };

  const handleFileDragOver = (e: React.DragEvent) => {
    if (!e.dataTransfer.types.includes("Files")) return;
    e.preventDefault();
    const pos = cursorToContent(e);
    if (pos) setFileDrag({ cursorContentX: pos.x, cursorContentY: pos.y });
  };

  const handleFileDragLeave = (e: React.DragEvent) => {
    // Only clear if leaving the scroll container's rect — dragleave
    // fires whenever we cross any descendant element, which would
    // otherwise blink the ghost off whenever the cursor passes between
    // children.
    const container = scrollRef.current;
    if (!container) return;
    const rect = container.getBoundingClientRect();
    if (
      e.clientX < rect.left ||
      e.clientX >= rect.right ||
      e.clientY < rect.top ||
      e.clientY >= rect.bottom
    ) {
      setFileDrag(null);
    }
  };

  const handleFileDrop = (e: React.DragEvent) => {
    if (!e.dataTransfer.types.includes("Files")) return;
    e.preventDefault();
    const pos = cursorToContent(e);
    setFileDrag(null);
    if (!pos) return;
    if (e.dataTransfer.files.length === 0) return;

    const inAttachZone =
      showAttachZone && pos.y >= contentHeight && onAttachDrop != null;
    if (inAttachZone) {
      const side = pos.x >= currentTime * pxPerSec ? "start" : "end";
      onAttachDrop!(side, e.dataTransfer.files);
      return;
    }
    if (importFiles) {
      const idx = computeInsertionIndex(pos.x, reorderableBlocks, pxPerSec);
      void importFiles(e.dataTransfer.files, idx);
    }
  };

  const playheadX = currentTime * pxPerSec;
  // A grabbed clip and a dragged-in file share the same drag position →
  // the same insertion ghost (reorder = "drop this existing child at the
  // snapped slot") and the same attach-zone hover.
  const dragPos: { x: number; y: number } | null =
    fileDrag != null
      ? { x: fileDrag.cursorContentX, y: fileDrag.cursorContentY }
      : reorderDrag != null
        ? { x: reorderDrag.cursorX, y: reorderDrag.cursorY }
        : null;
  const inAttachZone =
    showAttachZone && dragPos != null && dragPos.y >= contentHeight;
  const insertionGhostX =
    dragPos != null && !inAttachZone
      ? insertionIndexToX(
          computeInsertionIndex(dragPos.x, reorderableBlocks, pxPerSec),
          reorderableBlocks,
          pxPerSec,
        )
      : null;
  const attachHoverSide: "start" | "end" | null = inAttachZone
    ? dragPos!.x >= playheadX
      ? "start"
      : "end"
    : null;

  return (
    <div
      ref={scrollRef}
      onPointerDown={handlePointerDown}
      onDragOver={handleFileDragOver}
      onDragLeave={handleFileDragLeave}
      onDrop={handleFileDrop}
      style={{
        flex: 1,
        overflow: "auto",
        position: "relative",
        cursor: reorderDrag ? "grabbing" : "crosshair",
      }}
    >
      <div style={{ width: contentWidth, height: totalContentHeight, position: "relative" }}>
        <TimelineSurface
          surface={surface}
          timeline={timeline}
          scrollRef={scrollRef}
          docRoot={docRoot}
          selectedIndices={selectedIndices}
          onSelectionChange={onSelectionChange}
          expanded={expanded}
          onToggleExpand={onToggleExpand}
          editHistory={editHistory}
          reorderDragIndex={reorderDrag?.fromIndex ?? null}
          onReorderDragStart={onReorder ? startReorderDrag : null}
          insertionGhostX={insertionGhostX}
          showAttachZone={showAttachZone}
          attachHoverSide={attachHoverSide}
        />
        <Playhead x={playheadX} height={contentHeight} />
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

/**
 * Renders one composition body's blocks, then — for each expanded
 * composition — an `overflow:hidden` container holding a nested
 * `<TimelineGroup>`. The container is positioned at the composition's
 * window (left/width from the block) so its inner, full (un-windowed)
 * timeline is clipped to that window: things outside simply don't show,
 * and (once interactions land) moving a child past the edge clips rather
 * than vanishes. Coordinates are local to each group — the container is a
 * fresh positioning context, so a nested block's x is just
 * `child.timelineStart * pxPerSec` again.
 *
 * Only the root group (`depth === 0`) is interactive this phase; nested
 * groups render and expand/collapse but don't select/reorder/resize.
 */
function TimelineGroup({
  group,
  yBase,
  depth,
  pxPerSec,
  selectedIndices,
  onSelectionChange,
  expanded,
  onToggleExpand,
  reorderDragIndex,
  onReorderDragStart,
  onResizeDragStart,
}: {
  group: TreeGroup;
  /** Y offset (px) for row 0 within this group's container. */
  yBase: number;
  depth: number;
  pxPerSec: number;
  selectedIndices: number[];
  onSelectionChange: (indices: number[]) => void;
  expanded: Set<string>;
  onToggleExpand: (addr: string) => void;
  reorderDragIndex: number | null;
  onReorderDragStart: ((index: number, e: PointerEvent) => void) | null;
  onResizeDragStart:
    | ((
        index: number,
        isAttachment: boolean,
        side: "left" | "right",
        e: React.PointerEvent,
      ) => void)
    | null;
}) {
  const isRoot = depth === 0;
  // Window transform: inner time → this group's container px. A child of a
  // windowed composition is shifted by the window `in` and compressed by
  // the window speed; the container clips what lands outside.
  const toX = (sec: number) => ((sec - group.originSec) / group.scale) * pxPerSec;
  return (
    <>
      {group.blocks.map((block) => {
        const { child, index, row, isAttachment, docChild, addr } = block;
        const isSelected = isRoot && selectedIndices.includes(index);
        const isPrimary =
          isSelected &&
          !isAttachment &&
          selectedIndices.length >= 2 &&
          selectedIndices[0] === index;
        // Reorder is sequential-children only (attachments are
        // anchor-positioned). Resize handles apply to attachments too —
        // their length has little bearing, and it's easy to fix after.
        const blockReorderStart =
          isRoot && !isAttachment && onReorderDragStart ? onReorderDragStart : null;
        const blockResizeStart =
          isRoot && onResizeDragStart ? onResizeDragStart : null;
        const left = toX(child.timelineStart);
        const width = Math.max(toX(child.timelineEnd) - left, 2);
        return (
          <ChildBlockView
            key={addr}
            child={child}
            displayChild={docChild}
            index={index}
            left={left}
            top={yBase + rowTop(row)}
            width={width}
            depth={depth}
            isAttachment={isAttachment}
            isSelected={isSelected}
            isPrimary={isPrimary}
            isRoot={isRoot}
            isComposition={block.isComposition}
            isBinItem={block.isBinItem}
            isExpanded={block.isExpanded}
            onToggleExpand={() => onToggleExpand(addr)}
            selectedIndices={selectedIndices}
            onSelectionChange={onSelectionChange}
            isDraggingOut={reorderDragIndex === index && isRoot}
            onReorderDragStart={blockReorderStart}
            onResizeDragStart={blockResizeStart}
          />
        );
      })}
      {group.blocks.map((block) => {
        if (!block.expansion) return null;
        const { group: sub, topRow } = block.expansion;
        const left = toX(block.child.timelineStart);
        const width = Math.max(toX(block.child.timelineEnd) - left, 2);
        return (
          <div
            key={`${block.addr}-exp`}
            style={{
              position: "absolute",
              left,
              top: yBase + rowTop(topRow),
              width,
              height: sub.rowCount * (ROW_HEIGHT + ROW_GAP),
              overflow: "hidden",
            }}
          >
            <TimelineGroup
              group={sub}
              yBase={0}
              depth={depth + 1}
              pxPerSec={pxPerSec}
              selectedIndices={selectedIndices}
              onSelectionChange={onSelectionChange}
              expanded={expanded}
              onToggleExpand={onToggleExpand}
              reorderDragIndex={null}
              onReorderDragStart={null}
              onResizeDragStart={null}
            />
            {/* Window boundary lines (left = in, right = out), drawn over
                the clipped content so the composition's extent is clear. */}
            <div style={EXP_BOUNDARY_LEFT} />
            <div style={EXP_BOUNDARY_RIGHT} />
          </div>
        );
      })}
    </>
  );
}

function ChildBlockView({
  child,
  displayChild,
  index,
  left,
  top,
  width,
  depth,
  isAttachment,
  isSelected,
  isPrimary,
  isRoot,
  isComposition,
  isBinItem,
  isExpanded,
  onToggleExpand,
  selectedIndices,
  onSelectionChange,
  isDraggingOut,
  onReorderDragStart,
  onResizeDragStart,
}: {
  child: ResolvedChild;
  displayChild?: import("@seam/core").Child;
  index: number;
  /** Absolute position within the block's group container (px). */
  left: number;
  top: number;
  width: number;
  depth: number;
  isAttachment: boolean;
  isSelected: boolean;
  isPrimary: boolean;
  /** depth === 0: the only interactive level this phase. */
  isRoot: boolean;
  isComposition: boolean;
  isBinItem: boolean;
  isExpanded: boolean;
  onToggleExpand: () => void;
  selectedIndices: number[];
  onSelectionChange: (indices: number[]) => void;
  /** True while this block is the source of an active reorder drag —
   *  fade it so the user sees the ghost is the live thing. */
  isDraggingOut: boolean;
  /** When set, mouse-press + drag past the threshold hands off to the
   *  parent's reorder tracker. `null` disables reorder for this block
   *  (e.g. attachments, nested blocks, or read-only previews). */
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
  const label = childLabel(displayChild, child);
  const displayType = displayChild?.type ?? child.type;
  const colors = BLOCK_COLORS[displayType] ?? BLOCK_COLORS.clip;

  // Drag-to-reorder. `mouseDownPos` records the press origin;
  // `reorderHandedOff` flips true once we move past the threshold so the
  // pointerup that follows doesn't fire a click-to-select.
  const mouseDownPos = useRef<{ x: number; y: number } | null>(null);
  const reorderHandedOff = useRef(false);

  const toggleMembership = () => {
    if (selectedIndices.includes(index)) {
      onSelectionChange(selectedIndices.filter((i) => i !== index));
    } else {
      onSelectionChange([...selectedIndices, index]);
    }
  };

  const handlePointerDown = (e: React.PointerEvent) => {
    e.stopPropagation();
    reorderHandedOff.current = false;
    // Capture so pointermove keeps firing on this block even if the
    // cursor leaves it — that's the only way drag detection can win
    // when the user yanks the pointer fast.
    e.currentTarget.setPointerCapture(e.pointerId);
    mouseDownPos.current = { x: e.clientX, y: e.clientY };
  };

  const handlePointerMove = (e: React.PointerEvent) => {
    if (
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
    mouseDownPos.current = null;
    if (reorderHandedOff.current) {
      // Drag took over — DesktopTimeline owns the rest. Don't toggle
      // selection on this click-that-wasn't.
      reorderHandedOff.current = false;
      return;
    }
    e.stopPropagation();
    const modifier = e.ctrlKey || e.metaKey;
    if (modifier) {
      // Ctrl/Cmd+click toggles this block's membership in the selection.
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

  const handlePointerCancel = () => {
    mouseDownPos.current = null;
  };

  // Only the root level is interactive this phase; nested blocks render
  // but don't select/reorder/resize (the chevron is the one exception and
  // carries its own handler).
  const interactiveHandlers = isRoot
    ? {
        onPointerDown: handlePointerDown,
        onPointerMove: handlePointerMove,
        onPointerUp: handlePointerUp,
        onPointerCancel: handlePointerCancel,
        onContextMenu: (e: React.MouseEvent) => e.preventDefault(),
      }
    : {};

  // Nested blocks sit slightly inset within their row so the nesting reads
  // visually without breaking time alignment on the x-axis.
  const vInset = isRoot ? 0 : Math.min(depth, 3) * DEPTH_INSET;
  const border = isBinItem
    ? `2px dashed ${colors.border}` // shared bin entry — dashed to signal it
    : isSelected
      ? isPrimary
        ? `2px solid ${PRIMARY_BORDER}`
        : selectedIndices.length >= 2
          ? `2px dashed ${SECONDARY_BORDER}`
          : `2px solid ${PRIMARY_BORDER}`
      : `2px solid ${colors.border}`;

  return (
    <div
      {...interactiveHandlers}
      style={{
        position: "absolute",
        left,
        top: top + vInset,
        width,
        height: ROW_HEIGHT - 2 * vInset,
        background: isSelected ? "#4a7eb8" : colors.bg,
        borderRadius: 3,
        overflow: "hidden",
        display: "flex",
        alignItems: "center",
        gap: 4,
        paddingLeft: 6,
        paddingRight: 6,
        fontSize: 11,
        color: "#fff",
        whiteSpace: "nowrap",
        boxSizing: "border-box",
        border,
        cursor: onReorderDragStart ? "grab" : isRoot ? "pointer" : "default",
        opacity: isDraggingOut ? 0.3 : isAttachment ? 0.85 : depth > 0 ? 0.92 : 1,
      }}
    >
      {isComposition && (
        <button
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation();
            onToggleExpand();
          }}
          title={isExpanded ? "Collapse" : "Expand"}
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            background: "rgba(0,0,0,0.25)",
            border: "none",
            borderRadius: 3,
            color: "#fff",
            cursor: "pointer",
            padding: 0,
            width: 14,
            height: 14,
            flexShrink: 0,
          }}
        >
          {isExpanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        </button>
      )}
      {isBinItem && <Boxes size={11} style={{ flexShrink: 0, opacity: 0.9 }} />}
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

// ── Root component ───────────────────────────────────────────────────

export default function TimelinePanel({
  timeline,
  document: doc,
  filePath,
  selectedIndices,
  onSelectionChange,
  onDocumentChange,
  history,
  platform,
}: TimelinePanelProps) {
  const { currentTime } = useTimeline();
  // The panel is editable only when given a document; the CC-cut preview
  // passes none, leaving the timeline read-only (selection-only).
  const editable = doc != null;
  // Expanded compositions, keyed by node address (see `timelineTree`).
  // Local to the panel: expansion is a view concern, not part of the doc.
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const onToggleExpand = useCallback((addr: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(addr)) next.delete(addr);
      else next.add(addr);
      return next;
    });
  }, []);
  const rootBin = doc?.bin ?? EMPTY_BIN;
  const emptyDoc: SeamFile = { type: "composition", children: [] };
  const importFiles = useImport(
    doc ?? emptyDoc,
    filePath ?? null,
    onDocumentChange ?? (() => {}),
    platform
  );

  // Single sequential-child selection that's a valid anchor target —
  // drives the attach zone's existence during drag.
  const attachIndex = useMemo<number | null>(() => {
    if (!doc) return null;
    if (selectedIndices.length !== 1) return null;
    const idx = selectedIndices[0];
    if (idx < 0 || idx >= doc.children.length) return null;
    const child = doc.children[idx];
    if (
      child.type !== "clip" &&
      child.type !== "audio" &&
      child.type !== "composition"
    ) {
      return null;
    }
    return idx;
  }, [doc, selectedIndices]);

  const handleAttachDrop = useCallback(
    async (side: "start" | "end", files: FileList) => {
      if (!doc || !onDocumentChange) return;
      if (attachIndex == null) return;
      const baseDir = filePath ? dirname(filePath) : null;
      const newItems = await buildItemsFromFiles(files, platform, baseDir);
      if (newItems.length === 0) return;
      const next = attachNewItems(
        doc,
        currentTime,
        attachIndex,
        newItems,
        side,
      );
      if (next) onDocumentChange(next);
    },
    [doc, onDocumentChange, attachIndex, filePath, platform, currentTime],
  );

  // Drop a grabbed child on the attach zone → move it into the selected
  // anchor's attachments. Routed through the SAME `attachNewItems` path as
  // a file drop: the dragged clip is stripped of any existing anchors and
  // removed from `children`, then re-added as a fresh single-(start|end)-
  // anchored attachment — so it can't end up pinned on both ends. Clears
  // selection because the child moved and indices shift.
  const handleAttachExisting = useCallback(
    (side: "start" | "end", fromIndex: number) => {
      if (!doc || !onDocumentChange) return;
      if (attachIndex == null || fromIndex === attachIndex) return;
      const child = doc.children[fromIndex];
      if (!child) return;
      const item = { ...child } as Child;
      delete (item as { start?: unknown }).start;
      delete (item as { end?: unknown }).end;
      const remaining = doc.children.filter((_, i) => i !== fromIndex);
      // Removing an earlier child shifts the anchor's index down by one.
      const anchorIdx = fromIndex < attachIndex ? attachIndex - 1 : attachIndex;
      const next = attachNewItems(
        { ...doc, children: remaining },
        currentTime,
        anchorIdx,
        [item],
        side,
      );
      if (next) {
        onDocumentChange(next);
        onSelectionChange([]);
      }
    },
    [doc, onDocumentChange, attachIndex, currentTime, onSelectionChange],
  );

  // Delete/Backspace to remove selected blocks — handles both `children`
  // and `attachments` indices. Editable panels only (the CC-cut preview
  // routes Delete through its own handler in App).
  useEffect(() => {
    if (!doc) return;
    const handler = (e: KeyboardEvent) => {
      if (
        (e.key === "Delete" || e.key === "Backspace") &&
        selectedIndices.length > 0 &&
        onDocumentChange
      ) {
        e.preventDefault();
        onDocumentChange(removeSelected(doc, selectedIndices));
        onSelectionChange([]);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [selectedIndices, doc, onDocumentChange, onSelectionChange]);

  // Only forward file drop / attach callbacks when editable; a read-only
  // preview should no-op on drop.
  const shellImportFiles = editable ? importFiles : undefined;
  const shellAttachIndex = editable ? attachIndex : null;
  const shellOnAttachDrop = editable ? handleAttachDrop : undefined;
  const shellOnAttachExisting = editable ? handleAttachExisting : undefined;

  return (
    <div
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
      {(() => {
        // The panel renders the document's children (+ attachments) as
        // blocks. A read-only preview has no doc, so labels fall back to
        // the resolved nodes and editing is disabled.
        const panelDoc = doc;
        const splitIndex = panelDoc ? panelDoc.children.length : undefined;
        const editHistory = editable ? history : undefined;
        const onReorder =
          doc && onDocumentChange
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
        return (
          <DesktopTimeline
            timeline={timeline}
            docRoot={panelDoc}
            attachmentStartIndex={splitIndex}
            selectedIndices={selectedIndices}
            onSelectionChange={onSelectionChange}
            expanded={expanded}
            onToggleExpand={onToggleExpand}
            rootBin={rootBin}
            editHistory={editHistory}
            onReorder={onReorder}
            attachIndex={shellAttachIndex}
            onAttachDrop={shellOnAttachDrop}
            onAttachExisting={shellOnAttachExisting}
            importFiles={shellImportFiles}
          />
        );
      })()}
    </div>
  );
}

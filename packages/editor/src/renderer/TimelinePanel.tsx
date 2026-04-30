import React, { useRef, useMemo, useCallback, useState, useEffect } from "react";
import { useTimeline } from "@seam/preview";
import { resolveComposition } from "@seam/core";
import type {
  ResolvedTimeline,
  ResolvedChild,
  SeamFile,
  Child,
  Clip,
  TimeAnchor,
} from "@seam/core";
import { useImport } from "./useImport.js";
import type { View } from "./views.js";
import type { History } from "./useHistory.js";
import type { Platform } from "./platform/index.js";
import { removeSelected } from "./selection.js";

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

function childLabel(docChild: import("@seam/core").Child | undefined, resolved: ResolvedChild): string {
  if (docChild) {
    if (docChild.type === "clip" || docChild.type === "audio") {
      return (docChild.source ?? "").split("/").pop() || "untitled";
    }
    if (docChild.type === "empty") return "empty";
    if (docChild.type === "data") return "data";
    return docChild.type;
  }
  // Fallback to resolved tree (shouldn't happen given we always pass docChild)
  if (resolved.type === "clip" || resolved.type === "audio") {
    return (resolved.source ?? "").split("/").pop() || "untitled";
  }
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
        <AnchorLinesLayer
          selectedIndices={selectedIndices}
          docRoot={docRoot}
          timeline={timeline}
          blocks={blocks}
          pxPerSec={pxPerSec}
          history={editHistory}
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
  editHistory,
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
          <AnchorLinesLayer
            selectedIndices={selectedIndices}
            docRoot={docRoot}
            timeline={timeline}
            blocks={blocks}
            pxPerSec={pxPerSec}
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
  };
  attachmentStartIndex: number;
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
        cursor: "pointer",
        opacity: isAttachment ? 0.85 : 1,
      }}
    >
      <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>
        {label}
      </span>
    </div>
  );
}

// ── Anchor-line overlay ──────────────────────────────────────────────
//
// When an attachment is selected, draw a line from the anchored node to the
// attachment for each of its `start`/`end` anchors:
//
//   ── on the anchor's row, a circle at the anchorPoint location;
//   ── on the attachment's row, a circle at the resolved edge (start or end);
//   ── a straight line connecting the two.
//
// Each circle is labelled `s` (anchorPoint/offset is a number — seconds) or
// `%` (a percentage string). The labels follow the actual JSON shape, with
// timeSource-implied defaults when the field is omitted.

interface AnchorLineSpec {
  key: string;
  topX: number;
  topY: number;
  bottomX: number;
  bottomY: number;
  topLabel: "s" | "%";
  bottomLabel: "s" | "%";
  edit: AnchorEditCtx;
}

function parsePct(s: string): number {
  const m = /^(-?\d+(?:\.\d+)?)%$/.exec(s);
  return m ? parseFloat(m[1]) / 100 : 0;
}

/**
 * Resolved-output time of the anchor *point* (no offset applied). Mirrors
 * the resolver's source/output formulas so the dot lands exactly where the
 * resolver would put it; the attachment's edge is `pointTime + offsetSec`,
 * which we already have on the resolved attachment as `timelineStart` /
 * `timelineEnd`.
 */
function computePointTime(
  spec: TimeAnchor,
  anchorDoc: Child,
  anchorResolved: ResolvedChild
): number | null {
  const start = anchorResolved.timelineStart;
  const end = anchorResolved.timelineEnd;

  let baseSourceTime = 0;
  let speed = 1;
  if (anchorResolved.type === "clip" || anchorResolved.type === "audio") {
    baseSourceTime = anchorResolved.sourceIn;
    speed = anchorResolved.speed;
  } else if (anchorResolved.type === "composition") {
    baseSourceTime =
      anchorDoc.type === "composition" ? (anchorDoc.in ?? 0) : 0;
    speed = anchorResolved.speed;
  }

  const timeSource = spec.timeSource ?? "output";
  if (timeSource === "source") {
    const sourceTime =
      typeof spec.anchorPoint === "number" ? spec.anchorPoint : 0;
    return start + (sourceTime - baseSourceTime) / speed;
  }
  const pct =
    typeof spec.anchorPoint === "string" ? parsePct(spec.anchorPoint) : 0;
  return start + (end - start) * pct;
}

function findAnchorById(
  id: string,
  docRoot: { children: Child[]; attachments?: Child[] },
  timeline: ResolvedTimeline
): { doc: Child; resolved: ResolvedChild; blockIndex: number } | null {
  const childCount = docRoot.children.length;
  for (let i = 0; i < docRoot.children.length; i++) {
    if ((docRoot.children[i] as { id?: string }).id === id) {
      return {
        doc: docRoot.children[i],
        resolved: timeline.children[i],
        blockIndex: i,
      };
    }
  }
  const atts = docRoot.attachments ?? [];
  for (let j = 0; j < atts.length; j++) {
    if ((atts[j] as { id?: string }).id === id) {
      return {
        doc: atts[j],
        resolved: timeline.children[childCount + j],
        blockIndex: childCount + j,
      };
    }
  }
  return null;
}

function anchorPointKind(spec: TimeAnchor): "s" | "%" {
  if (typeof spec.anchorPoint === "string") return "%";
  if (typeof spec.anchorPoint === "number") return "s";
  // Omitted: follow the timeSource-implied default (source → 0sec, output → "0%")
  return spec.timeSource === "source" ? "s" : "%";
}

function offsetKind(spec: TimeAnchor): "s" | "%" {
  return typeof spec.offset === "string" ? "%" : "s";
}

function rowYTop(row: number): number {
  return RULER_HEIGHT + ROW_GAP + row * (ROW_HEIGHT + ROW_GAP);
}

// ── Anchor edit math ─────────────────────────────────────────────────
//
// Per-line context the handlers need to translate horizontal pixel motion
// into anchorPoint / offset value changes (and to convert units on toggle
// without moving the resolved point).

interface AnchorEditCtx {
  attIdx: number;
  side: "start" | "end";
  pointTime: number;
  anchorStart: number;
  anchorEnd: number;
  anchorBase: number;
  anchorSpeed: number;
  attNatDur: number;
}

const SEC_DECIMALS = 1000;
const PCT_DECIMALS = 10000;
const fmtSec = (s: number) => Math.round(s * SEC_DECIMALS) / SEC_DECIMALS;
const fmtPct = (frac: number) =>
  `${Math.round(frac * 100 * PCT_DECIMALS) / PCT_DECIMALS}%`;

function naturalDurOf(node: Child): number {
  if (node.type === "clip" || node.type === "audio") {
    if (node.duration != null) return node.duration;
    const speed = node.speed ?? 1;
    return (node.out - node.in) / speed;
  }
  if (node.type === "empty") return node.duration;
  if (node.type === "data") return node.duration ?? 0;
  if (node.type === "composition") {
    if (node.in != null && node.out != null) return node.out - node.in;
    try {
      return resolveComposition(node).duration;
    } catch {
      return 0;
    }
  }
  return 0;
}

/** Drag the anchorPoint to shift the resolved point time by `deltaSec`. */
function dragAnchorPoint(
  spec: TimeAnchor,
  deltaSec: number,
  ctx: AnchorEditCtx
): TimeAnchor {
  if (spec.timeSource === "source") {
    const oldVal = typeof spec.anchorPoint === "number" ? spec.anchorPoint : 0;
    return {
      ...spec,
      anchorPoint: fmtSec(oldVal + deltaSec * ctx.anchorSpeed),
      timeSource: "source",
    };
  }
  // output / undefined → output mode (percentage of anchor's output range)
  const range = ctx.anchorEnd - ctx.anchorStart;
  const oldPct =
    typeof spec.anchorPoint === "string" ? parsePct(spec.anchorPoint) : 0;
  const newPct = oldPct + (range > 0 ? deltaSec / range : 0);
  return {
    ...spec,
    anchorPoint: fmtPct(newPct),
    timeSource: "output",
  };
}

/** Drag offset by `deltaSec` (output seconds). */
function dragOffset(
  spec: TimeAnchor,
  deltaSec: number,
  ctx: AnchorEditCtx
): TimeAnchor {
  if (typeof spec.offset === "string") {
    const oldPct = parsePct(spec.offset);
    const newPct =
      oldPct + (ctx.attNatDur > 0 ? deltaSec / ctx.attNatDur : 0);
    return { ...spec, offset: fmtPct(newPct) };
  }
  const oldSec = typeof spec.offset === "number" ? spec.offset : 0;
  return { ...spec, offset: fmtSec(oldSec + deltaSec) };
}

/**
 * Toggle anchorPoint between source-seconds and output-percent. Recomputes
 * from `pointTime` so the dot stays put on the timeline through the toggle.
 */
function toggleAnchorPoint(spec: TimeAnchor, ctx: AnchorEditCtx): TimeAnchor {
  if (anchorPointKind(spec) === "s") {
    const range = ctx.anchorEnd - ctx.anchorStart;
    const pct = range > 0 ? (ctx.pointTime - ctx.anchorStart) / range : 0;
    return { ...spec, anchorPoint: fmtPct(pct), timeSource: "output" };
  }
  const sourceTime =
    ctx.anchorBase + (ctx.pointTime - ctx.anchorStart) * ctx.anchorSpeed;
  return { ...spec, anchorPoint: fmtSec(sourceTime), timeSource: "source" };
}

/** Toggle offset between seconds and percent of attachment natural duration. */
function toggleOffset(spec: TimeAnchor, ctx: AnchorEditCtx): TimeAnchor {
  if (offsetKind(spec) === "s") {
    const sec = typeof spec.offset === "number" ? spec.offset : 0;
    const pct = ctx.attNatDur > 0 ? sec / ctx.attNatDur : 0;
    return { ...spec, offset: fmtPct(pct) };
  }
  const pct = typeof spec.offset === "string" ? parsePct(spec.offset) : 0;
  return { ...spec, offset: fmtSec(pct * ctx.attNatDur) };
}

function setAttachmentSpec(
  doc: SeamFile,
  attIdx: number,
  side: "start" | "end",
  newSpec: TimeAnchor
): SeamFile {
  const atts = [...(doc.attachments ?? [])];
  const att = atts[attIdx];
  if (!att) return doc;
  atts[attIdx] = { ...att, [side]: newSpec } as Child;
  return { ...doc, attachments: atts };
}

function AnchorLinesLayer({
  selectedIndices,
  docRoot,
  timeline,
  blocks,
  pxPerSec,
  history,
}: {
  selectedIndices: number[];
  docRoot?: {
    children: import("@seam/core").Child[];
    attachments?: import("@seam/core").Child[];
  };
  timeline: ResolvedTimeline;
  blocks: ChildBlock[];
  pxPerSec: number;
  /** Provided only when editing is allowed (root view). */
  history?: History<SeamFile>;
}) {
  if (!docRoot) return null;
  const childCount = docRoot.children.length;

  const rowByIndex = new Map<number, number>();
  for (const b of blocks) rowByIndex.set(b.index, b.row);

  const lines: AnchorLineSpec[] = [];

  for (const sel of selectedIndices) {
    if (sel < childCount) continue; // only attachments draw lines
    const j = sel - childCount;
    const attDoc = docRoot.attachments?.[j];
    const attResolved = timeline.children[sel];
    if (!attDoc || !attResolved) continue;
    const attRow = rowByIndex.get(sel);
    if (attRow == null) continue;

    for (const side of ["start", "end"] as const) {
      const spec = (attDoc as { start?: TimeAnchor; end?: TimeAnchor })[side];
      if (!spec || spec.anchor == null) continue;

      const found = findAnchorById(spec.anchor, docRoot, timeline);
      if (!found) continue;
      const anchorRow = rowByIndex.get(found.blockIndex);
      if (anchorRow == null) continue;

      const pointTime = computePointTime(spec, found.doc, found.resolved);
      if (pointTime == null) continue;

      // The line is a plumb line dropped from the anchor point — always
      // perfectly vertical at `pointTime * pxPerSec`, regardless of where
      // the attachment's resolved edge lands. Offset shifts the clip
      // sideways relative to the line, not the line.
      const anchorY0 = rowYTop(anchorRow);
      const attY0 = rowYTop(attRow);
      const EXT = 10;
      let anchorOuterY: number;
      let attOuterY: number;
      if (anchorRow < attRow) {
        anchorOuterY = anchorY0 - EXT;
        attOuterY = attY0 + ROW_HEIGHT + EXT;
      } else if (anchorRow > attRow) {
        anchorOuterY = anchorY0 + ROW_HEIGHT + EXT;
        attOuterY = attY0 - EXT;
      } else {
        anchorOuterY = anchorY0 + ROW_HEIGHT / 2;
        attOuterY = anchorOuterY;
      }

      // Build the per-line edit context. Source-base/speed mirror what
      // `buildIdMapEntry` in the resolver tracks; clip/audio use the
      // resolved sourceIn + speed, composition uses the doc's `in` (the
      // pre-window inner-timeline base) + resolved.speed.
      let anchorBase = 0;
      let anchorSpeed = 1;
      if (
        found.resolved.type === "clip" ||
        found.resolved.type === "audio"
      ) {
        anchorBase = found.resolved.sourceIn;
        anchorSpeed = found.resolved.speed;
      } else if (found.resolved.type === "composition") {
        anchorBase = found.doc.type === "composition" ? found.doc.in ?? 0 : 0;
        anchorSpeed = found.resolved.speed;
      }

      const editCtx: AnchorEditCtx = {
        attIdx: j,
        side,
        pointTime,
        anchorStart: found.resolved.timelineStart,
        anchorEnd: found.resolved.timelineEnd,
        anchorBase,
        anchorSpeed,
        attNatDur: naturalDurOf(attDoc),
      };

      const lineX = pointTime * pxPerSec;
      lines.push({
        key: `${sel}-${side}`,
        topX: lineX,
        topY: anchorOuterY,
        bottomX: lineX,
        bottomY: attOuterY,
        topLabel: anchorPointKind(spec),
        bottomLabel: offsetKind(spec),
        edit: editCtx,
      });
    }
  }

  if (lines.length === 0) return null;

  const RADIUS = 9;
  const STROKE = "#ffcc00";
  const HIT_THICKNESS = 14;
  const CLICK_THRESHOLD_PX = 4;
  const editable = history != null;

  // Begin a drag (or click+drag from a circle). `kind` selects which field
  // moves; `clickToggle` runs on pointerup if the user never crossed the
  // movement threshold (used for circles, not for line halves).
  //
  // We use explicit pointer capture on the originating SVG element so the
  // drag survives state-driven re-renders: each `replace` causes React to
  // reconcile, and without explicit capture the implicit capture browsers
  // do for pointer events can be lost mid-drag — which strands the user
  // with no `pointerup` and the cursor "tied to the mouse".
  const startEdit = (
    e: React.PointerEvent,
    ctx: AnchorEditCtx,
    kind: "anchorPoint" | "offset",
    clickToggle: ((spec: TimeAnchor) => TimeAnchor) | null
  ) => {
    e.stopPropagation();
    if (!history) return;
    e.preventDefault();
    const target = e.currentTarget as Element;
    const pointerId = e.pointerId;
    const startX = e.clientX;
    const startY = e.clientY;
    const initialDoc = history.current;
    const initialAtt = initialDoc.attachments?.[ctx.attIdx];
    if (!initialAtt) return;
    const initialSpec = (initialAtt as {
      start?: TimeAnchor;
      end?: TimeAnchor;
    })[ctx.side];
    if (!initialSpec) return;

    try {
      target.setPointerCapture(pointerId);
    } catch {
      /* element gone — fall back to ambient pointer events */
    }

    let pastSnapshot = false;
    let dragging = !clickToggle; // line halves are pure-drag
    if (dragging) {
      history.pushPast(initialDoc);
      pastSnapshot = true;
    }

    const onMove = (ev: Event) => {
      const me = ev as PointerEvent;
      if (me.pointerId !== pointerId) return;
      const dx = me.clientX - startX;
      const dy = me.clientY - startY;
      if (!dragging && Math.hypot(dx, dy) > CLICK_THRESHOLD_PX) {
        dragging = true;
        if (!pastSnapshot) {
          history.pushPast(initialDoc);
          pastSnapshot = true;
        }
      }
      if (!dragging) return;
      const deltaSec = dx / pxPerSec;
      const newSpec =
        kind === "anchorPoint"
          ? dragAnchorPoint(initialSpec, deltaSec, ctx)
          : dragOffset(initialSpec, deltaSec, ctx);
      history.replace(
        setAttachmentSpec(initialDoc, ctx.attIdx, ctx.side, newSpec)
      );
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
      if (!dragging && clickToggle) {
        const newSpec = clickToggle(initialSpec);
        history.push(
          setAttachmentSpec(initialDoc, ctx.attIdx, ctx.side, newSpec)
        );
      }
    };
    target.addEventListener("pointermove", onMove);
    target.addEventListener("pointerup", onUp);
    target.addEventListener("pointercancel", onUp);
  };

  return (
    <svg
      style={{
        position: "absolute",
        left: 0,
        top: 0,
        width: "100%",
        height: "100%",
        overflow: "visible",
        pointerEvents: "none",
        zIndex: 4,
      }}
    >
      {lines.map((l) => {
        const midX = (l.topX + l.bottomX) / 2;
        const midY = (l.topY + l.bottomY) / 2;
        return (
          <g key={l.key}>
            {/* Top-half hit area — drag anchorPoint. */}
            <line
              x1={l.topX}
              y1={l.topY}
              x2={midX}
              y2={midY}
              stroke="transparent"
              strokeWidth={HIT_THICKNESS}
              style={{
                pointerEvents: editable ? "stroke" : "none",
                cursor: editable ? "grab" : "default",
              }}
              onPointerDown={(e) => startEdit(e, l.edit, "anchorPoint", null)}
            />
            {/* Bottom-half hit area — drag offset. */}
            <line
              x1={midX}
              y1={midY}
              x2={l.bottomX}
              y2={l.bottomY}
              stroke="transparent"
              strokeWidth={HIT_THICKNESS}
              style={{
                pointerEvents: editable ? "stroke" : "none",
                cursor: editable ? "grab" : "default",
              }}
              onPointerDown={(e) => startEdit(e, l.edit, "offset", null)}
            />
            {/* Visible cosmetic line. */}
            <line
              x1={l.topX}
              y1={l.topY}
              x2={l.bottomX}
              y2={l.bottomY}
              stroke={STROKE}
              strokeWidth={2}
              style={{ pointerEvents: "none" }}
            />
            {/* Top circle — click to toggle anchorPoint units, drag to move. */}
            <circle
              cx={l.topX}
              cy={l.topY}
              r={RADIUS}
              fill={STROKE}
              stroke="#1e1e1e"
              strokeWidth={1}
              style={{
                pointerEvents: editable ? "visiblePainted" : "none",
                cursor: editable ? "pointer" : "default",
              }}
              onPointerDown={(e) =>
                startEdit(e, l.edit, "anchorPoint", (spec) =>
                  toggleAnchorPoint(spec, l.edit)
                )
              }
            />
            <text
              x={l.topX}
              y={l.topY}
              textAnchor="middle"
              dominantBaseline="central"
              fill="#1e1e1e"
              fontSize={10}
              fontWeight={700}
              style={{ userSelect: "none", pointerEvents: "none" }}
            >
              {l.topLabel}
            </text>
            {/* Bottom circle — click to toggle offset units, drag to move. */}
            <circle
              cx={l.bottomX}
              cy={l.bottomY}
              r={RADIUS}
              fill={STROKE}
              stroke="#1e1e1e"
              strokeWidth={1}
              style={{
                pointerEvents: editable ? "visiblePainted" : "none",
                cursor: editable ? "pointer" : "default",
              }}
              onPointerDown={(e) =>
                startEdit(e, l.edit, "offset", (spec) =>
                  toggleOffset(spec, l.edit)
                )
              }
            />
            <text
              x={l.bottomX}
              y={l.bottomY}
              textAnchor="middle"
              dominantBaseline="central"
              fill="#1e1e1e"
              fontSize={10}
              fontWeight={700}
              style={{ userSelect: "none", pointerEvents: "none" }}
            >
              {l.bottomLabel}
            </text>
          </g>
        );
      })}
    </svg>
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
          />
        );
      })()}
    </div>
  );
}

import React, { useRef, useMemo, useCallback, useState, useEffect } from "react";
import { useTimeline } from "@seam/preview";
import { ChevronRight, ChevronDown, Boxes } from "lucide-react";
import type {
  BinEntry,
  Child,
  ResolvedTimeline,
  ResolvedChild,
  SeamFile,
  TimeExpr,
} from "@seam/core";
import { buildItemsFromFiles, SOURCE_DRAG_MIME } from "./useImport.js";
import { playheadAfterDelete } from "./deletePlayhead.js";
import { dirname } from "./pathUtils.js";
import type { History } from "./useHistory.js";
import type { Platform } from "./platform/index.js";
import {
  parsePath,
  pathKey,
  samePath,
  removeNodesAtPaths,
  insertNodes,
  moveNodesTracked,
  updateCompAtPath,
  editContainer,
  splitLast,
  type NodePath,
} from "./nodePath.js";
import { moveRun, shiftOffsets, type InsertOptions } from "./runEdit.js";
import {
  flattenDropRegions,
  flattenGroups,
  dropTargetAt,
  runZIndexAt,
  type DropTarget,
} from "./dropRegions.js";
import {
  ROW_HEIGHT,
  ROW_GAP,
  RULER_HEIGHT,
  DEPTH_INSET,
  rowTop,
} from "./timelineLayout.js";
import { layoutTree, type TreeGroup } from "./timelineTree.js";
import type { KeyframeLane } from "./keyframeLanes.js";
import KeyframeDiamond, { KEYFRAME_DIAMOND_SIZE } from "./KeyframeDiamond.js";
import { setKeyframeTime, timeExprForLocal } from "./keyframeEdit.js";
import AnchorLinesLayer from "./AnchorLinesLayer.js";
import { timeAfterLift } from "./dropTime.js";
import { resizeChild, resizeChildInPlace } from "./resizeTool.js";
import { useEvent } from "./useEvent.js";
import { isTypingInEditableSurface } from "./keyboardGuards.js";

export interface TimelinePanelProps {
  timeline: ResolvedTimeline;
  /**
   * The authored document whose `children` correspond to the
   * timeline. When undefined the panel is read-only (e.g. the CC-cut
   * preview) — editing, reorder, delete, and import are all
   * disabled and block labels fall back to the resolved nodes.
   */
  document?: SeamFile;
  filePath?: string | null;
  /** Canonical selection: path keys (`children.0`,
   *  `children.3.children.1`). See `nodePath.ts`. */
  selection: string[];
  onSelectionChange: (keys: string[]) => void;
  onDocumentChange?: (doc: SeamFile) => void;
  history: History<SeamFile>;
  platform: Platform;
  /** Reveal a dotted JSON path in the inspector's JSON editor — used when a
   *  keyframe diamond on a lane is clicked (`children.3.opacity.2`). */
  onJumpToJson?: (pathKey: string) => void;
}

const MIN_PX_PER_SEC = 10;
const MAX_PX_PER_SEC = 1000;
const DEFAULT_PX_PER_SEC = 100;
const HANDLE_WIDTH = 10;
/** Pixels of movement before a mouse press on a child block is treated
 *  as drag-to-reorder rather than a click. */
const REORDER_THRESHOLD_PX = 6;
/** How close (px) a Shift-snapped new-run drop must be to a node edge. */
const SNAP_THRESHOLD_PX = 10;

/** Stable empty bin so `layoutTree`'s memo doesn't bust each render when a
 *  document has no `bin`. */
const EMPTY_BIN: BinEntry[] = [];

/** How a drop target lands in the array (see `InsertOptions`). */
function insertOptionsFor(target: DropTarget): InsertOptions {
  return target.kind === "newRun" ? { start: target.time } : { before: target.before };
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
  const base = baseLabel(docChild, resolved);
  // A node that actually loops (anchored span longer than its content with
  // `underflow: "loop"`) — the block shows one span; the content repeats.
  return (resolved as { loop?: unknown }).loop ? `${base} ↻` : base;
}

function baseLabel(docChild: import("@seam/core").Child | undefined, resolved: ResolvedChild): string {
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
    if (docChild.type === "data") return "data";
    return docChild.type;
  }
  // Fallback to resolved tree (shouldn't happen given we always pass docChild)
  if (resolved.type === "clip" || resolved.type === "audio") {
    return (resolved.source ?? "").split("/").pop() || "untitled";
  }
  if (resolved.type === "text") return "text";
  if (resolved.type === "data") return "data";
  return resolved.type;
}

const BLOCK_COLORS: Record<string, { bg: string; border: string }> = {
  clip: { bg: "#3a6ea5", border: "#4a8ed0" },
  audio: { bg: "#3e7a5a", border: "#52a47a" },
  composition: { bg: "#6a5acd", border: "#8470ff" },
  data: { bg: "#7a5a3a", border: "#a47a52" },
  text: { bg: "#a04060", border: "#c45582" },
  rect: { bg: "#b03a8f", border: "#d957b8" },
  circle: { bg: "#b03a8f", border: "#d957b8" },
  map: { bg: "#2f7a5a", border: "#4bb886" },
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
   * The document subtree whose `children` correspond 1:1 to the timeline's
   * blocks. Used to recover the authored node behind each block (the real
   * type of a bin reference, run heads, labels).
   */
  docRoot?: { children?: Child[] };
  selection: string[];
  onSelectionChange: (keys: string[]) => void;
  /** Set of expanded composition addresses (see `timelineTree`). */
  expanded: Set<string>;
  /** Toggle a composition's expanded state by its address. */
  onToggleExpand: (addr: string) => void;
  /** Root document's bin entries — for pairing `binItem` expansions. */
  rootBin: BinEntry[];
  /** Provided only when the panel is editable. */
  editHistory?: History<SeamFile>;
  /** Move existing nodes (in the given order, landing contiguous) onto a
   *  drop target — same-container reorder, cross-container drag, or a new
   *  run. Undefined when editing isn't supported. */
  onMoveNodes?: (fromPaths: NodePath[], target: DropTarget) => void;
  /** Cursor-based file import onto a drop target. */
  onImportAt?: (target: DropTarget, files: FileList | File[]) => Promise<void>;
  /** Insert prebuilt nodes (dragged from the media browser) onto a drop
   *  target. Mirrors `onImportAt` but skips file import. */
  onInsertChildrenAt?: (target: DropTarget, children: Child[]) => void;
  /** Re-stack a run: move `[head, end)` of the container before `index`. */
  onMoveRun?: (containerPath: NodePath, head: number, end: number, index: number) => void;
  /** Reveal a dotted JSON path (keyframe diamond click). */
  onJumpToJson?: (pathKey: string) => void;
}

// ── Timeline surface (hook + body) ───────────────────────────────────
//
// The timeline shell boils down to: scroll container + playhead + this
// body. The hook and body are split out so a future mobile shell can
// reuse them with its own scroll/playhead layout.

interface TimelineSurfaceState {
  pxPerSec: number;
  setPxPerSec: React.Dispatch<React.SetStateAction<number>>;
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
  authored: { children?: Child[] } | undefined,
  expanded: Set<string>,
  rootBin: BinEntry[],
  scrollRef: React.RefObject<HTMLDivElement | null>,
): TimelineSurfaceState {
  const { totalDuration } = useTimeline();
  const [pxPerSec, setPxPerSec] = useState(DEFAULT_PX_PER_SEC);

  const rootGroup = useMemo(
    () => layoutTree(timeline.children, authored, expanded, rootBin),
    [timeline, authored, expanded, rootBin],
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
  docRoot?: { children?: Child[] };
  selection: string[];
  onSelectionChange: (keys: string[]) => void;
  expanded: Set<string>;
  onToggleExpand: (addr: string) => void;
  /** Root bin — injected into nested containers so `binItem`s resolve when
   *  an edit (resize/reorder) runs against a sub-composition. */
  rootBin: BinEntry[];
  editHistory?: History<SeamFile>;
  /** Path keys of the nodes currently being drag-moved (fades their
   *  blocks). `null` when no move drag is in flight. */
  reorderDragKeys: Set<string> | null;
  /** Hand-off callback when a block's mouse-press passes the drag
   *  threshold. Pass `null` to disable drag for this shell. */
  onReorderDragStart: ((path: NodePath, e: PointerEvent) => void) | null;
  /** Hand-off when a run's dotted underline is pressed (z-order drag). */
  onRunDragStart:
    | ((containerPath: NodePath, head: number, end: number, e: React.PointerEvent) => void)
    | null;
  /** Where the current drag would land. Null hides the ghost. */
  dropGhost?: DropTarget | null;
  /** Content-space bar shown while a run is dragged vertically. */
  runDragGhost?: { left: number; width: number; y: number } | null;
  /** Reveal a dotted JSON path (e.g. a keyframe `children.3.opacity.2`)
   *  when a keyframe diamond is clicked. */
  onJumpToJson: ((pathKey: string) => void) | null;
}

/** Body of the timeline: ruler + child blocks + anchor lines. Positioned
 *  absolutely within the parent's content box, so each shell wraps it in
 *  its own scroll/padding/playhead layout. */
function TimelineSurface({
  surface,
  timeline,
  scrollRef,
  docRoot,
  selection,
  onSelectionChange,
  expanded,
  onToggleExpand,
  rootBin,
  editHistory,
  reorderDragKeys,
  onReorderDragStart,
  onRunDragStart,
  dropGhost,
  runDragGhost,
  onJumpToJson,
}: TimelineSurfaceProps) {
  const { pxPerSec, rootGroup, rulerTicks } = surface;
  // Editable group placements drive the anchor-line overlay (it draws every
  // selected anchored node's line in content coords, at any nesting level).
  const groups = useMemo(
    () => flattenGroups(rootGroup, pxPerSec),
    [rootGroup, pxPerSec],
  );

  // Per-block drag-resize (Shift = in place, no ripple). Stable identity via useEvent so re-renders
  // (and rAF ticks of currentTime) don't churn the prop on every block.
  // The latest editHistory / pxPerSec / currentTime / seek are read
  // inside the closure when a handle is pressed.
  const startResize = useEvent(
    (
      path: NodePath,
      side: "left" | "right",
      scale: number,
      e: React.PointerEvent,
    ) => {
      if (!editHistory) return;
      e.stopPropagation();
      e.preventDefault();
      const target = e.currentTarget as Element;
      const pointerId = e.pointerId;
      const startX = e.clientX;
      const initialDoc = editHistory.current;
      const split = splitLast(path);
      if (!split) return;
      const { parent, last } = split;
      // Shift held at the press: resize in place — an `offset` absorbs the
      // length change so nothing downstream moves (see `resizeChildInPlace`).
      const resize = e.shiftKey ? resizeChildInPlace : resizeChild;

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
        // A nested group compresses time by `scale`, so a pixel of cursor
        // travel is `scale` seconds of source there (identity at root).
        const deltaSec = (deltaPx / pxPerSec) * scale;
        if (!pushed) {
          editHistory.pushPast(initialDoc);
          pushed = true;
        }
        editHistory.replace(
          editContainer(initialDoc, parent, rootBin, (sub) =>
            resize(sub, last.index, side, deltaSec),
          ),
        );
        // (Resizing a block does not move the playhead — follow-the-cursor was
        // meaningless. The playhead stays put on whatever frame it was on.)
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

  // Keyframe-diamond drag. Mirrors `startResize`: pointer-captures the
  // diamond, tracks a cursor delta, and live-`replace`s the doc. A press that
  // never crosses the threshold is a click → reveal the keyframe in JSON
  // (otherwise the diamond would be un-clickable once drag is wired). The
  // delta is converted px → output-seconds (window `scale`) → local-seconds
  // (the lane's `outputPerLocal`), so it works at any nesting level.
  const startKeyframeDrag = useEvent((args: KeyframeDragArgs) => {
    const {
      path,
      prop,
      kfIndex,
      timeExpr,
      domain,
      startLocalSec,
      scale,
      jumpKey,
      e,
    } = args;
    e.stopPropagation();
    e.preventDefault();
    const target = e.currentTarget as Element;
    const pointerId = e.pointerId;
    const startX = e.clientX;
    const initialDoc = editHistory?.current;
    try {
      target.setPointerCapture(pointerId);
    } catch {
      /* element gone — fall back to ambient pointer events */
    }
    let pushed = false;
    let dragged = false;

    const onMove = (ev: Event) => {
      const me = ev as PointerEvent;
      if (me.pointerId !== pointerId) return;
      const deltaPx = me.clientX - startX;
      if (!dragged && Math.abs(deltaPx) < KEYFRAME_DRAG_THRESHOLD_PX) return;
      dragged = true;
      if (!editHistory || initialDoc == null) return;
      // px → output-seconds: a nested group compresses time by `scale`
      // (identity at root). Output-seconds === local-seconds (uniform domain).
      const deltaLocal = (deltaPx / pxPerSec) * scale;
      const newLocal = Math.max(0, Math.min(domain, startLocalSec + deltaLocal));
      const newTime = timeExprForLocal(timeExpr, newLocal, domain);
      if (!pushed) {
        editHistory.pushPast(initialDoc);
        pushed = true;
      }
      editHistory.replace(
        setKeyframeTime(initialDoc, path, prop, kfIndex, newTime),
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
      if (!dragged) onJumpToJson?.(jumpKey);
    };
    target.addEventListener("pointermove", onMove);
    target.addEventListener("pointerup", onUp);
    target.addEventListener("pointercancel", onUp);
  });

  const onKeyframeDragStart = editHistory ? startKeyframeDrag : null;

  return (
    <>
      <RulerLayer pxPerSec={pxPerSec} ticks={rulerTicks} />
      <TimelineGroup
        group={rootGroup}
        yBase={RULER_HEIGHT + ROW_GAP}
        depth={0}
        pxPerSec={pxPerSec}
        selection={selection}
        onSelectionChange={onSelectionChange}
        expanded={expanded}
        onToggleExpand={onToggleExpand}
        reorderDragKeys={reorderDragKeys}
        onReorderDragStart={onReorderDragStart}
        onRunDragStart={onRunDragStart}
        onResizeDragStart={onResizeDragStart}
        onJumpToJson={onJumpToJson ?? null}
        onKeyframeDragStart={onKeyframeDragStart}
      />
      <AnchorLinesLayer
        selection={selection}
        docRoot={docRoot as SeamFile | undefined}
        rootBin={rootBin}
        groups={groups}
        pxPerSec={pxPerSec}
        history={editHistory}
      />
      {dropGhost != null && <DropGhost target={dropGhost} />}
      {runDragGhost != null && (
        <div
          style={{
            position: "absolute",
            left: runDragGhost.left,
            top: runDragGhost.y - 1,
            width: runDragGhost.width,
            height: 2,
            background: GHOST_COLOR,
            boxShadow: GHOST_GLOW,
            zIndex: 8,
            pointerEvents: "none",
          }}
        />
      )}
    </>
  );
}

const GHOST_COLOR = "#4a9eff";
const GHOST_GLOW = "0 0 6px rgba(74, 158, 255, 0.8)";
/** The new-run tick while it sits on a snapped node edge. */
const SNAP_COLOR = "#ffcc00";

/** Where a drag would land: a vertical line on one row (extend that run), or
 *  a highlighted strip / ruler band with a tick at the cursor (new run). */
function DropGhost({ target }: { target: DropTarget }) {
  if (target.kind === "insert") {
    return (
      <div
        style={{
          position: "absolute",
          left: target.x - 1,
          top: target.top,
          width: 2,
          height: target.height,
          background: GHOST_COLOR,
          boxShadow: GHOST_GLOW,
          zIndex: 8,
          pointerEvents: "none",
        }}
      />
    );
  }
  return (
    <>
      <div
        style={{
          position: "absolute",
          left: target.region.left,
          top: target.top,
          width: target.region.width,
          height: target.height,
          background: "rgba(74, 158, 255, 0.28)",
          zIndex: 8,
          pointerEvents: "none",
        }}
      />
      <div
        style={{
          position: "absolute",
          left: target.x - 1,
          top: target.top - 3,
          width: 2,
          height: target.height + 6,
          background: target.snapped ? SNAP_COLOR : GHOST_COLOR,
          boxShadow: GHOST_GLOW,
          zIndex: 8,
          pointerEvents: "none",
        }}
      />
    </>
  );
}

function DesktopTimeline({
  timeline,
  docRoot,
  selection,
  onSelectionChange,
  expanded,
  onToggleExpand,
  rootBin,
  editHistory,
  onMoveNodes,
  onImportAt,
  onInsertChildrenAt,
  onMoveRun,
  onJumpToJson,
}: InnerProps) {
  const { currentTime, totalDuration, isPlaying, seek } = useTimeline();
  const scrollRef = useRef<HTMLDivElement>(null);
  const surface = useTimelineSurfaceState(
    timeline,
    docRoot,
    expanded,
    rootBin,
    scrollRef,
  );
  const { pxPerSec, rootGroup, contentHeight } = surface;
  const contentWidth = Math.max(totalDuration * pxPerSec + 200, 200);

  // Item-drag state: the grabbed nodes (the whole selection when the grabbed
  // block is part of it, in selection order) tracked in content
  // (scroll-relative) px. `offset` mode (Shift held at grab) nudges the
  // nodes' `offset`s live instead of moving them in the array.
  const [itemDrag, setItemDrag] = useState<{
    paths: NodePath[];
    mode: "move" | "offset";
    startX: number;
    cursorX: number;
    cursorY: number;
    /** Shift held mid-move: a new-run drop snaps to node edges. */
    snap: boolean;
  } | null>(null);

  // Offset-drag session, fixed at the grab: the document as it was, each
  // dragged node's container (with its window scale), and whether the undo
  // snapshot has been pushed. Lives in a ref because every tick rewrites the
  // document, which re-renders (and re-subscribes) everything around it —
  // the session must not be re-captured from the already-shifted doc.
  const offsetDragRef = useRef<{
    initialDoc: SeamFile;
    groups: {
      path: NodePath;
      indices: Set<number>;
      scale: number;
      /** Each node's output length at the grab (for the end clamp). */
      durations: Map<number, number>;
    }[];
    pushed: boolean;
    /** The drag's first direction — the only way a zero offset may move. */
    direction: 1 | -1 | null;
  } | null>(null);

  // Run z-drag state: a run's dotted underline dragged vertically.
  const [runDrag, setRunDrag] = useState<{
    containerPath: NodePath;
    head: number;
    end: number;
    cursorY: number;
  } | null>(null);

  // File-drag state. The cursor position drives the drop ghost.
  const [fileDrag, setFileDrag] = useState<{
    cursorContentX: number;
    cursorContentY: number;
    snap: boolean;
  } | null>(null);

  // Every editable container, flattened to a content-space drop target.
  // A drag hit-tests these to find which composition (root or nested) the
  // cursor is over and where in it the drop lands.
  const regions = useMemo(
    () =>
      flattenDropRegions(rootGroup, pxPerSec, {
        width: contentWidth,
        height: contentHeight,
      }),
    [rootGroup, pxPerSec, contentWidth, contentHeight],
  );

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

  // ── Drag-to-move (reorder + in/out of compositions + new runs) ──
  // A block press that crosses the threshold hands off here. The cursor
  // is then tracked on window events (independent of the source block's
  // capture) and the drop hit-tests the drop regions for its target — so
  // nodes can move within their container, across composition boundaries,
  // or head a new run. With Shift held at the grab, the drag instead nudges
  // the grabbed nodes' `offset`s (live, like a resize).
  const startReorderDrag = useCallback(
    (path: NodePath, e: PointerEvent) => {
      if (!onMoveNodes) return;
      const container = scrollRef.current;
      if (!container) return;
      const rect = container.getBoundingClientRect();
      const cursorX = e.clientX - rect.left + container.scrollLeft;
      const cursorY = e.clientY - rect.top + container.scrollTop;
      const key = pathKey(path);
      const paths = selection.includes(key) ? selection.map(parsePath) : [path];
      const mode = e.shiftKey && editHistory ? "offset" : "move";
      offsetDragRef.current = null;
      if (mode === "offset" && editHistory) {
        const groups = new Map<
          string,
          { path: NodePath; indices: Set<number>; scale: number; durations: Map<number, number> }
        >();
        for (const p of paths) {
          const sp = splitLast(p);
          if (!sp || sp.last.field === "bin") continue;
          const k = pathKey(sp.parent);
          if (!groups.has(k)) {
            const region = regions.find((r) => samePath(r.path, sp.parent));
            // A nested group compresses time by its window scale.
            const scale = region?.scale ?? 1;
            const durations = new Map<number, number>();
            for (const run of region?.runs ?? []) {
              for (const m of run.members) {
                durations.set(m.index, ((m.endX - m.startX) / pxPerSec) * scale);
              }
            }
            groups.set(k, { path: sp.parent, indices: new Set(), scale, durations });
          }
          groups.get(k)!.indices.add(sp.last.index);
        }
        offsetDragRef.current = {
          initialDoc: editHistory.current,
          groups: [...groups.values()],
          pushed: false,
          direction: null,
        };
      }
      setItemDrag({
        paths,
        mode,
        startX: cursorX,
        cursorX,
        cursorY,
        snap: false,
      });
    },
    [onMoveNodes, selection, editHistory, regions, pxPerSec],
  );

  /** Edge snapping for a new-run drop: Shift pressed AFTER the grab (Shift at
   *  the grab is the offset drag). The dragged nodes' own edges don't count. */
  const snapFor = (paths: NodePath[]) => ({
    thresholdPx: SNAP_THRESHOLD_PX,
    exclude: new Set(paths.map(pathKey)),
    playheadX: currentTime * pxPerSec,
  });

  /** True when dropping `paths` on `target` would put them back where they
   *  are: one contiguous slice of the target container, dropped on itself. */
  const isSelfDrop = (paths: NodePath[], target: DropTarget): boolean => {
    if (target.kind !== "insert") return false;
    const idx: number[] = [];
    for (const p of paths) {
      if (!samePath(p.slice(0, -1), target.region.path)) return false;
      idx.push(p[p.length - 1].index);
    }
    const lo = Math.min(...idx);
    const hi = Math.max(...idx);
    if (hi - lo + 1 !== idx.length) return false;
    if (idx.some((v, k) => k > 0 && v < idx[k - 1])) return false;
    return target.index >= lo && target.index <= hi + 1;
  };

  useEffect(() => {
    if (!itemDrag || !onMoveNodes) return;
    const container = scrollRef.current;
    if (!container) return;
    const dragRef = itemDrag;

    const cursorFromEvent = (e: PointerEvent): { x: number; y: number } => {
      const rect = container.getBoundingClientRect();
      return {
        x: e.clientX - rect.left + container.scrollLeft,
        y: e.clientY - rect.top + container.scrollTop,
      };
    };

    // Offset mode: each tick is `grab-time offset + (cursor − grab x)`,
    // rewritten from the grab-time document; one undo step for the drag.
    // Neither edge of a node crosses its reference point within the drag
    // (see `shiftOffsets`).
    const applyOffsets = (x: number) => {
      const session = offsetDragRef.current;
      if (!editHistory || !session) return;
      if (session.direction == null) {
        if (x === dragRef.startX) return;
        session.direction = x > dragRef.startX ? 1 : -1;
      }
      const direction = session.direction;
      let next = session.initialDoc;
      for (const g of session.groups) {
        const delta = Math.round(((x - dragRef.startX) / pxPerSec) * g.scale * 1000) / 1000;
        next = updateCompAtPath(next, g.path, (comp) => ({
          ...comp,
          children: shiftOffsets(comp.children ?? [], g.indices, delta, {
            direction,
            durations: g.durations,
          }),
        }));
      }
      if (!session.pushed) {
        if (next === session.initialDoc) return;
        editHistory.pushPast(session.initialDoc);
        session.pushed = true;
      }
      editHistory.replace(next);
    };

    const onMove = (e: PointerEvent) => {
      const { x, y } = cursorFromEvent(e);
      if (dragRef.mode === "offset") applyOffsets(x);
      setItemDrag((prev) =>
        prev ? { ...prev, cursorX: x, cursorY: y, snap: e.shiftKey } : null,
      );
    };
    // Shift can be pressed / released without moving the mouse.
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Shift") return;
      setItemDrag((prev) => (prev ? { ...prev, snap: e.type === "keydown" } : null));
    };

    const onUp = (e: PointerEvent) => {
      const { x, y } = cursorFromEvent(e);
      if (dragRef.mode === "offset") {
        applyOffsets(x);
      } else {
        const target = dropTargetAt(
          regions,
          x,
          y,
          pxPerSec,
          e.shiftKey ? snapFor(dragRef.paths) : undefined,
        );
        if (!isSelfDrop(dragRef.paths, target)) onMoveNodes(dragRef.paths, target);
      }
      setItemDrag(null);
    };

    const onCancel = () => setItemDrag(null);

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onCancel);
    window.addEventListener("keydown", onKey);
    window.addEventListener("keyup", onKey);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onCancel);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("keyup", onKey);
    };
    // Only the drag's *existence* drives subscribe/unsubscribe; cursor
    // updates come through setState. Re-subscribing mid-drag (callbacks
    // change identity as the doc changes) is harmless: the offset session
    // lives in `offsetDragRef`, and a move reads `regions` fresh at drop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [itemDrag !== null, onMoveNodes, regions, pxPerSec, currentTime]);

  // ── Run z-drag (dotted underline, vertical) ────────────────────
  const startRunDrag = useCallback(
    (containerPath: NodePath, head: number, end: number, e: React.PointerEvent) => {
      if (!onMoveRun) return;
      const container = scrollRef.current;
      if (!container) return;
      e.stopPropagation();
      e.preventDefault();
      const rect = container.getBoundingClientRect();
      setRunDrag({
        containerPath,
        head,
        end,
        cursorY: e.clientY - rect.top + container.scrollTop,
      });
    },
    [onMoveRun],
  );

  useEffect(() => {
    if (!runDrag || !onMoveRun) return;
    const container = scrollRef.current;
    if (!container) return;
    const dragRef = runDrag;
    const yOf = (e: PointerEvent) =>
      e.clientY - container.getBoundingClientRect().top + container.scrollTop;
    const onMove = (e: PointerEvent) => {
      const y = yOf(e);
      setRunDrag((prev) => (prev ? { ...prev, cursorY: y } : null));
    };
    const onUp = (e: PointerEvent) => {
      const region = regions.find((r) => samePath(r.path, dragRef.containerPath));
      if (region) {
        onMoveRun(
          dragRef.containerPath,
          dragRef.head,
          dragRef.end,
          runZIndexAt(region, dragRef.head, yOf(e)),
        );
      }
      setRunDrag(null);
    };
    const onCancel = () => setRunDrag(null);
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onCancel);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onCancel);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runDrag !== null, onMoveRun, regions]);

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

  // Both OS files and media-browser source drags drive the same ghost; the
  // payload only differs at drop time.
  const isDraggablePayload = (e: React.DragEvent) =>
    e.dataTransfer.types.includes("Files") ||
    e.dataTransfer.types.includes(SOURCE_DRAG_MIME);

  const handleFileDragOver = (e: React.DragEvent) => {
    if (!isDraggablePayload(e)) return;
    e.preventDefault();
    const pos = cursorToContent(e);
    if (pos) setFileDrag({ cursorContentX: pos.x, cursorContentY: pos.y, snap: e.shiftKey });
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
    if (!isDraggablePayload(e)) return;
    e.preventDefault();
    const pos = cursorToContent(e);
    setFileDrag(null);
    if (!pos) return;

    // Media-browser source drag carries prebuilt nodes; an OS drop carries
    // files. Parse the source payload (if any) so both land on the same
    // drop target below.
    const raw = e.dataTransfer.getData(SOURCE_DRAG_MIME);
    let sourceChildren: Child[] | null = null;
    if (raw) {
      try {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed) && parsed.length > 0) sourceChildren = parsed;
      } catch {
        /* malformed payload — fall through to the file path */
      }
    }
    if (!sourceChildren && e.dataTransfer.files.length === 0) return;

    const target = dropTargetAt(
      regions,
      pos.x,
      pos.y,
      pxPerSec,
      e.shiftKey ? snapFor([]) : undefined,
    );
    if (sourceChildren) {
      onInsertChildrenAt?.(target, sourceChildren);
    } else if (onImportAt) {
      void onImportAt(target, e.dataTransfer.files);
    }
  };

  const playheadX = currentTime * pxPerSec;
  // A grabbed node and a dragged-in file share the same drag position →
  // the same drop ghost. (An offset drag has no target: the blocks move.)
  const dragPos: { x: number; y: number } | null =
    fileDrag != null
      ? { x: fileDrag.cursorContentX, y: fileDrag.cursorContentY }
      : itemDrag != null && itemDrag.mode === "move"
        ? { x: itemDrag.cursorX, y: itemDrag.cursorY }
        : null;
  const dragSnap =
    fileDrag != null
      ? fileDrag.snap
        ? snapFor([])
        : undefined
      : itemDrag?.snap
        ? snapFor(itemDrag.paths)
        : undefined;
  const dropGhost =
    dragPos != null ? dropTargetAt(regions, dragPos.x, dragPos.y, pxPerSec, dragSnap) : null;
  const runDragRegion =
    runDrag != null ? regions.find((r) => samePath(r.path, runDrag.containerPath)) : undefined;
  const runDragGhost =
    runDrag != null && runDragRegion
      ? { left: runDragRegion.left, width: runDragRegion.width, y: runDrag.cursorY }
      : null;
  const reorderDragKeys = useMemo(
    () =>
      itemDrag && itemDrag.mode === "move" ? new Set(itemDrag.paths.map(pathKey)) : null,
    [itemDrag?.paths, itemDrag?.mode],
  );

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
        cursor: runDrag ? "ns-resize" : itemDrag ? "grabbing" : "crosshair",
      }}
    >
      <div style={{ width: contentWidth, height: contentHeight, position: "relative" }}>
        <TimelineSurface
          surface={surface}
          timeline={timeline}
          scrollRef={scrollRef}
          docRoot={docRoot}
          selection={selection}
          onSelectionChange={onSelectionChange}
          expanded={expanded}
          onToggleExpand={onToggleExpand}
          rootBin={rootBin}
          editHistory={editHistory}
          reorderDragKeys={reorderDragKeys}
          onReorderDragStart={onMoveNodes ? startReorderDrag : null}
          onRunDragStart={onMoveRun ? startRunDrag : null}
          dropGhost={dropGhost}
          runDragGhost={runDragGhost}
          onJumpToJson={onJumpToJson ?? null}
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

// Vertical offset (px) of a lane's track line within its ROW_HEIGHT row.
// The small property label sits above it.
const LANE_TRACK_Y = 21;

/** Args for a diamond's pointer press. The handler distinguishes a click
 *  (→ jump to JSON) from a drag (→ retime) via a small threshold. */
export interface KeyframeDragArgs {
  path: NodePath;
  prop: string;
  kfIndex: number;
  timeExpr: TimeExpr;
  /** Duration (s) the time expression resolves against (the block's output
   *  span); also the clamp range for the dragged time. */
  domain: number;
  /** The keyframe's current resolved local time (s) — the drag baseline. */
  startLocalSec: number;
  /** The enclosing group's window scale (px↔sec). */
  scale: number;
  /** Dotted keyframe path, revealed on a click (no drag). */
  jumpKey: string;
  e: React.PointerEvent;
}
export type KeyframeDragStart = (args: KeyframeDragArgs) => void;

/** Pixels of cursor travel before a diamond press becomes a retime drag
 *  rather than a click-to-reveal. */
const KEYFRAME_DRAG_THRESHOLD_PX = 3;

/**
 * One keyframe lane: a small property label, a horizontal track spanning the
 * block's width, and a diamond at each keyframe. Positioned in the enclosing
 * group's coordinate space (same `toX` as the block), so the lane lines up
 * under its block. A diamond drags to retime (editable) and clicks to reveal
 * its JSON; in a read-only preview it only clicks-to-jump.
 */
function KeyframeLaneRow({
  lane,
  nodePath,
  nodeKey,
  scale,
  top,
  toX,
  onJump,
  onKeyframeDragStart,
}: {
  lane: KeyframeLane;
  /** The lane's node path (for write-back). */
  nodePath: NodePath;
  /** The lane's node path key (`children.3`) — keyframe jump paths are
   *  `${nodeKey}.${lane.prop}.${index}`. */
  nodeKey: string;
  /** The enclosing group's window scale (px↔sec for drag deltas). */
  scale: number;
  /** Top of this lane's row in the group container (px). */
  top: number;
  toX: (sec: number) => number;
  /** Jump the JSON editor to a dotted keyframe path. */
  onJump?: (pathKey: string) => void;
  /** Begin a diamond drag (editable timelines only). */
  onKeyframeDragStart?: KeyframeDragStart | null;
}) {
  const left = toX(lane.outputStart);
  const right = toX(lane.outputStart + lane.outputSpan);
  const width = Math.max(right - left, 2);
  const r = KEYFRAME_DIAMOND_SIZE / 2;
  return (
    <>
      <div
        style={{
          position: "absolute",
          left,
          top: top + 2,
          width,
          height: 11,
          fontSize: 9,
          lineHeight: "11px",
          color: "#9a8fb5",
          whiteSpace: "nowrap",
          overflow: "hidden",
          textOverflow: "ellipsis",
          pointerEvents: "none",
        }}
      >
        {lane.label}
      </div>
      <div
        style={{
          position: "absolute",
          left,
          top: top + LANE_TRACK_Y,
          width,
          height: 2,
          background: "rgba(212, 196, 110, 0.35)",
          borderRadius: 1,
          pointerEvents: "none",
        }}
      />
      {lane.diamonds.map((d, pos) => {
        const jumpKey = `${nodeKey}.${lane.prop}.${d.index}`;
        return (
          <div
            key={d.index}
            onPointerDown={(e) => e.stopPropagation()}
            style={{
              position: "absolute",
              left: toX(d.outputSec) - r,
              top: top + LANE_TRACK_Y + 1 - r,
            }}
          >
            <KeyframeDiamond
              incomingEasing={d.easing}
              outgoingEasing={lane.diamonds[pos + 1]?.easing}
              onPointerDown={
                onKeyframeDragStart
                  ? (e) =>
                      onKeyframeDragStart({
                        path: nodePath,
                        prop: lane.prop,
                        kfIndex: d.index,
                        timeExpr: d.timeExpr,
                        domain: lane.outputSpan,
                        startLocalSec: d.localSec,
                        scale,
                        jumpKey,
                        e,
                      })
                  : undefined
              }
              onClick={
                !onKeyframeDragStart && onJump
                  ? (e) => {
                      e.stopPropagation();
                      onJump(jumpKey);
                    }
                  : undefined
              }
            />
          </div>
        );
      })}
    </>
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
  selection,
  onSelectionChange,
  expanded,
  onToggleExpand,
  reorderDragKeys,
  onReorderDragStart,
  onRunDragStart,
  onResizeDragStart,
  onJumpToJson,
  onKeyframeDragStart,
}: {
  group: TreeGroup;
  /** Y offset (px) for row 0 within this group's container. */
  yBase: number;
  depth: number;
  pxPerSec: number;
  selection: string[];
  onSelectionChange: (keys: string[]) => void;
  expanded: Set<string>;
  onToggleExpand: (addr: string) => void;
  reorderDragKeys: Set<string> | null;
  onReorderDragStart: ((path: NodePath, e: PointerEvent) => void) | null;
  onRunDragStart:
    | ((containerPath: NodePath, head: number, end: number, e: React.PointerEvent) => void)
    | null;
  onResizeDragStart:
    | ((
        path: NodePath,
        side: "left" | "right",
        scale: number,
        e: React.PointerEvent,
      ) => void)
    | null;
  /** Reveal a dotted JSON path (e.g. a keyframe `children.3.opacity.2`). */
  onJumpToJson: ((pathKey: string) => void) | null;
  /** Begin a keyframe-diamond drag (editable timelines only). */
  onKeyframeDragStart: KeyframeDragStart | null;
}) {
  const isRoot = depth === 0;
  // Window transform: inner time → this group's container px. A child of a
  // windowed composition is shifted by the window `in` and compressed by
  // the window speed; the container clips what lands outside.
  const toX = (sec: number) => ((sec - group.originSec) / group.scale) * pxPerSec;
  return (
    <>
      {group.runs.map((run) => {
        // The run's dotted underline, in the strip below its row. Dragged
        // vertically it re-stacks the run (z-order).
        const left = toX(run.startSec);
        const width = Math.max(toX(run.endSec) - left, 2);
        const draggable = group.editable && onRunDragStart != null;
        return (
          <div
            key={`run-${run.head}`}
            onPointerDown={
              draggable
                ? (e) => onRunDragStart!(group.path, run.head, run.end, e)
                : undefined
            }
            title={draggable ? "Drag up/down to change stacking order" : undefined}
            style={{
              position: "absolute",
              left,
              top: yBase + rowTop(run.row) + ROW_HEIGHT,
              width,
              height: ROW_GAP,
              cursor: draggable ? "ns-resize" : "default",
              display: "flex",
              alignItems: "center",
            }}
          >
            <div style={{ width: "100%", borderTop: "2px dotted #777" }} />
          </div>
        );
      })}
      {group.blocks.map((block) => {
        const { child, index, row, docChild, addr } = block;
        const isSelected = selection.includes(addr);
        // The first selected item (the attach primary) is always the
        // primary, regardless of type; the rest are secondaries.
        const isPrimary = isSelected && selection[0] === addr;
        // Drag-to-move works for any block at any editable level; the drop
        // pass routes it within or across containers. Resize too — nested
        // deltas scale by the window.
        const blockReorderStart =
          group.editable && onReorderDragStart
            ? onReorderDragStart
            : null;
        const blockResizeStart =
          group.editable && onResizeDragStart ? onResizeDragStart : null;
        const left = toX(child.timelineStart);
        const width = Math.max(toX(child.timelineEnd) - left, 2);
        return (
          <ChildBlockView
            key={addr}
            child={child}
            displayChild={docChild}
            index={index}
            addr={addr}
            path={block.path}
            left={left}
            top={yBase + rowTop(row)}
            width={width}
            depth={depth}
            scale={group.scale}
            editable={group.editable}
            isSelected={isSelected}
            isPrimary={isPrimary}
            isRoot={isRoot}
            isComposition={block.isComposition}
            isExpandable={block.isComposition || block.hasLanes}
            isBinItem={block.isBinItem}
            isExpanded={block.isExpanded}
            onToggleExpand={() => onToggleExpand(addr)}
            selection={selection}
            onSelectionChange={onSelectionChange}
            isDraggingOut={reorderDragKeys?.has(addr) ?? false}
            reorderDragActive={reorderDragKeys != null}
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
              selection={selection}
              onSelectionChange={onSelectionChange}
              expanded={expanded}
              onToggleExpand={onToggleExpand}
              reorderDragKeys={reorderDragKeys}
              onReorderDragStart={onReorderDragStart}
              onRunDragStart={onRunDragStart}
              onResizeDragStart={onResizeDragStart}
              onJumpToJson={onJumpToJson}
              onKeyframeDragStart={onKeyframeDragStart}
            />
            {/* Window boundary lines (left = in, right = out), drawn over
                the clipped content so the composition's extent is clear. */}
            <div style={EXP_BOUNDARY_LEFT} />
            <div style={EXP_BOUNDARY_RIGHT} />
          </div>
        );
      })}
      {group.blocks.map((block) => {
        if (!block.lanes || block.laneTopRow == null) return null;
        const laneTopRow = block.laneTopRow;
        return block.lanes.map((lane, i) => (
          <KeyframeLaneRow
            key={`${block.addr}-lane-${lane.prop}`}
            lane={lane}
            nodePath={block.path}
            nodeKey={block.addr}
            scale={group.scale}
            top={yBase + rowTop(laneTopRow + i)}
            toX={toX}
            onJump={onJumpToJson ?? undefined}
            onKeyframeDragStart={group.editable ? onKeyframeDragStart : null}
          />
        ));
      })}
    </>
  );
}

function ChildBlockView({
  child,
  displayChild,
  index,
  addr,
  path,
  left,
  top,
  width,
  depth,
  scale,
  editable,
  isSelected,
  isPrimary,
  isRoot,
  isComposition,
  isExpandable,
  isBinItem,
  isExpanded,
  onToggleExpand,
  selection,
  onSelectionChange,
  isDraggingOut,
  reorderDragActive,
  onReorderDragStart,
  onResizeDragStart,
}: {
  child: ResolvedChild;
  displayChild?: import("@seam/core").Child;
  index: number;
  /** This block's selection / path key (`children.0`). */
  addr: string;
  /** This block's structured path from the root composition. */
  path: NodePath;
  /** Absolute position within the block's group container (px). */
  left: number;
  top: number;
  width: number;
  depth: number;
  /** The enclosing group's window scale (px↔sec for resize deltas). */
  scale: number;
  /** Whether this block's container is editable (1:1 with the doc). */
  editable: boolean;
  isSelected: boolean;
  isPrimary: boolean;
  /** depth === 0: the root level (drives reorder / scrub specifics). */
  isRoot: boolean;
  isComposition: boolean;
  /** Whether to show the expand toggle — composition (window) or any node
   *  with animated properties (keyframe lanes). */
  isExpandable: boolean;
  isBinItem: boolean;
  isExpanded: boolean;
  onToggleExpand: () => void;
  selection: string[];
  onSelectionChange: (keys: string[]) => void;
  /** True while this block is the source of an active reorder drag —
   *  fade it so the user sees the ghost is the live thing. */
  isDraggingOut: boolean;
  /** True while *any* reorder drag is in flight (this block or another).
   *  A target block's pointerup must then bubble to DesktopTimeline's
   *  window drop handler instead of being swallowed as a click-to-select. */
  reorderDragActive: boolean;
  /** When set, mouse-press + drag past the threshold hands off to the
   *  parent's drag tracker. `null` disables drag for this block (e.g.
   *  non-editable blocks or read-only previews). */
  onReorderDragStart: ((path: NodePath, e: PointerEvent) => void) | null;
  /** When set, pointer-down on a side handle hands off to the parent's
   *  resize tracker. `null` hides the handles. */
  onResizeDragStart:
    | ((
        path: NodePath,
        side: "left" | "right",
        scale: number,
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
    if (selection.includes(addr)) {
      onSelectionChange(selection.filter((k) => k !== addr));
    } else {
      onSelectionChange([...selection, addr]);
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
        onReorderDragStart(path, e.nativeEvent);
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
    if (reorderDragActive) {
      // Another block is being dragged and the user released over this one.
      // Bail *without* stopPropagation so the pointerup bubbles to
      // DesktopTimeline's window drop handler — otherwise the drop is
      // swallowed here and the item can only land on empty space.
      return;
    }
    e.stopPropagation();
    const modifier = e.ctrlKey || e.metaKey;
    if (modifier) {
      // Ctrl/Cmd+click toggles this block's membership in the selection.
      toggleMembership();
    } else {
      // Single select: replace selection, or deselect if this was the only one.
      if (selection.length === 1 && selection[0] === addr) {
        onSelectionChange([]);
      } else {
        onSelectionChange([addr]);
      }
    }
  };

  const handlePointerCancel = () => {
    mouseDownPos.current = null;
  };

  // Every editable block is interactive (select; root also reorders).
  // Non-editable blocks (binItem expansions) render but don't respond —
  // the chevron is the one exception and carries its own handler.
  const interactiveHandlers = editable
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
  // Primary (first selected) → solid; any other selected → dashed; these win
  // over the binItem marker so the attach roles read clearly regardless of
  // type. Unselected binItem refs keep their dashed marker.
  const border = isPrimary
    ? `2px solid ${PRIMARY_BORDER}`
    : isSelected
      ? `2px dashed ${SECONDARY_BORDER}`
      : isBinItem
        ? `2px dashed ${colors.border}`
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
        cursor: onReorderDragStart ? "grab" : editable ? "pointer" : "default",
        opacity: isDraggingOut ? 0.3 : depth > 0 ? 0.92 : 1,
        // A negative-offset crossfade overlaps the incoming block back over the
        // previous one's tail, covering its right resize handle. Lift a
        // selected block above its siblings so its handles stay grabbable
        // (primary above secondaries when several overlap). Kept below the
        // drop ghost (8).
        zIndex: isPrimary ? 4 : isSelected ? 3 : undefined,
      }}
    >
      {isExpandable && (
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
            onPointerDown={(e) => onResizeDragStart(path, "left", scale, e)}
          />
          <ResizeHandle
            side="right"
            onPointerDown={(e) => onResizeDragStart(path, "right", scale, e)}
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
  selection,
  onSelectionChange,
  onDocumentChange,
  history,
  platform,
  onJumpToJson,
}: TimelinePanelProps) {
  // The panel is editable only when given a document; the CC-cut preview
  // passes none, leaving the timeline read-only (selection-only).
  const editable = doc != null;
  const { currentTime, seek } = useTimeline();
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

  // ── Drag / drop / import handlers (path + edit-lens based) ───────
  // All work at any editable level: the `path` identifies the node, and
  // `editContainer` runs the existing pure tools against the target
  // composition (root or nested), injecting the root bin for resolution.

  // Move nodes onto a drop target (within their container, across
  // composition boundaries, or as a new run), then re-select them at their
  // new home.
  const onMoveNodes = useCallback(
    (fromPaths: NodePath[], target: DropTarget) => {
      if (!doc || !onDocumentChange) return;
      // A new run is aimed at the layout as it looks now; lifting the nodes
      // can ripple what the cursor was pointing at, so carry the time over
      // to where that spot ends up (see `dropTime.ts`).
      const options: InsertOptions =
        target.kind === "newRun"
          ? { start: timeAfterLift(doc, fromPaths, target.region.path, target.time) }
          : insertOptionsFor(target);
      const moved = moveNodesTracked(doc, fromPaths, target.region.path, target.index, options);
      if (!moved) return;
      onDocumentChange(moved.doc);
      onSelectionChange(moved.paths.map(pathKey));
    },
    [doc, onDocumentChange, onSelectionChange],
  );

  // Import dropped files onto a drop target.
  const onImportAt = useCallback(
    async (target: DropTarget, files: FileList | File[]) => {
      if (!doc || !onDocumentChange) return;
      const baseDir = filePath ? dirname(filePath) : null;
      const items = await buildItemsFromFiles(files, platform, baseDir);
      if (items.length === 0) return;
      onDocumentChange(
        insertNodes(doc, target.region.path, target.index, items, insertOptionsFor(target)),
      );
    },
    [doc, onDocumentChange, filePath, platform],
  );

  // Media-browser drag: insert prebuilt nodes (already-stored sources) onto a
  // drop target. Mirrors `onImportAt` minus the file-import step.
  const onInsertChildrenAt = useCallback(
    (target: DropTarget, children: Child[]) => {
      if (!doc || !onDocumentChange || children.length === 0) return;
      onDocumentChange(
        insertNodes(doc, target.region.path, target.index, children, insertOptionsFor(target)),
      );
    },
    [doc, onDocumentChange],
  );

  // Re-stack a run (z-order). Indices shift, so the selection is dropped.
  const onMoveRun = useCallback(
    (containerPath: NodePath, head: number, end: number, index: number) => {
      if (!doc || !onDocumentChange) return;
      const next = updateCompAtPath(doc, containerPath, (comp) => {
        const children = comp.children ?? [];
        const moved = moveRun(children, head, end, index);
        return moved === children ? comp : { ...comp, children: moved };
      });
      if (next === doc) return;
      onDocumentChange(next);
      onSelectionChange([]);
    },
    [doc, onDocumentChange, onSelectionChange],
  );

  // Delete/Backspace to remove selected blocks (runs anchored to a deleted
  // node go with it). Editable panels only (the CC-cut preview
  // routes Delete through its own handler in App).
  useEffect(() => {
    if (!doc) return;
    const handler = (e: KeyboardEvent) => {
      // Bail when typing into an input (e.g. the Media panel's filter box) —
      // otherwise Backspace there would delete the timeline selection.
      if (isTypingInEditableSurface(e)) return;
      if (
        (e.key === "Delete" || e.key === "Backspace") &&
        selection.length > 0 &&
        onDocumentChange
      ) {
        e.preventDefault();
        const paths = selection.map(parsePath);
        // Follow the content: slide the playhead back by the removed span
        // when what's under it shifts (see `deletePlayhead.ts`).
        const nextTime = playheadAfterDelete(timeline, doc, paths, currentTime);
        if (nextTime !== currentTime) seek(nextTime);
        onDocumentChange(removeNodesAtPaths(doc, paths));
        onSelectionChange([]);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [selection, doc, timeline, currentTime, seek, onDocumentChange, onSelectionChange]);

  // Only forward drag / drop callbacks when editable; a read-only preview
  // should no-op on drop.
  const shellOnMoveNodes = editable ? onMoveNodes : undefined;
  const shellOnImportAt = editable ? onImportAt : undefined;
  const shellOnInsertChildrenAt = editable ? onInsertChildrenAt : undefined;
  const shellOnMoveRun = editable ? onMoveRun : undefined;

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
      <DesktopTimeline
        timeline={timeline}
        docRoot={doc}
        selection={selection}
        onSelectionChange={onSelectionChange}
        expanded={expanded}
        onToggleExpand={onToggleExpand}
        rootBin={rootBin}
        editHistory={editable ? history : undefined}
        onMoveNodes={shellOnMoveNodes}
        onImportAt={shellOnImportAt}
        onInsertChildrenAt={shellOnInsertChildrenAt}
        onMoveRun={shellOnMoveRun}
        onJumpToJson={onJumpToJson}
      />
    </div>
  );
}

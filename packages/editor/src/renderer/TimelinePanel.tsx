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
import { buildItemsFromFiles, SOURCE_DRAG_MIME } from "./useImport.js";
import { attachNewItems } from "./attachTool.js";
import { dirname } from "./pathUtils.js";
import type { History } from "./useHistory.js";
import type { Platform } from "./platform/index.js";
import {
  parsePath,
  pathKey,
  samePath,
  removeNodesAtPaths,
  removeNodeAtPath,
  insertNode,
  moveNode,
  getNodeAtPath,
  getCompAtPath,
  adjustPathAfterRemoval,
  editContainer,
  splitLast,
  type NodePath,
} from "./nodePath.js";
import {
  flattenDropRegions,
  flattenGroups,
  regionAt,
  insertionIndexIn,
  insertionXIn,
  localTime,
} from "./dropRegions.js";
import {
  ROW_HEIGHT,
  ROW_GAP,
  RULER_HEIGHT,
  DEPTH_INSET,
  rowTop,
} from "./timelineLayout.js";
import { layoutTree, type TreeGroup } from "./timelineTree.js";
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
  /** Canonical selection: path keys (`children.0`,
   *  `children.3.attachments.1`). See `nodePath.ts`. */
  selection: string[];
  onSelectionChange: (keys: string[]) => void;
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
/** Strip any `start`/`end` anchors off a node — used when moving a node
 *  into a sequential `children` band where anchors are meaningless. */
function stripAnchors(child: Child): Child {
  if (!("start" in child) && !("end" in child)) return child;
  const next = { ...child } as Record<string, unknown>;
  delete next.start;
  delete next.end;
  return next as unknown as Child;
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
  selection: string[];
  onSelectionChange: (keys: string[]) => void;
  /** Set of expanded composition addresses (see `timelineTree`). */
  expanded: Set<string>;
  /** Toggle a composition's expanded state by its address. */
  onToggleExpand: (addr: string) => void;
  /** Root document's bin entries — for pairing `binItem` expansions. */
  rootBin: BinEntry[];
  /** Provided only when the panel is editable, where attachment edits are
   *  writable. */
  editHistory?: History<SeamFile>;
  /** Move an existing node into a container's `children` band at insertion
   *  index `to`. Handles both same-container reorder and cross-container
   *  drag (in/out of a composition). Undefined when editing isn't
   *  supported. */
  onMoveNode?: (
    fromPath: NodePath,
    toContainer: NodePath,
    toIndex: number,
  ) => void;
  /** Cursor-based file import into a specific container at a slot. */
  onImportAt?: (
    toContainer: NodePath,
    toIndex: number,
    files: FileList | File[],
  ) => Promise<void>;
  /** Insert prebuilt nodes (dragged from the media browser) into a container
   *  at a slot. Mirrors `onImportAt` but skips file import — the source is
   *  already stored. */
  onInsertChildrenAt?: (
    toContainer: NodePath,
    toIndex: number,
    children: Child[],
  ) => void;
  /** Receives a file drop on the attach zone — anchors new items to the
   *  selected primary (at `containerPath`'s `field[fieldIndex]`, where
   *  `field` is the primary's own band) at its container-local `localTime`
   *  (the playhead). */
  onAttachDropAt?: (
    containerPath: NodePath,
    field: "children" | "attachments",
    fieldIndex: number,
    side: "start" | "end",
    localTime: number,
    files: FileList,
  ) => void;
  /** Attach-zone drop of prebuilt nodes (media-browser drag). Mirrors
   *  `onAttachDropAt` without file import. */
  onAttachChildrenAt?: (
    containerPath: NodePath,
    field: "children" | "attachments",
    fieldIndex: number,
    side: "start" | "end",
    localTime: number,
    children: Child[],
  ) => void;
  /** Receives a grabbed-node drop on the attach zone — moves the node at
   *  `fromPath` into the selected primary's container as an anchored
   *  attachment. */
  onAttachExistingAt?: (
    containerPath: NodePath,
    field: "children" | "attachments",
    fieldIndex: number,
    side: "start" | "end",
    localTime: number,
    fromPath: NodePath,
  ) => void;
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
  selection: string[];
  onSelectionChange: (keys: string[]) => void;
  expanded: Set<string>;
  onToggleExpand: (addr: string) => void;
  /** Root bin — injected into nested containers so `binItem`s resolve when
   *  an edit (resize/reorder) runs against a sub-composition. */
  rootBin: BinEntry[];
  editHistory?: History<SeamFile>;
  /** Path key of the node currently being drag-moved (fades its block
   *  view). Pass `null` when the shell doesn't support drag. */
  reorderDragKey: string | null;
  /** Hand-off callback when a block's mouse-press passes the drag
   *  threshold. Pass `null` to disable drag for this shell. */
  onReorderDragStart: ((path: NodePath, e: PointerEvent) => void) | null;
  /** Insertion-line ghost: content-X plus the target container's vertical
   *  extent. Null hides it. */
  insertionGhost?: { x: number; top: number; height: number } | null;
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
  selection,
  onSelectionChange,
  expanded,
  onToggleExpand,
  rootBin,
  editHistory,
  reorderDragKey,
  onReorderDragStart,
  insertionGhost,
  showAttachZone,
  attachHoverSide,
}: TimelineSurfaceProps) {
  const { pxPerSec, rootGroup, contentHeight, rulerTicks } = surface;
  const { currentTime, totalDuration, seek } = useTimeline();
  // Editable group placements drive the anchor-line overlay (it draws every
  // selected attachment's line in content coords, at any nesting level).
  const groups = useMemo(
    () => flattenGroups(rootGroup, pxPerSec),
    [rootGroup, pxPerSec],
  );

  // Per-block drag-resize. Stable identity via useEvent so re-renders
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
      const isAttachment = last.field === "attachments";

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
            resizeChild(sub, last.index, isAttachment, side, deltaSec),
          ),
        );
        // Scrub the playhead to the cursor (same audio feedback as
        // dragging on the timeline) — root blocks only; a nested block's
        // local px don't map to a global playhead time.
        const container = scrollRef.current;
        if (container && parent.length === 0) {
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
        selection={selection}
        onSelectionChange={onSelectionChange}
        expanded={expanded}
        onToggleExpand={onToggleExpand}
        reorderDragKey={reorderDragKey}
        onReorderDragStart={onReorderDragStart}
        onResizeDragStart={onResizeDragStart}
      />
      <AnchorLinesLayer
        selection={selection}
        docRoot={docRoot as SeamFile | undefined}
        rootBin={rootBin}
        groups={groups}
        pxPerSec={pxPerSec}
        history={editHistory}
      />
      {insertionGhost != null && (
        <InsertionGhost
          x={insertionGhost.x}
          top={insertionGhost.top}
          height={insertionGhost.height}
        />
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

function InsertionGhost({
  x,
  top,
  height,
}: {
  x: number;
  top: number;
  height: number;
}) {
  return (
    <div
      style={{
        position: "absolute",
        left: x - 1,
        top,
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
  selection,
  onSelectionChange,
  expanded,
  onToggleExpand,
  rootBin,
  editHistory,
  onMoveNode,
  onImportAt,
  onInsertChildrenAt,
  onAttachDropAt,
  onAttachChildrenAt,
  onAttachExistingAt,
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
  const contentWidth = Math.max(totalDuration * pxPerSec + 200, 200);

  // Item-drag state: a grabbed node tracked in content (scroll-relative)
  // px. The same position drives the insertion ghost and the attach-zone
  // hover, just like a dropped file.
  const [itemDrag, setItemDrag] = useState<{
    fromPath: NodePath;
    cursorX: number;
    cursorY: number;
  } | null>(null);

  // File-drag state. cursorContentX drives the insertion ghost +
  // cursor-based snap; cursorContentY decides attach zone vs main area.
  const [fileDrag, setFileDrag] = useState<{
    cursorContentX: number;
    cursorContentY: number;
  } | null>(null);

  // Every editable container, flattened to a content-space drop target.
  // A drag hit-tests these to find which composition (root or nested) the
  // cursor is over and the insertion slot within it.
  const regions = useMemo(
    () =>
      flattenDropRegions(rootGroup, pxPerSec, {
        width: contentWidth,
        height: contentHeight,
      }),
    [rootGroup, pxPerSec, contentWidth, contentHeight],
  );

  // The single selected node that's a valid anchor primary — any node type
  // (the format lets you anchor to anything), as a sequential child or an
  // existing attachment, at any editable level. (`attachNewItems` resolves
  // its container un-windowed, so windowed containers are fine.)
  const attachTarget = useMemo(() => {
    if (!docRoot || selection.length !== 1) return null;
    const key = selection[0];
    const path = parsePath(key);
    const last = path[path.length - 1];
    if (!last || (last.field !== "children" && last.field !== "attachments")) {
      return null;
    }
    const node = getNodeAtPath(docRoot as SeamFile, path);
    if (!node) return null;
    return {
      key,
      path,
      containerPath: path.slice(0, -1),
      field: last.field,
      fieldIndex: last.index,
    };
  }, [docRoot, selection]);

  // The attach zone is available during a file drag (drop files as
  // attachments) and during a grabbed-node drag (re-attach an existing
  // node) — both anchored to the selected primary, as long as the grabbed
  // node isn't itself the primary.
  const fileAttachActive =
    fileDrag != null && attachTarget != null && !!onAttachDropAt;
  const itemAttachActive =
    itemDrag != null &&
    attachTarget != null &&
    pathKey(itemDrag.fromPath) !== attachTarget.key &&
    !!onAttachExistingAt;
  const showAttachZone = fileAttachActive || itemAttachActive;
  const totalContentHeight = contentHeight + (showAttachZone ? ATTACH_ZONE_HEIGHT : 0);

  // Local-output time on the attach primary's container at the playhead —
  // the anchor point for an attach drop.
  const attachLocalTime = (): number => {
    if (!attachTarget) return currentTime;
    const region = regions.find((r) =>
      samePath(r.path, attachTarget.containerPath),
    );
    return region ? localTime(region, currentTime * pxPerSec, pxPerSec) : currentTime;
  };

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

  // ── Drag-to-move (reorder + in/out of compositions) ────────────
  // A block press that crosses the threshold hands off here. The cursor
  // is then tracked on window events (independent of the source block's
  // capture) and the drop hit-tests the drop regions to find its target
  // container + slot — so a node can move within its container or across
  // composition boundaries.
  const startReorderDrag = useCallback(
    (path: NodePath, e: PointerEvent) => {
      if (!onMoveNode) return;
      const container = scrollRef.current;
      if (!container) return;
      const rect = container.getBoundingClientRect();
      const cursorX = e.clientX - rect.left + container.scrollLeft;
      const cursorY = e.clientY - rect.top + container.scrollTop;
      setItemDrag({ fromPath: path, cursorX, cursorY });
    },
    [onMoveNode],
  );

  useEffect(() => {
    if (!itemDrag || !onMoveNode) return;
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

    const onMove = (e: PointerEvent) => {
      const { x, y } = cursorFromEvent(e);
      setItemDrag((prev) =>
        prev ? { ...prev, cursorX: x, cursorY: y } : null,
      );
    };

    const onUp = (e: PointerEvent) => {
      const { x, y } = cursorFromEvent(e);
      const fromPath = dragRef.fromPath;
      // Dropping a grabbed node on the attach zone attaches it to the
      // selected primary — same handler intent as a dropped file.
      const inAttachZone =
        attachTarget != null &&
        pathKey(fromPath) !== attachTarget.key &&
        onAttachExistingAt != null &&
        y >= contentHeight;
      if (inAttachZone) {
        const side = x >= currentTime * pxPerSec ? "start" : "end";
        onAttachExistingAt(
          attachTarget.containerPath,
          attachTarget.field,
          attachTarget.fieldIndex,
          side,
          attachLocalTime(),
          fromPath,
        );
      } else {
        const region = regionAt(regions, x, y);
        const slot = insertionIndexIn(region, x);
        onMoveNode(fromPath, region.path, slot);
      }
      setItemDrag(null);
    };

    const onCancel = () => setItemDrag(null);

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onCancel);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onCancel);
    };
    // Only the drag's *existence* drives subscribe/unsubscribe; cursor
    // updates come through setState. The other values are read fresh at
    // drop time via the closure (re-subscription on change is harmless).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    itemDrag !== null,
    onMoveNode,
    onAttachExistingAt,
    regions,
    attachTarget,
    pxPerSec,
    currentTime,
    contentHeight,
  ]);

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

  // Both OS files and media-browser source drags drive the same ghost +
  // attach-zone affordance; the payload only differs at drop time.
  const isDraggablePayload = (e: React.DragEvent) =>
    e.dataTransfer.types.includes("Files") ||
    e.dataTransfer.types.includes(SOURCE_DRAG_MIME);

  const handleFileDragOver = (e: React.DragEvent) => {
    if (!isDraggablePayload(e)) return;
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
    if (!isDraggablePayload(e)) return;
    e.preventDefault();
    const pos = cursorToContent(e);
    setFileDrag(null);
    if (!pos) return;

    // Media-browser source drag carries prebuilt nodes; an OS drop carries
    // files. Parse the source payload (if any) so both go through the same
    // attach-zone / region branching below.
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

    const inAttachZone =
      showAttachZone &&
      pos.y >= contentHeight &&
      attachTarget != null;
    if (inAttachZone) {
      const side = pos.x >= currentTime * pxPerSec ? "start" : "end";
      if (sourceChildren) {
        onAttachChildrenAt?.(
          attachTarget!.containerPath,
          attachTarget!.field,
          attachTarget!.fieldIndex,
          side,
          attachLocalTime(),
          sourceChildren,
        );
      } else if (onAttachDropAt) {
        onAttachDropAt(
          attachTarget!.containerPath,
          attachTarget!.field,
          attachTarget!.fieldIndex,
          side,
          attachLocalTime(),
          e.dataTransfer.files,
        );
      }
      return;
    }

    const region = regionAt(regions, pos.x, pos.y);
    const slot = insertionIndexIn(region, pos.x);
    if (sourceChildren) {
      onInsertChildrenAt?.(region.path, slot, sourceChildren);
    } else if (onImportAt) {
      void onImportAt(region.path, slot, e.dataTransfer.files);
    }
  };

  const playheadX = currentTime * pxPerSec;
  // A grabbed node and a dragged-in file share the same drag position →
  // the same insertion ghost (a move = "drop this node at the snapped
  // slot in the targeted container") and the same attach-zone hover.
  const dragPos: { x: number; y: number } | null =
    fileDrag != null
      ? { x: fileDrag.cursorContentX, y: fileDrag.cursorContentY }
      : itemDrag != null
        ? { x: itemDrag.cursorX, y: itemDrag.cursorY }
        : null;
  const inAttachZone =
    showAttachZone && dragPos != null && dragPos.y >= contentHeight;
  // Hit-test the targeted container and snap the ghost to its insertion
  // slot, drawn over that container's vertical extent.
  const insertionGhost =
    dragPos != null && !inAttachZone
      ? (() => {
          const region = regionAt(regions, dragPos.x, dragPos.y);
          const slot = insertionIndexIn(region, dragPos.x);
          return {
            x: insertionXIn(region, slot),
            top: region.top,
            height: region.height,
          };
        })()
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
        cursor: itemDrag ? "grabbing" : "crosshair",
      }}
    >
      <div style={{ width: contentWidth, height: totalContentHeight, position: "relative" }}>
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
          reorderDragKey={itemDrag ? pathKey(itemDrag.fromPath) : null}
          onReorderDragStart={onMoveNode ? startReorderDrag : null}
          insertionGhost={insertionGhost}
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
  selection,
  onSelectionChange,
  expanded,
  onToggleExpand,
  reorderDragKey,
  onReorderDragStart,
  onResizeDragStart,
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
  reorderDragKey: string | null;
  onReorderDragStart: ((path: NodePath, e: PointerEvent) => void) | null;
  onResizeDragStart:
    | ((
        path: NodePath,
        side: "left" | "right",
        scale: number,
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
        const isSelected = selection.includes(addr);
        // The first selected item (the attach primary) is always the
        // primary, regardless of type; the rest are secondaries.
        const isPrimary = isSelected && selection[0] === addr;
        // Drag-to-move is for sequential children at any editable level
        // (attachments are anchor-positioned, so they don't reorder); the
        // drop pass routes it within or across containers. Resize also
        // works at any editable level — nested deltas scale by the window.
        const blockReorderStart =
          group.editable && !isAttachment && onReorderDragStart
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
            isAttachment={isAttachment}
            isSelected={isSelected}
            isPrimary={isPrimary}
            isRoot={isRoot}
            isComposition={block.isComposition}
            isBinItem={block.isBinItem}
            isExpanded={block.isExpanded}
            onToggleExpand={() => onToggleExpand(addr)}
            selection={selection}
            onSelectionChange={onSelectionChange}
            isDraggingOut={reorderDragKey === addr}
            reorderDragActive={reorderDragKey != null}
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
              reorderDragKey={reorderDragKey}
              onReorderDragStart={onReorderDragStart}
              onResizeDragStart={onResizeDragStart}
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
  addr,
  path,
  left,
  top,
  width,
  depth,
  scale,
  editable,
  isAttachment,
  isSelected,
  isPrimary,
  isRoot,
  isComposition,
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
  isAttachment: boolean;
  isSelected: boolean;
  isPrimary: boolean;
  /** depth === 0: the root level (drives reorder / scrub specifics). */
  isRoot: boolean;
  isComposition: boolean;
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
   *  attachments, non-editable blocks, or read-only previews). */
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
}: TimelinePanelProps) {
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

  // ── Drag / drop / import handlers (path + edit-lens based) ───────
  // All work at any editable level: the `path` identifies the node, and
  // `editContainer` runs the existing pure tools against the target
  // composition (root or nested), injecting the root bin for resolution.

  // Move a node within its container or across composition boundaries,
  // then re-select it at its new home.
  const onMoveNode = useCallback(
    (fromPath: NodePath, toContainer: NodePath, toIndex: number) => {
      if (!doc || !onDocumentChange) return;
      const next = moveNode(
        doc,
        fromPath,
        toContainer,
        "children",
        toIndex,
        stripAnchors,
      );
      if (next === doc) return;
      // Destination index after the splice (for selection-follow).
      const last = fromPath[fromPath.length - 1];
      const sameContainer = samePath(fromPath.slice(0, -1), toContainer);
      let dest = toIndex;
      if (sameContainer && last?.field === "children" && last.index < toIndex) {
        dest = toIndex - 1;
      }
      const len = getCompAtPath(next, toContainer)?.children.length ?? 0;
      dest = Math.max(0, Math.min(dest, len - 1));
      onDocumentChange(next);
      onSelectionChange([
        pathKey([...toContainer, { field: "children", index: dest }]),
      ]);
    },
    [doc, onDocumentChange, onSelectionChange],
  );

  // Import dropped files into a specific container at a slot.
  const onImportAt = useCallback(
    async (
      toContainer: NodePath,
      toIndex: number,
      files: FileList | File[],
    ) => {
      if (!doc || !onDocumentChange) return;
      const baseDir = filePath ? dirname(filePath) : null;
      const items = await buildItemsFromFiles(files, platform, baseDir);
      if (items.length === 0) return;
      let next = doc;
      for (let k = 0; k < items.length; k++) {
        next = insertNode(next, toContainer, "children", toIndex + k, items[k]);
      }
      onDocumentChange(next);
    },
    [doc, onDocumentChange, filePath, platform],
  );

  // Anchor dropped files to the selected primary at `anchorTime` (its
  // container-local playhead), adding them as attachments in the primary's
  // container via the edit lens.
  const handleAttachDropAt = useCallback(
    async (
      containerPath: NodePath,
      field: "children" | "attachments",
      fieldIndex: number,
      side: "start" | "end",
      anchorTime: number,
      files: FileList,
    ) => {
      if (!doc || !onDocumentChange) return;
      const baseDir = filePath ? dirname(filePath) : null;
      const items = await buildItemsFromFiles(files, platform, baseDir);
      if (items.length === 0) return;
      const next = editContainer(doc, containerPath, rootBin, (sub) =>
        attachNewItems(sub, anchorTime, field, fieldIndex, items, side),
      );
      if (next !== doc) onDocumentChange(next);
    },
    [doc, onDocumentChange, filePath, platform, rootBin],
  );

  // Media-browser drag: insert prebuilt nodes (already-stored sources) into a
  // container at a slot. Mirrors `onImportAt` minus the file-import step.
  const onInsertChildrenAt = useCallback(
    (toContainer: NodePath, toIndex: number, children: Child[]) => {
      if (!doc || !onDocumentChange || children.length === 0) return;
      let next = doc;
      for (let k = 0; k < children.length; k++) {
        next = insertNode(
          next,
          toContainer,
          "children",
          toIndex + k,
          children[k],
        );
      }
      onDocumentChange(next);
    },
    [doc, onDocumentChange],
  );

  // Media-browser drag onto the attach zone: anchor prebuilt nodes to the
  // selected primary. Mirrors `handleAttachDropAt` minus the file-import step.
  const onAttachChildrenAt = useCallback(
    (
      containerPath: NodePath,
      field: "children" | "attachments",
      fieldIndex: number,
      side: "start" | "end",
      anchorTime: number,
      children: Child[],
    ) => {
      if (!doc || !onDocumentChange || children.length === 0) return;
      const next = editContainer(doc, containerPath, rootBin, (sub) =>
        attachNewItems(sub, anchorTime, field, fieldIndex, children, side),
      );
      if (next !== doc) onDocumentChange(next);
    },
    [doc, onDocumentChange, rootBin],
  );

  // Move a grabbed node into the selected primary's container as a fresh
  // single-(start|end)-anchored attachment. Strips any existing anchors so
  // it can't end up pinned on both ends; clears selection since it moved.
  const handleAttachExistingAt = useCallback(
    (
      containerPath: NodePath,
      field: "children" | "attachments",
      fieldIndex: number,
      side: "start" | "end",
      anchorTime: number,
      fromPath: NodePath,
    ) => {
      if (!doc || !onDocumentChange) return;
      const node = getNodeAtPath(doc, fromPath);
      if (!node) return;
      const item = stripAnchors({ ...node } as Child);
      const removed = removeNodeAtPath(doc, fromPath);
      const adjContainer = adjustPathAfterRemoval(containerPath, fromPath);
      // Removing an earlier sibling in the primary's *own* band (same
      // container, same field) shifts the primary's index down by one.
      const last = fromPath[fromPath.length - 1];
      let adjFieldIndex = fieldIndex;
      if (
        samePath(fromPath.slice(0, -1), containerPath) &&
        last?.field === field &&
        last.index < fieldIndex
      ) {
        adjFieldIndex -= 1;
      }
      const next = editContainer(removed, adjContainer, rootBin, (sub) =>
        attachNewItems(sub, anchorTime, field, adjFieldIndex, [item], side),
      );
      if (next !== removed) {
        onDocumentChange(next);
        onSelectionChange([]);
      }
    },
    [doc, onDocumentChange, rootBin, onSelectionChange],
  );

  // Delete/Backspace to remove selected blocks — handles both `children`
  // and `attachments` indices. Editable panels only (the CC-cut preview
  // routes Delete through its own handler in App).
  useEffect(() => {
    if (!doc) return;
    const handler = (e: KeyboardEvent) => {
      if (
        (e.key === "Delete" || e.key === "Backspace") &&
        selection.length > 0 &&
        onDocumentChange
      ) {
        e.preventDefault();
        onDocumentChange(removeNodesAtPaths(doc, selection.map(parsePath)));
        onSelectionChange([]);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [selection, doc, onDocumentChange, onSelectionChange]);

  // Only forward drag / drop / attach callbacks when editable; a read-only
  // preview should no-op on drop.
  const shellOnMoveNode = editable ? onMoveNode : undefined;
  const shellOnImportAt = editable ? onImportAt : undefined;
  const shellOnInsertChildrenAt = editable ? onInsertChildrenAt : undefined;
  const shellOnAttachDropAt = editable ? handleAttachDropAt : undefined;
  const shellOnAttachChildrenAt = editable ? onAttachChildrenAt : undefined;
  const shellOnAttachExistingAt = editable ? handleAttachExistingAt : undefined;

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
        return (
          <DesktopTimeline
            timeline={timeline}
            docRoot={panelDoc}
            attachmentStartIndex={splitIndex}
            selection={selection}
            onSelectionChange={onSelectionChange}
            expanded={expanded}
            onToggleExpand={onToggleExpand}
            rootBin={rootBin}
            editHistory={editHistory}
            onMoveNode={shellOnMoveNode}
            onImportAt={shellOnImportAt}
            onInsertChildrenAt={shellOnInsertChildrenAt}
            onAttachDropAt={shellOnAttachDropAt}
            onAttachChildrenAt={shellOnAttachChildrenAt}
            onAttachExistingAt={shellOnAttachExistingAt}
          />
        );
      })()}
    </div>
  );
}

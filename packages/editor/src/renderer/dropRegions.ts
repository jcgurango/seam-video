// Flattens the timeline layout tree into content-space geometry so passes
// that span the whole tree (drag-drop, anchor lines) can address any
// container, not just the root.
//
// Two views over the same walk:
//   • drop regions — one rectangle per editable container, with its window
//     transform and its runs' content-space extents (drag);
//   • group placements — each editable group's content-space origin (the
//     anchor-line overlay draws every selected head's plumb line in content
//     coords).
//
// Geometry invariant: a block's content-x is
//   containerLeft + ((localSec - originSec) / scale) * pxPerSec
// which is exactly the global-timeline mapping (that's why an expansion
// aligns under its composition block). So `contentX / pxPerSec` is global
// output time at every level, and a container's local output time at a
// cursor is `originSec + (contentX - containerLeft) / pxPerSec * scale`.
//
// `rowsTop` is the true content-y of a group's row 0: the root's rows start
// below the ruler (`RULER_HEIGHT + ROW_GAP`), and each nested group's rows
// start at its clip-box top. (The root drop *region*'s rect still starts at
// y=0 so it's the always-containing hit-test floor.)
//
// Drop targets (`dropTargetAt`):
//   • on a block row — extend a run: before/after any node (dropping before
//     a run's head takes over its anchor);
//   • on the strip under a row (where the dotted run underline lives) — a
//     NEW run starting at the cursor's time, stacked after that row's runs;
//   • on the ruler (root only) — a new run at the front of the array.

import { ROW_HEIGHT, ROW_GAP, RULER_HEIGHT, rowTop } from "./timelineLayout.js";
import type { TreeGroup } from "./timelineTree.js";
import { pathKey, type NodePath } from "./nodePath.js";

export interface DropChild {
  /** Index within the container's `children` array. */
  index: number;
  path: NodePath;
  /** Content-space px extents of the block. */
  startX: number;
  endX: number;
}

export interface DropRun {
  /** `[head, end)` slice of the container's `children`. */
  head: number;
  end: number;
  /** Local row within the group. */
  row: number;
  startX: number;
  endX: number;
  members: DropChild[];
}

export interface DropRegion {
  path: NodePath;
  /** Content-space rectangle of the container (for cursor hit-testing). */
  left: number;
  top: number;
  width: number;
  height: number;
  /** Window transform back to this container's local output seconds. */
  originSec: number;
  scale: number;
  containerLeft: number;
  /** Content-y of row 0. */
  rowsTop: number;
  /** Runs in array (z) order. */
  runs: DropRun[];
  childCount: number;
}

/** An editable group placed in content space: its row-0 top and left edge. */
export interface GroupPlacement {
  group: TreeGroup;
  containerLeft: number;
  containerTop: number;
}

interface Placement {
  group: TreeGroup;
  left: number;
  /** True content-y of this group's row 0. */
  trueTop: number;
  /** y of this group's drop-region rect (root = 0; nested = clip-box top). */
  regionTop: number;
  width: number;
  height: number;
}

/** Depth-first walk producing one placement per group, outermost-first. */
function walkPlacements(
  root: TreeGroup,
  pxPerSec: number,
  content: { width: number; height: number },
): Placement[] {
  const out: Placement[] = [];
  const visit = (
    group: TreeGroup,
    left: number,
    trueTop: number,
    regionTop: number,
    width: number,
    height: number,
  ) => {
    out.push({ group, left, trueTop, regionTop, width, height });
    const toX = (sec: number) =>
      left + ((sec - group.originSec) / group.scale) * pxPerSec;
    for (const b of group.blocks) {
      if (!b.expansion) continue;
      const cl = toX(b.child.timelineStart);
      const cw = Math.max(toX(b.child.timelineEnd) - cl, 2);
      const ct = trueTop + rowTop(b.expansion.topRow);
      const ch = b.expansion.group.rowCount * (ROW_HEIGHT + ROW_GAP);
      visit(b.expansion.group, cl, ct, ct, cw, ch);
    }
  };
  // Root rows start below the ruler, but its region rect covers the whole
  // content (top 0) so it's the hit-test floor.
  visit(root, 0, RULER_HEIGHT + ROW_GAP, 0, content.width, content.height);
  return out;
}

/** Flatten editable containers into drop regions, outermost-first (a deeper
 *  match wins the hit-test). */
export function flattenDropRegions(
  root: TreeGroup,
  pxPerSec: number,
  content: { width: number; height: number },
): DropRegion[] {
  return walkPlacements(root, pxPerSec, content)
    .filter((p) => p.group.editable)
    .map((p) => {
      const toX = (sec: number) =>
        p.left + ((sec - p.group.originSec) / p.group.scale) * pxPerSec;
      const byIndex = new Map(p.group.blocks.map((b) => [b.index, b]));
      const runs: DropRun[] = p.group.runs.map((run) => {
        const members: DropChild[] = [];
        for (let i = run.head; i < run.end; i++) {
          const b = byIndex.get(i);
          if (!b) continue;
          members.push({
            index: i,
            path: b.path,
            startX: toX(b.child.timelineStart),
            endX: toX(b.child.timelineEnd),
          });
        }
        return {
          head: run.head,
          end: run.end,
          row: run.row,
          startX: toX(run.startSec),
          endX: toX(run.endSec),
          members,
        };
      });
      return {
        path: p.group.path,
        left: p.left,
        top: p.regionTop,
        width: p.width,
        height: p.height,
        originSec: p.group.originSec,
        scale: p.group.scale,
        containerLeft: p.left,
        rowsTop: p.trueTop,
        runs,
        childCount: p.group.blocks.length,
      };
    });
}

/** Flatten editable groups into content-space placements (for the anchor
 *  overlay, which needs each group's true row-0 top). The root rect dims
 *  don't affect placements, so no content box is needed. */
export function flattenGroups(
  root: TreeGroup,
  pxPerSec: number,
): GroupPlacement[] {
  return walkPlacements(root, pxPerSec, { width: 0, height: 0 })
    .filter((p) => p.group.editable)
    .map((p) => ({
      group: p.group,
      containerLeft: p.left,
      containerTop: p.trueTop,
    }));
}

function contains(r: DropRegion, x: number, y: number): boolean {
  return (
    x >= r.left && x <= r.left + r.width && y >= r.top && y <= r.top + r.height
  );
}

/** The deepest editable region under `(x, y)` — the root region is the
 *  always-containing floor. */
export function regionAt(
  regions: DropRegion[],
  x: number,
  y: number,
): DropRegion {
  let best = regions[0];
  for (const r of regions) {
    if (r.path.length > best.path.length && contains(r, x, y)) best = r;
  }
  return best;
}

/** This region's local output seconds at a content-space X. */
export function localTime(
  region: DropRegion,
  contentX: number,
  pxPerSec: number,
): number {
  return (
    region.originSec +
    ((contentX - region.containerLeft) / pxPerSec) * region.scale
  );
}

export type DropTarget =
  | {
      /** Extend a run: insert at `index`; `before` = take over the head slot
       *  of the node at `index`. Ghost = a vertical line on one row. */
      kind: "insert";
      region: DropRegion;
      index: number;
      before: boolean;
      x: number;
      top: number;
      height: number;
    }
  | {
      /** Head a new run at local `time`, inserted at `index`. Ghost = a bar
       *  on the strip (or the ruler) plus a tick at `x`. */
      kind: "newRun";
      region: DropRegion;
      index: number;
      time: number;
      x: number;
      top: number;
      height: number;
      /** True when `x`/`time` were snapped onto a node edge. */
      snapped: boolean;
    };

/** Snapping for a new-run drop (Shift held mid-drag): the run's start jumps
 *  to the nearest node start/end within `thresholdPx`. It is NOT an anchor —
 *  just an authored absolute time that happens to coincide with that edge. */
export interface DropSnap {
  thresholdPx: number;
  /** Path keys whose edges don't count (the nodes being dragged). */
  exclude?: ReadonlySet<string>;
}

/** Content-x of the node edge nearest to `x` across every region (edges line
 *  up in content space at any nesting level), or null if none is in reach. */
function snapX(regions: DropRegion[], x: number, snap: DropSnap): number | null {
  let best: number | null = null;
  let bestDist = snap.thresholdPx;
  for (const region of regions) {
    for (const run of region.runs) {
      for (const m of run.members) {
        if (snap.exclude?.has(pathKey(m.path))) continue;
        for (const edge of [m.startX, m.endX]) {
          const d = Math.abs(edge - x);
          if (d <= bestDist) {
            bestDist = d;
            best = edge;
          }
        }
      }
    }
  }
  return best;
}

/** The run row at content-y (the lowest run row starting at or above it). */
function runRowAt(region: DropRegion, y: number): number {
  const rows = [...new Set(region.runs.map((r) => r.row))].sort((a, b) => a - b);
  let row = rows[0] ?? 0;
  for (const r of rows) {
    if (region.rowsTop + rowTop(r) <= y) row = r;
  }
  return row;
}

/** Resolve the cursor to a drop target (see the header for the zones). */
export function dropTargetAt(
  regions: DropRegion[],
  x: number,
  y: number,
  pxPerSec: number,
  snap?: DropSnap,
): DropTarget {
  const region = regionAt(regions, x, y);
  const isRoot = region.path.length === 0;
  // A new run starts at the cursor's local time — or, when snapping, at the
  // local time of the nearest node edge (kept at full precision so the run
  // really starts with that node).
  const newRun = (index: number, top: number, height: number): DropTarget => {
    const edge = snap ? snapX(regions, x, snap) : null;
    const at = edge ?? x;
    const t = Math.max(0, localTime(region, at, pxPerSec));
    return {
      kind: "newRun",
      region,
      index,
      time: edge != null ? Math.round(t * 1e6) / 1e6 : Math.round(t * 1000) / 1000,
      x: at,
      top,
      height,
      snapped: edge != null,
    };
  };

  if (region.runs.length === 0) {
    return {
      kind: "insert",
      region,
      index: 0,
      before: false,
      x: region.containerLeft,
      top: region.rowsTop,
      height: ROW_HEIGHT,
    };
  }
  if (isRoot && y < region.rowsTop) {
    return newRun(0, 0, RULER_HEIGHT);
  }

  const row = runRowAt(region, y);
  const rowY = region.rowsTop + rowTop(row);
  const onRow = region.runs.filter((r) => r.row === row);
  if (y - rowY >= ROW_HEIGHT) {
    // The strip under the row: a new run, stacked after this row's runs.
    return newRun(Math.max(...onRow.map((r) => r.end)), rowY + ROW_HEIGHT, ROW_GAP);
  }

  // On the row: the run under the cursor, else the nearest one.
  const dist = (r: DropRun) => (x < r.startX ? r.startX - x : x > r.endX ? x - r.endX : 0);
  const run = onRow.reduce((a, b) => (dist(b) < dist(a) ? b : a));
  for (let k = 0; k < run.members.length; k++) {
    const m = run.members[k];
    if (x < (m.startX + m.endX) / 2) {
      return {
        kind: "insert",
        region,
        index: m.index,
        before: k === 0,
        x: m.startX,
        top: rowY,
        height: ROW_HEIGHT,
      };
    }
  }
  const last = run.members[run.members.length - 1];
  return {
    kind: "insert",
    region,
    index: run.end,
    before: false,
    x: last ? last.endX : run.endX,
    top: rowY,
    height: ROW_HEIGHT,
  };
}

/** Where a run dragged vertically to content-y lands in the array: before
 *  the head of the first OTHER run (array order) whose row lies below the
 *  cursor, else at the end. */
export function runZIndexAt(region: DropRegion, draggedHead: number, y: number): number {
  for (const r of region.runs) {
    if (r.head === draggedHead) continue;
    if (region.rowsTop + rowTop(r.row) + ROW_HEIGHT / 2 > y) return r.head;
  }
  return region.childCount;
}

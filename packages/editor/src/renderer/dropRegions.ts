// Flattens the timeline layout tree into content-space geometry so passes
// that span the whole tree (drag-drop, anchor lines) can address any
// container, not just the root.
//
// Two views over the same walk:
//   • drop regions — one rectangle per editable container, with its window
//     transform and its sequential children's content-space extents (drag);
//   • group placements — each editable group's content-space origin (the
//     anchor-line overlay draws every selected attachment's plumb line in
//     content coords).
//
// Geometry invariant: a block's content-x is
//   containerLeft + ((localSec - originSec) / scale) * pxPerSec
// which is exactly the global-timeline mapping (that's why an expansion
// aligns under its composition block). So `contentX / pxPerSec` is global
// output time at every level, and a container's local output time at a
// cursor is `originSec + (contentX - containerLeft) / pxPerSec * scale`.
//
// `containerTop` is the true content-y of a group's row 0: the root's rows
// start below the ruler (`RULER_HEIGHT + ROW_GAP`), and each nested group's
// rows start at its clip-box top. (The root drop *region*'s rect still
// starts at y=0 so it's the always-containing hit-test floor.)

import { ROW_HEIGHT, ROW_GAP, RULER_HEIGHT, rowTop } from "./timelineLayout.js";
import type { TreeGroup } from "./timelineTree.js";
import type { NodePath } from "./nodePath.js";

export interface DropChild {
  /** Field index within the container's `children` array. */
  index: number;
  path: NodePath;
  /** Content-space px extents of the block. */
  startX: number;
  endX: number;
}

export interface DropRegion {
  path: NodePath;
  /** Content-space rectangle of the container (for cursor hit-testing and
   *  the insertion ghost's vertical extent). */
  left: number;
  top: number;
  width: number;
  height: number;
  /** Window transform back to this container's local output seconds. */
  originSec: number;
  scale: number;
  containerLeft: number;
  /** Sequential children band only (reorder/insert targets). */
  children: DropChild[];
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

function lastIndex(path: NodePath): number {
  return path.length > 0 ? path[path.length - 1].index : 0;
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
      const children: DropChild[] = p.group.blocks
        .filter((b) => !b.isAttachment)
        .sort((a, b) => a.index - b.index)
        .map((b) => ({
          index: lastIndex(b.path),
          path: b.path,
          startX: toX(b.child.timelineStart),
          endX: toX(b.child.timelineEnd),
        }));
      return {
        path: p.group.path,
        left: p.left,
        top: p.regionTop,
        width: p.width,
        height: p.height,
        originSec: p.group.originSec,
        scale: p.group.scale,
        containerLeft: p.left,
        children,
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

/** Insertion slot for cursor X within a region: `k` = before child `k`,
 *  `children.length` = append. Splits each child at its midpoint. */
export function insertionIndexIn(region: DropRegion, x: number): number {
  for (let k = 0; k < region.children.length; k++) {
    const c = region.children[k];
    if (x < (c.startX + c.endX) / 2) return k;
  }
  return region.children.length;
}

/** Content-space X of the insertion ghost for a slot in a region. */
export function insertionXIn(region: DropRegion, slot: number): number {
  const cs = region.children;
  if (cs.length === 0) return region.containerLeft;
  if (slot >= cs.length) return cs[cs.length - 1].endX;
  return cs[slot].startX;
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

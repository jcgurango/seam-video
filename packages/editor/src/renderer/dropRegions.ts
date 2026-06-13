// Flattens the timeline layout tree into content-space "drop regions" — one
// per editable container — so a single drag pass can target any composition,
// not just the root. Each region knows its rectangle (for hit-testing the
// cursor), its window transform (originSec/scale/containerLeft, to convert
// pixels ↔ that container's local output seconds), and its sequential
// children's content-space extents (for the insertion-slot midpoint test).
//
// Geometry invariant: a block's content-x is
//   containerLeft + ((localSec - originSec) / scale) * pxPerSec
// which is exactly the global-timeline mapping (that's why an expansion
// aligns under its composition block). So `contentX / pxPerSec` is global
// output time at every level, and a container's local output time at a
// cursor is `originSec + (contentX - containerLeft) / pxPerSec * scale`.

import { ROW_HEIGHT, ROW_GAP, rowTop } from "./timelineLayout.js";
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

function lastIndex(path: NodePath): number {
  return path.length > 0 ? path[path.length - 1].index : 0;
}

/** Flatten editable containers into drop regions. `rootRect` bounds the root
 *  region (the whole content area below the ruler). Regions are emitted
 *  outermost-first, so a later (deeper) match wins the hit-test. */
export function flattenDropRegions(
  root: TreeGroup,
  pxPerSec: number,
  rootRect: { left: number; top: number; width: number; height: number },
): DropRegion[] {
  const out: DropRegion[] = [];
  const walk = (
    group: TreeGroup,
    containerLeft: number,
    containerTop: number,
    rect: { left: number; top: number; width: number; height: number },
  ) => {
    const toX = (sec: number) =>
      containerLeft + ((sec - group.originSec) / group.scale) * pxPerSec;
    if (group.editable) {
      const children: DropChild[] = group.blocks
        .filter((b) => !b.isAttachment)
        .sort((a, b) => a.index - b.index)
        .map((b) => ({
          index: lastIndex(b.path),
          path: b.path,
          startX: toX(b.child.timelineStart),
          endX: toX(b.child.timelineEnd),
        }));
      out.push({
        path: group.path,
        ...rect,
        originSec: group.originSec,
        scale: group.scale,
        containerLeft,
        children,
      });
    }
    for (const b of group.blocks) {
      if (!b.expansion) continue;
      const left = toX(b.child.timelineStart);
      const width = Math.max(toX(b.child.timelineEnd) - left, 2);
      const top = containerTop + rowTop(b.expansion.topRow);
      const height = b.expansion.group.rowCount * (ROW_HEIGHT + ROW_GAP);
      walk(b.expansion.group, left, top, { left, top, width, height });
    }
  };
  walk(root, 0, rootRect.top, rootRect);
  return out;
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

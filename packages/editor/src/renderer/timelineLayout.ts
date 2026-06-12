// Shared layout primitives for the timeline panel: pixel constants,
// the resolved-child-to-row spec, and the y-coordinate helper. Used
// by both the main TimelinePanel (DesktopTimeline / ChildrenLayer /
// ChildBlockView) and the AnchorLinesLayer overlay. Extracted here so
// AnchorLinesLayer can sit in its own file without importing back into
// TimelinePanel.

import type { ResolvedChild } from "@seam/core";

export const ROW_HEIGHT = 32;
export const ROW_GAP = 2;
export const RULER_HEIGHT = 24;

/** Vertical inset (px) per nesting level applied to nested blocks so they
 *  read as "inside" their parent without breaking x-axis time alignment. */
export const DEPTH_INSET = 2;

/** A laid-out block in the timeline panel: which resolved child it
 *  came from, its index in the (children-then-attachments) array, and
 *  the row it was packed into. (The recursive layout in `timelineTree`
 *  uses its own `TreeBlock`; this remains for `AnchorLinesLayer`'s
 *  root-level index→row map.) */
export interface ChildBlock {
  child: ResolvedChild;
  index: number;
  row: number;
  isAttachment: boolean;
}

/** Top-edge y-coordinate (in container pixels) of a block on the given
 *  row, measured from the timeline content top (below the ruler). Nested
 *  groups measure from their own container with `rowTop` instead. */
export function rowYTop(row: number): number {
  return RULER_HEIGHT + ROW_GAP + row * (ROW_HEIGHT + ROW_GAP);
}

/** Row offset (px) within a group's own container — no ruler, since
 *  nested groups render inside a clip box rather than the ruler'd root. */
export function rowTop(row: number): number {
  return row * (ROW_HEIGHT + ROW_GAP);
}

// Shared layout primitives for the timeline panel: pixel constants,
// the resolved-child-to-row spec, and the y-coordinate helper. Used
// by both the main TimelinePanel (DesktopTimeline / MobileTimeline /
// ChildrenLayer / ChildBlockView) and the AnchorLinesLayer overlay.
// Extracted here so AnchorLinesLayer can sit in its own file without
// importing back into TimelinePanel.

import type { ResolvedChild } from "@seam/core";

export const ROW_HEIGHT = 32;
export const ROW_GAP = 2;
export const RULER_HEIGHT = 24;

/** A laid-out block in the timeline panel: which resolved child it
 *  came from, its index in the (children-then-attachments) array, and
 *  the row it was packed into. */
export interface ChildBlock {
  child: ResolvedChild;
  index: number;
  row: number;
  isAttachment: boolean;
}

/** Top-edge y-coordinate (in container pixels) of a block on the
 *  given row. */
export function rowYTop(row: number): number {
  return RULER_HEIGHT + ROW_GAP + row * (ROW_HEIGHT + ROW_GAP);
}

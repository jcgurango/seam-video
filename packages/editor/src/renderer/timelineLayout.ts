// Shared layout primitives for the timeline panel: pixel constants,
// the resolved-child-to-row spec, and the y-coordinate helper. Used
// by both the main TimelinePanel (DesktopTimeline / ChildrenLayer /
// ChildBlockView) and the AnchorLinesLayer overlay. Extracted here so
// AnchorLinesLayer can sit in its own file without importing back into
// TimelinePanel.


export const ROW_HEIGHT = 32;
/** Gap under each row. It holds the run's dotted underline (the z-order drag
 *  handle) and, during a drag, is the "new run here" drop strip. */
export const ROW_GAP = 8;
export const RULER_HEIGHT = 24;

/** Vertical inset (px) per nesting level applied to nested blocks so they
 *  read as "inside" their parent without breaking x-axis time alignment. */
export const DEPTH_INSET = 2;

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

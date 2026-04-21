import type { Clip, SeamFile, ResolvedTimeline, ResolvedChild } from "@seam/core";

export type View =
  | { type: "root" }
  | { type: "clip"; rootIndex: number; sourceDuration: number };

/** Returns the document the player should render for the current view. */
export function getViewDocument(doc: SeamFile, view: View): SeamFile {
  if (view.type === "root") return doc;

  const target = doc.children[view.rootIndex];
  if (target?.type !== "clip") return doc; // fallback if view went stale

  // Strip trim so the full source is visible; player plays the whole source,
  // the clip-view panel overlays trim handles at the real in/out.
  const { duration: _d, in: _i, out: _o, ...base } = target as Clip;
  const expanded: Clip = { ...base, in: 0, out: view.sourceDuration };
  return { type: "composition", children: [expanded] };
}

/** Translate a view-time back to a time in the parent (root) timeline. */
export function translateTimeOnExit(
  doc: SeamFile,
  resolvedRoot: ResolvedTimeline,
  view: View,
  viewTime: number
): number {
  if (view.type !== "clip") return viewTime;

  const target = doc.children[view.rootIndex];
  const resolvedTarget = resolvedRoot.children[view.rootIndex];
  if (
    target?.type !== "clip" ||
    !resolvedTarget ||
    resolvedTarget.type !== "clip"
  ) {
    return 0;
  }

  const parentStart = resolvedTarget.timelineStart;
  const parentEnd = resolvedTarget.timelineEnd;
  const { in: clipIn, out: clipOut, speed = 1 } = target;

  // Clamp viewTime into the trim window
  const clamped = Math.max(clipIn, Math.min(clipOut, viewTime));
  const offsetInParent = (clamped - clipIn) / speed;
  return Math.max(parentStart, Math.min(parentEnd, parentStart + offsetInParent));
}

/** Returns the initial time to show when entering a clip view. */
export function timeOnEnter(
  doc: SeamFile,
  resolvedRoot: ResolvedTimeline,
  rootIndex: number,
  currentParentTime: number
): number {
  const target = doc.children[rootIndex];
  const resolvedTarget = resolvedRoot.children[rootIndex];
  if (
    target?.type !== "clip" ||
    !resolvedTarget ||
    resolvedTarget.type !== "clip"
  ) {
    return 0;
  }
  const parentStart = resolvedTarget.timelineStart;
  const { in: clipIn, speed = 1 } = target;
  // If the parent playhead is inside this clip, translate to source time
  if (
    currentParentTime >= parentStart &&
    currentParentTime <= resolvedTarget.timelineEnd
  ) {
    return clipIn + (currentParentTime - parentStart) * speed;
  }
  // Otherwise start at the clip's current `in`
  return clipIn;
}

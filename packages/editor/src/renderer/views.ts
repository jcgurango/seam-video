import type { Clip, Composition, SeamFile, ResolvedTimeline } from "@seam/core";

export type View =
  | { type: "root" }
  | { type: "clip"; rootIndex: number; sourceDuration: number }
  | { type: "composition"; rootIndex: number };

/** Returns the document the player should render for the current view. */
export function getViewDocument(doc: SeamFile, view: View): SeamFile {
  if (view.type === "root") return doc;

  const target = doc.children[view.rootIndex];
  if (!target) return doc;

  if (view.type === "clip") {
    if (target.type !== "clip") return doc;
    // Strip trim so the full source is visible; player plays the whole
    // source, the clip-view panel overlays trim handles at the real in/out.
    const { duration: _d, in: _i, out: _o, ...base } = target as Clip;
    const expanded: Clip = { ...base, in: 0, out: view.sourceDuration };
    return { type: "composition", children: [expanded] };
  }

  // composition view: show the target's full inner timeline by stripping its
  // parent-level windowing/stretch fields, then render it as the root.
  if (target.type !== "composition") return doc;
  const {
    in: _i,
    out: _o,
    flex: _f,
    overflow: _ov,
    underflow: _uf,
    ...rest
  } = target as Composition & { flex?: number };
  return rest as SeamFile;
}

/** Translate a view-time back to a time in the parent (root) timeline. */
export function translateTimeOnExit(
  doc: SeamFile,
  resolvedRoot: ResolvedTimeline,
  view: View,
  viewTime: number
): number {
  if (view.type === "root") return viewTime;

  const target = doc.children[view.rootIndex];
  const resolvedTarget = resolvedRoot.children[view.rootIndex];
  if (!target || !resolvedTarget) return 0;

  if (view.type === "clip") {
    if (target.type !== "clip" || resolvedTarget.type !== "clip") return 0;
    const parentStart = resolvedTarget.timelineStart;
    const parentEnd = resolvedTarget.timelineEnd;
    const { in: clipIn, out: clipOut, speed = 1 } = target;
    const clamped = Math.max(clipIn, Math.min(clipOut, viewTime));
    const offsetInParent = (clamped - clipIn) / speed;
    return Math.max(parentStart, Math.min(parentEnd, parentStart + offsetInParent));
  }

  // composition view: viewTime is on the target's full (unwindowed) inner
  // timeline. Map back through its window and speed.
  if (target.type !== "composition" || resolvedTarget.type !== "composition") {
    return 0;
  }
  const parentStart = resolvedTarget.timelineStart;
  const parentEnd = resolvedTarget.timelineEnd;
  const compIn = target.in ?? 0;
  const speed = resolvedTarget.speed;
  const compOut = compIn + (parentEnd - parentStart) * speed;
  const clamped = Math.max(compIn, Math.min(compOut, viewTime));
  const offsetInParent = (clamped - compIn) / speed;
  return Math.max(parentStart, Math.min(parentEnd, parentStart + offsetInParent));
}

/** Returns the initial time to show when entering a view. */
export function timeOnEnter(
  doc: SeamFile,
  resolvedRoot: ResolvedTimeline,
  rootIndex: number,
  currentParentTime: number
): number {
  const target = doc.children[rootIndex];
  const resolvedTarget = resolvedRoot.children[rootIndex];
  if (!target || !resolvedTarget) return 0;

  if (target.type === "clip" && resolvedTarget.type === "clip") {
    const parentStart = resolvedTarget.timelineStart;
    const { in: clipIn, speed = 1 } = target;
    if (
      currentParentTime >= parentStart &&
      currentParentTime <= resolvedTarget.timelineEnd
    ) {
      return clipIn + (currentParentTime - parentStart) * speed;
    }
    return clipIn;
  }

  if (target.type === "composition" && resolvedTarget.type === "composition") {
    const parentStart = resolvedTarget.timelineStart;
    const parentEnd = resolvedTarget.timelineEnd;
    const compIn = target.in ?? 0;
    const speed = resolvedTarget.speed;
    if (currentParentTime >= parentStart && currentParentTime <= parentEnd) {
      return compIn + (currentParentTime - parentStart) * speed;
    }
    return compIn;
  }

  return 0;
}

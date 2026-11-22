// Where a "new run" drop lands once the dragged nodes have left.
//
// The drag is aimed at the timeline as it looks BEFORE the move, but lifting
// nodes out of a run ripples whatever followed them. Dragging A out of
// `[A, B, C]` onto C's start should make the new run start with C *in the
// result* — where C ends up, not where it was.
//
// So the drop time is carried from the before-layout into the after-layout
// by the node edge the cursor sits on or after: the latest surviving edge
// (a start or an end) at or before the drop time moves by some amount when
// the nodes leave, and the drop time moves with it. A drop before every edge
// keeps its time.

import type { Seam, BinEntry, Composition, ResolvedChild, SeamFile } from "@seam/core";
import { compileDocument } from "./compile.js";
import {
  adjustPathAfterRemovals,
  getCompAtPath,
  pathKey,
  removeNodesAtPaths,
  type NodePath,
} from "./nodePath.js";

/** A container's children on its own un-windowed, un-cropped inner timeline
 *  (1:1 with the authored array), or null if it can't be resolved. */
function resolveContainer(
  seam: Seam,
  doc: SeamFile,
  containerPath: NodePath,
  rootBin: BinEntry[],
): ResolvedChild[] | null {
  const comp = getCompAtPath(doc, containerPath);
  if (!comp) return null;
  try {
    const synthetic: Composition = {
      type: "composition",
      children: comp.children ?? [],
      ...(rootBin.length ? { bin: rootBin } : {}),
    };
    const { doc: compiled } = compileDocument(seam, synthetic, { runScripts: false });
    return seam.resolveComposition(compiled as Composition, { uncropped: true }).children;
  } catch {
    return null;
  }
}

/**
 * `time` (local seconds in the container at `containerPath`, read off the
 * current layout) translated to the layout that results from lifting the
 * nodes at `moved` out of the document.
 */
export function timeAfterLift(
  seam: Seam,
  doc: SeamFile,
  moved: NodePath[],
  containerPath: NodePath,
  time: number,
): number {
  const rootBin = doc.bin ?? [];
  const before = resolveContainer(seam, doc, containerPath, rootBin);
  if (!before) return time;
  const lifted = removeNodesAtPaths(doc, moved, false);
  const after = resolveContainer(seam, lifted, adjustPathAfterRemovals(containerPath, moved), rootBin);
  if (!after) return time;

  const key = pathKey(containerPath);
  const gone = new Set<number>();
  for (const p of moved) {
    if (p.length > 0 && pathKey(p.slice(0, -1)) === key) gone.add(p[p.length - 1].index);
  }

  // The latest surviving edge at or before `time`, and how far it moves.
  let bestPre = -Infinity;
  let shift = 0;
  let j = 0;
  for (let i = 0; i < before.length; i++) {
    if (gone.has(i)) continue;
    const pre = before[i];
    const post = after[j++];
    if (!post) break;
    for (const [a, b] of [
      [pre.timelineStart, post.timelineStart],
      [pre.timelineEnd, post.timelineEnd],
    ]) {
      if (a <= time + 1e-6 && a > bestPre) {
        bestPre = a;
        shift = b - a;
      }
    }
  }
  return Math.max(0, Math.round((time + shift) * 1e6) / 1e6);
}

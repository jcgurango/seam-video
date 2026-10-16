// Playhead follow-through for deletes: when a sequential item is removed,
// everything after it slides left by its length, so the playhead should
// slide with it to keep showing the same content.
//
// Per deleted item (its absolute [start, end] measured on the resolved
// timeline *before* the delete):
//   • playhead before `start` → untouched;
//   • otherwise → move back by `end − start` (clamped to `start`, so a
//     playhead that sat on the deleted item lands where its successor now
//     begins).
// Gated by whether the shift is visible from the playhead's position: walk
// up from the deleted item; the nearest enclosing composition with a FIXED
// output length (`duration`, `in` + `out`, or both ends anchored) absorbs
// the shrink — content
// after it doesn't move — so we bail unless the playhead is currently on
// that composition. With no fixed-length ancestor the whole chain shortens
// and the playhead moves regardless. Deliberately naive: no check of what's
// actually rendered under the playhead, no transition/overlap accounting.
//
// Only sequential `children` shift siblings; deleting an attachment itself
// never moves the playhead, but deleting children *inside* an attached
// composition does (the attachment shrinks, or its content shifts).
// Bin-rooted paths are skipped (per-reference time is ambiguous). Multiple
// deletions are summed from one snapshot.
//
// Pure — no React, no platform deps.

import type { ResolvedTimeline, SeamFile } from "@seam/core";
import { getNodeAtPath, isPrefix, type NodePath } from "./nodePath.js";
import { globalSpanOf } from "./resolveLocal.js";

const EPS = 1e-6;

/** A composition whose output length is pinned: an explicit `duration`, a
 *  full `in` + `out` window, or (attachments) both ends anchored. */
function hasFixedDuration(doc: SeamFile, path: NodePath): boolean {
  const node = getNodeAtPath(doc, path);
  if (!node || node.type !== "composition") return false;
  return (
    node.duration != null ||
    (node.in != null && node.out != null) ||
    (node.start != null && node.end != null)
  );
}

/** The playhead position after deleting the nodes at `paths`, given the
 *  resolved timeline (editor timeline — children 1:1 with the authored
 *  doc) and the playhead *before* the delete. Returns `currentTime`
 *  unchanged when nothing qualifies. */
export function playheadAfterDelete(
  resolvedRoot: ResolvedTimeline,
  doc: SeamFile,
  paths: NodePath[],
  currentTime: number,
): number {
  let shift = 0;
  let floor = Infinity;

  for (const path of paths) {
    if (path.length === 0) continue;
    const last = path[path.length - 1];
    if (last.field !== "children") continue;
    // An ancestor is being deleted too — its span already covers this one.
    if (paths.some((p) => p !== path && p.length < path.length && isPrefix(p, path))) {
      continue;
    }
    const span = globalSpanOf(resolvedRoot, doc, path);
    if (!span) continue;
    if (currentTime < span.start - EPS) continue;

    // Nearest fixed-length ancestor decides visibility.
    let visible = true;
    for (let depth = path.length - 1; depth >= 1; depth--) {
      const ancestor = path.slice(0, depth);
      if (!hasFixedDuration(doc, ancestor)) continue;
      const aSpan = globalSpanOf(resolvedRoot, doc, ancestor);
      visible =
        aSpan != null &&
        currentTime >= aSpan.start - EPS &&
        currentTime < aSpan.end - EPS;
      break;
    }
    if (!visible) continue;

    shift += span.end - span.start;
    floor = Math.min(floor, span.start);
  }

  if (shift <= 0) return currentTime;
  return Math.max(floor, currentTime - shift);
}

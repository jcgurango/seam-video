// Bracket tool (toolbar): align an edge of each secondary to the primary —
// or, with only a primary selected, align the primary's edge to the playhead.
//
// Selection semantics mirror the attach tool — the first selection is the
// primary, the rest are secondaries. "Bracket start" moves each subject's
// *start* edge, "Bracket end" its *end* edge. With secondaries, only they
// are edited and the target time depends on the relationship:
//   • the secondary is attached to the primary (its `start` anchors the
//     primary's id, same container) → match the SAME
//     edge of the primary (start↔start / end↔end);
//   • otherwise → legato: the bracketed edge meets the primary's OPPOSITE
//     edge (bracket end → primary's start, bracket start → primary's end).
// With no secondaries, the primary itself is the subject and the target is
// the playhead.
//
// How the edge moves, per subject:
//   • START edge of a node with a `start` (it heads a run) → shift its
//     `offset` by the delta: the node (and the run behind it) moves, the
//     anchor itself stays put;
//   • START edge of a node without `start` (a run member, or the implicit
//     head at index 0) → its position belongs to the run, so it is trimmed
//     instead: the timeline's left drag-handle logic (`resizeChild`) cuts
//     `in`/`duration` by the delta (rate-aware);
//   • END edge → always trimmed via `resizeChild`'s right handle
//     (`out`/`duration`) so the edge lands on the target.
//
// All deltas are measured against the initial resolved timeline (snapshot
// semantics — sequential-sibling shifts from one edit don't re-target the
// next) and expressed in each subject's container-local output time, so
// primary and secondaries may live in different containers at any depth.
// Bin-rooted selections are skipped (their per-reference time is ambiguous).
//
// Pure transformations on a SeamFile — no React, no platform deps.

import { startAnchorId } from "@seam/core";
import type { ResolvedTimeline, SeamFile } from "@seam/core";
import {
  editContainer,
  getNodeAtPath,
  parsePath,
  pathKey,
  splitLast,
  type NodePath,
} from "./nodePath.js";
import { descendToContainer, globalSpanOf } from "./resolveLocal.js";
import { resizeChild } from "./resizeTool.js";
import { shiftOffsets } from "./runEdit.js";

const EPS = 1e-6;

/** Move one edge of the node at `path` to `targetGlobal` (global output
 *  seconds): offset shift for the start of a run head, trim otherwise.
 *  Deltas are measured on the initial `doc`/`resolvedRoot` snapshot; the
 *  edit lands on `working`. Returns `working` unchanged when the path
 *  doesn't resolve or the edge is already in place. */
function bracketEdge(
  working: SeamFile,
  doc: SeamFile,
  resolvedRoot: ResolvedTimeline,
  rootBin: NonNullable<SeamFile["bin"]>,
  path: NodePath,
  side: "start" | "end",
  targetGlobal: number,
): SeamFile {
  const split = splitLast(path);
  if (!split) return working;
  const { parent: containerPath, last } = split;
  const node = getNodeAtPath(doc, path);
  if (!node) return working;

  // Map the target into the node's container-local output time and read the
  // node's resolved edge there.
  const desc = descendToContainer(resolvedRoot, doc, containerPath, targetGlobal);
  if (!desc) return working;
  const rNode = desc.rContainer.children[last.index];
  if (!rNode) return working;
  const edge = side === "start" ? rNode.timelineStart : rNode.timelineEnd;
  const delta = desc.localTime - edge;
  if (Math.abs(delta) < EPS) return working;

  if (side === "start" && node.start != null) {
    return editContainer(working, containerPath, rootBin, (sub) => ({
      ...sub,
      children: shiftOffsets(sub.children ?? [], new Set([last.index]), delta),
    }));
  }
  return editContainer(working, containerPath, rootBin, (sub) =>
    resizeChild(sub, last.index, side === "start" ? "left" : "right", delta),
  );
}

/**
 * Bracket tool. With secondaries, aligns each secondary's edge to the
 * primary; with only a primary, aligns the primary's edge to the playhead
 * (`currentTime`, global output seconds). Returns the edited document, or
 * null when nothing applied (bin-rooted/path-less primary, unresolvable
 * spans, or every delta was already zero).
 */
export function applyBracket(
  doc: SeamFile,
  resolvedRoot: ResolvedTimeline,
  currentTime: number,
  primaryKey: string,
  secondaryKeys: string[],
  side: "start" | "end",
): SeamFile | null {
  const primaryPath = parsePath(primaryKey);
  if (primaryPath.length === 0 || primaryPath.some((s) => s.field === "bin")) {
    return null;
  }
  const primary = getNodeAtPath(doc, primaryPath);
  if (!primary) return null;
  const rootBin = doc.bin ?? [];

  // Primary only: bracket the primary itself against the playhead.
  if (secondaryKeys.length === 0) {
    const next = bracketEdge(
      doc,
      doc,
      resolvedRoot,
      rootBin,
      primaryPath,
      side,
      currentTime,
    );
    return next !== doc ? next : null;
  }

  const primarySpan = globalSpanOf(resolvedRoot, doc, primaryPath);
  if (!primarySpan) return null;
  const primaryId = primary.id;
  const primaryContainerKey = pathKey(primaryPath.slice(0, -1));

  let working = doc;
  for (const key of secondaryKeys) {
    const p = parsePath(key);
    if (p.length === 0 || p.some((s) => s.field === "bin")) continue;
    if (pathKey(p) === primaryKey) continue;
    const node = getNodeAtPath(doc, p);
    if (!node) continue;

    // Attached case only when the anchor id can actually resolve to the
    // primary — anchors are sibling-scoped, so require the same container.
    const attachedToPrimary =
      primaryId != null &&
      pathKey(p.slice(0, -1)) === primaryContainerKey &&
      startAnchorId(node.start) === primaryId;
    const targetGlobal = attachedToPrimary
      ? side === "start"
        ? primarySpan.start
        : primarySpan.end
      : side === "start"
        ? primarySpan.end
        : primarySpan.start;

    working = bracketEdge(
      working,
      doc,
      resolvedRoot,
      rootBin,
      p,
      side,
      targetGlobal,
    );
  }
  return working !== doc ? working : null;
}

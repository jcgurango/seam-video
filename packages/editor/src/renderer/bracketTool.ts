// Bracket tool (toolbar): align an edge of each secondary to the primary —
// or, with only a primary selected, align the primary's edge to the playhead.
//
// Selection semantics mirror the attach tool — the first selection is the
// primary, the rest are secondaries. "Bracket start" moves each subject's
// *start* edge, "Bracket end" its *end* edge. With secondaries, only they
// are edited and the target time depends on the relationship:
//   • the secondary is attached to the primary (one of its `start`/`end`
//     anchors references the primary's id, sibling scope) → match the SAME
//     edge of the primary (start↔start / end↔end);
//   • otherwise → legato: the bracketed edge meets the primary's OPPOSITE
//     edge (bracket end → primary's start, bracket start → primary's end).
// With no secondaries, the primary itself is the subject and the target is
// the playhead.
//
// How the edge moves follows one invariant, per subject:
//   • the bracketed side has a `start`/`end` anchor spec → shift that spec's
//     `offset` by the delta (the anchor point itself stays put);
//   • no spec on that side → reuse the timeline drag-handle logic
//     (`resizeChild`), trimming `in`/`out`/`duration` so the floating edge
//     lands on the target (rate-aware for `speed`/`duration` overrides).
//
// All deltas are measured against the initial resolved timeline (snapshot
// semantics — sequential-sibling shifts from one edit don't re-target the
// next) and expressed in each subject's container-local output time, so
// primary and secondaries may live in different containers at any depth.
// Bin-rooted selections are skipped (their per-reference time is ambiguous).
//
// Pure transformations on a SeamFile — no React, no platform deps.

import type {
  Child,
  ResolvedChild,
  ResolvedTimeline,
  SeamFile,
  TimeAnchor,
} from "@seam/core";
import { fmtPct, fmtSec, naturalDurOf, parsePct } from "./anchorEdit.js";
import {
  editContainer,
  getNodeAtPath,
  parsePath,
  pathKey,
  splitLast,
  updateNodeAtPath,
  type NodePath,
} from "./nodePath.js";
import { descendToContainer } from "./resolveLocal.js";
import { resizeChild } from "./resizeTool.js";

const EPS = 1e-6;

interface Span {
  start: number;
  end: number;
}

/** The node's resolved [timelineStart, timelineEnd] mapped up into GLOBAL
 *  output time, walking the enclosing compositions' inner→output transforms
 *  (`parent = timelineStart + (inner − in) / speed` per level). Null for
 *  bin-rooted paths or when any level doesn't resolve 1:1. */
function globalSpanOf(
  resolvedRoot: ResolvedTimeline,
  doc: SeamFile,
  path: NodePath,
): Span | null {
  let rNode: { children: ResolvedChild[] } = resolvedRoot;
  let aNode: { children?: Child[]; attachments?: Child[] } = doc;
  let toGlobal = (t: number) => t;
  for (let i = 0; i < path.length; i++) {
    const seg = path[i];
    if (seg.field === "bin") return null;
    const aChildren = aNode.children ?? [];
    const flat =
      seg.field === "children" ? seg.index : aChildren.length + seg.index;
    const rChild = rNode.children[flat];
    if (!rChild) return null;
    if (i === path.length - 1) {
      return {
        start: toGlobal(rChild.timelineStart),
        end: toGlobal(rChild.timelineEnd),
      };
    }
    const aChild =
      seg.field === "children"
        ? aChildren[seg.index]
        : (aNode.attachments ?? [])[seg.index];
    if (
      !aChild ||
      aChild.type !== "composition" ||
      rChild.type !== "composition"
    ) {
      return null;
    }
    const start = rChild.timelineStart;
    const speed = rChild.speed;
    const inVal = aChild.in ?? 0;
    const prev = toGlobal;
    toGlobal = (t) => prev(start + (t - inVal) / speed);
    rNode = rChild;
    aNode = aChild;
  }
  return null;
}

/** Shift an anchor spec's offset by `deltaSec` (container-local output
 *  seconds), preserving the authored unit. A %-offset resolves against the
 *  attachment's natural duration; when that's unknown (0) the offset falls
 *  back to seconds so the shift isn't silently lost. No side clamping —
 *  unlike the drag path, bracketing legitimately crosses zero. */
function shiftOffset(
  spec: TimeAnchor,
  deltaSec: number,
  natDur: number,
): TimeAnchor {
  if (typeof spec.offset === "string" && natDur > 0) {
    return { ...spec, offset: fmtPct(parsePct(spec.offset) + deltaSec / natDur) };
  }
  const oldSec =
    typeof spec.offset === "string"
      ? parsePct(spec.offset) * natDur
      : spec.offset ?? 0;
  return { ...spec, offset: fmtSec(oldSec + deltaSec) };
}

/** Move one edge of the node at `path` to `targetGlobal` (global output
 *  seconds), applying the offset-vs-resize invariant. Deltas are measured on
 *  the initial `doc`/`resolvedRoot` snapshot; the edit lands on `working`.
 *  Returns `working` unchanged when the path doesn't resolve or the edge is
 *  already in place. */
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
  const flat =
    last.field === "children"
      ? last.index
      : (desc.aContainer.children ?? []).length + last.index;
  const rNode = desc.rContainer.children[flat];
  if (!rNode) return working;
  const edge = side === "start" ? rNode.timelineStart : rNode.timelineEnd;
  const delta = desc.localTime - edge;
  if (Math.abs(delta) < EPS) return working;

  const spec = (node as { start?: TimeAnchor; end?: TimeAnchor })[side];
  if (spec != null) {
    const newSpec = shiftOffset(spec, delta, naturalDurOf(node));
    return updateNodeAtPath(working, path, (n) => {
      return { ...n, [side]: newSpec } as Child;
    });
  }
  return editContainer(working, containerPath, rootBin, (sub) =>
    resizeChild(
      sub,
      last.index,
      last.field === "attachments",
      side === "start" ? "left" : "right",
      delta,
    ),
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
  const primaryId = (primary as { id?: string }).id;
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
    const specs = node as { start?: TimeAnchor; end?: TimeAnchor };
    const attachedToPrimary =
      primaryId != null &&
      pathKey(p.slice(0, -1)) === primaryContainerKey &&
      (specs.start?.anchor === primaryId || specs.end?.anchor === primaryId);
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

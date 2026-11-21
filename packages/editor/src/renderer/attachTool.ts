// Attach tool: anchor the secondaries of a selection to the primary at the
// playhead. Each secondary becomes the head of its own run in the primary's
// container, with `start` pointing at the primary.
//
// Pure transformations on a SeamFile — no React, no platform deps.

import { clipOut, formatStart, loopLocalTime } from "@seam/core";
import type { Child, ResolvedChild, ResolvedTimeline, SeamFile, Start } from "@seam/core";
import {
  getCompAtPath,
  getNodeAtPath,
  isPrefix,
  moveNodesTracked,
  parsePath,
  pathKey,
  updateNodeAtPath,
} from "./nodePath.js";
import { descendToContainer } from "./resolveLocal.js";
import { withPlacement } from "./runEdit.js";

/** Collect every `id` appearing anywhere in the document tree. */
function collectAllIds(doc: SeamFile): Set<string> {
  const out = new Set<string>();
  const visit = (child: Child) => {
    const id = (child as { id?: string }).id;
    if (id != null) out.add(id);
    if (child.type === "composition" || child.type === "map") {
      (child.children ?? []).forEach(visit);
    }
  };
  visit(doc);
  for (const entry of doc.bin ?? []) entry.children.forEach(visit);
  return out;
}

/** Pick a unique id for an attach target, starting from `base`. */
function pickFreshId(existingIds: Set<string>, base: string): string {
  if (!existingIds.has(base)) return base;
  let i = 2;
  while (existingIds.has(`${base}_${i}`)) i++;
  return `${base}_${i}`;
}

/**
 * The placement that puts a node's start at local time `t`, anchored to
 * `primary` (whose id is `id`).
 *
 * Types with a real source axis (clip / audio / composition) anchor to the
 * **source** moment under `t` (`"id@<sec>"`) — it survives later trims — with
 * no offset. Every other type has no content axis: the anchor is the bare id
 * (its start) and the distance to `t` goes into `offset`.
 */
export function placementAt(
  id: string,
  primary: Child,
  resolved: ResolvedChild,
  t: number,
): { start: Start; offset?: number } {
  if (
    (primary.type === "clip" || primary.type === "audio") &&
    (resolved.type === "clip" || resolved.type === "audio")
  ) {
    // A looping clip replays its range — map into the current cycle.
    const sourceTime =
      resolved.sourceIn +
      loopLocalTime(resolved.loop, t - resolved.timelineStart) * resolved.speed;
    const clamped = Math.max(primary.in, Math.min(clipOut(primary), sourceTime));
    return { start: sourcePoint(id, clamped) };
  }
  if (primary.type === "composition" && resolved.type === "composition") {
    const compIn = primary.in ?? 0;
    // Resolved duration is in OUTPUT seconds; the window on the inner
    // (source) timeline is `duration * speed` long.
    const compOut = compIn + resolved.duration * resolved.speed;
    const sourceTime =
      compIn + loopLocalTime(resolved.loop, t - resolved.timelineStart) * resolved.speed;
    return { start: sourcePoint(id, Math.max(compIn, Math.min(compOut, sourceTime))) };
  }
  const offset = Math.round((t - resolved.timelineStart) * 1000) / 1000;
  return { start: id, ...(offset !== 0 ? { offset } : {}) };
}

function sourcePoint(id: string, seconds: number): Start {
  return formatStart({
    kind: "node",
    id,
    point: { kind: "source", value: Math.round(seconds * 1000) / 1000 },
  });
}

/**
 * Attach tool (toolbar). The first selection is the primary; the rest are
 * secondaries. Each secondary is lifted out of wherever it is (its run's
 * remainder keeps its place — see `runEdit`) and re-inserted at the END of
 * the **primary's container** (on top) as the head of its own run, starting
 * at the playhead and anchored to the primary there (see `placementAt`).
 * Secondaries in another container are pulled in.
 *
 * Selections are path keys. `resolvedRoot` is the editor's resolved timeline
 * (used to map the global playhead into the primary's container). Returns
 * null when inapplicable (no secondaries, bin-rooted/path-less primary, or
 * the primary can't be resolved). The moved nodes' new keys come back so the
 * caller can keep them selected.
 */
export function applyAttach(
  doc: SeamFile,
  resolvedRoot: ResolvedTimeline,
  currentTime: number,
  primaryKey: string,
  secondaryKeys: string[],
): { doc: SeamFile; primaryKey: string; secondaryKeys: string[] } | null {
  if (secondaryKeys.length === 0) return null;
  const primaryPath = parsePath(primaryKey);
  if (primaryPath.length === 0 || primaryPath.some((s) => s.field === "bin")) {
    return null;
  }
  const containerPath = primaryPath.slice(0, -1);
  const containerKey = pathKey(containerPath);

  const primary = getNodeAtPath(doc, primaryPath);
  if (!primary) return null;
  // Map the playhead into the primary's container-local time, then read the
  // primary's resolved node there.
  const desc = descendToContainer(resolvedRoot, doc, containerPath, currentTime);
  if (!desc) return null;
  const primaryIndex = primaryPath[primaryPath.length - 1].index;
  const resolvedPrimary = desc.rContainer.children[primaryIndex];
  if (!resolvedPrimary) return null;

  // Valid secondaries: non-bin, not the primary's container, not an
  // ancestor-or-equal of the primary.
  const secPaths = secondaryKeys
    .map(parsePath)
    .filter(
      (p) =>
        p.length > 0 &&
        !p.some((s) => s.field === "bin") &&
        !isPrefix(p, primaryPath) &&
        pathKey(p) !== containerKey,
    );
  if (secPaths.length === 0) return null;

  // The primary needs an id to be referenced (adding a field shifts no paths).
  let primaryId = (primary as { id?: string }).id;
  let working = doc;
  if (primaryId == null) {
    primaryId = pickFreshId(collectAllIds(doc), "anchor");
    const id = primaryId;
    working = updateNodeAtPath(doc, primaryPath, (n) => ({ ...n, id }) as Child);
  }
  const placement = placementAt(primaryId, primary, resolvedPrimary, desc.localTime);

  const end = (getCompAtPath(working, containerPath)?.children ?? []).length;
  const moved = moveNodesTracked(working, secPaths, containerPath, end);
  if (!moved) return null;
  // They landed as one contiguous run; make each its own anchored head.
  let next = moved.doc;
  for (const p of moved.paths) {
    next = updateNodeAtPath(next, p, (n) => withPlacement(n, placement.start, placement.offset));
  }
  // The primary's own index shifts down by the secondaries lifted before it.
  let newPrimaryIndex = primaryIndex;
  for (const p of secPaths) {
    if (pathKey(p.slice(0, -1)) === containerKey && p[p.length - 1].index < primaryIndex) {
      newPrimaryIndex -= 1;
    }
  }
  const containerAfter = moved.paths[0].slice(0, -1);
  return {
    doc: next,
    primaryKey: pathKey([...containerAfter, { field: "children", index: newPrimaryIndex }]),
    secondaryKeys: moved.paths.map(pathKey),
  };
}

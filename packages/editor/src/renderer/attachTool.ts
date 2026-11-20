// Attach tool: anchor the secondaries of a selection to the primary WITHOUT
// moving them. Each secondary becomes the head of its own run in the
// primary's container, with `start` pointing at a point on the primary
// (the playhead, kept inside the secondary's own span) and `offset` making
// up the distance to where the secondary already sits.
//
// Pure transformations on a SeamFile — no React, no platform deps.

import {
  clipOut,
  clipSourceTime,
  formatStart,
  loopLocalTime,
  resolvedPlayStart,
  resolvedSignedRate,
} from "@seam/core";
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
import { descendToContainer, globalSpanOf } from "./resolveLocal.js";
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
 * The anchor onto `primary` (whose id is `id`) for local time `t`, plus the
 * time that anchor resolves to.
 *
 * Types with a real source axis (clip / audio / composition) anchor to the
 * **source** moment under `t` (`"id@<sec>"`, clamped to what the primary
 * plays) — it survives later trims. Every other type has no content axis:
 * the anchor is the bare id, i.e. the primary's start, whatever `t` is.
 */
export function anchorAt(
  id: string,
  primary: Child,
  resolved: ResolvedChild,
  t: number,
): { start: Start; pointTime: number } {
  if (
    (primary.type === "clip" || primary.type === "audio") &&
    (resolved.type === "clip" || resolved.type === "audio")
  ) {
    // A looping clip replays its range — map into the current cycle.
    // (`clipSourceTime` handles a reversed clip, whose source runs down.)
    const sourceTime = clipSourceTime(
      resolved,
      loopLocalTime(resolved.loop, t - resolved.timelineStart),
    );
    const out = clipOut(primary);
    const clamped = round3(
      Math.max(Math.min(primary.in, out), Math.min(Math.max(primary.in, out), sourceTime)),
    );
    return {
      start: sourcePoint(id, clamped),
      pointTime:
        resolved.timelineStart +
        (clamped - resolvedPlayStart(resolved)) / resolvedSignedRate(resolved),
    };
  }
  if (primary.type === "composition" && resolved.type === "composition") {
    const compIn = primary.in ?? 0;
    // Resolved duration is in OUTPUT seconds; the window on the inner
    // (source) timeline is `duration * speed` long.
    const compOut = compIn + resolved.duration * resolved.speed;
    const sourceTime =
      compIn + loopLocalTime(resolved.loop, t - resolved.timelineStart) * resolved.speed;
    const clamped = round3(Math.max(compIn, Math.min(compOut, sourceTime)));
    return {
      start: sourcePoint(id, clamped),
      pointTime: resolved.timelineStart + (clamped - compIn) / resolved.speed,
    };
  }
  return { start: id, pointTime: resolved.timelineStart };
}

const round3 = (n: number) => Math.round(n * 1000) / 1000;

function sourcePoint(id: string, seconds: number): Start {
  return formatStart({
    kind: "node",
    id,
    point: { kind: "source", value: seconds },
  });
}

/**
 * Attach tool (toolbar). The first selection is the primary; the rest are
 * secondaries. Each secondary is lifted out of wherever it is (its run's
 * remainder keeps its place — see `runEdit`) and re-inserted at the END of
 * the **primary's container** (on top) as the head of its own run, anchored
 * to the primary — and it **stays where it is** on the timeline:
 *
 *   • the anchor point is the playhead, pulled inside the secondary's own
 *     span when the playhead is before or past it (and inside what the
 *     primary plays — see `anchorAt`);
 *   • `offset` is the distance from that point back to the secondary's
 *     current start.
 *
 * Secondaries in another container are pulled in (their position is carried
 * across in global time).
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
  const id = primaryId;

  // Each secondary's placement, measured before anything moves: where it sits
  // now (in the primary container's local time) and the anchor for it.
  const toLocal = (globalTime: number) =>
    descendToContainer(resolvedRoot, doc, containerPath, globalTime)?.localTime ?? globalTime;
  const placements = secPaths.map((p) => {
    const span = globalSpanOf(resolvedRoot, doc, p);
    if (!span) {
      // Can't tell where it is: start it at the playhead instead.
      return { start: anchorAt(id, primary, resolvedPrimary, desc.localTime).start };
    }
    const secStart = toLocal(span.start);
    const secEnd = toLocal(span.end);
    // The point never sits before the secondary or past its end.
    const t = Math.max(secStart, Math.min(secEnd, desc.localTime));
    const anchor = anchorAt(id, primary, resolvedPrimary, t);
    const offset = round3(secStart - anchor.pointTime);
    return { start: anchor.start, ...(offset !== 0 ? { offset } : {}) };
  });

  const end = (getCompAtPath(working, containerPath)?.children ?? []).length;
  const moved = moveNodesTracked(working, secPaths, containerPath, end);
  if (!moved) return null;
  // They landed as one contiguous run; make each its own anchored head.
  let next = moved.doc;
  moved.paths.forEach((p, k) => {
    const placement: { start: Start; offset?: number } = placements[k];
    next = updateNodeAtPath(next, p, (n) => withPlacement(n, placement.start, placement.offset));
  });
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

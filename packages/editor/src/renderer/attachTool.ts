// Attach tool: take a selection of >=2 children, move every secondary
// into `attachments`, and anchor its `start` or `end` to a source-mode
// point on the primary at the playhead.
//
// Pure transformations on a SeamFile — no React, no platform deps.

import { resolveComposition } from "@seam/core";
import type { Child, ResolvedChild, SeamFile, TimeAnchor } from "@seam/core";

/** Collect every `id` appearing anywhere in the document tree. */
function collectAllIds(doc: SeamFile): Set<string> {
  const out = new Set<string>();
  const visit = (child: Child) => {
    const id = (child as { id?: string }).id;
    if (id != null) out.add(id);
    if (child.type === "composition") {
      child.children.forEach(visit);
      if (child.attachments) child.attachments.forEach(visit);
    }
  };
  visit(doc);
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
 * Source-time of the playhead within `primary`, clamped to its source range.
 * Maps the resolver's source→output formula in reverse:
 *   source_time = base + (output_time − timelineStart) * speed
 * where `base` is `sourceIn` (clip/audio) or `in ?? 0` (composition).
 *
 * Returns null for primaries that have no meaningful source axis (data,
 * empty) — the attach tool is disabled in those cases.
 */
function sourceAnchorPoint(
  primary: Child,
  resolved: ResolvedChild,
  t: number,
): number | null {
  if (
    (primary.type === "clip" || primary.type === "audio") &&
    (resolved.type === "clip" || resolved.type === "audio")
  ) {
    const sourceTime =
      resolved.sourceIn + (t - resolved.timelineStart) * resolved.speed;
    return Math.max(primary.in, Math.min(primary.out, sourceTime));
  }
  if (primary.type === "composition" && resolved.type === "composition") {
    const compIn = primary.in ?? 0;
    // Resolved duration is in OUTPUT seconds; window length on the inner
    // (source) timeline is `duration * speed`. compIn..compIn+windowLen is
    // the visible source range to clamp into.
    const compOut = compIn + resolved.duration * resolved.speed;
    const sourceTime =
      compIn + (t - resolved.timelineStart) * resolved.speed;
    return Math.max(compIn, Math.min(compOut, sourceTime));
  }
  return null;
}

/**
 * Move every secondary out of `children` and into `attachments`, anchoring
 * either the secondary's `start` or `end` to a source-mode point on the
 * primary at the playhead. Auto-assigns an id to the primary if it lacks one.
 *
 * Returns null if the action isn't applicable (fewer than 2 selections, or
 * the primary type has no source axis).
 */
export function applyAttach(
  doc: SeamFile,
  currentTime: number,
  selectedIndices: number[],
  side: "start" | "end",
): SeamFile | null {
  if (selectedIndices.length < 2) return null;
  const [primaryIdx, ...secondaryIdx] = selectedIndices;
  const primary = doc.children[primaryIdx];
  if (!primary) return null;

  let resolved;
  try {
    resolved = resolveComposition(doc);
  } catch {
    return null;
  }
  const resolvedPrimary = resolved.children[primaryIdx];
  if (!resolvedPrimary) return null;

  const anchorPoint = sourceAnchorPoint(primary, resolvedPrimary, currentTime);
  if (anchorPoint == null) return null;

  // Ensure the primary has an id so the attachments can reference it.
  const existingIds = collectAllIds(doc);
  let primaryId = (primary as { id?: string }).id;
  let updatedPrimary: Child = primary;
  if (primaryId == null) {
    primaryId = pickFreshId(existingIds, "anchor");
    updatedPrimary = { ...primary, id: primaryId } as Child;
  }

  const anchor: TimeAnchor = {
    anchor: primaryId,
    timeSource: "source",
    anchorPoint,
    offset: 0,
  };

  const newChildren = [...doc.children];
  newChildren[primaryIdx] = updatedPrimary;

  // Build the new attachment list in original child order so z-order is
  // predictable (earlier-in-doc renders below later-in-doc among the new
  // attachments).
  const sortedSecAsc = [...secondaryIdx].sort((a, b) => a - b);
  const newAttachments: Child[] = [];
  for (const i of sortedSecAsc) {
    const node = doc.children[i];
    if (!node) continue;
    const updated = { ...node } as Child;
    if (side === "start") {
      (updated as { start?: TimeAnchor }).start = anchor;
    } else {
      (updated as { end?: TimeAnchor }).end = anchor;
    }
    newAttachments.push(updated);
  }

  // Splice descending so earlier indices stay valid.
  const sortedSecDesc = [...secondaryIdx].sort((a, b) => b - a);
  for (const i of sortedSecDesc) newChildren.splice(i, 1);

  return {
    ...doc,
    children: newChildren,
    attachments: [...(doc.attachments ?? []), ...newAttachments],
  };
}

/**
 * Append `newItems` as attachments anchored to `primaryIndex` at the
 * source-mode point corresponding to `currentTime` on the primary.
 * Used by the drag-drop attach zone: dropped files become attachments
 * pre-anchored to the selected clip at the playhead. Auto-assigns an
 * id to the primary if it lacks one.
 *
 * `side === "start"` anchors each new item's `start` to the playhead
 * (item lives to the right of the playhead); `side === "end"` anchors
 * the `end` (item lives to the left). Returns null when the primary's
 * type has no source axis.
 */
export function attachNewItems(
  doc: SeamFile,
  currentTime: number,
  primaryIndex: number,
  newItems: Child[],
  side: "start" | "end",
): SeamFile | null {
  if (newItems.length === 0) return null;
  const primary = doc.children[primaryIndex];
  if (!primary) return null;

  let resolved;
  try {
    // Resolve the container *un-windowed* so its child indices stay 1:1 with
    // the authored body (a narrowing `in`/`out` would crop children and
    // shift `primaryIndex`). The caller's `currentTime` is already an
    // un-windowed local-output time (the timeline expansion is laid out
    // un-windowed), so the two line up. The window stays on the returned doc.
    const probeDoc =
      doc.in != null || doc.out != null
        ? { ...doc, in: undefined, out: undefined }
        : doc;
    resolved = resolveComposition(probeDoc);
  } catch {
    return null;
  }
  const resolvedPrimary = resolved.children[primaryIndex];
  if (!resolvedPrimary) return null;

  const anchorPoint = sourceAnchorPoint(primary, resolvedPrimary, currentTime);
  if (anchorPoint == null) return null;

  const existingIds = collectAllIds(doc);
  let primaryId = (primary as { id?: string }).id;
  let updatedPrimary: Child = primary;
  if (primaryId == null) {
    primaryId = pickFreshId(existingIds, "anchor");
    updatedPrimary = { ...primary, id: primaryId } as Child;
  }

  const anchor: TimeAnchor = {
    anchor: primaryId,
    timeSource: "source",
    anchorPoint,
    offset: 0,
  };

  const anchored: Child[] = newItems.map((item) => {
    const updated = { ...item } as Child;
    if (side === "start") {
      (updated as { start?: TimeAnchor }).start = anchor;
    } else {
      (updated as { end?: TimeAnchor }).end = anchor;
    }
    return updated;
  });

  const newChildren = [...doc.children];
  newChildren[primaryIndex] = updatedPrimary;

  return {
    ...doc,
    children: newChildren,
    attachments: [...(doc.attachments ?? []), ...anchored],
  };
}

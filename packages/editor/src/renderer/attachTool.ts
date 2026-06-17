// Attach tool: take a selection of >=2 children, move every secondary
// into `attachments`, and anchor its `start` or `end` to a source-mode
// point on the primary at the playhead.
//
// Pure transformations on a SeamFile — no React, no platform deps.

import { resolveComposition } from "@seam/core";
import type {
  Child,
  Composition,
  ResolvedChild,
  ResolvedTimeline,
  SeamFile,
  TimeAnchor,
} from "@seam/core";
import {
  getNodeAtPath,
  isPrefix,
  parsePath,
  pathKey,
  splitLast,
  updateCompAtPath,
  type NodePath,
} from "./nodePath.js";
import { descendToContainer } from "./resolveLocal.js";

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

/** The `timeSource`/`anchorPoint` pair an attachment should use to pin to a
 *  point on the primary at the playhead. Either a `source`-mode seconds value
 *  (for types with a real content axis) or an `output`-mode percentage. */
type AnchorSpec =
  | { timeSource: "source"; anchorPoint: number }
  | { timeSource: "output"; anchorPoint: string };

/**
 * The anchor spec for pinning to the playhead point on `primary`.
 *
 * For types with a real source axis (clip/audio/composition) we anchor in
 * **source** mode — a content moment that survives later trims. Maps the
 * resolver's source→output formula in reverse:
 *   source_time = base + (output_time − timelineStart) * speed
 * where `base` is `sourceIn` (clip/audio) or `in ?? 0` (composition).
 *
 * Every other type (empty, static, text, graphic, data) has no content axis
 * but still occupies an output span — anchor in **output** mode as a
 * percentage of that span (the file format allows attaching to any node).
 *
 * Returns null only when the resolved span is degenerate enough to be
 * unusable (it otherwise always produces a spec).
 */
function computeAnchorSpec(
  primary: Child,
  resolved: ResolvedChild,
  t: number,
): AnchorSpec | null {
  if (
    (primary.type === "clip" || primary.type === "audio") &&
    (resolved.type === "clip" || resolved.type === "audio")
  ) {
    const sourceTime =
      resolved.sourceIn + (t - resolved.timelineStart) * resolved.speed;
    const clamped = Math.max(primary.in, Math.min(primary.out, sourceTime));
    return { timeSource: "source", anchorPoint: clamped };
  }
  if (primary.type === "composition" && resolved.type === "composition") {
    const compIn = primary.in ?? 0;
    // Resolved duration is in OUTPUT seconds; window length on the inner
    // (source) timeline is `duration * speed`. compIn..compIn+windowLen is
    // the visible source range to clamp into.
    const compOut = compIn + resolved.duration * resolved.speed;
    const sourceTime =
      compIn + (t - resolved.timelineStart) * resolved.speed;
    const clamped = Math.max(compIn, Math.min(compOut, sourceTime));
    return { timeSource: "source", anchorPoint: clamped };
  }
  // No source axis — pin to a percentage of the output span.
  const span = resolved.timelineEnd - resolved.timelineStart;
  const pct = span > 0 ? (t - resolved.timelineStart) / span : 0;
  const clamped = Math.max(0, Math.min(1, pct));
  return {
    timeSource: "output",
    anchorPoint: `${parseFloat((clamped * 100).toFixed(4))}%`,
  };
}

/**
 * Attach tool (toolbar). The first selection is the primary anchor; the rest
 * are secondaries. Each secondary becomes an attachment in the **primary's
 * container**, with its chosen `side` (`start`/`end`) anchored to a
 * source-mode point on the primary at the playhead. The other side is left
 * untouched, so the tool overwrites just that one anchor:
 *   • a child secondary is promoted to an attachment;
 *   • an attachment secondary has its `side` re-anchored (even if it was
 *     anchored elsewhere);
 *   • secondaries in a different container are pulled into the primary's
 *     (e.g. a root child dragged into a composition the primary lives in).
 * Validity of the *other* (untouched) anchor across a container boundary is
 * deliberately NOT checked — the user sees the result and adjusts.
 *
 * Selections are path keys. `resolvedRoot` is the editor's resolved timeline
 * (used to map the global playhead onto the primary's source). Returns null
 * when inapplicable (no secondaries, bin-rooted/path-less primary, primary
 * has no source axis, or the primary can't be resolved).
 */
export function applyAttach(
  doc: SeamFile,
  resolvedRoot: ResolvedTimeline,
  currentTime: number,
  primaryKey: string,
  secondaryKeys: string[],
  side: "start" | "end",
): SeamFile | null {
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
  // primary's resolved node there to compute its source anchor point.
  const desc = descendToContainer(resolvedRoot, doc, containerPath, currentTime);
  if (!desc) return null;
  const last = primaryPath[primaryPath.length - 1];
  const flat =
    last.field === "children"
      ? last.index
      : desc.aContainer.children.length + last.index;
  const resolvedPrimary = desc.rContainer.children[flat];
  if (!resolvedPrimary) return null;
  const anchorSpec = computeAnchorSpec(primary, resolvedPrimary, desc.localTime);
  if (anchorSpec == null) return null;

  // Valid secondaries: non-bin, not the primary's container, not an
  // ancestor-or-equal of the primary (can't attach the primary's container
  // to itself).
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
  const dropSet = new Set(secPaths.map(pathKey));

  // Ensure the primary has an id so the attachments can reference it (adding
  // a field doesn't shift any paths).
  let primaryId = (primary as { id?: string }).id;
  let working = doc;
  if (primaryId == null) {
    primaryId = pickFreshId(collectAllIds(doc), "anchor");
    working = setIdAtPath(doc, primaryPath, primaryId);
  }
  const anchor: TimeAnchor = {
    anchor: primaryId,
    ...anchorSpec,
    offset: 0,
  };

  // Read each secondary, overwrite only its chosen side, keep the rest.
  const gathered: Child[] = [];
  for (const p of secPaths) {
    const node = getNodeAtPath(working, p);
    if (!node) continue;
    const updated = { ...node } as Child;
    (updated as unknown as Record<string, unknown>)[side] = anchor;
    gathered.push(updated);
  }
  if (gathered.length === 0) return null;

  // One immutable pass: drop the secondaries from wherever they are and
  // append the rewritten copies to the primary's container's attachments.
  return attachRebuild(working, [], dropSet, containerKey, gathered);
}

/** Set the `id` field on the node at `path` (used to give the primary an id). */
function setIdAtPath(doc: SeamFile, path: NodePath, id: string): SeamFile {
  const sp = splitLast(path);
  if (!sp) return doc;
  return updateCompAtPath(doc, sp.parent, (comp) => {
    const isAtt = sp.last.field === "attachments";
    const arr = isAtt ? comp.attachments ?? [] : comp.children;
    const node = arr[sp.last.index];
    if (!node) return comp;
    const next = [...arr];
    next[sp.last.index] = { ...node, id } as Child;
    return isAtt
      ? { ...comp, attachments: next }
      : { ...comp, children: next };
  });
}

/** Immutable rebuild: drop every node whose path key is in `dropSet`, and
 *  append `gathered` to the attachments of the container at `containerKey`.
 *  `binItem` references are treated as leaves (their body lives in the bin). */
function attachRebuild(
  comp: Composition,
  path: NodePath,
  dropSet: Set<string>,
  containerKey: string,
  gathered: Child[],
): Composition {
  const recurse = (c: Child, childPath: NodePath): Child =>
    c.type === "composition" && !c.binItem
      ? attachRebuild(c, childPath, dropSet, containerKey, gathered)
      : c;

  const newChildren: Child[] = [];
  (comp.children ?? []).forEach((c, i) => {
    const childPath: NodePath = [...path, { field: "children", index: i }];
    if (dropSet.has(pathKey(childPath))) return;
    newChildren.push(recurse(c, childPath));
  });

  const newAttachments: Child[] = [];
  (comp.attachments ?? []).forEach((a, j) => {
    const attPath: NodePath = [...path, { field: "attachments", index: j }];
    if (dropSet.has(pathKey(attPath))) return;
    newAttachments.push(recurse(a, attPath));
  });

  if (pathKey(path) === containerKey) newAttachments.push(...gathered);

  if (newAttachments.length > 0) {
    return { ...comp, children: newChildren, attachments: newAttachments };
  }
  const { attachments: _drop, ...rest } = comp;
  return { ...rest, children: newChildren };
}

/**
 * Append `newItems` as attachments anchored to the primary at
 * `primaryField[primaryIndex]` (a sequential child or an existing
 * attachment), at the point corresponding to `currentTime` on the primary.
 * Used by the drag-drop attach zone: dropped files become attachments
 * pre-anchored to the selected primary at the playhead. Auto-assigns an
 * id to the primary if it lacks one.
 *
 * `side === "start"` anchors each new item's `start` to the playhead
 * (item lives to the right of the playhead); `side === "end"` anchors
 * the `end` (item lives to the left). Any primary type works — types with
 * a source axis anchor in source mode, the rest in output-percentage mode.
 */
export function attachNewItems(
  doc: SeamFile,
  currentTime: number,
  primaryField: "children" | "attachments",
  primaryIndex: number,
  newItems: Child[],
  side: "start" | "end",
): SeamFile | null {
  if (newItems.length === 0) return null;
  const sourceArr =
    primaryField === "children" ? doc.children : doc.attachments ?? [];
  const primary = sourceArr[primaryIndex];
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
  // The resolver appends resolved attachments after resolved children.
  const resolvedIndex =
    primaryField === "children"
      ? primaryIndex
      : doc.children.length + primaryIndex;
  const resolvedPrimary = resolved.children[resolvedIndex];
  if (!resolvedPrimary) return null;

  const anchorSpec = computeAnchorSpec(primary, resolvedPrimary, currentTime);
  if (anchorSpec == null) return null;

  const existingIds = collectAllIds(doc);
  let primaryId = (primary as { id?: string }).id;
  let updatedPrimary: Child = primary;
  if (primaryId == null) {
    primaryId = pickFreshId(existingIds, "anchor");
    updatedPrimary = { ...primary, id: primaryId } as Child;
  }

  const anchor: TimeAnchor = {
    anchor: primaryId,
    ...anchorSpec,
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

  // Write the (possibly id-stamped) primary back into its own array, then
  // append the new attachments. New items always land in `attachments` and
  // after the primary in array order, so they can reference its id.
  const children =
    primaryField === "children"
      ? doc.children.map((c, i) => (i === primaryIndex ? updatedPrimary : c))
      : doc.children;
  const baseAttachments =
    primaryField === "attachments"
      ? (doc.attachments ?? []).map((a, i) =>
          i === primaryIndex ? updatedPrimary : a,
        )
      : doc.attachments ?? [];

  return {
    ...doc,
    children,
    attachments: [...baseAttachments, ...anchored],
  };
}

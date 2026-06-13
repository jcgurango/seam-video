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
  const containerKey = pathKey(primaryPath.slice(0, -1));

  const primary = getNodeAtPath(doc, primaryPath);
  if (!primary) return null;
  const glob = resolvePrimaryGlobal(resolvedRoot, doc, primaryPath);
  if (!glob) return null;
  const anchorPoint = globalAnchorPoint(
    primary,
    glob.resolved,
    glob.gStart,
    glob.gSpeed,
    currentTime,
  );
  if (anchorPoint == null) return null;

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
    timeSource: "source",
    anchorPoint,
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

/** Walk `path` in parallel through the resolved + authored trees,
 *  accumulating the primary's *global* output start and cumulative speed.
 *  Nested resolved children carry container-local `timelineStart`, so each
 *  level contributes `start += childLocalStart / cumSpeed` and
 *  `cumSpeed *= comp.speed`. Returns null if the path doesn't resolve 1:1
 *  (e.g. a narrowing-windowed ancestor crops it — the acknowledged edge). */
function resolvePrimaryGlobal(
  resolvedRoot: ResolvedTimeline,
  doc: SeamFile,
  path: NodePath,
): { resolved: ResolvedChild; gStart: number; gSpeed: number } | null {
  let gStart = 0;
  let cum = 1;
  let rNode: { children: ResolvedChild[] } = resolvedRoot;
  let aNode: { children: Child[]; attachments?: Child[] } = doc;
  for (let i = 0; i < path.length; i++) {
    const seg = path[i];
    if (seg.field === "bin") return null;
    const childCount = aNode.children.length;
    const flat = seg.field === "children" ? seg.index : childCount + seg.index;
    const rChild = rNode.children?.[flat];
    if (!rChild) return null;
    const childGStart = gStart + rChild.timelineStart / cum;
    const speed = (rChild as { speed?: number }).speed ?? 1;
    if (i === path.length - 1) {
      return { resolved: rChild, gStart: childGStart, gSpeed: cum * speed };
    }
    if (rChild.type !== "composition") return null;
    gStart = childGStart;
    cum = cum * speed;
    rNode = rChild;
    const aChild =
      seg.field === "children"
        ? aNode.children[seg.index]
        : (aNode.attachments ?? [])[seg.index];
    if (!aChild || aChild.type !== "composition") return null;
    aNode = aChild;
  }
  return null;
}

/** Source-mode anchor point on the primary at global output time `t`, using
 *  the primary's global start + cumulative speed. Mirrors the resolver's
 *  source→output formula so the dot lands at the playhead. */
function globalAnchorPoint(
  primary: Child,
  resolved: ResolvedChild,
  gStart: number,
  gSpeed: number,
  t: number,
): number | null {
  if (
    (primary.type === "clip" || primary.type === "audio") &&
    (resolved.type === "clip" || resolved.type === "audio")
  ) {
    const sourceTime = resolved.sourceIn + (t - gStart) * gSpeed;
    return Math.max(primary.in, Math.min(primary.out, sourceTime));
  }
  if (primary.type === "composition" && resolved.type === "composition") {
    const compIn = primary.in ?? 0;
    // duration*speed is the intrinsic source span (window length), invariant
    // to ancestor scaling, so the local resolved values are correct here.
    const compOut = compIn + resolved.duration * resolved.speed;
    const sourceTime = compIn + (t - gStart) * gSpeed;
    return Math.max(compIn, Math.min(compOut, sourceTime));
  }
  return null;
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

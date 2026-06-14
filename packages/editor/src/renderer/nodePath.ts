// Centralized, position-path-keyed addressing for timeline nodes.
//
// A node is identified by a `NodePath`: a list of segments. Most paths root
// at the document (`children.0`, `children.3.attachments.1`). A path may
// instead root at a **bin entry** — a leading `bin.<id>` segment — so a
// `binItem` expansion's children address the shared entry rather than the
// reference site (`bin.<id>.children.0`). Editing such a path rewrites the
// bin entry, so the change propagates to every reference (by design — Phase
// 3). Serialized to a dotted string (`pathKey`) the path doubles as a React
// key, a selection-set member, an expand-state key, and a "jump to JSON"
// path. (Bin ids are assumed dot-free, like all identifiers.)
//
// The selection state in `App` is a flat `string[]` of these keys; the UI
// layer resolves each back to a node (or, for the root-only tools that
// predate nesting, to a flat root index via the adapters at the bottom).
//
// All mutators are pure `(SeamFile, …) → SeamFile` and immutable. The
// `editContainer` lens is the reuse hinge: it runs any existing
// `(Composition) → Composition` tool against the composition at a path,
// injecting the root bin so nested `binItem`s still resolve, then splices
// the result back. Regular, nested, and bin-entry edits differ only in
// which path is bound — the same wiring.

import type { BinEntry, Child, Composition, SeamFile } from "@seam/core";
import { findBinItem } from "./nodeBin.js";

export interface PathSeg {
  /** `bin` only ever appears as the first segment (a bin-entry root); its
   *  `id` names the entry and `index` is unused. */
  field: "children" | "attachments" | "bin";
  index: number;
  id?: string;
}

/** Path to a node. Empty = the document root. A leading `bin` segment roots
 *  the path at a shared bin entry. */
export type NodePath = PathSeg[];

/** A structural view of anything carrying child arrays (Composition or
 *  BinEntry). */
type Body = { children?: Child[]; attachments?: Child[] };

/** Serialize to a dotted key: `children.3.attachments.1`, `bin.intro.children.0`. */
export function pathKey(path: NodePath): string {
  return path
    .map((s) => (s.field === "bin" ? `bin.${s.id}` : `${s.field}.${s.index}`))
    .join(".");
}

/** Inverse of `pathKey`. */
export function parsePath(key: string): NodePath {
  if (key === "") return [];
  const parts = key.split(".");
  const segs: NodePath = [];
  let i = 0;
  if (parts[0] === "bin") {
    segs.push({ field: "bin", index: 0, id: parts[1] });
    i = 2;
  }
  for (; i + 1 < parts.length; i += 2) {
    const field = parts[i] === "attachments" ? "attachments" : "children";
    segs.push({ field, index: Number(parts[i + 1]) });
  }
  return segs;
}

export function samePath(a: NodePath, b: NodePath): boolean {
  return pathKey(a) === pathKey(b);
}

/** Segment equality — bin segments compare by id, others by field + index. */
function segEq(a: PathSeg, b: PathSeg): boolean {
  if (a.field !== b.field) return false;
  return a.field === "bin" ? a.id === b.id : a.index === b.index;
}

/** True when `prefix` is an ancestor-or-equal of `path`. */
export function isPrefix(prefix: NodePath, path: NodePath): boolean {
  if (prefix.length > path.length) return false;
  for (let i = 0; i < prefix.length; i++) {
    if (!segEq(prefix[i], path[i])) return false;
  }
  return true;
}

function childArray(node: Body, field: "children" | "attachments"): Child[] {
  return (field === "children" ? node.children : node.attachments) ?? [];
}

/** The node at `path`, or undefined if any segment is missing. Root path
 *  ([]) returns undefined — the root isn't an addressable child. A leading
 *  `bin` segment of length 1 returns the bin entry itself. */
export function getNodeAtPath(
  root: SeamFile,
  path: NodePath,
): Child | undefined {
  if (path.length === 0) return undefined;
  let node: Body;
  let start = 0;
  if (path[0].field === "bin") {
    const entry = findBinItem(root.bin ?? [], path[0].id ?? "");
    if (!entry) return undefined;
    if (path.length === 1) return entry as unknown as Child;
    node = entry;
    start = 1;
  } else {
    node = root;
  }
  for (let i = start; i < path.length; i++) {
    const seg = path[i];
    if (seg.field === "bin") return undefined; // bin only valid as the root
    const next = childArray(node, seg.field)[seg.index];
    if (!next) return undefined;
    node = next as Body;
  }
  return node as Child;
}

/** The composition at `containerPath` ([] = root, a `bin` root = the bin
 *  entry), or undefined if the path doesn't land on one. */
export function getCompAtPath(
  root: SeamFile,
  containerPath: NodePath,
): Composition | undefined {
  if (containerPath.length === 0) return root;
  if (containerPath.length === 1 && containerPath[0].field === "bin") {
    const entry = findBinItem(root.bin ?? [], containerPath[0].id ?? "");
    return entry as unknown as Composition | undefined;
  }
  const node = getNodeAtPath(root, containerPath);
  return node && node.type === "composition" ? node : undefined;
}

/** Immutably replace the composition at `containerPath` ([] = root) with
 *  `fn`'s result. A leading `bin` segment rewrites the named bin entry (so
 *  the edit reaches every reference). No-ops if the path doesn't resolve. */
export function updateCompAtPath(
  root: SeamFile,
  containerPath: NodePath,
  fn: (comp: Composition) => Composition,
): SeamFile {
  if (containerPath.length === 0) return fn(root);
  const [seg, ...rest] = containerPath;
  if (seg.field === "bin") {
    const bin = root.bin ?? [];
    const idx = bin.findIndex((e) => e.id === seg.id);
    if (idx < 0) return root;
    // Present the entry as a composition for the tool; strip the synthetic
    // `type` (and any injected `bin`) back off on write-back.
    const asComp = { type: "composition", ...bin[idx] } as Composition;
    const newComp = updateCompAtPath(asComp as unknown as SeamFile, rest, fn);
    if (newComp === (asComp as unknown)) return root;
    const { type: _t, bin: _b, ...entryFields } = newComp as Composition;
    const newBin = [...bin];
    newBin[idx] = entryFields as unknown as BinEntry;
    return { ...root, bin: newBin };
  }
  const arr = childArray(root, seg.field);
  const child = arr[seg.index];
  if (!child || child.type !== "composition") return root;
  const newChild = updateCompAtPath(child, rest, fn);
  if (newChild === child) return root;
  const newArr = [...arr];
  newArr[seg.index] = newChild;
  return seg.field === "children"
    ? { ...root, children: newArr }
    : { ...root, attachments: newArr };
}

/** Run a pure composition tool against the composition at `containerPath`,
 *  injecting `rootBin` first so nested `binItem`s resolve, and stripping it
 *  back out on write-back (unless the container already had its own bin).
 *  The tool returning null leaves the container unchanged. */
export function editContainer(
  root: SeamFile,
  containerPath: NodePath,
  rootBin: BinEntry[],
  tool: (sub: Composition) => Composition | null,
): SeamFile {
  return updateCompAtPath(root, containerPath, (comp) => {
    const hadOwnBin = comp.bin != null;
    const withBin =
      hadOwnBin || rootBin.length === 0 ? comp : { ...comp, bin: rootBin };
    const result = tool(withBin);
    if (!result) return comp;
    if (!hadOwnBin && rootBin.length > 0 && result.bin != null) {
      const { bin: _drop, ...rest } = result;
      return rest as Composition;
    }
    return result;
  });
}

/** Ids a child references as time anchors (start/end). Only attachments
 *  carry meaningful anchors, but reading them off any node is harmless. */
function anchorRefs(child: Child): string[] {
  const c = child as { start?: { anchor?: string }; end?: { anchor?: string } };
  const out: string[] = [];
  if (c.start?.anchor) out.push(c.start.anchor);
  if (c.end?.anchor) out.push(c.end.anchor);
  return out;
}

function nodeId(child: Child): string | undefined {
  return (child as { id?: string }).id;
}

/**
 * Remove the child/attachment slots named by `childIdx`/`attIdx` from a single
 * composition, *cascading* into dependent attachments: any attachment anchored
 * (via `start`/`end`) to a removed node is removed too, transitively (a removed
 * attachment may itself be another attachment's anchor). Deleting a child thus
 * takes its attachments with it — even when an attachment also anchors to a
 * surviving node (one dangling end is enough), and even across several
 * attachments. Anchors only ever point at siblings, so this stays per-comp.
 */
export function removeFromComp(
  comp: Composition,
  childIdx: ReadonlySet<number>,
  attIdx: ReadonlySet<number>,
): Composition {
  const attachments = comp.attachments ?? [];

  // Seed removed-id set from the explicitly removed children + attachments.
  const removedIds = new Set<string>();
  comp.children.forEach((c, i) => {
    if (childIdx.has(i)) {
      const id = nodeId(c);
      if (id) removedIds.add(id);
    }
  });
  const removedAtt = new Set<number>(attIdx);
  attachments.forEach((a, i) => {
    if (attIdx.has(i)) {
      const id = nodeId(a);
      if (id) removedIds.add(id);
    }
  });

  // Fixpoint: pull in attachments anchored to any removed id, feeding their
  // own ids back so chained anchors cascade.
  let changed = true;
  while (changed) {
    changed = false;
    attachments.forEach((att, i) => {
      if (removedAtt.has(i)) return;
      if (anchorRefs(att).some((ref) => removedIds.has(ref))) {
        removedAtt.add(i);
        const id = nodeId(att);
        if (id && !removedIds.has(id)) removedIds.add(id);
        changed = true;
      }
    });
  }

  const newChildren = comp.children.filter((_, i) => !childIdx.has(i));
  const newAttachments = attachments.filter((_, i) => !removedAtt.has(i));
  if (newAttachments.length > 0) {
    return { ...comp, children: newChildren, attachments: newAttachments };
  }
  const { attachments: _drop, ...rest } = comp;
  return { ...rest, children: newChildren } as Composition;
}

/** Remove the node at `path`. No-op for the root path. */
export function removeNodeAtPath(root: SeamFile, path: NodePath): SeamFile {
  const split = splitLast(path);
  if (!split) return root;
  const { parent, last } = split;
  return updateCompAtPath(root, parent, (comp) =>
    spliceField(comp, last.field, (arr) => {
      const next = [...arr];
      next.splice(last.index, 1);
      return next;
    }),
  );
}

/** Remove many nodes at once, grouping by container and splicing each
 *  container's array in descending index order so earlier removals don't
 *  shift later ones. */
export function removeNodesAtPaths(
  root: SeamFile,
  paths: NodePath[],
): SeamFile {
  // Group by *container* (both fields together) so the cascade in
  // `removeFromComp` sees every removal in a composition at once — a child and
  // its dependent attachments live in the same comp but different fields.
  const groups = new Map<
    string,
    { path: NodePath; children: Set<number>; attachments: Set<number> }
  >();
  for (const p of paths) {
    const split = splitLast(p);
    if (!split) continue;
    const key = pathKey(split.parent);
    let g = groups.get(key);
    if (!g) {
      g = { path: split.parent, children: new Set(), attachments: new Set() };
      groups.set(key, g);
    }
    (split.last.field === "children" ? g.children : g.attachments).add(
      split.last.index,
    );
  }
  // Apply deepest-container-first so a parent removal doesn't invalidate a
  // child group's path. Deeper paths have longer keys → sort by path length
  // descending.
  const ordered = [...groups.values()].sort(
    (a, b) => b.path.length - a.path.length,
  );
  let doc = root;
  for (const g of ordered) {
    doc = updateCompAtPath(doc, g.path, (comp) =>
      removeFromComp(comp, g.children, g.attachments),
    );
  }
  return doc;
}

/** Insert `node` into the composition at `containerPath`'s `field` array at
 *  `index`. */
export function insertNode(
  root: SeamFile,
  containerPath: NodePath,
  field: PathSeg["field"],
  index: number,
  node: Child,
): SeamFile {
  return updateCompAtPath(root, containerPath, (comp) =>
    spliceField(comp, field, (arr) => {
      const next = [...arr];
      next.splice(Math.max(0, Math.min(index, next.length)), 0, node);
      return next;
    }),
  );
}

/** Move the node at `from` into the composition at `toContainer`'s `toField`
 *  at `toIndex`. Indices in `toContainer`/`toIndex` are interpreted against
 *  the *pre-removal* tree; this compensates for the shift the removal causes.
 *  `transform` lets the caller adapt the node for its new home (e.g. strip
 *  anchors when moving into a sequential `children` band). No-ops when the
 *  destination is inside the moved node's own subtree. */
export function moveNode(
  root: SeamFile,
  from: NodePath,
  toContainer: NodePath,
  toField: PathSeg["field"],
  toIndex: number,
  transform?: (child: Child) => Child,
): SeamFile {
  const node = getNodeAtPath(root, from);
  if (!node) return root;
  if (isPrefix(from, toContainer)) return root; // can't move into self
  const moved = transform ? transform(node) : node;

  const removed = removeNodeAtPath(root, from);
  const fromSplit = splitLast(from)!;

  // The target container path may shift if it sits after `from` in a shared
  // parent array.
  let tc = adjustPathAfterRemoval(toContainer, from);
  let ti = toIndex;
  // Same container + same field: removing an earlier sibling shifts the slot.
  if (
    samePath(tc, fromSplit.parent) &&
    toField === fromSplit.last.field &&
    toIndex > fromSplit.last.index
  ) {
    ti -= 1;
  }
  return insertNode(removed, tc, toField, ti, moved);
}

/** Adjust a path for the removal of the node at `removed`: if `path` passes
 *  through `removed`'s parent at a later index in the same field, decrement
 *  that segment. */
export function adjustPathAfterRemoval(path: NodePath, removed: NodePath): NodePath {
  const split = splitLast(removed);
  if (!split) return path;
  const { parent, last } = split;
  if (path.length <= parent.length) return path;
  for (let k = 0; k < parent.length; k++) {
    if (!segEq(path[k], parent[k])) return path;
  }
  const seg = path[parent.length];
  if (seg.field === last.field && seg.index > last.index) {
    const next = [...path];
    next[parent.length] = { field: seg.field, index: seg.index - 1 };
    return next;
  }
  return path;
}

export function splitLast(
  path: NodePath,
): { parent: NodePath; last: PathSeg } | null {
  if (path.length === 0) return null;
  return { parent: path.slice(0, -1), last: path[path.length - 1] };
}

/** Replace a composition's `children`/`attachments` array, dropping the
 *  `attachments` field entirely when it ends up empty so saved JSON stays
 *  clean. */
function spliceField(
  comp: Composition,
  field: PathSeg["field"],
  fn: (arr: Child[]) => Child[],
): Composition {
  if (field === "children") {
    return { ...comp, children: fn(comp.children) };
  }
  const next = fn(comp.attachments ?? []);
  if (next.length > 0) return { ...comp, attachments: next };
  const { attachments: _drop, ...rest } = comp;
  return rest as Composition;
}

// ── Root-index adapters ──────────────────────────────────────────────
//
// The tools that predate nesting (attach, compose, bin, word, slice,
// delete, transcribe, anchor lines) operate on flat *root* indices, where
// `[0, childCount)` are children and `[childCount, …)` are attachments —
// the same scheme the resolver uses when it appends attachments after
// children. These map the path-key selection back and forth at the UI
// boundary, ignoring (filtering out) any non-root selections.

/** The path key for a root child / attachment at flat index `i`. */
export function rootKeyFromIndex(i: number, childCount: number): string {
  return i < childCount
    ? `children.${i}`
    : `attachments.${i - childCount}`;
}

/** Flat root indices for the root-level keys in `keys`, in order. Nested
 *  keys (length > 1 segment) are dropped — root-only tools never see them. */
export function rootIndicesFromKeys(
  keys: string[],
  childCount: number,
): number[] {
  const out: number[] = [];
  for (const key of keys) {
    const path = parsePath(key);
    if (path.length !== 1) continue;
    const seg = path[0];
    out.push(seg.field === "children" ? seg.index : childCount + seg.index);
  }
  return out;
}

// Centralized, position-path-keyed addressing for timeline nodes.
//
// A node is identified by a `NodePath`: a list of segments. Most paths root
// at the document (`children.0`, `children.3.children.1`). A path may
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
import {
  insertIntoRuns,
  removeFromRuns,
  removeWithDependents,
  runBoundaryAtOrAfter,
  type InsertOptions,
} from "./runEdit.js";

export interface PathSeg {
  /** `bin` only ever appears as the first segment (a bin-entry root); its
   *  `id` names the entry and `index` is unused. */
  field: "children" | "bin";
  index: number;
  id?: string;
}

/** Path to a node. Empty = the document root. A leading `bin` segment roots
 *  the path at a shared bin entry. */
export type NodePath = PathSeg[];

/** A structural view of anything carrying child arrays (Composition or
 *  BinEntry). */
type Body = { children?: Child[] };

/** Serialize to a dotted key: `children.3.children.1`, `bin.intro.children.0`. */
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
    segs.push({ field: "children", index: Number(parts[i + 1]) });
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

function childArray(node: Body): Child[] {
  return node.children ?? [];
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
    const next = childArray(node)[seg.index];
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
  const arr = childArray(root);
  const child = arr[seg.index];
  if (!child || child.type !== "composition") return root;
  const newChild = updateCompAtPath(child, rest, fn);
  if (newChild === child) return root;
  const newArr = [...arr];
  newArr[seg.index] = newChild;
  return { ...root, children: newArr };
}

/** Immutably replace the node at `path` with `fn`'s result. Unlike
 *  {@link updateCompAtPath} the *target* can be any node type (filters live on
 *  clips/static/text/rect/circle/map/composition); intermediate segments must still be
 *  compositions. A leading `bin` segment edits inside the named bin entry. */
export function updateNodeAtPath(
  root: SeamFile,
  path: NodePath,
  fn: (node: Child) => Child,
): SeamFile {
  if (path.length === 0) {
    return fn(root as unknown as Child) as unknown as SeamFile;
  }
  const [seg, ...rest] = path;
  if (seg.field === "bin") {
    if (rest.length === 0) return root; // a bin entry isn't an editable Child here
    const bin = root.bin ?? [];
    const idx = bin.findIndex((e) => e.id === seg.id);
    if (idx < 0) return root;
    const asComp = { type: "composition", ...bin[idx] } as unknown as SeamFile;
    const newComp = updateNodeAtPath(asComp, rest, fn);
    if (newComp === (asComp as unknown)) return root;
    const { type: _t, bin: _b, ...entryFields } = newComp as unknown as Composition;
    const newBin = [...bin];
    newBin[idx] = entryFields as unknown as BinEntry;
    return { ...root, bin: newBin };
  }
  const arr = childArray(root);
  const child = arr[seg.index];
  if (!child) return root;
  let newChild: Child;
  if (rest.length === 0) {
    newChild = fn(child);
  } else {
    if (child.type !== "composition") return root;
    newChild = updateNodeAtPath(
      child as unknown as SeamFile,
      rest,
      fn,
    ) as unknown as Child;
  }
  if (newChild === child) return root;
  const newArr = [...arr];
  newArr[seg.index] = newChild;
  return { ...root, children: newArr };
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

/**
 * Remove the children at `indices` from one composition. Two run rules apply
 * (see `runEdit.ts`): a removed run head hands its `start`/`offset` to its
 * successor so the rest of the run stays put, and — with `cascade` (the
 * default, i.e. a delete) — any run whose head anchors to a removed node's id
 * goes with it, transitively.
 */
export function removeFromComp(
  comp: Composition,
  indices: ReadonlySet<number>,
  cascade = true,
): Composition {
  const children = comp.children ?? [];
  return {
    ...comp,
    children: cascade
      ? removeWithDependents(children, indices)
      : removeFromRuns(children, indices),
  };
}

/** Remove the node at `path` (no dependent cascade — this is the "lift" half
 *  of a move). No-op for the root path. */
export function removeNodeAtPath(root: SeamFile, path: NodePath): SeamFile {
  const split = splitLast(path);
  if (!split) return root;
  return updateCompAtPath(root, split.parent, (comp) =>
    removeFromComp(comp, new Set([split.last.index]), false),
  );
}

function groupByContainer(paths: NodePath[]): { path: NodePath; indices: Set<number> }[] {
  const groups = new Map<string, { path: NodePath; indices: Set<number> }>();
  for (const p of paths) {
    const split = splitLast(p);
    if (!split || split.last.field === "bin") continue;
    const key = pathKey(split.parent);
    let g = groups.get(key);
    if (!g) {
      g = { path: split.parent, indices: new Set() };
      groups.set(key, g);
    }
    g.indices.add(split.last.index);
  }
  // Deepest-container-first so a parent removal can't invalidate a child
  // group's path.
  return [...groups.values()].sort((a, b) => b.path.length - a.path.length);
}

/** Delete many nodes at once (grouped per container; dependents cascade). */
export function removeNodesAtPaths(
  root: SeamFile,
  paths: NodePath[],
  cascade = true,
): SeamFile {
  let doc = root;
  for (const g of groupByContainer(paths)) {
    doc = updateCompAtPath(doc, g.path, (comp) => removeFromComp(comp, g.indices, cascade));
  }
  return doc;
}

/** Insert `nodes` into the composition at `containerPath` at `index`, by the
 *  run rules of `insertIntoRuns` (`options.start` = head a new run there;
 *  `options.before` = take over the head slot of the node at `index`). */
export function insertNodes(
  root: SeamFile,
  containerPath: NodePath,
  index: number,
  nodes: Child[],
  options: InsertOptions = {},
): SeamFile {
  return updateCompAtPath(root, containerPath, (comp) => ({
    ...comp,
    children: insertIntoRuns(comp.children ?? [], index, nodes, options),
  }));
}

export function insertNode(
  root: SeamFile,
  containerPath: NodePath,
  index: number,
  node: Child,
  options: InsertOptions = {},
): SeamFile {
  return insertNodes(root, containerPath, index, [node], options);
}

/**
 * Move the nodes at `from` (in the given order — they land contiguous, in
 * that order) into the composition at `toContainer` at `toIndex`. Both are
 * interpreted against the *pre-removal* tree; the shift the removals cause is
 * compensated here. Run rules apply on both ends (a lifted head leaves its
 * `start`/`offset` to its successor; see `InsertOptions` for the landing).
 * Paths nested inside another moved node are ignored. No-ops when the
 * destination is inside a moved node's own subtree.
 *
 * Returns the new document plus the moved nodes' new paths (null = no-op).
 */
export function moveNodesTracked(
  root: SeamFile,
  from: NodePath[],
  toContainer: NodePath,
  toIndex: number,
  options: InsertOptions = {},
): { doc: SeamFile; paths: NodePath[] } | null {
  const paths = from.filter(
    (p, i) =>
      p.length > 0 &&
      p[p.length - 1].field !== "bin" &&
      !from.some((q, j) => j !== i && q.length < p.length && isPrefix(q, p)) &&
      from.findIndex((q) => samePath(q, p)) === i,
  );
  if (paths.some((p) => isPrefix(p, toContainer))) return null;
  const nodes: Child[] = [];
  for (const p of paths) {
    const node = getNodeAtPath(root, p);
    if (!node) return null;
    nodes.push(node);
  }
  if (nodes.length === 0) return null;

  const removed = removeNodesAtPaths(root, paths, false);
  const tc = adjustPathAfterRemovals(toContainer, paths);
  const tcKey = pathKey(toContainer);
  let ti = toIndex;
  for (const p of paths) {
    const split = splitLast(p)!;
    if (pathKey(split.parent) === tcKey && split.last.index < toIndex) ti -= 1;
  }
  const target = getCompAtPath(removed, tc);
  if (!target) return null;
  const siblings = target.children ?? [];
  ti = Math.max(0, Math.min(ti, siblings.length));
  // A new run slides to the next run boundary (see `insertIntoRuns`).
  if (options.start != null) ti = runBoundaryAtOrAfter(siblings, ti);
  const doc = insertNodes(removed, tc, ti, nodes, options);
  return {
    doc,
    paths: nodes.map((_, k) => [...tc, { field: "children" as const, index: ti + k }]),
  };
}

export function moveNodes(
  root: SeamFile,
  from: NodePath[],
  toContainer: NodePath,
  toIndex: number,
  options: InsertOptions = {},
): SeamFile {
  return moveNodesTracked(root, from, toContainer, toIndex, options)?.doc ?? root;
}

export function moveNode(
  root: SeamFile,
  from: NodePath,
  toContainer: NodePath,
  toIndex: number,
  options: InsertOptions = {},
): SeamFile {
  return moveNodes(root, [from], toContainer, toIndex, options);
}

/** Adjust `path` for the removal of every node in `removed` (all given in
 *  the same pre-removal coordinates): each segment drops by the number of
 *  removed earlier siblings in its array. */
export function adjustPathAfterRemovals(path: NodePath, removed: NodePath[]): NodePath {
  const next = path.map((s) => ({ ...s }));
  for (const r of removed) {
    const split = splitLast(r);
    if (!split) continue;
    const { parent, last } = split;
    if (path.length <= parent.length) continue;
    let under = true;
    for (let k = 0; k < parent.length; k++) {
      if (!segEq(path[k], parent[k])) {
        under = false;
        break;
      }
    }
    if (!under) continue;
    const seg = path[parent.length];
    if (seg.field === last.field && seg.index > last.index) next[parent.length].index -= 1;
  }
  return next;
}

/** Single-removal form of {@link adjustPathAfterRemovals}. */
export function adjustPathAfterRemoval(path: NodePath, removed: NodePath): NodePath {
  return adjustPathAfterRemovals(path, [removed]);
}

export function splitLast(
  path: NodePath,
): { parent: NodePath; last: PathSeg } | null {
  if (path.length === 0) return null;
  return { parent: path.slice(0, -1), last: path[path.length - 1] };
}

// ── Root-index adapters ──────────────────────────────────────────────
//
// A few tools that predate nesting (compose, bin, word, slice, transcribe)
// operate on root child indices. These map the path-key selection back and
// forth at the UI boundary, ignoring (filtering out) non-root selections.

/** The path key for the root child at index `i`. */
export function rootKeyFromIndex(i: number): string {
  return `children.${i}`;
}

/** Root child indices for the root-level keys in `keys`, in order. Nested
 *  keys (more than one segment) are dropped — root-only tools never see them. */
export function rootIndicesFromKeys(keys: string[]): number[] {
  const out: number[] = [];
  for (const key of keys) {
    const path = parsePath(key);
    if (path.length !== 1 || path[0].field === "bin") continue;
    out.push(path[0].index);
  }
  return out;
}

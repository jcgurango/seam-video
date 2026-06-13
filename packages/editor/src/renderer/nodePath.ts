// Centralized, position-path-keyed addressing for timeline nodes.
//
// A node is identified by a `NodePath`: a list of `{field, index}` segments
// from the root composition. `children.0`, `children.3.attachments.1`, etc.
// Serialized to a dotted string (`pathKey`) it doubles as a React key, a
// selection-set member, an expand-state key, and a "jump to JSON" path.
//
// The selection state in `App` is a flat `string[]` of these keys; the UI
// layer resolves each back to a node (or, for the root-only tools that
// predate nesting, to a flat root index via the adapters at the bottom).
//
// All mutators are pure `(SeamFile, …) → SeamFile` and immutable. The
// `editContainer` lens is the reuse hinge: it runs any existing
// `(Composition) → Composition` tool against the composition at a path,
// injecting the root bin so nested `binItem`s still resolve, then splices
// the result back. Regular vs nested vs (later) bin differ only in which
// path/lens is bound — the same wiring.

import type { BinEntry, Child, Composition, SeamFile } from "@seam/core";

export interface PathSeg {
  field: "children" | "attachments";
  index: number;
}

/** Path from the root composition to a node. Empty = the root itself. */
export type NodePath = PathSeg[];

/** Serialize to a dotted key: `children.3.attachments.1`. Root → "". */
export function pathKey(path: NodePath): string {
  return path.map((s) => `${s.field}.${s.index}`).join(".");
}

/** Inverse of `pathKey`. */
export function parsePath(key: string): NodePath {
  if (key === "") return [];
  const parts = key.split(".");
  const segs: NodePath = [];
  for (let i = 0; i + 1 < parts.length; i += 2) {
    const field = parts[i] === "attachments" ? "attachments" : "children";
    segs.push({ field, index: Number(parts[i + 1]) });
  }
  return segs;
}

export function samePath(a: NodePath, b: NodePath): boolean {
  return pathKey(a) === pathKey(b);
}

/** True when `prefix` is an ancestor-or-equal of `path`. */
export function isPrefix(prefix: NodePath, path: NodePath): boolean {
  if (prefix.length > path.length) return false;
  for (let i = 0; i < prefix.length; i++) {
    if (prefix[i].field !== path[i].field || prefix[i].index !== path[i].index)
      return false;
  }
  return true;
}

function childArray(node: Composition, field: PathSeg["field"]): Child[] {
  return (field === "children" ? node.children : node.attachments) ?? [];
}

/** The node at `path`, or undefined if any segment is missing. Root path
 *  ([]) returns undefined — the root isn't an addressable child. */
export function getNodeAtPath(
  root: SeamFile,
  path: NodePath,
): Child | undefined {
  let node: Child = root;
  for (const seg of path) {
    if (node.type !== "composition") return undefined;
    const arr = childArray(node, seg.field);
    const next = arr[seg.index];
    if (!next) return undefined;
    node = next;
  }
  return path.length === 0 ? undefined : node;
}

/** The composition at `containerPath` ([] = root), or undefined if the path
 *  doesn't land on a composition. */
export function getCompAtPath(
  root: SeamFile,
  containerPath: NodePath,
): Composition | undefined {
  if (containerPath.length === 0) return root;
  const node = getNodeAtPath(root, containerPath);
  return node && node.type === "composition" ? node : undefined;
}

/** Immutably replace the composition at `containerPath` ([] = root) with
 *  `fn`'s result. No-ops if the path doesn't resolve to a composition. */
export function updateCompAtPath(
  root: SeamFile,
  containerPath: NodePath,
  fn: (comp: Composition) => Composition,
): SeamFile {
  if (containerPath.length === 0) return fn(root);
  const [seg, ...rest] = containerPath;
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
  // Group by (container key, field) → indices.
  const groups = new Map<string, { path: NodePath; field: PathSeg["field"]; indices: number[] }>();
  for (const p of paths) {
    const split = splitLast(p);
    if (!split) continue;
    const key = `${pathKey(split.parent)}|${split.last.field}`;
    let g = groups.get(key);
    if (!g) {
      g = { path: split.parent, field: split.last.field, indices: [] };
      groups.set(key, g);
    }
    g.indices.push(split.last.index);
  }
  // Apply deepest-container-first so a parent removal doesn't invalidate a
  // child group's path. Deeper paths have longer keys → sort by path length
  // descending.
  const ordered = [...groups.values()].sort(
    (a, b) => b.path.length - a.path.length,
  );
  let doc = root;
  for (const g of ordered) {
    const desc = [...new Set(g.indices)].sort((a, b) => b - a);
    doc = updateCompAtPath(doc, g.path, (comp) =>
      spliceField(comp, g.field, (arr) => {
        const next = [...arr];
        for (const i of desc) next.splice(i, 1);
        return next;
      }),
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
function adjustPathAfterRemoval(path: NodePath, removed: NodePath): NodePath {
  const split = splitLast(removed);
  if (!split) return path;
  const { parent, last } = split;
  if (path.length <= parent.length) return path;
  for (let k = 0; k < parent.length; k++) {
    if (path[k].field !== parent[k].field || path[k].index !== parent[k].index)
      return path;
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

// Run-aware array edits.
//
// A composition's `children` is one array; a node lands at
// `(start ?? end of the previous node) + offset`. Nodes without `start`
// continue the previous node's *run*, so plain array splices silently change
// what a node is relative to. These helpers keep the two rules the editor
// promises:
//
//   • **Anchor transfer.** A run's placement (`start` + `offset`) belongs to
//     its head *slot*. Lift the head out and its successor inherits the pair
//     (so the rest of the run stays put); drop something `before` a head and
//     it takes the pair over (the old head becomes an ordinary member).
//   • **Dependent cascade** (delete only). A run whose head anchors to a
//     deleted node's id is deleted with it, transitively.
//
// Everything is a pure `Child[] → Child[]`.

import { startAnchorId, type Child, type Start } from "@seam/core";

type Placed = { id?: string; start?: Start; offset?: number };

function isHead(children: Child[], i: number): boolean {
  return i === 0 || (children[i] as Placed).start != null;
}

/** `node` with its placement pair replaced (undefined = key removed). */
export function withPlacement(
  node: Child,
  start: Start | undefined,
  offset: number | undefined,
): Child {
  const { start: _s, offset: _o, ...rest } = node as Child & Placed;
  return {
    ...rest,
    ...(start != null ? { start } : {}),
    ...(offset != null && offset !== 0 ? { offset } : {}),
  } as Child;
}

/** Remove the nodes at `remove`; a removed head's `start`/`offset` pass to
 *  the first surviving member of its run. */
export function removeFromRuns(children: Child[], remove: ReadonlySet<number>): Child[] {
  const out: Child[] = [];
  // Placement of a removed head still waiting for a surviving run member.
  let pending: { start?: Start; offset?: number } | null = null;
  for (let i = 0; i < children.length; i++) {
    const node = children[i] as Child & Placed;
    const head = isHead(children, i);
    if (head) pending = null;
    if (remove.has(i)) {
      if (head) pending = { start: node.start, offset: node.offset };
      continue;
    }
    if (pending) {
      out.push(withPlacement(node, pending.start, pending.offset));
      pending = null;
    } else {
      out.push(node);
    }
  }
  return out;
}

/** `remove` grown by every run whose head anchors (transitively) to a node
 *  being removed. */
export function withDependents(children: Child[], remove: ReadonlySet<number>): Set<number> {
  const all = new Set(remove);
  const removedIds = new Set<string>();
  const addIds = () => {
    for (const i of all) {
      const id = (children[i] as Placed).id;
      if (id) removedIds.add(id);
    }
  };
  addIds();
  let changed = true;
  while (changed) {
    changed = false;
    for (let h = 0; h < children.length; h++) {
      if (!isHead(children, h)) continue;
      const ref = startAnchorId((children[h] as Placed).start);
      if (ref == null || !removedIds.has(ref)) continue;
      // The whole run goes: the head would only hand the dangling anchor on.
      for (let i = h; i < children.length && (i === h || !isHead(children, i)); i++) {
        if (!all.has(i)) {
          all.add(i);
          changed = true;
        }
      }
    }
    if (changed) addIds();
  }
  return all;
}

export function removeWithDependents(children: Child[], remove: ReadonlySet<number>): Child[] {
  return removeFromRuns(children, withDependents(children, remove));
}

export interface InsertOptions {
  /** Head a NEW run: the first inserted node gets `start` (and no offset).
   *  The index slides right to the next run boundary so no run is split. */
  start?: Start;
  /** Dropping *before* the node at the insertion index. When that node heads
   *  a run, the first inserted node takes over its `start`/`offset` and it
   *  becomes a plain member. (Inserting at index 0 always behaves this way.)
   *  Without it the nodes extend the run of the node before the index. */
  before?: boolean;
}

/** Insert `nodes` contiguously at `index`. Inserted nodes lose any `start`
 *  of their own (they join a run, or head one via `options`); their `offset`s
 *  travel with them, except the first one's when it takes a head slot. */
export function insertIntoRuns(
  children: Child[],
  index: number,
  nodes: Child[],
  options: InsertOptions = {},
): Child[] {
  if (nodes.length === 0) return children;
  let at = Math.max(0, Math.min(index, children.length));
  const incoming = nodes.map((n) => {
    const p = n as Child & Placed;
    return p.start != null ? withPlacement(n, undefined, p.offset) : n;
  });
  const next = [...children];
  if (options.start != null) {
    // A new run never splits an existing one: slide to the next run boundary.
    at = runBoundaryAtOrAfter(next, at);
    incoming[0] = withPlacement(incoming[0], options.start, undefined);
    // Landing in front of the implicit head (first child, no `start`): pin it
    // at 0 explicitly so it doesn't join the new run.
    if (at === 0 && next.length > 0 && (next[0] as Placed).start == null) {
      next[0] = withPlacement(next[0], 0, (next[0] as Placed).offset);
    }
  } else if ((options.before || at === 0) && at < next.length && isHead(next, at)) {
    const target = next[at] as Child & Placed;
    incoming[0] = withPlacement(incoming[0], target.start, target.offset);
    next[at] = withPlacement(target, undefined, undefined);
  }
  next.splice(at, 0, ...incoming);
  return next;
}

/** Index at which a new run can be inserted without splitting an existing
 *  one: the end of the run containing `index − 1` (i.e. `index` moved right
 *  to the next head or the array end). */
export function runBoundaryAtOrAfter(children: Child[], index: number): number {
  let i = Math.max(0, Math.min(index, children.length));
  while (i < children.length && !isHead(children, i)) i++;
  return i;
}

/** Add `delta` seconds to the `offset` of each node at `indices`. Dumb on
 *  purpose: adjacent selected run members each get the delta.
 *
 *  With `clampDirection` (a Shift-drag) an offset never crosses zero within
 *  the operation: one that starts positive stops at 0 going down, one that
 *  starts negative stops at 0 going up, and one that starts at 0 may only
 *  move in `clampDirection` (the drag's first direction). */
export function shiftOffsets(
  children: Child[],
  indices: ReadonlySet<number>,
  delta: number,
  clampDirection?: 1 | -1,
): Child[] {
  if (delta === 0) return children;
  return children.map((node, i) => {
    if (!indices.has(i)) return node;
    const p = node as Child & Placed;
    const initial = p.offset ?? 0;
    let offset = +(initial + delta).toFixed(6);
    if (clampDirection != null) {
      const side = initial > 0 ? 1 : initial < 0 ? -1 : clampDirection;
      offset = side > 0 ? Math.max(0, offset) : Math.min(0, offset);
    }
    return offset === initial ? node : withPlacement(node, p.start, offset);
  });
}

/** Move the run `[head, end)` so it sits before the node currently at
 *  `index` (pre-move coordinates; snapped to a run boundary) — a pure z-order
 *  change. The implicit head (first child, no `start`) is pinned at `start: 0`
 *  whenever the move stops it being first, so it never joins another run. */
export function moveRun(children: Child[], head: number, end: number, index: number): Child[] {
  const to = runBoundaryAtOrAfter(children, index);
  if (to >= head && to <= end) return children;
  const src = [...children];
  // Either way the implicit head stops being first: leaving the front (it
  // would join whatever now precedes it) or being displaced from it (it would
  // join the run landing in front of it).
  if ((head === 0 || to === 0) && src.length > 0 && (src[0] as Placed).start == null) {
    src[0] = withPlacement(src[0], 0, (src[0] as Placed).offset);
  }
  const run = src.slice(head, end);
  const rest = [...src.slice(0, head), ...src.slice(end)];
  const at = to > head ? to - (end - head) : to;
  rest.splice(at, 0, ...run);
  return rest;
}

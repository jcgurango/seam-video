// Compose: wrap the selected nodes of one container into a new composition.
//
// The wrapper takes the FIRST selected node's slot (array order) and its
// slot-level fields (`LIFTED_FIELDS`: `start`, `offset`, `id`), so it lands
// exactly where that node was and inbound anchors to its id keep resolving.
// Inside the wrapper that node is the implicit head at 0.
//
// A run whose head anchors to an id that moves INSIDE the wrapper would
// dangle (anchors resolve per container), so such runs are pulled in too,
// transitively. Runs anchored to the lifted id stay outside — the wrapper
// carries that id now.
//
// Inside the wrapper a node keeps its `start` only when it anchors to another
// wrapped node; any other `start` (absolute, or an anchor left outside) is
// dropped and the node continues the previous one's run. So a slice of one
// run stays that run, and a scattered selection becomes one run in array
// order. Offsets always travel with their node.

import { startAnchorId, type Child, type Composition, type Start } from "@seam/core";
import { removeFromRuns, withPlacement } from "./runEdit.js";

type Placed = { id?: string; start?: Start; offset?: number };

/** Fields that describe the node's slot in its container — lifted from the
 *  first selected node to the wrapper. */
const LIFTED_FIELDS = ["start", "offset", "id"] as const;

function validSelection(children: readonly Child[], selected: readonly number[]): number[] {
  return [...new Set(selected)]
    .filter((i) => Number.isInteger(i) && i >= 0 && i < children.length)
    .sort((a, b) => a - b);
}

/** The indices Compose would wrap for `selected` (sorted ascending): the
 *  selection plus every run anchored, transitively, to an id that moves
 *  inside the wrapper. Empty when nothing valid is selected. */
export function walkComposeDependencies(
  children: readonly Child[],
  selected: readonly number[],
): number[] {
  const initial = validSelection(children, selected);
  if (initial.length === 0) return [];
  const first = initial[0];
  const wrapped = new Set(initial);
  const isHead = (i: number) => i === 0 || (children[i] as Placed).start != null;

  let changed = true;
  while (changed) {
    changed = false;
    const innerIds = new Set<string>();
    for (const i of wrapped) {
      const id = (children[i] as Placed).id;
      if (id && i !== first) innerIds.add(id);
    }
    for (let h = 0; h < children.length; h++) {
      if (!isHead(h)) continue;
      const ref = startAnchorId((children[h] as Placed).start);
      if (ref == null || !innerIds.has(ref)) continue;
      for (let i = h; i < children.length && (i === h || !isHead(i)); i++) {
        if (!wrapped.has(i)) {
          wrapped.add(i);
          changed = true;
        }
      }
    }
  }
  return [...wrapped].sort((a, b) => a - b);
}

export interface ComposeResult<T> {
  container: T;
  /** Index of the new composition in `container.children`. */
  index: number;
}

/** Wrap the nodes at `selected` (indices into `container.children`), plus
 *  their dependents, into one composition. Null when nothing valid is
 *  selected. */
export function applyCompose<T extends { children?: Child[] }>(
  container: T,
  selected: readonly number[],
): ComposeResult<T> | null {
  const children = container.children ?? [];
  const indices = walkComposeDependencies(children, selected);
  if (indices.length === 0) return null;
  const first = validSelection(children, selected)[0];

  const innerIds = new Set<string>();
  for (const i of indices) {
    const id = (children[i] as Placed).id;
    if (id && i !== first) innerIds.add(id);
  }

  const lifted: Record<string, unknown> = {};
  const inner = indices.map((i, k): Child => {
    const node = children[i];
    const placed = node as Child & Placed;
    if (i === first) {
      const rest = { ...(node as unknown as Record<string, unknown>) };
      for (const f of LIFTED_FIELDS) {
        if (rest[f] !== undefined) lifted[f] = rest[f];
        delete rest[f];
      }
      // Not the wrapper's first child (a pulled-in run sits below it in
      // z-order): pin it at 0 so it doesn't join that run.
      return (k === 0 ? rest : { ...rest, start: 0 }) as unknown as Child;
    }
    const ref = startAnchorId(placed.start);
    if (placed.start != null && (ref == null || !innerIds.has(ref))) {
      return withPlacement(node, undefined, placed.offset);
    }
    return node;
  });

  const wrapper = { type: "composition", children: inner, ...lifted } as Composition;

  // The wrapper takes the first selected node's slot as-is; every other
  // wrapped node leaves through the run-aware removal.
  const slotted = children.map((c, i) => (i === first ? wrapper : c));
  const remove = new Set(indices.filter((i) => i !== first));
  return {
    container: { ...container, children: removeFromRuns(slotted, remove) },
    index: first - indices.filter((i) => i < first).length,
  };
}

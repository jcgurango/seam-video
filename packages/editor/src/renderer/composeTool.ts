// Compose: take a contiguous range of children from a composition,
// collect every attachment whose start/end anchors land on any of those
// children (and recursively, any attachment whose anchors land on those
// already-collected attachments), then club the whole set into a new
// composition that replaces the contiguous range in the parent's
// `children`. The dependent attachments move out of the parent's
// `attachments` and into the new composition's `attachments`.
//
// Dependency walk extends the selection: if a collected attachment
// anchors to a child OUTSIDE the user's initial selection, the
// selection grows to a contiguous range that covers it (per user-chosen
// "fill the middle" rule). The caller is expected to confirm with the
// user when `extraChildren > 0` before applying.

import type { Child, Composition, SeamFile } from "@seam/core";

export interface ComposeWalk {
  /** Final set of child indices (sorted ascending). Always contiguous
   *  — the loop fills any gap created by extending the range. */
  childIndices: number[];
  /** Attachment indices to move into the new composition (sorted
   *  ascending — preserves z-order). */
  attachmentIndices: number[];
  /** How many extra children got pulled in beyond the user's initial
   *  selection. `> 0` means the caller should confirm before applying. */
  extraChildren: number;
}

function isContiguousAscending(sorted: number[]): boolean {
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i] !== sorted[i - 1] + 1) return false;
  }
  return true;
}

/** Returns true iff `initialChildIndices` is a non-empty, contiguous
 *  range. The Compose tool requires this because the result replaces a
 *  contiguous slice of the parent's `children` array. */
export function isComposableSelection(
  initialChildIndices: number[],
  childCount: number,
): boolean {
  if (initialChildIndices.length === 0) return false;
  for (const i of initialChildIndices) {
    if (i < 0 || i >= childCount) return false;
  }
  const sorted = [...initialChildIndices].sort((a, b) => a - b);
  return isContiguousAscending(sorted);
}

/** Walk attachment dependencies from `initialChildIndices`, extending
 *  the child range to fill any gap an anchor pulls in. Loops until
 *  stable so attachments-anchoring-attachments cascade correctly. */
export function walkComposeDependencies(
  parent: { children: readonly Child[]; attachments?: readonly Child[] },
  initialChildIndices: number[],
): ComposeWalk {
  const attachments = parent.attachments ?? [];
  const initialCount = new Set(initialChildIndices).size;

  // id → index lookups, scoped to the parent composition. Anchors can
  // reference either a child or an attachment.
  const childIdToIndex = new Map<string, number>();
  parent.children.forEach((c, i) => {
    const id = (c as { id?: string }).id;
    if (id != null) childIdToIndex.set(id, i);
  });
  const attachmentIdToIndex = new Map<string, number>();
  attachments.forEach((a, i) => {
    const id = (a as { id?: string }).id;
    if (id != null) attachmentIdToIndex.set(id, i);
  });

  const collectedChildren = new Set(initialChildIndices);
  const collectedAttachments = new Set<number>();

  const idOfChild = (i: number): string | undefined =>
    (parent.children[i] as { id?: string }).id;
  const idOfAttachment = (i: number): string | undefined =>
    (attachments[i] as { id?: string }).id;

  const anchorIdsOf = (a: Child): string[] => {
    const out: string[] = [];
    const sa = (a as { start?: { anchor?: string } }).start?.anchor;
    const ea = (a as { end?: { anchor?: string } }).end?.anchor;
    if (sa) out.push(sa);
    if (ea) out.push(ea);
    return out;
  };

  // Iterate to fixed-point: each round may collect new attachments
  // (which give the next round more covered ids) and extend the child
  // range (which may make further attachments dependent).
  let changed = true;
  while (changed) {
    changed = false;

    // Refresh the covered-id set from current collected indices.
    const coveredIds = new Set<string>();
    for (const i of collectedChildren) {
      const id = idOfChild(i);
      if (id) coveredIds.add(id);
    }
    for (const i of collectedAttachments) {
      const id = idOfAttachment(i);
      if (id) coveredIds.add(id);
    }

    // 1. New dependent attachments — anything anchored to a covered id.
    for (let i = 0; i < attachments.length; i++) {
      if (collectedAttachments.has(i)) continue;
      const ids = anchorIdsOf(attachments[i]);
      if (ids.some((id) => coveredIds.has(id))) {
        collectedAttachments.add(i);
        changed = true;
      }
    }

    // 2. Extend child range — if any collected attachment anchors to a
    //    child outside the current set, grow to the contiguous hull.
    let lo: number | null = null;
    let hi: number | null = null;
    for (const i of collectedChildren) {
      if (lo == null || i < lo) lo = i;
      if (hi == null || i > hi) hi = i;
    }
    for (const i of collectedAttachments) {
      for (const anchorId of anchorIdsOf(attachments[i])) {
        const childIdx = childIdToIndex.get(anchorId);
        if (childIdx == null) continue;
        if (collectedChildren.has(childIdx)) continue;
        // Grow the convex hull to cover this child.
        lo = lo == null ? childIdx : Math.min(lo, childIdx);
        hi = hi == null ? childIdx : Math.max(hi, childIdx);
      }
    }
    if (lo != null && hi != null) {
      for (let j = lo; j <= hi; j++) {
        if (!collectedChildren.has(j)) {
          collectedChildren.add(j);
          changed = true;
        }
      }
    }
  }

  const childIndices = [...collectedChildren].sort((a, b) => a - b);
  const attachmentIndices = [...collectedAttachments].sort((a, b) => a - b);
  return {
    childIndices,
    attachmentIndices,
    extraChildren: childIndices.length - initialCount,
  };
}

/** Apply the walk result: replace the contiguous child range with a new
 *  composition containing those children + the collected attachments;
 *  drop the collected attachments from the parent. */
export function applyCompose(
  doc: SeamFile,
  walk: ComposeWalk,
): SeamFile {
  const { childIndices, attachmentIndices } = walk;
  if (childIndices.length === 0) return doc;

  const start = childIndices[0];
  const end = childIndices[childIndices.length - 1];

  const newCompChildren = childIndices.map((i) => doc.children[i]);
  const allAttachments = doc.attachments ?? [];
  const newCompAttachments = attachmentIndices.map((i) => allAttachments[i]);

  const newComp: Composition = {
    type: "composition",
    children: newCompChildren,
  };
  if (newCompAttachments.length > 0) {
    newComp.attachments = newCompAttachments;
  }

  const newChildren = [
    ...doc.children.slice(0, start),
    newComp,
    ...doc.children.slice(end + 1),
  ];

  const droppedAttachmentSet = new Set(attachmentIndices);
  const newAttachments = allAttachments.filter(
    (_, i) => !droppedAttachmentSet.has(i),
  );

  if (newAttachments.length > 0) {
    return { ...doc, children: newChildren, attachments: newAttachments };
  }
  const { attachments: _drop, ...rest } = doc;
  return { ...rest, children: newChildren };
}

// ── Attachment compose ───────────────────────────────────────────────
//
// Composing an *attachment* is a different, deliberately narrow operation
// from composing children: it wraps a single attachment in a composition
// that takes over the node's slot in the parent. The wrapper inherits the
// fields that describe the node *as a slot in its parent* — its positioning
// anchors (`start`/`end`), its flex strategy (`overflow`/`underflow`, which
// only mean anything on the pinned-both-ends node, now the composition), and
// its identity (`id`, so inbound anchors — which resolve per-composition-
// scope — keep pointing at the same slot). Everything else (`source`,
// `in`/`out`, …) drops into the single inner child unchanged. No "magic":
// nothing else is lifted or inferred.

/** Fields that describe the node's slot in its parent — lifted to the
 *  wrapper. Everything else stays on the inner child. */
const LIFTED_FIELDS = ["start", "end", "id", "overflow", "underflow"] as const;

/** Wrap one attachment node in a composition, lifting its slot-level fields
 *  to the wrapper and leaving the rest as the inner child. */
function wrapAttachment(att: Child): Composition {
  const rest = { ...(att as unknown as Record<string, unknown>) };
  const lifted: Record<string, unknown> = {};
  for (const f of LIFTED_FIELDS) {
    if (rest[f] !== undefined) {
      lifted[f] = rest[f];
      delete rest[f];
    }
  }
  return {
    type: "composition",
    children: [rest as unknown as Child],
    ...lifted,
  } as Composition;
}

/** Replace each attachment at the given indices with its composition
 *  wrapper, in place (slots and ordering are unchanged). */
export function composeAttachments(
  doc: SeamFile,
  attachmentIndices: number[],
): SeamFile {
  if (attachmentIndices.length === 0) return doc;
  const atts = [...(doc.attachments ?? [])];
  let changed = false;
  for (const idx of attachmentIndices) {
    const att = atts[idx];
    if (!att) continue;
    atts[idx] = wrapAttachment(att);
    changed = true;
  }
  if (!changed) return doc;
  return { ...doc, attachments: atts };
}

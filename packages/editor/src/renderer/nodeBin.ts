// Bin support: a composition's `bin: BinEntry[]` field holds reusable
// bodies; any descendant composition can adopt one via `binItem: "<id>"`.
// Resolution is lexically scoped (nearest-enclosing wins) but the
// editor currently only edits the root composition, so the bin tool
// works against `doc.bin` directly. When child-composition editing
// arrives the same helpers can be extended to walk up the ancestor
// chain.

import type { BinEntry, Child, Composition, SeamFile } from "@seam/core";

export type { BinEntry };

/** Return the root composition's own bin (an empty array if absent). */
export function findBin(root: Composition): BinEntry[] {
  return root.bin ?? [];
}

/** Replace the root composition's bin. Empty arrays drop the field
 *  entirely so saved JSON stays clean when no bin is in use. */
export function withUpdatedBin(
  root: Composition,
  entries: BinEntry[],
): Composition {
  if (entries.length === 0) {
    const { bin: _drop, ...rest } = root;
    return rest as Composition;
  }
  return { ...root, bin: entries };
}

export function findBinItem(bin: BinEntry[], id: string): BinEntry | null {
  for (const entry of bin) if (entry.id === id) return entry;
  return null;
}

/** Returns the bin-item id this composition references, or null if it
 *  isn't a bin reference. */
export function binReferenceId(comp: Composition): string | null {
  return "binItem" in comp ? comp.binItem : null;
}

export function isBinReference(comp: Composition): boolean {
  return "binItem" in comp;
}

/** Rename a bin entry's id and rewrite every `binItem` reference in
 *  the document to match. Returns the input unchanged if `oldId` doesn't
 *  exist or `newId` collides with another entry. */
export function renameBinItemId(
  root: SeamFile,
  oldId: string,
  newId: string,
): SeamFile {
  if (oldId === newId) return root;
  const bin = findBin(root);
  if (!bin.some((e) => e.id === oldId)) return root;
  if (bin.some((e) => e.id === newId)) return root;
  const newBin = bin.map((e) => (e.id === oldId ? { ...e, id: newId } : e));
  const withRenamedBin = withUpdatedBin(root, newBin);
  return rewriteBinReferences(withRenamedBin, oldId, newId) as SeamFile;
}

function rewriteBinReferences(
  node: Composition,
  oldId: string,
  newId: string,
): Composition {
  let next: Composition = node;
  if (binReferenceId(node) === oldId) {
    next = { ...next, binItem: newId };
  }
  const newChildren = next.children?.map((child: Child) =>
    child.type === "composition"
      ? rewriteBinReferences(child, oldId, newId)
      : child,
  );
  const newAttachments = next.attachments?.map((child: Child) =>
    child.type === "composition"
      ? rewriteBinReferences(child, oldId, newId)
      : child,
  );
  return {
    ...next,
    ...(newChildren ? { children: newChildren } : {}),
    ...(newAttachments ? { attachments: newAttachments } : {}),
  };
}

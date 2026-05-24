// Bin tool: promote a selected composition into a reusable bin entry on
// the root composition's metadata, and replace the selected node with a
// bin reference pointing at the new entry. Instance-level fields
// (spatial, in/out, filters, other metadata) stay on the reference;
// only the structural body (children + attachments) moves into the bin.
//
// The reference also keeps the body verbatim so the saved document
// stays schema-valid (compositions need `children.length >= 1`) — the
// compile pass re-splices it on every load/save, but the on-disk form
// would otherwise be invalid the moment it's written.

import type { Composition, SeamFile } from "@seam/core";
import {
  BIN_ITEM_METADATA_KEY,
  findBin,
  isBinReference,
  withUpdatedBin,
  type BinEntry,
} from "./nodeBin.js";
import { findScript } from "./nodeScript.js";

/** Pick the next unused id of the form `bin-<n>` for a new entry. */
export function pickFreshBinId(existing: readonly BinEntry[]): string {
  const taken = new Set(existing.map((e) => e.id));
  let i = 1;
  while (taken.has(`bin-${i}`)) i++;
  return `bin-${i}`;
}

/** True if the composition at `index` in `doc.children` can be promoted
 *  to the bin: must be a plain composition (no script attached, not
 *  already a bin reference). */
export function canBin(doc: SeamFile, index: number): boolean {
  const child = doc.children[index];
  if (!child || child.type !== "composition") return false;
  if (isBinReference(child)) return false;
  if (findScript(child)) return false;
  return true;
}

export interface BinResult {
  doc: SeamFile;
  /** The id assigned to the new bin entry. The caller may want to
   *  surface this to the user (e.g. focus its row in the bin panel). */
  newId: string;
}

/** Promote the composition at `index` to a bin entry. Returns null if
 *  the operation isn't applicable. */
export function applyBin(doc: SeamFile, index: number): BinResult | null {
  if (!canBin(doc, index)) return null;
  const child = doc.children[index] as Composition;

  const existingBin = findBin(doc as Composition);
  const newId = pickFreshBinId(existingBin);

  const newEntry: BinEntry = { id: newId, children: child.children };
  if (child.attachments) newEntry.attachments = child.attachments;

  // Build the bin reference: keep every authored field on the reference
  // (spatial, in/out, filters, other metadata) and just add the bin-id
  // pointer to metadata. The body is preserved verbatim so the saved
  // doc remains valid until compile re-splices on next load.
  const newReference: Composition = {
    ...child,
    metadata: {
      ...(child.metadata ?? {}),
      [BIN_ITEM_METADATA_KEY]: newId,
    },
  };

  const newChildren = doc.children.slice();
  newChildren[index] = newReference;

  const withNewChildren: Composition = { ...doc, children: newChildren };
  const newDoc = withUpdatedBin(withNewChildren, [...existingBin, newEntry]);
  return { doc: newDoc as SeamFile, newId };
}

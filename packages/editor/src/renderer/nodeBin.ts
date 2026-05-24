// Bin support: the root composition can carry a `seam-editor-bin` entry in
// its metadata whose value is an array of `{ id, children, attachments? }`
// entries. Each entry is a reusable body that can be referenced from
// anywhere in the document by setting a composition's `metadata` to
// `{ "seam-editor-bin-item": "<id>" }`. A bin-reference composition's
// `children` + `attachments` are a *render* of the referenced bin entry
// (re-computed on every save), so editing the body directly is futile —
// the compile pass overwrites it.
//
// Bin entries are intentionally NOT full Composition nodes: only
// `children` + `attachments` live in the bin. Instance-level fields
// (spatial layout, in/out windowing, filters, metadata, etc.) live on
// each reference, which means swapping a bin entry can't accidentally
// reach out and overwrite a reference's authored properties.

import type { Child, Composition, Metadata, SeamFile } from "@seam/core";

export const BIN_METADATA_KEY = "seam-editor-bin";
export const BIN_ITEM_METADATA_KEY = "seam-editor-bin-item";

export interface BinEntry {
  id: string;
  children: Child[];
  attachments?: Child[];
}

/** Read the bin array out of a root composition's metadata. Returns an
 *  empty array (not null) if the field is missing so callers can iterate
 *  without checking. Malformed entries are skipped. */
export function findBin(root: Composition): BinEntry[] {
  const raw = root.metadata?.[BIN_METADATA_KEY];
  if (!Array.isArray(raw)) return [];
  const out: BinEntry[] = [];
  for (const entry of raw) {
    if (
      entry &&
      typeof entry === "object" &&
      typeof (entry as { id?: unknown }).id === "string" &&
      Array.isArray((entry as { children?: unknown }).children)
    ) {
      const e = entry as BinEntry;
      out.push({
        id: e.id,
        children: e.children,
        ...(e.attachments ? { attachments: e.attachments } : {}),
      });
    }
  }
  return out;
}

/** Write a new bin array back into the root composition's metadata,
 *  preserving any other metadata keys. Passing an empty array drops the
 *  field entirely (so saved JSON stays clean when the bin is unused). */
export function withUpdatedBin(
  root: Composition,
  entries: BinEntry[],
): Composition {
  const otherMeta: Metadata = { ...(root.metadata ?? {}) };
  delete otherMeta[BIN_METADATA_KEY];
  if (entries.length === 0) {
    const hasOther = Object.keys(otherMeta).length > 0;
    const { metadata: _drop, ...rest } = root;
    return hasOther ? { ...rest, metadata: otherMeta } : (rest as Composition);
  }
  return { ...root, metadata: { ...otherMeta, [BIN_METADATA_KEY]: entries } };
}

export function findBinItem(bin: BinEntry[], id: string): BinEntry | null {
  for (const entry of bin) if (entry.id === id) return entry;
  return null;
}

/** Returns the bin-item id this composition references, or null if it
 *  isn't a bin reference. */
export function binReferenceId(comp: Composition): string | null {
  const raw = comp.metadata?.[BIN_ITEM_METADATA_KEY];
  return typeof raw === "string" ? raw : null;
}

export function isBinReference(comp: Composition): boolean {
  return binReferenceId(comp) != null;
}

/** Splice a bin entry's body onto a bin-reference composition. The
 *  reference's authored fields (spatial, in/out, filters, metadata,
 *  etc.) are preserved verbatim — only `children` and `attachments` come
 *  from the bin entry. */
export function applyBinItemBody(
  reference: Composition,
  entry: BinEntry,
): Composition {
  const out: Composition = {
    ...reference,
    children: entry.children,
  };
  if (entry.attachments) out.attachments = entry.attachments;
  else delete (out as { attachments?: unknown }).attachments;
  return out;
}

/** Rename a bin entry's id and rewrite every `seam-editor-bin-item`
 *  reference in the document to match. Returns the input unchanged if
 *  `oldId` doesn't exist or `newId` collides with another entry. */
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

const SCRIPT_METADATA_KEY = "seam-editor-script";

function rewriteBinReferences(
  node: Composition,
  oldId: string,
  newId: string,
): Composition {
  let next: Composition = node;
  let metadata: Metadata | undefined = node.metadata;

  if (binReferenceId(node) === oldId) {
    metadata = { ...(metadata ?? {}), [BIN_ITEM_METADATA_KEY]: newId };
  }

  // Walk into the script payload's `original`: references buried inside
  // the user's authored source-of-truth also need to flip to the new id,
  // otherwise the script's next run rebuilds a body that points at the
  // now-missing old id.
  const scriptPayload = metadata?.[SCRIPT_METADATA_KEY];
  if (
    scriptPayload &&
    typeof scriptPayload === "object" &&
    "original" in (scriptPayload as Record<string, unknown>)
  ) {
    const payload = scriptPayload as { scriptSrc: string; original: unknown };
    const original = payload.original;
    if (
      original &&
      typeof original === "object" &&
      (original as { type?: unknown }).type === "composition"
    ) {
      const rewrittenOriginal = rewriteBinReferences(
        original as Composition,
        oldId,
        newId,
      );
      if (rewrittenOriginal !== original) {
        metadata = {
          ...(metadata ?? {}),
          [SCRIPT_METADATA_KEY]: { ...payload, original: rewrittenOriginal },
        };
      }
    }
  }

  if (metadata !== node.metadata) next = { ...next, metadata };

  const newChildren = next.children.map((child: Child) =>
    child.type === "composition"
      ? rewriteBinReferences(child, oldId, newId)
      : child,
  );
  const newAttachments = next.attachments?.map((child: Child) =>
    child.type === "composition"
      ? rewriteBinReferences(child, oldId, newId)
      : child,
  );
  return { ...next, children: newChildren, attachments: newAttachments };
}

import type { Composition, SeamFile } from "@seam/core";
import { removeFromComp } from "./nodePath.js";

/**
 * Selection indices are block-indices into the rendered timeline:
 *
 *   index ∈ [0, children.length)        → doc.children[index]
 *   index ∈ [children.length, total)    → doc.attachments[index − children.length]
 *
 * (Mirrors how the resolver appends attachments after sequential children
 * in the resolved timeline's `children` array.)
 */

export interface SplitSelection {
  childIndices: number[];
  attachmentIndices: number[];
}

export function splitSelection(
  doc: SeamFile,
  selectedIndices: number[]
): SplitSelection {
  const childCount = doc.children.length;
  const childIndices: number[] = [];
  const attachmentIndices: number[] = [];
  for (const i of selectedIndices) {
    if (i < childCount) childIndices.push(i);
    else attachmentIndices.push(i - childCount);
  }
  return { childIndices, attachmentIndices };
}

export function removeSelected(
  doc: SeamFile,
  selectedIndices: number[]
): SeamFile {
  const { childIndices, attachmentIndices } = splitSelection(
    doc,
    selectedIndices
  );
  // `removeFromComp` cascades: deleting a child also drops the attachments
  // anchored to it (transitively), so we don't leave dangling anchors behind.
  return removeFromComp(
    doc as Composition,
    new Set(childIndices),
    new Set(attachmentIndices),
  ) as SeamFile;
}

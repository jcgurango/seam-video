import type { SeamFile } from "@seam/core";

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
  const childDesc = [...childIndices].sort((a, b) => b - a);
  const attDesc = [...attachmentIndices].sort((a, b) => b - a);

  const newChildren = [...doc.children];
  for (const i of childDesc) newChildren.splice(i, 1);

  const newAttachments = [...(doc.attachments ?? [])];
  for (const i of attDesc) newAttachments.splice(i, 1);

  if (newAttachments.length > 0) {
    return { ...doc, children: newChildren, attachments: newAttachments };
  }
  // Drop the attachments field entirely when empty so saved files stay clean.
  const { attachments: _omit, ...rest } = doc;
  return { ...rest, children: newChildren };
}

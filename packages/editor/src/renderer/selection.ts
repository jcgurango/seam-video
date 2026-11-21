import type { SeamFile } from "@seam/core";
import { removeFromComp } from "./nodePath.js";

/** Delete the root children at `selectedIndices` (child indices — the
 *  resolved timeline is 1:1 with `doc.children`). Goes through
 *  `removeFromComp`, so a removed run head hands its `start`/`offset` to its
 *  successor and runs anchored to a removed node's id are deleted with it
 *  (transitively) — no dangling anchors left behind. */
export function removeSelected(
  doc: SeamFile,
  selectedIndices: number[],
): SeamFile {
  return removeFromComp(doc, new Set(selectedIndices));
}

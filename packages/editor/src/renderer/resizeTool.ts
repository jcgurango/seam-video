// Drag-resize a child via its left/right edge handle. Naive
// translation: cursor pixel delta / pxPerSec → seconds → directly mutate
// `in` / `out` / `duration`. No speed or duration-override math.
//
//   clip / audio                      → `in` (left)  / `out` (right)
//   composition (with `in` & `out`)   → `in` (left)  / `out` (right)
//   static / text / empty / data      → `duration` (left shrinks, right grows)
//
// Clamped at 0 lower bound; the upper bound (source media length) isn't
// known during a timeline drag, so it's left to the schema validator
// or to a later UX polish pass that probes media.

import { resolveComposition } from "@seam/core";
import type { Child, Composition, SeamFile } from "@seam/core";

export function resizeChild(
  doc: SeamFile,
  index: number,
  isAttachment: boolean,
  side: "left" | "right",
  deltaSec: number,
): SeamFile {
  const arr = (isAttachment ? doc.attachments : doc.children) ?? [];
  const child = arr[index];
  if (!child) return doc;
  const next = mutateChild(child, side, deltaSec);
  if (next === child) return doc;
  const newArr = [...arr];
  newArr[index] = next;
  if (isAttachment) {
    return { ...doc, attachments: newArr };
  }
  return { ...doc, children: newArr };
}

function mutateChild(
  child: Child,
  side: "left" | "right",
  deltaSec: number,
): Child {
  if (child.type === "clip" || child.type === "audio") {
    return resizeInOut(child, side, deltaSec);
  }
  if (child.type === "composition") {
    // A composition without an explicit window resizes by *adding* one:
    // default `in` to 0 and `out` to the inner timeline's natural
    // duration, so the first drag materialises the window the handle then
    // adjusts (instead of silently no-opping).
    const inVal = child.in ?? 0;
    const outVal = child.out ?? innerDuration(child);
    return resizeInOut({ ...child, in: inVal, out: outVal }, side, deltaSec);
  }
  // Static / text / empty / data: no source axis. Both handles just
  // adjust `duration` — left handle shrinks (drag right ⇒ shorter),
  // right handle grows (drag right ⇒ longer).
  const old = (child as { duration?: number }).duration ?? 0;
  const delta = side === "left" ? -deltaSec : deltaSec;
  const newDur = Math.max(0, old + delta);
  return { ...child, duration: newDur } as Child;
}

/** Natural duration of a composition's inner timeline (the un-windowed
 *  [0, innerDuration] the default `out` covers). Falls back to 0 if the
 *  composition can't be resolved. */
function innerDuration(comp: Composition): number {
  try {
    return resolveComposition(comp).duration;
  } catch {
    return 0;
  }
}

function resizeInOut<T extends { in: number; out: number }>(
  child: T,
  side: "left" | "right",
  deltaSec: number,
): T {
  if (side === "left") {
    const newIn = Math.max(0, Math.min(child.out, child.in + deltaSec));
    return { ...child, in: newIn };
  }
  const newOut = Math.max(child.in, child.out + deltaSec);
  return { ...child, out: newOut };
}

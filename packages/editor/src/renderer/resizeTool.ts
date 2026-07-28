// Drag-resize a child via its left/right edge handle. Cursor pixel delta /
// pxPerSec → output seconds → mutate `in` / `out` / `duration`.
//
//   clip / audio                      → `in` (left)  / `out` (right)
//   composition (with `in` & `out`)   → `in` (left)  / `out` (right)
//   static / text / empty / data      → `duration` (left shrinks, right grows)
//
// `in`/`out` are SOURCE seconds while the cursor delta is OUTPUT seconds, so
// nodes with a `speed` (or a `duration` override, whose rate is derived as
// `(out - in) / duration`) scale the delta by that rate — one second of
// cursor travel consumes `rate` seconds of source. A `duration` override is
// also adjusted by the applied output delta so the edge tracks the cursor at
// a constant playback rate.
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

function resizeInOut<
  T extends { in: number; out: number; speed?: number; duration?: number },
>(child: T, side: "left" | "right", deltaSec: number): T {
  // Source seconds consumed per output second. With a `duration` override
  // the rate is implied by the window; otherwise it's `speed` (default 1).
  const rawRate =
    child.duration != null && child.duration > 0
      ? (child.out - child.in) / child.duration
      : child.speed ?? 1;
  const rate = rawRate > 0 ? rawRate : 1;
  const sourceDelta = deltaSec * rate;
  if (side === "left") {
    const newIn = Math.max(0, Math.min(child.out, child.in + sourceDelta));
    // Applied output delta after clamping — keeps `duration` consistent when
    // the drag ran out of source headroom.
    const applied = (newIn - child.in) / rate;
    const next = { ...child, in: newIn };
    if (child.duration != null) {
      next.duration = Math.max(0, child.duration - applied);
    }
    return next;
  }
  const newOut = Math.max(child.in, child.out + sourceDelta);
  const applied = (newOut - child.out) / rate;
  const next = { ...child, out: newOut };
  if (child.duration != null) {
    next.duration = Math.max(0, child.duration + applied);
  }
  return next;
}

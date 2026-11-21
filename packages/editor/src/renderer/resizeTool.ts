// Drag-resize a child via its left/right edge handle. Cursor pixel delta /
// pxPerSec → output seconds → mutate `in` / `out` / `duration`.
//
//   clip / audio                      → `in` (left)  / `out` (right)
//   composition (with `in` & `out`)   → `in` (left)  / `out` (right)
//   everything else (static / text / data / rect / circle / map)
//                                     → `duration` (left shrinks, right grows)
//
// `in`/`out` are SOURCE seconds while the cursor delta is OUTPUT seconds, so
// the delta is scaled by the node's playback rate — one second of cursor
// travel consumes `rate` seconds of source. The rate is `speed` (default 1),
// except when a `duration` is being filled by the `stretch` strategy (the
// default for both `overflow` and `underflow`), where it is derived as
// `(out - in) / duration`. With a non-stretch strategy `duration` is just the
// output length and the rate stays `speed`. Either way an authored `duration`
// is adjusted by the applied output delta so the edge tracks the cursor at a
// constant playback rate.
//
// Only the node's own span changes — its `start`/`offset` are untouched, so
// a left-handle trim keeps the node's start in place and whatever follows it
// in the run moves with its end.
//
// Clamped at 0 lower bound; the upper bound (source media length) isn't
// known during a timeline drag, so it's left to the schema validator
// or to a later UX polish pass that probes media.

import { clipOut, compileSeamFile, resolveComposition, runHeadIndex } from "@seam/core";
import { withPlacement } from "./runEdit.js";
import type { Child, Composition, Overflow, Underflow, SeamFile } from "@seam/core";

export function resizeChild(
  doc: SeamFile,
  index: number,
  side: "left" | "right",
  deltaSec: number,
): SeamFile {
  const arr = doc.children ?? [];
  const child = arr[index];
  if (!child) return doc;
  const next = mutateChild(child, side, deltaSec);
  if (next === child) return doc;
  const newArr = [...arr];
  newArr[index] = next;
  return { ...doc, children: newArr };
}

/** Output length of `doc.children[index]` (bins inflated, scripts off, so
 *  `binItem` references measure their real body). */
function outputLength(doc: SeamFile, index: number): number | null {
  try {
    const r = resolveComposition(compileSeamFile(doc, { runScripts: false }).doc, {
      uncropped: true,
    }).children[index];
    return r ? r.timelineEnd - r.timelineStart : null;
  } catch {
    return null;
  }
}

/**
 * Shift-drag resize: the same edge trim as {@link resizeChild}, but the
 * length change is taken up by an `offset` so everything downstream stays
 * where it is (no ripple) — the dragged node's far edge included.
 *
 *  • **left** handle: the change goes onto the node's own `offset`, so its
 *    right edge holds still while the left edge follows the cursor.
 *  • **right** handle: walk backwards through the run from the node (itself
 *    included) to the first node that already has an `offset` and put the
 *    change there; with none, onto the run's head. The node's right edge —
 *    and so every follower — holds still.
 *
 * The change is measured from the resolved timeline, so rate, clamping and
 * `duration` handling all come from `resizeChild`.
 */
export function resizeChildInPlace(
  doc: SeamFile,
  index: number,
  side: "left" | "right",
  deltaSec: number,
): SeamFile {
  const resized = resizeChild(doc, index, side, deltaSec);
  if (resized === doc) return doc;
  const before = outputLength(doc, index);
  const after = outputLength(resized, index);
  if (before == null || after == null) return resized;
  // Shorter ⇒ push later by what was lost; longer ⇒ pull earlier.
  const shift = Math.round((before - after) * 1e6) / 1e6;
  if (shift === 0) return resized;

  const children = resized.children ?? [];
  let target = index;
  if (side === "right") {
    const head = runHeadIndex(children, index);
    while (target > head && !(children[target] as { offset?: number }).offset) target--;
  }
  const node = children[target] as Child & { start?: Child["start"]; offset?: number };
  const offset = Math.round(((node.offset ?? 0) + shift) * 1e6) / 1e6;
  const next = [...children];
  next[target] = withPlacement(node, node.start, offset);
  return { ...resized, children: next };
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
  // Static / text / data / shapes / map: no source axis. Both handles just
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

/** Source seconds consumed per output second. `speed` (default 1), unless a
 *  `duration` that differs from the natural length is filled by `stretch` —
 *  then the window is squeezed/stretched into it. */
function playbackRate(
  child: {
    in: number;
    speed?: number;
    duration?: number;
    overflow?: Overflow;
    underflow?: Underflow;
  },
  out: number,
): number {
  const speed = child.speed != null && child.speed > 0 ? child.speed : 1;
  if (child.duration == null || !(child.duration > 0)) return speed;
  const natural = (out - child.in) / speed;
  if (child.duration === natural) return speed;
  const strategy =
    child.duration < natural ? child.overflow ?? "stretch" : child.underflow ?? "stretch";
  if (strategy !== "stretch") return speed;
  const rate = (out - child.in) / child.duration;
  return rate > 0 ? rate : speed;
}

function resizeInOut<
  T extends {
    in: number;
    out?: number;
    speed?: number;
    duration?: number;
    overflow?: Overflow;
    underflow?: Underflow;
  },
>(child: T, side: "left" | "right", deltaSec: number): T {
  // `out` may be omitted on clips/audio (= in + duration); resolve it once.
  // A right-handle drag then materialises `out` on the node.
  const out = clipOut(child);
  const rate = playbackRate(child, out);
  const sourceDelta = deltaSec * rate;
  if (side === "left") {
    const newIn = Math.max(0, Math.min(out, child.in + sourceDelta));
    // Applied output delta after clamping — keeps `duration` consistent when
    // the drag ran out of source headroom.
    const applied = (newIn - child.in) / rate;
    const next = { ...child, in: newIn };
    if (child.duration != null) {
      next.duration = Math.max(0, child.duration - applied);
    }
    return next;
  }
  const newOut = Math.max(child.in, out + sourceDelta);
  const applied = (newOut - out) / rate;
  const next = { ...child, out: newOut };
  if (child.duration != null) {
    next.duration = Math.max(0, child.duration + applied);
  }
  return next;
}

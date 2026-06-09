// Translate "give me the state of this graphic at output-time t" into a
// concrete filled snapshot the renderer can draw. Pre-computes every
// keyframe (fillFrame is async — runs once per (graphic, frame)) and
// builds an extended keyframe list with ghost entries when loop=true,
// matching the seam semantics designed in @seam/motion-editor-test.

import { interpolateFrames, type FilledFrame, type FlatFrame } from "@seam/core";
import { fillFrame } from "./fill.js";

interface ExtKf {
  stamp: number;
  snap: FilledFrame;
  frameIdx: number;
  easing?: string;
}

export interface GraphicPlayback {
  filledFrames: FilledFrame[];
  extKfs: ExtKf[];
  duration: number;
  loop: boolean;
}

interface GraphicLike {
  duration?: number | string;
  loop?: boolean;
  frames: ReadonlyArray<ReadonlyArray<unknown>>;
}

/** Resolve a stamp (number or "<n>%" / "<n>% +- <n>") to seconds against
 *  the graphic's duration. Length strings without context fall back to 0. */
function resolveStamp(value: unknown, durationCtx: number): number {
  if (typeof value === "number") return value;
  if (typeof value !== "string") return 0;
  // Same regex shape as @seam/core's LengthSchema percent forms.
  const m = value.match(/^(-?\d+(?:\.\d+)?)%(?:\s*([+-])\s*(-?\d+(?:\.\d+)?))?$/);
  if (!m) return Number(value) || 0;
  const pct = Number(m[1]);
  const base = (pct / 100) * durationCtx;
  if (!m[2]) return base;
  const offset = Number(m[3]);
  return m[2] === "+" ? base + offset : base - offset;
}

function resolveDuration(
  authored: GraphicLike,
  lastStamp: number,
): number {
  if (typeof authored.duration === "number" && authored.duration > 0) {
    return authored.duration;
  }
  if (typeof authored.duration === "string") {
    // Percent stamps make no sense for the duration itself (no parent
    // context here). Fall back to last keyframe.
  }
  return lastStamp;
}

/** Eagerly fill every keyframe once and return the playback handle. */
export async function precomputeGraphicPlayback(
  authored: GraphicLike,
): Promise<GraphicPlayback> {
  const frames = authored.frames as ReadonlyArray<
    ReadonlyArray<unknown> & { 0: unknown; 1: ReadonlyArray<unknown>; 2?: string }
  >;
  // First pass with a placeholder duration just to surface the raw
  // stamp ordering, then a second pass once we know `duration`.
  const rawStamps = frames.map((f) => (typeof f[0] === "number" ? f[0] : 0));
  const rawLast = rawStamps[rawStamps.length - 1] ?? 0;
  const duration = resolveDuration(authored, rawLast);

  const filledFrames: FilledFrame[] = await Promise.all(
    frames.map((f, i) => fillFrame(f[1] as unknown[], i)),
  );
  const stamps = frames.map((f) => resolveStamp(f[0], duration));
  const easings = frames.map((f) => f[2]);
  const firstStamp = stamps[0] ?? 0;
  const lastStamp = stamps[stamps.length - 1] ?? 0;
  const loop = authored.loop === true && duration > 0 && filledFrames.length >= 1;

  const extKfs: ExtKf[] = filledFrames.map((snap, i) => ({
    stamp: stamps[i],
    snap,
    frameIdx: i,
    easing: easings[i],
  }));
  if (loop && filledFrames.length >= 1) {
    const lastIdx = filledFrames.length - 1;
    extKfs.unshift({
      stamp: lastStamp - duration,
      snap: filledFrames[lastIdx],
      frameIdx: lastIdx,
      easing: easings[lastIdx],
    });
    extKfs.push({
      stamp: duration + firstStamp,
      snap: filledFrames[0],
      frameIdx: 0,
      easing: easings[0],
    });
  }
  extKfs.sort((a, b) => a.stamp - b.stamp);

  return { filledFrames, extKfs, duration, loop };
}

/** Snapshot of the graphic at local time `t`. Returns the flat path-keyed
 *  state map the renderer iterates to draw individual objects. */
export function snapshotAt(playback: GraphicPlayback, t: number): FlatFrame {
  const { extKfs, duration, loop } = playback;
  if (extKfs.length === 0) return {};
  let local = t;
  if (loop) {
    local = ((local % duration) + duration) % duration;
  } else if (local <= extKfs[0].stamp) {
    return { ...extKfs[0].snap.flat };
  } else if (local >= extKfs[extKfs.length - 1].stamp) {
    return { ...extKfs[extKfs.length - 1].snap.flat };
  }
  if (extKfs.length === 1) return { ...extKfs[0].snap.flat };
  let prevIdx = 0;
  for (let i = 0; i < extKfs.length - 1; i++) {
    if (extKfs[i].stamp <= local && local < extKfs[i + 1].stamp) {
      prevIdx = i;
      break;
    }
  }
  const nextIdx = prevIdx + 1;
  const span = extKfs[nextIdx].stamp - extKfs[prevIdx].stamp;
  const pairT = span > 0 ? (local - extKfs[prevIdx].stamp) / span : 0;
  return interpolateFrames(
    extKfs[prevIdx].snap,
    extKfs[nextIdx].snap,
    pairT,
    extKfs[prevIdx].easing,
  );
}

/** Returns true when no interpolation occurs across the graphic's
 *  duration (either zero/one keyframe or all keyframes identical). The
 *  caller can short-circuit to a single PNG render. */
export function isStatic(playback: GraphicPlayback): boolean {
  if (playback.loop) return false;
  if (playback.filledFrames.length <= 1) return true;
  // Equality check skipped — false positives only force one extra
  // animated render, no correctness issue.
  return false;
}

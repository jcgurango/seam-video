// Sub-clip playback for graphics — node-side port of the same engine we
// designed in motion-editor-test. Outer-time → per-Clip local time →
// clipDef snapshot → walk-and-apply onto the clipDef's frame-0 tree to
// produce a list of fabric specs the renderer turns into a Group.
//
// Anchors come from the *raw authored* outer frames (not the filled
// snapshots), because the rule "startPosition continues unless re-anchored"
// requires distinguishing "explicitly authored at 0" from "missing /
// defaulted to 0". The filled snapshot can't tell the two apart.

import { interpolateFrames, type FilledFrame, type FlatFrame } from "@seam/core";
import { fillFrame } from "./fill.js";

export interface ClipDefLike {
  id: string;
  duration?: number | string;
  loop?: boolean;
  contentWidth?: number | string;
  contentHeight?: number | string;
  frames: ReadonlyArray<ReadonlyArray<unknown>>;
}

interface ClipExtKf {
  stamp: number;
  snap: FilledFrame;
  frameIdx: number;
  easing?: string;
}

export interface ClipPlayback {
  filledFrames: FilledFrame[];
  extKfs: ClipExtKf[];
  duration: number;
  loop: boolean;
  contentWidth: number;
  contentHeight: number;
}

function asNumber(v: unknown, fallback: number): number {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return fallback;
}

/** Fill every keyframe in a clip definition once. extKfs include the
 *  loop ghosts so pair-search at the seam is uniform. */
export async function precomputeClipPlayback(
  clipDef: ClipDefLike,
): Promise<ClipPlayback> {
  const frames = clipDef.frames;
  const filledFrames = await Promise.all(
    frames.map((f, i) => fillFrame(f[1] as unknown[], i)),
  );
  const stamps = frames.map((f) => asNumber(f[0], 0));
  const easings = frames.map((f) => f[2] as string | undefined);
  const firstStamp = stamps[0] ?? 0;
  const lastStamp = stamps[stamps.length - 1] ?? 0;
  const duration =
    typeof clipDef.duration === "number" && clipDef.duration > 0
      ? clipDef.duration
      : lastStamp;
  const loop =
    clipDef.loop === true && duration > 0 && filledFrames.length >= 1;

  const extKfs: ClipExtKf[] = filledFrames.map((snap, i) => ({
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

  return {
    filledFrames,
    extKfs,
    duration,
    loop,
    contentWidth: asNumber(clipDef.contentWidth, 0),
    contentHeight: asNumber(clipDef.contentHeight, 0),
  };
}

/** Schedule of authored startPosition values for a single Clip instance,
 *  identified by its hierarchical path in the outer graphic. */
export type ClipAnchor = { outerT: number; startPosition: number };

export function getClipAnchorsAtPath(
  outerFrames: ReadonlyArray<ReadonlyArray<unknown>>,
  clipPath: string,
): ClipAnchor[] {
  const anchors: ClipAnchor[] = [];
  const parts = clipPath.split(".");
  for (const f of outerFrames) {
    const outerT = f[0] as number;
    const objs = f[1] as ReadonlyArray<unknown>;
    const found = walkAuthoredToPath(objs, parts, 0);
    if (
      found &&
      typeof (found as { startPosition?: unknown }).startPosition === "number"
    ) {
      anchors.push({
        outerT,
        startPosition: (found as { startPosition: number }).startPosition,
      });
    }
  }
  return anchors;
}

function walkAuthoredToPath(
  nodes: ReadonlyArray<unknown>,
  parts: ReadonlyArray<string>,
  depth: number,
): Record<string, unknown> | null {
  if (depth >= parts.length) return null;
  const target = parts[depth];
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i] as Record<string, unknown>;
    const id = node.id;
    const key = typeof id === "string" && id.length > 0 ? id : String(i);
    if (key !== target) continue;
    if (depth === parts.length - 1) return node;
    const children = node.objects;
    if (!Array.isArray(children)) return null;
    return walkAuthoredToPath(children, parts, depth + 1);
  }
  return null;
}

export function computeLocalTime(
  anchors: ReadonlyArray<ClipAnchor>,
  outerT: number,
  duration: number,
  repeat: number,
): number {
  let anchor: ClipAnchor = { outerT: 0, startPosition: 0 };
  for (const a of anchors) {
    if (a.outerT <= outerT) anchor = a;
    else break;
  }
  const elapsed = anchor.startPosition + (outerT - anchor.outerT);
  if (duration <= 0) return anchor.startPosition;
  if (repeat === -1) {
    return ((elapsed % duration) + duration) % duration;
  }
  const cyclesTotal = repeat + 1;
  if (elapsed >= duration * cyclesTotal) return duration;
  return elapsed % duration;
}

export function clipSnapAtLocalTime(
  playback: ClipPlayback,
  localTime: number,
): FlatFrame {
  const { extKfs } = playback;
  if (extKfs.length === 0) return {};
  if (extKfs.length === 1) return { ...extKfs[0].snap.flat };
  if (localTime <= extKfs[0].stamp) return { ...extKfs[0].snap.flat };
  if (localTime >= extKfs[extKfs.length - 1].stamp) {
    return { ...extKfs[extKfs.length - 1].snap.flat };
  }
  let prevIdx = 0;
  for (let i = 0; i < extKfs.length - 1; i++) {
    if (extKfs[i].stamp <= localTime && localTime < extKfs[i + 1].stamp) {
      prevIdx = i;
      break;
    }
  }
  const nextIdx = prevIdx + 1;
  const span = extKfs[nextIdx].stamp - extKfs[prevIdx].stamp;
  const pairT = span > 0 ? (localTime - extKfs[prevIdx].stamp) / span : 0;
  return interpolateFrames(
    extKfs[prevIdx].snap,
    extKfs[nextIdx].snap,
    pairT,
    extKfs[prevIdx].easing,
  );
}

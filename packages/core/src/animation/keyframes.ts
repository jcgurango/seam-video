// Keyframe types and sampler. A property is "animated" when its value is
// an array whose first element is itself an array — the discriminator that
// distinguishes  [[time, value, easing?], ...]  from any static value
// (numbers, strings, padding tuples, etc.).

import { interpolateNumber, interpolateRgb } from "d3-interpolate";
import { resolveEasing } from "./easing.js";
import { resolveTimeExpr, type TimeExpr } from "./time.js";
import { resolveLength } from "../layout/units.js";
import type { TextPadding } from "../types.js";

export type Keyframe<T> = [TimeExpr, T] | [TimeExpr, T, string];
export type Keyframed<T> = T | Keyframe<T>[];

export function isKeyframed<T>(v: Keyframed<T>): v is Keyframe<T>[] {
  return Array.isArray(v) && v.length > 0 && Array.isArray(v[0]);
}

interface Frame<R> {
  time: number;
  value: R;
  ease: string | undefined;
}

function buildFrames<T, R>(
  kfs: Keyframe<T>[],
  duration: number,
  project: (v: T) => R
): Frame<R>[] {
  if (kfs.length === 0) {
    throw new Error("Keyframe array must contain at least one entry");
  }
  const frames: Frame<R>[] = kfs.map((kf) => ({
    time: resolveTimeExpr(kf[0], duration),
    value: project(kf[1]),
    ease: kf[2],
  }));
  frames.sort((a, b) => a.time - b.time);
  return frames;
}

function sampleFrames<R>(
  frames: Frame<R>[],
  t: number,
  interpolate: (a: R, b: R, fraction: number) => R
): R {
  if (t <= frames[0].time) return frames[0].value;
  const last = frames[frames.length - 1];
  if (t >= last.time) return last.value;
  for (let i = 0; i < frames.length - 1; i++) {
    const a = frames[i];
    const b = frames[i + 1];
    if (t >= a.time && t <= b.time) {
      if (b.time === a.time) return b.value;
      const fraction = (t - a.time) / (b.time - a.time);
      const eased = resolveEasing(b.ease)(fraction);
      return interpolate(a.value, b.value, eased);
    }
  }
  return last.value;
}

// ── Per-type samplers ──────────────────────────────────────────────

export function sampleNumber(
  value: Keyframed<number>,
  t: number,
  duration: number
): number {
  if (!isKeyframed(value)) return value as number;
  const frames = buildFrames(value, duration, (v) => v);
  return sampleFrames(frames, t, (a, b, f) => a + (b - a) * f);
}

export function sampleColor(
  value: Keyframed<string>,
  t: number,
  duration: number
): string {
  if (!isKeyframed(value)) return value as string;
  const frames = buildFrames(value, duration, (v) => v);
  return sampleFrames(frames, t, (a, b, f) => interpolateRgb(a, b)(f));
}

// Padding can be a single number, [v, h], or [t, r, b, l]. Mixed shapes
// across keyframes are upcast to the 4-tuple form before interpolation —
// otherwise we'd be interpolating between arrays of different lengths.
export function samplePadding(
  value: Keyframed<TextPadding>,
  t: number,
  duration: number
): TextPadding {
  if (!isKeyframed(value)) return value as TextPadding;
  const expand = (p: TextPadding): [number, number, number, number] => {
    if (typeof p === "number") return [p, p, p, p];
    if (p.length === 2) return [p[0], p[1], p[0], p[1]];
    return p;
  };
  const frames = buildFrames(value, duration, expand);
  return sampleFrames(frames, t, (a, b, f) => [
    a[0] + (b[0] - a[0]) * f,
    a[1] + (b[1] - a[1]) * f,
    a[2] + (b[2] - a[2]) * f,
    a[3] + (b[3] - a[3]) * f,
  ]);
}

// Length expression: `number | "<n>%" | "<n>% +- <n>"`. Both forms must
// collapse to pixels (relative to `referenceSize`) before interpolating,
// otherwise mixing percentages and pixel offsets across keyframes would
// produce nonsense values mid-tween. `percentDefault` is the property's
// fallback percent when the input is a bare number — 50 for origin /
// translation (center), 0 for size / contentWidth (literal pixels).
export function sampleLength(
  value: Keyframed<number | string>,
  t: number,
  duration: number,
  referenceSize: number,
  percentDefault: number,
): number {
  if (!isKeyframed(value))
    return resolveLength(value as number | string, referenceSize, percentDefault);
  const frames = buildFrames(value, duration, (v) =>
    resolveLength(v, referenceSize, percentDefault),
  );
  return sampleFrames(frames, t, (a, b, f) => a + (b - a) * f);
}

// Generic numeric sampler that already-prepared frames (used when the same
// keyframe set is sampled many times — currently unused but cheap to keep).
export { interpolateNumber };

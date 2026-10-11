// Keyframe types and sampler. A property is "animated" when its value is
// an array whose first element is itself an array — the discriminator that
// distinguishes  [[time, value, easing?], ...]  from any static value
// (numbers, strings, padding tuples, etc.).

import { interpolateNumber, interpolateRgb } from "d3-interpolate";
import { resolveEasing } from "./easing.js";
import { resolveTimeExpr, type TimeExpr } from "./time.js";
import { resolveLength } from "../layout/units.js";
import type { Distort, Inset, Length, TextPadding } from "../types.js";

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

// Volume: a linear gain multiplier or a decibel string ("25dB", "-25.5dB").
// dB is converted to linear gain (10^(dB/20)) before interpolation, so a
// keyframe set may freely mix linear and dB values and the tween stays linear
// in gain — matching how plain numeric volumes already interpolate.
const DB_RE = /^([+-]?\d+(?:\.\d+)?)\s*dB$/i;

/** Decibels → linear gain. 0dB = 1, +6dB ≈ 2×, -∞ → 0. */
export function dbToGain(db: number): number {
  return Math.pow(10, db / 20);
}

/** Resolve a single volume value (linear number or "<n>dB" string) to linear
 *  gain. Unrecognized strings fall back to unity so a typo never silences. */
export function resolveVolume(value: number | string): number {
  if (typeof value === "number") return value;
  const m = DB_RE.exec(value.trim());
  if (m) return dbToGain(parseFloat(m[1]));
  const n = Number(value);
  return Number.isFinite(n) ? n : 1;
}

export function sampleVolume(
  value: Keyframed<number | string>,
  t: number,
  duration: number
): number {
  if (!isKeyframed(value)) return resolveVolume(value as number | string);
  const frames = buildFrames(value, duration, resolveVolume);
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

// Inset: per-edge crop in the text-padding shorthand shape (`L` | `[v,h]` |
// `[t,r,b,l]`), but Length-valued. Each edge resolves through `sampleLength`
// against its axis (left/right → refW, top/bottom → refH), so `%`/px/combos
// and keyframing all work. Returns the four edges in pixels.
export function sampleInset(
  value: Keyframed<Inset>,
  t: number,
  duration: number,
  refW: number,
  refH: number,
): { top: number; right: number; bottom: number; left: number } {
  if (!isKeyframed(value)) {
    const e = expandInset(value as Inset);
    return {
      top: resolveLength(e[0], refH, 0),
      right: resolveLength(e[1], refW, 0),
      bottom: resolveLength(e[2], refH, 0),
      left: resolveLength(e[3], refW, 0),
    };
  }
  const kf = value as Keyframe<Inset>[];
  // Project the keyframed shorthand onto one edge → Keyframed<Length>, then
  // sample (same trick `sampleAxis` uses for Point2D).
  const edge = (i: number, ref: number): number => {
    const projected = kf.map((entry) => {
      const len = expandInset(entry[1])[i];
      return entry.length === 3
        ? ([entry[0], len, entry[2]] as [TimeExpr, Length, string])
        : ([entry[0], len] as [TimeExpr, Length]);
    });
    return sampleLength(projected, t, duration, ref, 0);
  };
  return {
    top: edge(0, refH),
    right: edge(1, refW),
    bottom: edge(2, refH),
    left: edge(3, refW),
  };
}

// Distort: corner-pin of the content canvas. Eight optional Lengths, one per
// corner coordinate (clockwise from top-left). Each resolves through
// `sampleLength` against its axis (x → refW, y → refH) with the corner's OWN
// natural position as the percent default — so an absent entry sits at the
// corner, `"100% - 20"` and a bare `-20` both pull it in 20px, and keyframes
// tween every coordinate in pixels (the whole set animates as one value).

/** Sampled distort corners in content-canvas pixels, clockwise from top-left. */
export interface DistortCorners {
  x0: number; y0: number;
  x1: number; y1: number;
  x2: number; y2: number;
  x3: number; y3: number;
}

const DISTORT_KEYS = ["x0", "y0", "x1", "y1", "x2", "y2", "x3", "y3"] as const;
/** Natural corner position (percent of the axis) for each coordinate —
 *  TL (0,0), TR (100,0), BR (100,100), BL (0,100). */
const DISTORT_DEFAULT_PCT = [0, 0, 100, 0, 100, 100, 0, 100] as const;

export function sampleDistort(
  value: Keyframed<Distort>,
  t: number,
  duration: number,
  refW: number,
  refH: number,
): DistortCorners {
  const out = {} as DistortCorners;
  for (let i = 0; i < DISTORT_KEYS.length; i++) {
    const key = DISTORT_KEYS[i];
    const ref = i % 2 === 0 ? refW : refH;
    const pct = DISTORT_DEFAULT_PCT[i];
    if (!isKeyframed(value)) {
      const v = (value as Distort)[key];
      out[key] = v == null ? (pct / 100) * ref : resolveLength(v, ref, pct);
      continue;
    }
    const projected = (value as Keyframe<Distort>[]).map((entry) => {
      const len: Length = entry[1][key] ?? `${pct}%`;
      return entry.length === 3
        ? ([entry[0], len, entry[2]] as [TimeExpr, Length, string])
        : ([entry[0], len] as [TimeExpr, Length]);
    });
    out[key] = sampleLength(projected, t, duration, ref, pct);
  }
  return out;
}

/** True when the corners sit exactly on the canvas rect — nothing to warp. */
export function isIdentityDistort(c: DistortCorners, w: number, h: number): boolean {
  return (
    c.x0 === 0 && c.y0 === 0 &&
    c.x1 === w && c.y1 === 0 &&
    c.x2 === w && c.y2 === h &&
    c.x3 === 0 && c.y3 === h
  );
}

/** Expand the inset shorthand to `[top, right, bottom, left]`. */
function expandInset(v: Inset): [Length, Length, Length, Length] {
  if (typeof v === "number" || typeof v === "string") return [v, v, v, v];
  if (v.length === 2) return [v[0], v[1], v[0], v[1]];
  return v;
}

// Generic numeric sampler that already-prepared frames (used when the same
// keyframe set is sampled many times — currently unused but cheap to keep).
export { interpolateNumber };

// Bake a `Keyframed<…>` value into a piecewise-linear sample series and
// compile it into MLT's keyframed-property syntax (`<frame>=<value>`).
// Sampling uses the same easing/interpolation engine the editor preview
// uses (`sampleNumber` from core), so the rendered curve matches the
// preview's curve — easings are "compiled into" the samples, and the
// MLT keyframe string itself only carries values at frame boundaries,
// leaving MLT to do nothing more than linear interp.

import {
  isKeyframed,
  sampleNumber,
  type Keyframed,
} from "@seam/core";

/** Pre-baked sample series — strictly increasing `t` in seconds. */
export interface PwlSamples {
  duration: number;
  /** ≥1 entry. A single entry is a constant "static" value. */
  samples: Array<{ t: number; v: number }>;
}

/** Bake a numeric Keyframed value into PWL samples at `fps` resolution.
 *  Static values collapse to a one-sample series. Animated values get
 *  one sample per output frame from t=0 to t=duration (inclusive). */
export function bakePwl(
  value: Keyframed<number>,
  duration: number,
  fps: number,
): PwlSamples {
  if (!isKeyframed(value)) {
    return { duration, samples: [{ t: 0, v: value as number }] };
  }
  return { duration, samples: sampleSeries(duration, fps, (t) => sampleNumber(value, t, duration)) };
}

function sampleSeries(
  duration: number,
  fps: number,
  sampler: (t: number) => number,
): Array<{ t: number; v: number }> {
  const out: Array<{ t: number; v: number }> = [];
  const step = 1 / fps;
  for (let t = 0; t <= duration + step / 2; t += step) {
    const tc = Math.min(t, duration);
    out.push({ t: tc, v: sampler(tc) });
  }
  const last = out[out.length - 1];
  if (last.t < duration) out.push({ t: duration, v: sampler(duration) });
  return collapseConstant(out);
}

/** If every sample is within `eps` of the first one, collapse to a
 *  single-sample series. Lets the rest of the pipeline treat
 *  effectively-static values as constants — important because
 *  `bakeSpatialPwl` always samples all four axes even when only one is
 *  animated, and the unchanged axes would otherwise emit thousands of
 *  redundant keyframes. */
function collapseConstant(
  samples: Array<{ t: number; v: number }>,
  eps: number = 1e-6,
): Array<{ t: number; v: number }> {
  if (samples.length <= 1) return samples;
  const v0 = samples[0].v;
  for (let i = 1; i < samples.length; i++) {
    if (Math.abs(samples[i].v - v0) > eps) return samples;
  }
  return [{ t: 0, v: v0 }];
}

/** Whether a baked PWL is effectively a constant. */
export function isConstant(pwl: PwlSamples): boolean {
  return pwl.samples.length === 1;
}

// ── MLT keyframe-property compiler ────────────────────────────────

/** Format a number for MLT property values. Trims trailing zeros so
 *  `0.500000` becomes `0.5`, but always keeps at least one decimal-free
 *  integer rendering for whole numbers. */
function fnum(n: number): string {
  if (!Number.isFinite(n)) return "0";
  return n.toFixed(6).replace(/0+$/, "").replace(/\.$/, "");
}

/** Compile a PWL into an ffmpeg expression in the variable `t`
 *  (seconds), used by the volume filter's `eval=frame` mode for
 *  animated audio gain. Linear interpolation between adjacent samples
 *  (easings are baked in at sample time), held outside the
 *  keyframed range. Structured as a balanced binary tree of
 *  `if(lt(t, …))` so depth stays O(log N) — long PWLs blow past
 *  ffmpeg's expression parser depth otherwise. */
export function pwlToExpression(pwl: PwlSamples, tShift: number = 0): string {
  const s = pwl.samples;
  if (s.length === 1) return fnum(s[0].v);
  const tVar = tShift === 0 ? "t" : `(t-${fnum(tShift)})`;
  const lerpSegment = (i: number): string => {
    const a = s[i];
    const b = s[i + 1];
    const dt = b.t - a.t;
    if (dt <= 0) return fnum(b.v);
    return `(${fnum(a.v)}+(${fnum(b.v - a.v)})*(${tVar}-${fnum(a.t)})/${fnum(dt)})`;
  };
  const buildTree = (lo: number, hi: number): string => {
    if (lo === hi - 1) return lerpSegment(lo);
    const mid = (lo + hi) >> 1;
    return `if(lt(${tVar},${fnum(s[mid].t)}),${buildTree(lo, mid)},${buildTree(mid, hi)})`;
  };
  const inner = buildTree(0, s.length - 1);
  const firstT = fnum(s[0].t);
  const lastT = fnum(s[s.length - 1].t);
  const firstV = fnum(s[0].v);
  const lastV = fnum(s[s.length - 1].v);
  return `if(lt(${tVar},${firstT}),${firstV},if(lt(${tVar},${lastT}),${inner},${lastV}))`;
}

/** Compile a numeric PWL into MLT's keyframed-property syntax —
 *  `<frame>=<value>;<frame>=<value>;…`. Static (single-sample) PWLs
 *  return just the bare value so the property reads as a constant.
 *
 *  `frameOffset` shifts each keyframe by a fixed number of frames —
 *  used for filters whose timeline is the parent tractor (animations
 *  on a track entry are still in the entry's local frame, but
 *  filters/transitions on the tractor see absolute timeline frames).
 *
 *  Adjacent samples whose values match within `eps` are collapsed —
 *  long runs of "constant for these N frames" turn into one keyframe. */
export function pwlToMltKeyframes(
  pwl: PwlSamples,
  fps: number,
  frameOffset: number = 0,
  eps: number = 1e-4,
): string {
  const s = pwl.samples;
  if (s.length === 1) return fnum(s[0].v);
  const parts: string[] = [];
  let prev: number | null = null;
  for (let i = 0; i < s.length; i++) {
    const v = s[i].v;
    if (prev != null && Math.abs(v - prev) < eps && i < s.length - 1) continue;
    const f = Math.round(s[i].t * fps) + frameOffset;
    parts.push(`${f}=${fnum(v)}`);
    prev = v;
  }
  return parts.join(";");
}

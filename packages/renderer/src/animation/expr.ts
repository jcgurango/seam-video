// Compile a `Keyframed<number>` (or `Keyframed<Dimension>`) into a form
// ffmpeg can consume — either an expression string (for filters that
// support `eval=frame`) or a sendcmd command sequence (for filters that
// only accept runtime commands).
//
// We pre-bake the keyframes into a piecewise-linear sample series at the
// output fps using the same easing/interpolation engine the editor
// preview uses (`sampleNumber` / `sampleDimension` from core), so the
// rendered curve matches the previewed curve. Easing is "compiled into"
// the samples; the ffmpeg expression itself is always linear between
// adjacent samples.

import {
  isKeyframed,
  sampleNumber,
  sampleDimension,
  resolveDimension,
  resolveBoxProps,
  type Keyframed,
  type SpatialInput,
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

/** Bake a Dimension Keyframed value (number | "<n>%") into pixel-space
 *  PWL samples against `parentSize`. Mirrors `sampleDimension` from core. */
export function bakePwlDimension(
  value: Keyframed<number | string>,
  duration: number,
  fps: number,
  parentSize: number,
): PwlSamples {
  if (!isKeyframed(value)) {
    return {
      duration,
      samples: [{ t: 0, v: resolveDimension(value as number | string, parentSize) }],
    };
  }
  return {
    duration,
    samples: sampleSeries(duration, fps, (t) =>
      sampleDimension(value, t, duration, parentSize),
    ),
  };
}

function sampleSeries(
  duration: number,
  fps: number,
  sampler: (t: number) => number,
): Array<{ t: number; v: number }> {
  const out: Array<{ t: number; v: number }> = [];
  const step = 1 / fps;
  // Half-step epsilon avoids missing the t=duration sample due to
  // float drift in the loop bound.
  for (let t = 0; t <= duration + step / 2; t += step) {
    const tc = Math.min(t, duration);
    out.push({ t: tc, v: sampler(tc) });
  }
  // Make sure the last sample lands exactly on `duration` so expressions
  // hold the final value cleanly past the end.
  const last = out[out.length - 1];
  if (last.t < duration) out.push({ t: duration, v: sampler(duration) });
  return collapseConstant(out);
}

/** If every sample is within `eps` of the first one, collapse to a
 *  single-sample series. Lets the rest of the pipeline treat
 *  effectively-static values as constants — important because
 *  `bakeSpatialPwl` always samples all four axes even when only one is
 *  animated, and the unchanged axes would otherwise emit thousands of
 *  redundant if-segments. */
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

/** Whether a baked PWL is effectively a constant. Lets callers skip
 *  per-frame eval / sendcmd when nothing actually changes. */
export function isConstant(pwl: PwlSamples): boolean {
  return pwl.samples.length === 1;
}

/** Format a number for an ffmpeg expression — ~6 sig figs, no exponent. */
function fnum(n: number): string {
  if (!Number.isFinite(n)) return "0";
  // Avoid scientific notation; ffmpeg's parser doesn't always grok 1e-7.
  return n.toFixed(6).replace(/0+$/, "").replace(/\.$/, "");
}

/** Compile a PWL into an ffmpeg expression in the variable `t` (seconds).
 *  Optional `tShift` subtracts a constant from `t` first — used when the
 *  filter's clock starts at the timeline origin but the keyframes are in
 *  node-local time (e.g. animated overlay positions on a delayed child).
 *
 *  The expression is structured as a balanced binary tree of
 *  `if(lt(t, pivot), …, …)` so depth is O(log N) instead of O(N). A
 *  900-sample series turns into a depth-10 tree, which ffmpeg's parser
 *  handles cleanly — the right-leaning chain we used before tripped its
 *  recursion budget around a couple hundred samples. */
export function pwlToExpression(pwl: PwlSamples, tShift: number = 0): string {
  const s = pwl.samples;
  if (s.length === 1) return fnum(s[0].v);
  const tVar = tShift === 0 ? "t" : `(t-${fnum(tShift)})`;

  // Linear-interpolation expression for segment `i` covering
  // [s[i].t, s[i+1].t]. Caller is responsible for ensuring t lies in
  // (or close to) that range — clamping at the timeline edges is done
  // by the wrapping if(...) below, not per segment.
  const lerpSegment = (i: number): string => {
    const a = s[i];
    const b = s[i + 1];
    const dt = b.t - a.t;
    if (dt <= 0) return fnum(b.v);
    return `(${fnum(a.v)}+(${fnum(b.v - a.v)})*(${tVar}-${fnum(a.t)})/${fnum(dt)})`;
  };

  // Build a balanced binary tree over the half-open segment range
  // [lo, hi). Each node splits at the midpoint sample's time.
  // Invariant: when this subtree is reached, t ∈ [s[lo].t, s[hi].t].
  const buildTree = (lo: number, hi: number): string => {
    if (lo === hi - 1) return lerpSegment(lo);
    const mid = (lo + hi) >> 1;
    const left = buildTree(lo, mid);
    const right = buildTree(mid, hi);
    return `if(lt(${tVar},${fnum(s[mid].t)}),${left},${right})`;
  };

  const inner = buildTree(0, s.length - 1);
  // Clamp to first/last value outside the keyframed range — matches
  // the runtime sampler in core (`sampleFrames`).
  const firstT = fnum(s[0].t);
  const lastT = fnum(s[s.length - 1].t);
  const firstV = fnum(s[0].v);
  const lastV = fnum(s[s.length - 1].v);
  return `if(lt(${tVar},${firstT}),${firstV},if(lt(${tVar},${lastT}),${inner},${lastV}))`;
}

/** Resolved per-frame spatial samples for an animated node. Each axis
 *  is a separate PWL so the ffmpeg expressions for `overlay` (x, y) and
 *  `scale` (w, h) can be compiled independently. */
export interface SpatialPwl {
  x: PwlSamples;
  y: PwlSamples;
  w: PwlSamples;
  h: PwlSamples;
}

/** Sample a node's animated spatial input at output fps, re-running
 *  `resolveBoxProps` per frame so the keyframes resolve correctly
 *  against the parent dims at every frame (percent-based dims, opposing
 *  edges, etc.). When no spatial fields are set, falls back to the full
 *  parent rect — the caller should still pre-check and skip the
 *  animated path entirely if there's no spatial input. */
export function bakeSpatialPwl(
  input: SpatialInput,
  parentW: number,
  parentH: number,
  duration: number,
  fps: number,
): SpatialPwl {
  const xs: Array<{ t: number; v: number }> = [];
  const ys: Array<{ t: number; v: number }> = [];
  const ws: Array<{ t: number; v: number }> = [];
  const hs: Array<{ t: number; v: number }> = [];
  const step = 1 / fps;
  for (let t = 0; t <= duration + step / 2; t += step) {
    const tc = Math.min(t, duration);
    const { spatial } = resolveBoxProps(input, parentW, parentH, tc, duration);
    xs.push({ t: tc, v: spatial?.x ?? 0 });
    ys.push({ t: tc, v: spatial?.y ?? 0 });
    ws.push({ t: tc, v: spatial?.width ?? parentW });
    hs.push({ t: tc, v: spatial?.height ?? parentH });
  }
  // Land a sample exactly on `duration` so expressions hold cleanly past
  // the end (matches the bakeSeries convention used elsewhere here).
  const lastT = xs[xs.length - 1].t;
  if (lastT < duration) {
    const { spatial } = resolveBoxProps(input, parentW, parentH, duration, duration);
    xs.push({ t: duration, v: spatial?.x ?? 0 });
    ys.push({ t: duration, v: spatial?.y ?? 0 });
    ws.push({ t: duration, v: spatial?.width ?? parentW });
    hs.push({ t: duration, v: spatial?.height ?? parentH });
  }
  // Per-axis collapse: callers usually only animate one or two edges,
  // and the others fall out of `resolveBoxProps` constant. Without this
  // step, every static axis would still bake a 30-second-at-30fps PWL
  // and bury ffmpeg's expression parser under thousands of identical
  // segments.
  return {
    x: { duration, samples: collapseConstant(xs) },
    y: { duration, samples: collapseConstant(ys) },
    w: { duration, samples: collapseConstant(ws) },
    h: { duration, samples: collapseConstant(hs) },
  };
}

/** Compile a PWL into a `sendcmd` command list targeting `<filter> <param>`.
 *  Each sample emits one stepwise command at its time; ffmpeg holds the
 *  value until the next command. With `tShift > 0`, command times are
 *  shifted into the parent timeline (used for delayed children).
 *
 *  Output is the value for sendcmd's `commands=` argument; the caller
 *  joins it with the filter graph (`sendcmd=c='<this>',<filter>`).
 *
 *  Only emits commands when the value actually changes between samples —
 *  back-to-back equal values are dropped to keep the graph small. */
export function pwlToSendcmdCommands(
  pwl: PwlSamples,
  filter: string,
  param: string,
  tShift: number = 0,
): string {
  const out: string[] = [];
  let prev: number | null = null;
  for (const s of pwl.samples) {
    if (prev != null && Math.abs(s.v - prev) < 1e-7) continue;
    out.push(`${fnum(s.t + tShift)} ${filter} ${param} ${fnum(s.v)}`);
    prev = s.v;
  }
  return out.join(";");
}

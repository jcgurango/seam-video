// Compile a `Keyframed<number>` (or `Keyframed<Dimension>`) into a form
// ffmpeg can consume — either an expression string (for filters that
// support `eval=frame`) or a sendcmd command sequence (for filters that
// only accept runtime commands).
//
// Two compilation paths:
//   - `keyframedToExpression` (preferred for plain scalars like volume,
//     filter params): walks the keyframes directly and emits one
//     analytical expression per segment using native ffmpeg math for
//     linear / ease-in / ease-out / ease-in-out. No per-frame sampling
//     unless a segment uses cubic-bezier (still fall-back to PWL).
//   - `bakePwl*` + `pwlToExpression` (used by spatial, where field
//     interactions in `resolveBoxProps` make a closed form per axis
//     awkward): samples per output frame, then RLE collapses any
//     samples that lie on the line between their neighbours, so flat
//     and linear stretches don't bloat the expression.

import {
  isKeyframed,
  sampleNumber,
  sampleDimension,
  resolveDimension,
  resolveBoxProps,
  resolveTimeExpr,
  type Keyframe,
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

/** Drop samples that lie on the straight line between their neighbours.
 *  Constant runs collapse to two endpoints; a uniformly linear stretch
 *  (e.g. linear-easing region) collapses similarly; only segments where
 *  the curve actually bends (cubic easings, mid-animation kinks)
 *  survive. Greedy: each kept sample anchors the next colinearity check
 *  so we don't accumulate error. */
function colinearRle(
  samples: Array<{ t: number; v: number }>,
  eps: number = 1e-3,
): Array<{ t: number; v: number }> {
  if (samples.length <= 2) return samples;
  const out: Array<{ t: number; v: number }> = [samples[0]];
  for (let i = 1; i < samples.length - 1; i++) {
    const prev = out[out.length - 1];
    const curr = samples[i];
    const next = samples[i + 1];
    const dt = next.t - prev.t;
    if (dt <= 0) continue;
    const predicted = prev.v + (next.v - prev.v) * (curr.t - prev.t) / dt;
    if (Math.abs(curr.v - predicted) > eps) out.push(curr);
  }
  out.push(samples[samples.length - 1]);
  return out;
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
  // Drop interior samples that lie on the line between their
  // neighbours. Flat regions collapse to two endpoints; uniformly
  // linear regions (e.g. the entire "linear" easing region) collapse
  // similarly. Only true bends (cubic easings, etc.) survive.
  const s = colinearRle(pwl.samples);
  if (s.length === 1) return fnum(s[0].v);
  const tVar = tShift === 0 ? "t" : `(t-${fnum(tShift)})`;

  // Expression for segment `i` covering [s[i].t, s[i+1].t]. When the
  // segment's two endpoints have the same value, we emit a literal
  // instead of the lerp formula — saves bytes for constant runs and
  // makes the resulting expression easier to read.
  const lerpSegment = (i: number): string => {
    const a = s[i];
    const b = s[i + 1];
    const dt = b.t - a.t;
    if (dt <= 0) return fnum(b.v);
    if (Math.abs(b.v - a.v) <= 1e-9) return fnum(a.v);
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

// ── Native-easing scalar compiler ──────────────────────────────────

type NativeEasing =
  | "linear"
  | "ease-in"
  | "ease-out"
  | "ease-in-out"
  | { kind: "bezier"; x1: number; y1: number; x2: number; y2: number };

/** Map an easing string to either a native form (analytical ffmpeg
 *  expression) or a structured cubic-bezier we'll have to sample. */
function classifyEasing(ease: string | undefined): NativeEasing | null {
  if (ease == null || ease === "linear") return "linear";
  // CSS "ease" is roughly cubic-bezier(0.25, 0.1, 0.25, 1). Our preview
  // approximates it with cubic-in-out — keep the same approximation
  // here so ffmpeg matches.
  if (ease === "ease" || ease === "ease-in-out") return "ease-in-out";
  if (ease === "ease-in") return "ease-in";
  if (ease === "ease-out") return "ease-out";
  const m = ease.match(/^cubic-bezier\s*\(\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*\)$/);
  if (m) {
    return { kind: "bezier", x1: parseFloat(m[1]), y1: parseFloat(m[2]), x2: parseFloat(m[3]), y2: parseFloat(m[4]) };
  }
  return null;
}

/** Build the analytical ffmpeg expression for a single keyframe pair
 *  `(a, b)` under a native easing. `a.v` and `b.v` are the segment
 *  endpoints; `t` is the parent variable (already shifted if needed). */
function nativeEasingSegment(
  a: { t: number; v: number },
  b: { t: number; v: number },
  ease: Exclude<NativeEasing, { kind: "bezier" }>,
  tVar: string,
): string {
  const dt = b.t - a.t;
  if (dt <= 0) return fnum(b.v);
  if (Math.abs(b.v - a.v) <= 1e-9) return fnum(a.v);
  // Normalised position in segment, f ∈ [0, 1].
  const f = `((${tVar}-${fnum(a.t)})/${fnum(dt)})`;
  const delta = fnum(b.v - a.v);
  const baseV = fnum(a.v);
  switch (ease) {
    case "linear":
      return `(${baseV}+(${delta})*${f})`;
    case "ease-in":
      // cubic-in: t³
      return `(${baseV}+(${delta})*pow(${f},3))`;
    case "ease-out":
      // cubic-out: 1 - (1-t)³
      return `(${baseV}+(${delta})*(1-pow(1-${f},3)))`;
    case "ease-in-out":
      // cubic-in-out: t<0.5 ? 4t³ : 1 - (-2t+2)³ / 2
      return `(${baseV}+(${delta})*if(lt(${f},0.5),(4*pow(${f},3)),(1-pow(-2*${f}+2,3)/2)))`;
  }
}

/** Build a sampled sub-tree for a single segment that uses a non-native
 *  easing (cubic-bezier with arbitrary control points). We sample the
 *  segment at output fps using the exact same easing engine the preview
 *  uses, then run it through `pwlToExpression` (which RLEs + balances).
 *  The redundant outer clamp the PWL compiler adds is harmless — the
 *  caller's segment tree already restricts `t` to this range. */
function bezierSegmentExpression(
  a: { t: number; v: number },
  b: { t: number; v: number },
  bezier: { kind: "bezier"; x1: number; y1: number; x2: number; y2: number },
  tShift: number,
  fps: number,
): string {
  const dt = b.t - a.t;
  if (dt <= 0) return fnum(b.v);
  // Reconstruct a 2-keyframe value with the original easing string and
  // run our existing sampler against it. Times are absolute timeline
  // seconds — bare numeric keyframe times pass through unchanged.
  const easeStr = `cubic-bezier(${bezier.x1},${bezier.y1},${bezier.x2},${bezier.y2})`;
  const segKeyframes: Keyframe<number>[] = [
    [a.t, a.v],
    [b.t, b.v, easeStr],
  ];
  const samples = sampleSeries(dt, fps, (rel) =>
    sampleNumber(segKeyframes, a.t + rel, dt),
  ).map((s) => ({ t: a.t + s.t, v: s.v }));
  return pwlToExpression({ duration: dt, samples }, tShift);
}

/** Compile a `Keyframed<number>` directly into an ffmpeg expression,
 *  bypassing per-frame sampling for keyframes that use only the
 *  built-in CSS easings. Cubic-bezier with custom control points still
 *  samples (within just that segment, not across the whole timeline).
 *
 *  `tShift` shifts `t` by a constant — used when the filter clock is in
 *  parent-timeline time but the keyframes are in node-local time.
 *
 *  `fps` is only consulted for cubic-bezier fallback sampling; native
 *  easings ignore it entirely (no sampling happens). */
export function keyframedToExpression(
  value: Keyframed<number>,
  duration: number,
  fps: number,
  tShift: number = 0,
): string {
  if (!isKeyframed(value)) return fnum(value as number);
  // Effectively-constant keyframe arrays compile to a single literal —
  // no segment tree needed. Saves both the recursive build and a
  // pointless `eval=frame` callsite when downstream forgets to check.
  if (isStaticOrConstant(value)) {
    return fnum(value.length === 0 ? 0 : value[0][1]);
  }
  // Resolve keyframe times to absolute seconds and sort.
  const kfs = value
    .map((kf) => ({
      t: resolveTimeExpr(kf[0], duration),
      v: kf[1],
      ease: kf[2],
    }))
    .sort((a, b) => a.t - b.t);
  if (kfs.length === 0) return "0";
  if (kfs.length === 1) return fnum(kfs[0].v);

  const tVar = tShift === 0 ? "t" : `(t-${fnum(tShift)})`;

  // For each segment between adjacent keyframes, produce one
  // expression piece. Easing is on the *destination* keyframe (CSS
  // animation-timing-function semantics).
  const pieces: Array<{ t0: number; t1: number; expr: string }> = [];
  for (let i = 0; i < kfs.length - 1; i++) {
    const a = kfs[i];
    const b = kfs[i + 1];
    if (b.t <= a.t) continue;
    const ease = classifyEasing(b.ease);
    if (ease == null) {
      // Unknown easing — degrade to linear with a warning at runtime
      // would be safer, but linear is also the documented default.
      pieces.push({
        t0: a.t,
        t1: b.t,
        expr: nativeEasingSegment({ t: a.t, v: a.v }, { t: b.t, v: b.v }, "linear", tVar),
      });
    } else if (typeof ease === "object") {
      pieces.push({
        t0: a.t,
        t1: b.t,
        expr: bezierSegmentExpression({ t: a.t, v: a.v }, { t: b.t, v: b.v }, ease, tShift, fps),
      });
    } else {
      pieces.push({
        t0: a.t,
        t1: b.t,
        expr: nativeEasingSegment({ t: a.t, v: a.v }, { t: b.t, v: b.v }, ease, tVar),
      });
    }
  }

  if (pieces.length === 0) return fnum(kfs[0].v);
  if (pieces.length === 1) {
    // Single segment — just clamp at the boundaries.
    const p = pieces[0];
    const firstV = fnum(kfs[0].v);
    const lastV = fnum(kfs[kfs.length - 1].v);
    return `if(lt(${tVar},${fnum(p.t0)}),${firstV},if(lt(${tVar},${fnum(p.t1)}),${p.expr},${lastV}))`;
  }

  // Combine multiple segments via balanced binary tree on segment
  // boundaries. Each piece i covers (t0, t1]; the tree splits at each
  // boundary so the right subtree starts at the next segment's t0.
  const buildTree = (lo: number, hi: number): string => {
    if (lo === hi - 1) return pieces[lo].expr;
    const mid = (lo + hi) >> 1;
    const left = buildTree(lo, mid);
    const right = buildTree(mid, hi);
    return `if(lt(${tVar},${fnum(pieces[mid].t0)}),${left},${right})`;
  };
  const inner = buildTree(0, pieces.length);
  const firstT = fnum(kfs[0].t);
  const lastT = fnum(kfs[kfs.length - 1].t);
  const firstV = fnum(kfs[0].v);
  const lastV = fnum(kfs[kfs.length - 1].v);
  return `if(lt(${tVar},${firstT}),${firstV},if(lt(${tVar},${lastT}),${inner},${lastV}))`;
}

/** True when the value is either static or compiles to a single
 *  literal — lets callers skip `eval=frame` and just emit a constant. */
export function isStaticOrConstant(value: Keyframed<number>): boolean {
  if (!isKeyframed(value)) return true;
  if (value.length === 0) return true;
  const v0 = value[0][1];
  return value.every((kf) => Math.abs(kf[1] - v0) <= 1e-9);
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

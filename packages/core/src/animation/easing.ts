// CSS-flavoured easing keywords. Maps to d3-ease functions where possible;
// `cubic-bezier(a, b, c, d)` is implemented inline (d3-ease doesn't expose
// arbitrary control points). All functions take `t ∈ [0, 1]` and return the
// eased fraction, also nominally in [0, 1].

import {
  easeLinear,
  easeCubicIn,
  easeCubicOut,
  easeCubicInOut,
} from "d3-ease";

export type EasingFn = (t: number) => number;

const KEYWORDS: Record<string, EasingFn> = {
  linear: easeLinear,
  // CSS "ease" is roughly cubic-bezier(0.25, 0.1, 0.25, 1). Close enough to
  // easeCubicInOut for our purposes; users wanting the exact curve can spell
  // it as cubic-bezier().
  ease: easeCubicInOut,
  "ease-in": easeCubicIn,
  "ease-out": easeCubicOut,
  "ease-in-out": easeCubicInOut,
};

const BEZIER_RE =
  /^cubic-bezier\s*\(\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*\)$/;

export function resolveEasing(name: string | undefined): EasingFn {
  if (name == null) return easeLinear;
  const k = KEYWORDS[name];
  if (k) return k;
  const m = name.match(BEZIER_RE);
  if (m) {
    const [, x1, y1, x2, y2] = m.map(parseFloat);
    return cubicBezier(x1, y1, x2, y2);
  }
  throw new Error(
    `Unknown easing: "${name}" (expected one of linear, ease, ease-in, ease-out, ease-in-out, or cubic-bezier(a,b,c,d))`
  );
}

// Standard CSS-style cubic-bezier solver. We solve for the t parameter that
// produces our input x via Newton's method (with a binary-search fallback
// for robustness near flat sections), then evaluate y at that t.
function cubicBezier(x1: number, y1: number, x2: number, y2: number): EasingFn {
  // Bezier basis:  P(t) = 3(1-t)²t·P1 + 3(1-t)t²·P2 + t³  (P0=0, P3=1)
  const sampleX = (t: number) =>
    ((1 - t) * (1 - t) * 3 * x1 + (1 - t) * t * 3 * x2 + t * t) * t * 1; // unused factor — see below
  void sampleX;

  const bezier = (t: number, a: number, b: number) =>
    3 * (1 - t) * (1 - t) * t * a + 3 * (1 - t) * t * t * b + t * t * t;
  const dBezier = (t: number, a: number, b: number) =>
    3 * (1 - t) * (1 - t) * a +
    6 * (1 - t) * t * (b - a) +
    3 * t * t * (1 - b);

  return (x: number) => {
    if (x <= 0) return 0;
    if (x >= 1) return 1;
    let t = x;
    for (let i = 0; i < 8; i++) {
      const xt = bezier(t, x1, x2);
      const dxt = dBezier(t, x1, x2);
      if (Math.abs(dxt) < 1e-6) break;
      const next = t - (xt - x) / dxt;
      if (Math.abs(next - t) < 1e-6) {
        t = next;
        break;
      }
      t = next;
    }
    // Bisection backstop in case Newton drifted out of [0, 1].
    if (t < 0 || t > 1) {
      let lo = 0;
      let hi = 1;
      for (let i = 0; i < 24; i++) {
        const mid = (lo + hi) / 2;
        if (bezier(mid, x1, x2) < x) lo = mid;
        else hi = mid;
      }
      t = (lo + hi) / 2;
    }
    return bezier(t, y1, y2);
  };
}

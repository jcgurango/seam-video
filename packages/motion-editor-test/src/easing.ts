// CSS-flavoured easing keywords, matching @seam/core's set. The cubic
// curves are inlined (no d3-ease dependency in the test bench); they match
// d3-ease's easeCubicIn/Out/InOut to numerical precision sufficient for our
// preview path.

export type EasingFn = (t: number) => number;

function linear(t: number): number {
  return t;
}
function cubicIn(t: number): number {
  return t * t * t;
}
function cubicOut(t: number): number {
  return 1 - Math.pow(1 - t, 3);
}
function cubicInOut(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

const KEYWORDS: Record<string, EasingFn> = {
  linear,
  // CSS "ease" is roughly cubic-bezier(0.25, 0.1, 0.25, 1); easeCubicInOut
  // is close enough for our purposes. Authors wanting the exact CSS curve
  // can spell it via cubic-bezier() once we wire that in.
  ease: cubicInOut,
  "ease-in": cubicIn,
  "ease-out": cubicOut,
  "ease-in-out": cubicInOut,
};

export function resolveEasing(name: string | undefined): EasingFn {
  if (!name) return linear;
  return KEYWORDS[name] ?? linear;
}

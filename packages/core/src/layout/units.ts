// ── Length: percent + pixel composition ───────────────────────────
//
// A spatial value is a sum of two parts:
//   percent  — a fraction (0..1) of some property-specific reference dim
//   pixels   — a literal pixel offset
//
// Authored forms:
//   25          → number only         → percent omitted, pixels = 25
//   "50%"       → percent only        → percent = 50, pixels = 0
//   "50% + 10"  → combined            → percent = 50, pixels = 10
//   "50% - 10"  → combined (subtract) → percent = 50, pixels = -10
//
// Percent-omitted is distinct from percent-zero: each property picks a
// fallback percent when the author only gave a pixel number, so the
// same `0` reads as "center of parent" for translation but "literal
// zero pixels" for size. `resolveLength` takes that default explicitly.

export type Length = number | string;

export interface ParsedLength {
  /** Percent fraction expressed as 0..100 (e.g. 50 for "50%"). Null when
   *  the author wrote a bare number — `resolveLength` substitutes the
   *  caller's default in that case. */
  percent: number | null;
  pixels: number;
}

const PERCENT_ONLY_RE = /^(-?\d+(?:\.\d+)?)%$/;
const PERCENT_PLUS_PX_RE = /^(-?\d+(?:\.\d+)?)%\s*([+-])\s*(-?\d+(?:\.\d+)?)$/;

export function parseLength(input: Length): ParsedLength {
  if (typeof input === "number") {
    if (!Number.isFinite(input)) {
      throw new Error(`Invalid length: ${input}`);
    }
    return { percent: null, pixels: input };
  }
  const pOnly = input.match(PERCENT_ONLY_RE);
  if (pOnly) return { percent: parseFloat(pOnly[1]), pixels: 0 };
  const combined = input.match(PERCENT_PLUS_PX_RE);
  if (combined) {
    const p = parseFloat(combined[1]);
    const sign = combined[2] === "+" ? 1 : -1;
    const px = parseFloat(combined[3]);
    return { percent: p, pixels: sign * px };
  }
  throw new Error(
    `Invalid length: "${input}" (expected a number, "<n>%", or "<n>% +/- <n>")`
  );
}

/**
 * Evaluate a `Length` against a reference dimension.
 *
 * `percentDefault` is the percent fraction (0..100) used when the input
 * is a bare number — for `origin`/`translation` that's 50 (center of
 * reference); for `size`/`contentWidth` etc. that's 0 (literal pixels).
 */
export function resolveLength(
  input: Length,
  referenceSize: number,
  percentDefault: number,
): number {
  const { percent, pixels } = parseLength(input);
  const p = percent ?? percentDefault;
  return (p / 100) * referenceSize + pixels;
}

/** True when the input is a percentage (with or without a pixel offset).
 *  Pixel-only values return false. Used by the renderer when checking
 *  whether contentWidth/contentHeight need a parent reference to resolve. */
export function hasPercent(input: Length): boolean {
  if (typeof input === "number") return false;
  return PERCENT_ONLY_RE.test(input) || PERCENT_PLUS_PX_RE.test(input);
}

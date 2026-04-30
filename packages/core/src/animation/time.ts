// Keyframe time expressions, evaluated against a node's local duration.
//
//   0.5         → 0.5 seconds from the start of the node
//   "50%"       → halfway through the node's duration
//   "50% + 10"  → halfway, plus 10 seconds (whitespace required around the operator)
//   "50% - 10"  → halfway, minus 10 seconds
//
// Times resolved outside [0, duration] are allowed (the sampler clamps).

export type TimeExpr = number | string;

export interface ParsedTimeExpr {
  /** Fraction of the node's duration. 0 if absent. 0.5 = "50%". */
  percent: number;
  /** Constant seconds offset. 0 if absent. */
  offset: number;
}

const PCT = String.raw`(-?\d+(?:\.\d+)?)%`;
const NUM = String.raw`(-?\d+(?:\.\d+)?)`;
const PCT_ONLY_RE = new RegExp(`^\\s*${PCT}\\s*$`);
const PCT_PLUS_NUM_RE = new RegExp(`^\\s*${PCT}\\s+([+-])\\s+${NUM}\\s*$`);

export function parseTimeExpr(expr: TimeExpr): ParsedTimeExpr {
  if (typeof expr === "number") {
    if (!Number.isFinite(expr)) {
      throw new Error(`Invalid time expression: ${expr}`);
    }
    return { percent: 0, offset: expr };
  }
  const pctOnly = expr.match(PCT_ONLY_RE);
  if (pctOnly) {
    return { percent: parseFloat(pctOnly[1]) / 100, offset: 0 };
  }
  const combined = expr.match(PCT_PLUS_NUM_RE);
  if (combined) {
    const sign = combined[2] === "-" ? -1 : 1;
    return {
      percent: parseFloat(combined[1]) / 100,
      offset: sign * parseFloat(combined[3]),
    };
  }
  throw new Error(
    `Invalid time expression: "${expr}" (expected a number, "<n>%", or "<n>% + <n>")`
  );
}

export function evaluateTimeExpr(
  parsed: ParsedTimeExpr,
  duration: number
): number {
  return parsed.percent * duration + parsed.offset;
}

export function resolveTimeExpr(expr: TimeExpr, duration: number): number {
  return evaluateTimeExpr(parseTimeExpr(expr), duration);
}

// Pure tools for editing keyframe timing from the timeline lanes.
//
// Dragging a diamond retimes a single keyframe. The new time is written back
// in the *same form* the author used (the general Length/TimeExpr editing
// rule): a percent-only time stays percent, a bare number stays a number, and
// a mixed `"50% + 10"` keeps its percent anchor fixed and moves only the
// seconds offset. (Percent is treated as a deliberate, fixed anchor point.)

import {
  parseTimeExpr,
  type Child,
  type SeamFile,
  type TimeExpr,
} from "@seam/core";
import { updateNodeAtPath, type NodePath } from "./nodePath.js";

export type TimeExprKind = "number" | "percent" | "mixed";

/** Classify an authored time expression by its *form* (not its value — a
 *  number `0` and the string `"0%"` resolve to the same instant but edit
 *  differently). Drives which component a drag rewrites. */
export function classifyTimeExpr(expr: TimeExpr): TimeExprKind {
  if (typeof expr === "number") return "number";
  const s = expr.trim();
  if (!s.includes("%")) return "number";
  return /%\s*[+-]/.test(s) ? "mixed" : "percent";
}

const roundSec = (s: number): number => Math.round(s * 1000) / 1000;
const roundPct = (p: number): number => Math.round(p * 100) / 100;

/** Produce the new time expression for a keyframe dragged to `newLocalSec`
 *  (seconds in the lane's time domain), preserving the authored form of
 *  `original`. `domain` is the duration percentages resolve against. */
export function timeExprForLocal(
  original: TimeExpr,
  newLocalSec: number,
  domain: number,
): TimeExpr {
  const kind = classifyTimeExpr(original);
  if (kind === "number") return roundSec(newLocalSec);
  // Percent forms need a non-zero domain to express a fraction; fall back to
  // leaving the time untouched rather than dividing by zero.
  if (domain <= 0) return original;
  if (kind === "percent") {
    return `${roundPct((newLocalSec / domain) * 100)}%`;
  }
  // Mixed: keep the authored percent anchor, move only the seconds offset.
  const { percent } = parseTimeExpr(original);
  const offset = roundSec(newLocalSec - percent * domain);
  const sign = offset < 0 ? "-" : "+";
  return `${roundPct(percent * 100)}% ${sign} ${Math.abs(offset)}`;
}

/** Immutably rewrite the time (element 0) of keyframe `kfIndex` of the
 *  `prop` array on the node at `path` (`[time, value, easing?]` — only
 *  element 0 is touched). */
export function setKeyframeTime(
  doc: SeamFile,
  path: NodePath,
  prop: string,
  kfIndex: number,
  newTime: TimeExpr,
): SeamFile {
  if (path.length === 0 || path[path.length - 1].field === "bin") return doc;
  return updateNodeAtPath(doc, path, (node) => {
    const child = node as Child & Record<string, unknown>;
    const kfs = child[prop];
    if (!Array.isArray(kfs)) return node;
    const kf = kfs[kfIndex];
    if (!Array.isArray(kf)) return node;

    const newKf = [...kf];
    newKf[0] = newTime;
    const newKfs = [...kfs];
    newKfs[kfIndex] = newKf;
    return { ...child, [prop]: newKfs } as Child;
  });
}

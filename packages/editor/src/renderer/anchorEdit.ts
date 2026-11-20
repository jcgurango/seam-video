// Pure logic for the anchor-line editor (the SVG overlay in TimelinePanel
// that lets the user drag a run head's `start` anchor). All functions here
// operate on schema values and a small per-line context — no React, no DOM,
// no timeline-pixel constants.
//
// A head's position is `anchor point + offset`. The line's top handle is the
// point (`"id"`, `"id@50%"`, `"id@10"`); its bottom handle is the node's own
// `offset`. The React layer measures pointer motion in pixels, converts to
// seconds via the panel's pxPerSec, and hands deltas to `dragAnchorPoint` /
// `dragOffset`; a click on the top handle goes through `toggleAnchorPoint`.

import { formatStart, parseStart, resolvedPlayStart, resolvedSignedRate } from "@seam/core";
import type { Child, Composition, ParsedStart, ResolvedChild, Start } from "@seam/core";
import { withPlacement } from "./runEdit.js";

export interface AnchorEditCtx {
  /** Index of the anchored node in its container's `children`. */
  index: number;
  /** Resolved time of the anchor point (no offset). */
  pointTime: number;
  anchorStart: number;
  anchorEnd: number;
  /** Source time at the target's start, and its source-per-output rate. */
  anchorBase: number;
  anchorSpeed: number;
}

const SEC_DECIMALS = 1000;
const PCT_DECIMALS = 1000000;

export const fmtSec = (s: number) => Math.round(s * SEC_DECIMALS) / SEC_DECIMALS;
const fmtFrac = (frac: number) => Math.round(frac * PCT_DECIMALS) / PCT_DECIMALS;

type NodeStart = Extract<ParsedStart, { kind: "node" }>;

/** `start` parsed as a node anchor, or null (unset / absolute). */
export function nodeAnchor(start: Start | undefined): NodeStart | null {
  if (typeof start !== "string") return null;
  const parsed = parseStart(start);
  return parsed.kind === "node" ? parsed : null;
}

/** The target's source mapping, mirroring the resolver: clip/audio use the
 *  resolved `sourceIn` + speed, a composition its authored `in` + speed,
 *  a static its freeze time, everything else plain output seconds. */
export function anchorSource(
  anchorDoc: Child,
  anchorResolved: ResolvedChild,
): { base: number; speed: number } {
  if (anchorResolved.type === "clip" || anchorResolved.type === "audio") {
    // Signed for a reversed clip (source falls as output advances).
    return { base: resolvedPlayStart(anchorResolved), speed: resolvedSignedRate(anchorResolved) };
  }
  if (anchorResolved.type === "composition") {
    return {
      base: anchorDoc.type === "composition" ? (anchorDoc.in ?? 0) : 0,
      speed: anchorResolved.speed,
    };
  }
  if (anchorResolved.type === "static") return { base: anchorResolved.sourceTime, speed: 1 };
  return { base: 0, speed: 1 };
}

/** Resolved-output time of the anchor *point* (no offset applied) — the same
 *  formulas as the resolver, so the handle lands exactly where it resolves. */
export function computePointTime(
  anchor: NodeStart,
  anchorDoc: Child,
  anchorResolved: ResolvedChild,
): number {
  const start = anchorResolved.timelineStart;
  const end = anchorResolved.timelineEnd;
  if (!anchor.point) return start;
  if (anchor.point.kind === "percent") return start + (end - start) * anchor.point.value;
  const { base, speed } = anchorSource(anchorDoc, anchorResolved);
  return start + (anchor.point.value - base) / speed;
}

export function findAnchorById(
  id: string,
  children: Child[],
  resolved: ResolvedChild[],
): { doc: Child; resolved: ResolvedChild; index: number } | null {
  for (let i = 0; i < children.length; i++) {
    if ((children[i] as { id?: string }).id === id && resolved[i]) {
      return { doc: children[i], resolved: resolved[i], index: i };
    }
  }
  return null;
}

/** `"s"` for a source-seconds point, `"%"` for a percent / bare-id one. */
export function anchorPointKind(anchor: NodeStart): "s" | "%" {
  return anchor.point?.kind === "source" ? "s" : "%";
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

function percentStart(id: string, frac: number): Start {
  const value = fmtFrac(frac);
  return value === 0 ? id : formatStart({ kind: "node", id, point: { kind: "percent", value } });
}

/**
 * Drag the anchor point so its resolved time shifts by `deltaSec`. An absolute
 * (numeric) start is clamped at 0; an anchored one to the target's real bounds — percent to 0–100%, source seconds to the
 * target's `[sourceStart, sourceEnd]`. (Typing a value can still overshoot.)
 */
export function dragAnchorPoint(start: Start, deltaSec: number, ctx: AnchorEditCtx): Start {
  // An absolute start just moves along the container's time axis (not before 0).
  if (typeof start === "number") return Math.max(0, fmtSec(start + deltaSec));
  const anchor = nodeAnchor(start);
  if (!anchor) return start;
  if (anchor.point?.kind === "source") {
    const sourceStart = ctx.anchorBase;
    const sourceEnd = ctx.anchorBase + (ctx.anchorEnd - ctx.anchorStart) * ctx.anchorSpeed;
    // `anchorSpeed` is negative on a reversed clip, where the range runs down.
    const next = clamp(
      anchor.point.value + deltaSec * ctx.anchorSpeed,
      Math.min(sourceStart, sourceEnd),
      Math.max(sourceStart, sourceEnd),
    );
    return formatStart({ ...anchor, point: { kind: "source", value: fmtSec(next) } });
  }
  const range = ctx.anchorEnd - ctx.anchorStart;
  const old = anchor.point?.value ?? 0;
  return percentStart(anchor.id, clamp(old + (range > 0 ? deltaSec / range : 0), 0, 1));
}

/** Drag the node's `offset` by `deltaSec` (output seconds). */
export function dragOffset(offset: number | undefined, deltaSec: number): number {
  return fmtSec((offset ?? 0) + deltaSec);
}

/** Toggle the point between source seconds and output percent, recomputed
 *  from `pointTime` so the handle stays put on the timeline. */
export function toggleAnchorPoint(start: Start, ctx: AnchorEditCtx): Start {
  const anchor = nodeAnchor(start);
  if (!anchor) return start;
  if (anchorPointKind(anchor) === "s") {
    const range = ctx.anchorEnd - ctx.anchorStart;
    return percentStart(anchor.id, range > 0 ? (ctx.pointTime - ctx.anchorStart) / range : 0);
  }
  const sourceTime = ctx.anchorBase + (ctx.pointTime - ctx.anchorStart) * ctx.anchorSpeed;
  return formatStart({ ...anchor, point: { kind: "source", value: fmtSec(sourceTime) } });
}

/** Replace the placement (`start` + `offset`) of `comp.children[index]`. */
export function setPlacement(
  comp: Composition,
  index: number,
  start: Start | undefined,
  offset: number | undefined,
): Composition {
  const children = [...(comp.children ?? [])];
  const node = children[index];
  if (!node) return comp;
  children[index] = withPlacement(node, start, offset);
  return { ...comp, children };
}

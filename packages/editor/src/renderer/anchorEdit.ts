// Pure logic for the anchor-line editor (the SVG overlay in
// TimelinePanel that lets the user drag attachment anchors). All
// functions here operate on schema objects and a small per-line
// context — no React, no DOM, no timeline-pixel constants.
//
// The React layer (AnchorLinesLayer in TimelinePanel) measures pointer
// motion in pixels, converts to seconds via the panel's pxPerSec, and
// hands deltas to `dragAnchorPoint` / `dragOffset`. Clicks-to-toggle go
// through `toggleAnchorPoint` / `toggleOffset`. Commit goes through
// `setAttachmentSpec`.

import { resolveComposition } from "@seam/core";
import type {
  Child,
  ResolvedChild,
  ResolvedTimeline,
  SeamFile,
  TimeAnchor,
} from "@seam/core";

export interface AnchorEditCtx {
  attIdx: number;
  side: "start" | "end";
  pointTime: number;
  anchorStart: number;
  anchorEnd: number;
  anchorBase: number;
  anchorSpeed: number;
  attNatDur: number;
}

const SEC_DECIMALS = 1000;
const PCT_DECIMALS = 10000;

const fmtSec = (s: number) => Math.round(s * SEC_DECIMALS) / SEC_DECIMALS;
const fmtPct = (frac: number) =>
  `${Math.round(frac * 100 * PCT_DECIMALS) / PCT_DECIMALS}%`;

export function parsePct(s: string): number {
  const m = /^(-?\d+(?:\.\d+)?)%$/.exec(s);
  return m ? parseFloat(m[1]) / 100 : 0;
}

/**
 * Resolved-output time of the anchor *point* (no offset applied). Mirrors
 * the resolver's source/output formulas so the dot lands exactly where the
 * resolver would put it; the attachment's edge is `pointTime + offsetSec`,
 * which we already have on the resolved attachment as `timelineStart` /
 * `timelineEnd`.
 */
export function computePointTime(
  spec: TimeAnchor,
  anchorDoc: Child,
  anchorResolved: ResolvedChild,
): number | null {
  const start = anchorResolved.timelineStart;
  const end = anchorResolved.timelineEnd;

  let baseSourceTime = 0;
  let speed = 1;
  if (anchorResolved.type === "clip" || anchorResolved.type === "audio") {
    baseSourceTime = anchorResolved.sourceIn;
    speed = anchorResolved.speed;
  } else if (anchorResolved.type === "composition") {
    baseSourceTime =
      anchorDoc.type === "composition" ? (anchorDoc.in ?? 0) : 0;
    speed = anchorResolved.speed;
  }

  const timeSource = spec.timeSource ?? "output";
  if (timeSource === "source") {
    const sourceTime =
      typeof spec.anchorPoint === "number" ? spec.anchorPoint : 0;
    return start + (sourceTime - baseSourceTime) / speed;
  }
  const pct =
    typeof spec.anchorPoint === "string" ? parsePct(spec.anchorPoint) : 0;
  return start + (end - start) * pct;
}

export function findAnchorById(
  id: string,
  docRoot: { children: Child[]; attachments?: Child[] },
  timeline: ResolvedTimeline,
): { doc: Child; resolved: ResolvedChild; blockIndex: number } | null {
  const childCount = docRoot.children.length;
  for (let i = 0; i < docRoot.children.length; i++) {
    if ((docRoot.children[i] as { id?: string }).id === id) {
      return {
        doc: docRoot.children[i],
        resolved: timeline.children[i],
        blockIndex: i,
      };
    }
  }
  const atts = docRoot.attachments ?? [];
  for (let j = 0; j < atts.length; j++) {
    if ((atts[j] as { id?: string }).id === id) {
      return {
        doc: atts[j],
        resolved: timeline.children[childCount + j],
        blockIndex: childCount + j,
      };
    }
  }
  return null;
}

export function anchorPointKind(spec: TimeAnchor): "s" | "%" {
  if (typeof spec.anchorPoint === "string") return "%";
  if (typeof spec.anchorPoint === "number") return "s";
  // Omitted: follow the timeSource-implied default (source → 0sec, output → "0%")
  return spec.timeSource === "source" ? "s" : "%";
}

export function offsetKind(spec: TimeAnchor): "s" | "%" {
  return typeof spec.offset === "string" ? "%" : "s";
}

export function naturalDurOf(node: Child): number {
  if (node.type === "clip" || node.type === "audio") {
    if (node.duration != null) return node.duration;
    const speed = node.speed ?? 1;
    return (node.out - node.in) / speed;
  }
  if (node.type === "empty") return node.duration;
  if (node.type === "data") return node.duration ?? 0;
  if (node.type === "composition") {
    if (node.in != null && node.out != null) return node.out - node.in;
    try {
      return resolveComposition(node).duration;
    } catch {
      return 0;
    }
  }
  return 0;
}

const clamp = (v: number, lo: number, hi: number) =>
  Math.max(lo, Math.min(hi, v));

/**
 * Drag the anchorPoint to shift the resolved point time by `deltaSec`.
 *
 * The drag clamps to the anchor's real bounds — percentage to 0–100%,
 * source-seconds to the anchor's [sourceStart, sourceEnd]. Clamping lives
 * only here (the drag path); editing the property directly can still
 * overshoot, since overshooting is the degenerate case.
 */
export function dragAnchorPoint(
  spec: TimeAnchor,
  deltaSec: number,
  ctx: AnchorEditCtx,
): TimeAnchor {
  if (spec.timeSource === "source") {
    const oldVal = typeof spec.anchorPoint === "number" ? spec.anchorPoint : 0;
    const sourceStart = ctx.anchorBase;
    const sourceEnd =
      ctx.anchorBase + (ctx.anchorEnd - ctx.anchorStart) * ctx.anchorSpeed;
    const next = clamp(oldVal + deltaSec * ctx.anchorSpeed, sourceStart, sourceEnd);
    return { ...spec, anchorPoint: fmtSec(next), timeSource: "source" };
  }
  // output / undefined → output mode (percentage of anchor's output range)
  const range = ctx.anchorEnd - ctx.anchorStart;
  const oldPct =
    typeof spec.anchorPoint === "string" ? parsePct(spec.anchorPoint) : 0;
  const newPct = clamp(oldPct + (range > 0 ? deltaSec / range : 0), 0, 1);
  return { ...spec, anchorPoint: fmtPct(newPct), timeSource: "output" };
}

/**
 * Drag offset by `deltaSec` (output seconds). Clamped by side: an `end`
 * anchor's offset can't go negative and a `start` anchor's can't go
 * positive (the offset would push the edge the wrong way). The opposite
 * sign is the degenerate case — reachable by editing the property, not by
 * dragging.
 */
export function dragOffset(
  spec: TimeAnchor,
  deltaSec: number,
  ctx: AnchorEditCtx,
): TimeAnchor {
  const clampSide = (v: number) =>
    ctx.side === "end" ? Math.max(0, v) : Math.min(0, v);
  if (typeof spec.offset === "string") {
    const oldPct = parsePct(spec.offset);
    const newPct =
      oldPct + (ctx.attNatDur > 0 ? deltaSec / ctx.attNatDur : 0);
    return { ...spec, offset: fmtPct(clampSide(newPct)) };
  }
  const oldSec = typeof spec.offset === "number" ? spec.offset : 0;
  return { ...spec, offset: fmtSec(clampSide(oldSec + deltaSec)) };
}

/**
 * Toggle anchorPoint between source-seconds and output-percent. Recomputes
 * from `pointTime` so the dot stays put on the timeline through the toggle.
 */
export function toggleAnchorPoint(
  spec: TimeAnchor,
  ctx: AnchorEditCtx,
): TimeAnchor {
  if (anchorPointKind(spec) === "s") {
    const range = ctx.anchorEnd - ctx.anchorStart;
    const pct = range > 0 ? (ctx.pointTime - ctx.anchorStart) / range : 0;
    return { ...spec, anchorPoint: fmtPct(pct), timeSource: "output" };
  }
  const sourceTime =
    ctx.anchorBase + (ctx.pointTime - ctx.anchorStart) * ctx.anchorSpeed;
  return { ...spec, anchorPoint: fmtSec(sourceTime), timeSource: "source" };
}

/** Toggle offset between seconds and percent of attachment natural duration. */
export function toggleOffset(spec: TimeAnchor, ctx: AnchorEditCtx): TimeAnchor {
  if (offsetKind(spec) === "s") {
    const sec = typeof spec.offset === "number" ? spec.offset : 0;
    const pct = ctx.attNatDur > 0 ? sec / ctx.attNatDur : 0;
    return { ...spec, offset: fmtPct(pct) };
  }
  const pct = typeof spec.offset === "string" ? parsePct(spec.offset) : 0;
  return { ...spec, offset: fmtSec(pct * ctx.attNatDur) };
}

export function setAttachmentSpec(
  doc: SeamFile,
  attIdx: number,
  side: "start" | "end",
  newSpec: TimeAnchor,
): SeamFile {
  const atts = [...(doc.attachments ?? [])];
  const att = atts[attIdx];
  if (!att) return doc;
  atts[attIdx] = { ...att, [side]: newSpec } as Child;
  return { ...doc, attachments: atts };
}

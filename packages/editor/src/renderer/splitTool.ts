// Split tool: slice the child currently under the playhead into two
// halves. Clips/audio split by source time; compositions split by
// inner timeline. Anchors in the rest of the document that reference
// the split node are rewritten so they keep pointing at the half they
// originally landed on.
//
// Pure transformations on a SeamFile — no React, no platform deps.

import { resolveComposition } from "@seam/core";
import type { Child, Composition, SeamFile, TimeAnchor } from "@seam/core";

function clipBaseSpeed(clip: {
  in: number;
  out: number;
  speed?: number;
  duration?: number;
}): number {
  if (clip.duration != null) return (clip.out - clip.in) / clip.duration;
  return clip.speed ?? 1;
}

/** Collect every `id` appearing anywhere in the document tree. */
function collectAllIds(doc: SeamFile): Set<string> {
  const out = new Set<string>();
  const visit = (child: Child) => {
    const id = (child as { id?: string }).id;
    if (id != null) out.add(id);
    if (child.type === "composition") {
      (child.children ?? []).forEach(visit);
      if (child.attachments) child.attachments.forEach(visit);
    }
  };
  visit(doc);
  return out;
}

/**
 * Pick a unique id for the right-hand side of a split, starting from
 * `${origId}_split` and suffixing `_2`, `_3`, ... on collision.
 */
function uniqueSplitId(existingIds: Set<string>, origId: string): string {
  const base = `${origId}_split`;
  if (!existingIds.has(base)) return base;
  let i = 2;
  while (existingIds.has(`${base}_${i}`)) i++;
  return `${base}_${i}`;
}

/**
 * Context needed to rewrite an anchor that points at a node which just got
 * split in half. All time values are in the ORIGINAL target's local output
 * timeline (the pre-split node's timelineStart-origin coords).
 */
interface SplitContext {
  origId: string;
  rightId: string;
  splitOffset: number; // split point, target-local output seconds
  origLen: number;     // original target's output duration
  baseSourceTime: number; // for source-mode: clip.in
  speed: number;       // for source-mode: source-secs-per-output-sec at the target level
}

function parsePercentStr(s: string): number {
  const m = /^(-?\d+(?:\.\d+)?)%$/.exec(s);
  return m ? parseFloat(m[1]) / 100 : 0;
}

function formatPercentStr(fraction: number): string {
  return `${Math.round(fraction * 1000000) / 10000}%`;
}

/** Natural output duration of a node — used by the anchor rewriter to expand
 *  %-offsets, which are sized against the *attachment's own length*. */
function nodeNaturalDuration(node: Child): number {
  if (node.type === "clip" || node.type === "audio") {
    if (node.duration != null) return node.duration;
    const speed = node.speed ?? 1;
    return (node.out - node.in) / speed;
  }
  if (node.type === "empty") return node.duration;
  if (node.type === "data") return node.duration ?? 0;
  if (node.type === "text") return node.duration ?? 0;
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

/**
 * Rewrite a single anchor spec so it still resolves to the same absolute
 * output time, pointing at whichever half of the split contains it.
 * Returns the original spec if it doesn't reference `origId`.
 */
function rewriteAnchor(
  spec: TimeAnchor | undefined,
  ctx: SplitContext,
  attachmentNatDur: number,
): TimeAnchor | undefined {
  if (!spec || spec.anchor !== ctx.origId) return spec;

  let offsetSeconds = 0;
  if (spec.offset != null) {
    offsetSeconds =
      typeof spec.offset === "number"
        ? spec.offset
        : parsePercentStr(spec.offset) * attachmentNatDur;
  }

  let pointOnTarget: number;
  if (spec.timeSource === "source") {
    const sourceTime =
      typeof spec.anchorPoint === "number" ? spec.anchorPoint : 0;
    pointOnTarget = (sourceTime - ctx.baseSourceTime) / ctx.speed;
  } else {
    const pct =
      typeof spec.anchorPoint === "string"
        ? parsePercentStr(spec.anchorPoint)
        : 0;
    pointOnTarget = pct * ctx.origLen;
  }

  const targetLocalTime = pointOnTarget + offsetSeconds;
  const onLeft = targetLocalTime <= ctx.splitOffset;
  const newAnchorId = onLeft ? ctx.origId : ctx.rightId;

  if (spec.timeSource === "source") {
    const rewritten: TimeAnchor = {
      anchor: newAnchorId,
      timeSource: "source",
      anchorPoint: spec.anchorPoint,
    };
    if (spec.offset != null) rewritten.offset = spec.offset;
    return rewritten;
  }

  const leftLen = ctx.splitOffset;
  const rightLen = ctx.origLen - ctx.splitOffset;
  const newLen = onLeft ? leftLen : rightLen;
  const localOnNew = onLeft
    ? targetLocalTime
    : targetLocalTime - ctx.splitOffset;
  const newFraction = newLen !== 0 ? localOnNew / newLen : 0;
  return {
    anchor: newAnchorId,
    timeSource: "output",
    anchorPoint: formatPercentStr(newFraction),
  };
}

/** Recursively rewrite all `start`/`end` anchors in the tree. */
function rewriteAnchorsInNode(node: Child, ctx: SplitContext): Child {
  const natDur = nodeNaturalDuration(node);
  let next: Child = node;
  const newStart = rewriteAnchor(node.start, ctx, natDur);
  const newEnd = rewriteAnchor(node.end, ctx, natDur);
  if (newStart !== node.start || newEnd !== node.end) {
    next = { ...node };
    if (newStart !== undefined) next.start = newStart;
    if (newEnd !== undefined) next.end = newEnd;
  }

  if (next.type === "composition") {
    const rewrittenChildren = (next.children ?? []).map((c) =>
      rewriteAnchorsInNode(c, ctx),
    );
    const rewrittenAttachments = next.attachments?.map((c) =>
      rewriteAnchorsInNode(c, ctx),
    );
    const updated: Composition = { ...next, children: rewrittenChildren };
    if (rewrittenAttachments) updated.attachments = rewrittenAttachments;
    return updated;
  }
  return next;
}

function rewriteSplitAnchors(doc: SeamFile, ctx: SplitContext): SeamFile {
  return rewriteAnchorsInNode(doc, ctx) as SeamFile;
}

/** Slice the child currently under the playhead. Returns null if no
 *  splittable child contains the playhead. */
export function sliceAtPlayhead(
  doc: SeamFile,
  currentTime: number,
): SeamFile | null {
  const resolved = resolveComposition(doc);
  const children = doc.children ?? [];

  let targetIdx = -1;
  let timelineStart = 0;

  for (let i = 0; i < resolved.children.length; i++) {
    const rc = resolved.children[i];
    if (currentTime > rc.timelineStart && currentTime < rc.timelineEnd) {
      targetIdx = i;
      timelineStart = rc.timelineStart;
      break;
    }
  }

  if (targetIdx === -1) return null;

  const child = children[targetIdx];
  if (
    child.type !== "clip" &&
    child.type !== "audio" &&
    child.type !== "composition"
  ) {
    // Splitting empty/data/text has no clear meaning — bail.
    return null;
  }

  const offset = currentTime - timelineStart;
  const origLen =
    resolved.children[targetIdx].timelineEnd -
    resolved.children[targetIdx].timelineStart;
  const newChildren = [...children];

  // Both halves of a split can't share the original id — left keeps it,
  // right gets a generated `${id}_split` variant (de-duplicated against
  // everything else already in the document).
  const existingIds = collectAllIds(doc);
  const origId = (child as { id?: string }).id;
  const rightId = origId != null ? uniqueSplitId(existingIds, origId) : undefined;

  let first: Child;
  let second: Child;
  let splitContext: SplitContext | null = null;

  if (child.type === "clip" || child.type === "audio") {
    const speed = clipBaseSpeed(child);
    const splitSource = child.in + offset * speed;
    const { duration: _d, ...base } = child;
    first = { ...base, out: splitSource } as typeof child;
    second = { ...base, in: splitSource } as typeof child;
    if (rightId != null) (second as { id?: string }).id = rightId;
    else delete (second as { id?: string }).id;
    if (origId != null && rightId != null) {
      splitContext = {
        origId,
        rightId,
        splitOffset: offset,
        origLen,
        baseSourceTime: child.in,
        speed,
      };
    }
  } else {
    // Composition: both halves share the same body (children +
    // attachments + spatial fields + metadata + filters + script/bin
    // payload). They differ only in the inner-timeline window — first
    // keeps [compIn..innerSplit], second takes [innerSplit..compOut].
    // Child compositions always run at unit speed (overflow/underflow
    // stretching only kicks in for anchored attachments), so the
    // output-offset translates 1:1 to inner-timeline coordinates.
    const compIn = child.in ?? 0;
    const resolvedComp = resolved.children[targetIdx];
    const compOut = child.out ?? compIn + resolvedComp.duration;
    const innerSplit = compIn + offset;
    first = { ...child, in: compIn, out: innerSplit };
    second = { ...child, in: innerSplit, out: compOut };
    if (rightId != null) (second as { id?: string }).id = rightId;
    else delete (second as { id?: string }).id;
    if (origId != null && rightId != null) {
      splitContext = {
        origId,
        rightId,
        splitOffset: offset,
        origLen,
        baseSourceTime: compIn,
        speed: 1,
      };
    }
  }

  newChildren.splice(targetIdx, 1, first, second);
  let nextDoc: SeamFile = { ...doc, children: newChildren };
  if (splitContext) nextDoc = rewriteSplitAnchors(nextDoc, splitContext);
  return nextDoc;
}

// Split tool: slice the child currently under the playhead into two
// halves. Clips/audio split by source time; compositions split by
// inner timeline.
//
// Placement: the left half keeps the original's `id`/`start`/`offset`; the
// right half is a plain run member directly after it (no `start`, no
// `offset`), so whatever followed the original in the array now follows the
// right half. Sibling `start` anchors that referenced the split node are
// rewritten so they keep landing on the same moment:
//   • bare `"id"`      → unchanged (the left half starts where the node did);
//   • `"id@<sec>"`     → retargeted to the right half when the source point
//                        falls after the split;
//   • `"id@<p>%"`      → re-expressed as a fraction of whichever half
//                        contains that moment.
//
// Pure transformations on a SeamFile — no React, no platform deps.

import {
  compileSeamFile,
  formatStart,
  parseStart,
  resolveComposition,
} from "@seam/core";
import type {
  Audio,
  Child,
  Clip,
  Composition,
  Overflow,
  ResolvedChild,
  ResolvedComposition,
  SeamFile,
  Start,
  Underflow,
} from "@seam/core";
import { withPlacement } from "./runEdit.js";

/** Collect every `id` appearing anywhere in the document tree. */
function collectAllIds(doc: SeamFile): Set<string> {
  const out = new Set<string>();
  const visit = (child: Child) => {
    if (child.id != null) out.add(child.id);
    if (child.type === "composition" || child.type === "map") {
      (child.children ?? []).forEach(visit);
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
 * split in half. Output values are in the ORIGINAL target's local output
 * timeline (0 = its start).
 */
interface SplitContext {
  origId: string;
  rightId: string;
  splitOffset: number; // split point, target-local output seconds
  origLen: number; // original target's output duration
  /** Source time the resolver measures `id@<sec>` from on the ORIGINAL node. */
  origBase: number;
  /** Same, for each half after the split. */
  leftBase: number;
  rightBase: number;
  speed: number; // source seconds per output second
}

/**
 * Rewrite one `start` so it still resolves to the same moment, pointing at
 * whichever half of the split contains it. Returns the original value when
 * it doesn't reference `origId` (or needs no change).
 */
function rewriteStart(start: Start | undefined, ctx: SplitContext): Start | undefined {
  if (typeof start !== "string") return start;
  const parsed = parseStart(start);
  if (parsed.kind !== "node" || parsed.id !== ctx.origId || !parsed.point) return start;

  // The anchored moment, in target-local output seconds.
  const moment =
    parsed.point.kind === "source"
      ? (parsed.point.value - ctx.origBase) / ctx.speed
      : parsed.point.value * ctx.origLen;
  const onLeft = moment <= ctx.splitOffset;
  const id = onLeft ? ctx.origId : ctx.rightId;
  const local = onLeft ? moment : moment - ctx.splitOffset;

  if (parsed.point.kind === "source") {
    const base = onLeft ? ctx.leftBase : ctx.rightBase;
    return formatStart({
      kind: "node",
      id,
      point: { kind: "source", value: base + local * ctx.speed },
    });
  }
  const len = onLeft ? ctx.splitOffset : ctx.origLen - ctx.splitOffset;
  return formatStart({
    kind: "node",
    id,
    point: { kind: "percent", value: len !== 0 ? local / len : 0 },
  });
}

/** Start of a composition's visible inner window. `[in, out]` unless a
 *  `duration` is filled by a non-stretch strategy, which trims / extends the
 *  window (mirrors the resolver's overflow / underflow strategies). */
function compWindowIn(
  comp: { overflow?: Overflow; underflow?: Underflow },
  compIn: number,
  compOut: number,
  windowLen: number,
): number {
  const span = compOut - compIn;
  const strategy =
    windowLen < span ? comp.overflow ?? "stretch" : comp.underflow ?? "stretch";
  switch (strategy) {
    case "trim-start":
    case "extend-start":
      return compOut - windowLen;
    case "trim-center":
    case "extend-center":
      return compIn + (span - windowLen) / 2;
    default:
      return compIn;
  }
}

/** True for the node types a slice applies to — splitting static / text /
 *  data / shapes / map has no clear meaning. */
function isSplittable(type: string | undefined): boolean {
  return type === "clip" || type === "audio" || type === "composition";
}

/**
 * Slice every splittable child (clip / audio / composition) under the
 * playhead, in one operation. With `only`, just the children at those indices
 * (the selection). Looping nodes are skipped — they replay their content, so
 * there is no single source point under the playhead to cut at. Returns null
 * when nothing was split.
 */
export function sliceAtPlayhead(
  doc: SeamFile,
  currentTime: number,
  only?: ReadonlySet<number>,
): SeamFile | null {
  // Resolve the COMPILED doc (bins inflated, scripts skipped) so `binItem`
  // references have their real body + duration — otherwise they resolve as
  // empty zero-width compositions and the playhead hit-test below never
  // matches them. `runScripts: false` + `uncropped` keep resolved children
  // 1:1 with the authored array, so indices address `doc.children` (the
  // array we mutate).
  const resolved = resolveComposition(
    compileSeamFile(doc, { runScripts: false }).doc,
    { uncropped: true },
  );
  const children = doc.children ?? [];

  const targets: number[] = [];
  for (let i = 0; i < resolved.children.length; i++) {
    if (only && !only.has(i)) continue;
    const rc = resolved.children[i];
    if (!isSplittable(children[i]?.type)) continue;
    if (currentTime > rc.timelineStart && currentTime < rc.timelineEnd) targets.push(i);
  }

  // Highest index first: each split inserts its right half just after the
  // node, so lower indices (and their resolved entries — a split never moves
  // anything in time) stay valid.
  let next = doc;
  for (let k = targets.length - 1; k >= 0; k--) {
    next = splitChildAt(next, targets[k], resolved.children[targets[k]], currentTime) ?? next;
  }
  return next === doc ? null : next;
}

/** Split `doc.children[targetIdx]` (resolving to `rChild`) at `currentTime`. */
function splitChildAt(
  doc: SeamFile,
  targetIdx: number,
  rChild: ResolvedChild,
  currentTime: number,
): SeamFile | null {
  const children = doc.children ?? [];
  const child = children[targetIdx] as Clip | Audio | Composition;
  if (
    (rChild.type !== "clip" && rChild.type !== "audio" && rChild.type !== "composition") ||
    rChild.loop
  ) {
    return null;
  }

  const offset = currentTime - rChild.timelineStart;
  const origLen = rChild.timelineEnd - rChild.timelineStart;
  const speed = rChild.speed;

  // Both halves of a split can't share the original id — left keeps it,
  // right gets a generated `${id}_split` variant (de-duplicated against
  // everything else already in the document).
  const origId = child.id;
  const rightId = origId != null ? uniqueSplitId(collectAllIds(doc), origId) : undefined;

  // The source window the node actually plays ([in, out], or what a
  // non-stretch overflow/underflow made of it) and the source time anchors
  // are measured from.
  let windowIn: number;
  let windowOut: number;
  let origBase: number;
  if (rChild.type === "composition") {
    // Composition (incl. a `binItem` reference, whose body comes from the
    // bin entry): both halves share the same node, differing only in the
    // inner-timeline window. A reference with no authored `in`/`out` windows
    // the whole adopted body.
    const comp = child as Composition;
    const windowLen = (rChild as ResolvedComposition).duration * speed;
    const compIn = comp.in ?? 0;
    const compOut = comp.out ?? compIn + windowLen;
    windowIn = compWindowIn(comp, compIn, compOut, windowLen);
    windowOut = windowIn + windowLen;
    origBase = compIn;
  } else {
    windowIn = rChild.sourceIn;
    windowOut = rChild.sourceOut;
    origBase = rChild.sourceIn;
  }
  const splitSource = windowIn + offset * speed;

  // An authored `duration` is split along with the window, so each half
  // keeps the original's playback rate (and `out` is always materialised).
  const first = {
    ...child,
    in: windowIn,
    out: splitSource,
    ...(child.duration != null ? { duration: offset } : {}),
  } as Child;
  const { id: _id, ...rightBase } = child;
  const second = withPlacement(
    {
      ...rightBase,
      ...(rightId != null ? { id: rightId } : {}),
      in: splitSource,
      out: windowOut,
      ...(child.duration != null ? { duration: origLen - offset } : {}),
    } as Child,
    undefined,
    undefined,
  );

  const ctx: SplitContext | null =
    origId != null && rightId != null
      ? {
          origId,
          rightId,
          splitOffset: offset,
          origLen,
          origBase,
          leftBase: windowIn,
          rightBase: splitSource,
          speed,
        }
      : null;

  const newChildren: Child[] = [];
  children.forEach((c, i) => {
    if (i === targetIdx) {
      newChildren.push(first, second);
      return;
    }
    // Anchors are sibling-scoped, so only this array can reference the node.
    const start = ctx ? rewriteStart(c.start, ctx) : c.start;
    newChildren.push(start !== c.start ? ({ ...c, start } as Child) : c);
  });
  return { ...doc, children: newChildren };
}

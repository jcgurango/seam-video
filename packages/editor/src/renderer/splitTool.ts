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
  formatStart,
  parseStart,
  resolvedPlayStart,
  resolvedSignedRate,
} from "@seam/core";
import type {
  Seam,
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
    // A composition or an extension container (a map).
    const kids = (child as { children?: Child[] }).children;
    if (Array.isArray(kids)) kids.forEach(visit);
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
  /** SIGNED source seconds per output second (negative = reversed clip). */
  speed: number;
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
function isSplittable(seam: Seam, type: string | undefined): boolean {
  if (type === "clip" || type === "audio" || type === "composition") return true;
  // An extension node type that says how it splits (a caption, between words).
  return type != null && seam.nodeTypes.get(type)?.editor?.split != null;
}

const micro = (n: number) => Math.round(n * 1e6) / 1e6;

/**
 * Split an extension node through its type's own `editor.split`. The left
 * half keeps the slot. The right half gets the SAME anchor moved forward to
 * where it begins (`at` seconds after the original's start), so each half
 * stands on its own:
 *   • numeric `start`           → `start + at`;
 *   • source anchor `"id@12"`   → the seconds advanced by `at` at the
 *                                 target's playback rate (it stays glued to
 *                                 the same moment of the footage);
 *   • bare `"id"` / `"id@50%"`  → same anchor, `offset` increased by `at`;
 *   • no `start` (a run member) → the next run member, `offset` = the gap
 *                                 left between the two.
 */
function splitExtensionAt(
  seam: Seam,
  doc: SeamFile,
  index: number,
  resolved: ResolvedChild[],
  currentTime: number,
): SeamFile | null {
  const children = doc.children ?? [];
  const child = children[index] as Child & { start?: Start; offset?: number };
  const rChild = resolved[index];
  const split = seam.nodeTypes.get(child.type)?.editor?.split;
  if (!split) return null;
  const result = split(child as unknown as Record<string, unknown>, currentTime - rChild.timelineStart);
  if (!result) return null;
  const { id: _id, start: _start, offset: _offset, ...body } = result.right as {
    id?: unknown;
    start?: unknown;
    offset?: unknown;
  };
  const at = result.at;

  let placement: { start?: Start; offset?: number };
  if (child.start === undefined) {
    // A run member: the right half continues the run after the left one.
    const leftLength = (() => {
      try {
        const kids = [...children];
        kids[index] = result.left as unknown as Child;
        const r = seam.resolveComposition(
          seam.compileSeamFile({ ...doc, children: kids }, { runScripts: false }).doc,
          { uncropped: true },
        ).children[index];
        return r.timelineEnd - r.timelineStart;
      } catch {
        return at;
      }
    })();
    const gap = micro(at - leftLength);
    placement = gap > 0 ? { offset: gap } : {};
  } else {
    const parsed = typeof child.start === "number" ? null : parseStart(child.start);
    if (typeof child.start === "number") {
      placement = { start: micro(child.start + at) };
      if (child.offset != null) placement.offset = child.offset;
    } else if (parsed && parsed.kind === "node" && parsed.point?.kind === "source") {
      // Source seconds per output second of the anchored sibling.
      const targetIndex = children.findIndex((c) => c.id === parsed.id);
      const rTarget = targetIndex >= 0 ? resolved[targetIndex] : undefined;
      const rate =
        rTarget && (rTarget.type === "clip" || rTarget.type === "audio")
          ? resolvedSignedRate(rTarget)
          : rTarget && rTarget.type === "composition"
            ? rTarget.speed
            : 1;
      placement = {
        start: formatStart({
          kind: "node",
          id: parsed.id,
          point: { kind: "source", value: micro(parsed.point.value + at * rate) },
        }),
      };
      if (child.offset != null) placement.offset = child.offset;
    } else {
      // The start of a sibling, or a fraction of it: keep the anchor.
      placement = { start: child.start, offset: micro((child.offset ?? 0) + at) };
    }
  }

  const next = [...children];
  next.splice(index, 1, result.left as unknown as Child, { ...body, ...placement } as unknown as Child);
  return { ...doc, children: next };
}

/**
 * Slice every splittable child (clip / audio / composition) under the
 * playhead, in one operation. With `only`, just the children at those indices
 * (the selection). Looping nodes are skipped — they replay their content, so
 * there is no single source point under the playhead to cut at. Returns null
 * when nothing was split.
 */
export function sliceAtPlayhead(
  seam: Seam,
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
  const resolved = seam.resolveComposition(
    seam.compileSeamFile(doc, { runScripts: false }).doc,
    { uncropped: true },
  );
  const children = doc.children ?? [];

  const targets: number[] = [];
  for (let i = 0; i < resolved.children.length; i++) {
    if (only && !only.has(i)) continue;
    const rc = resolved.children[i];
    if (!isSplittable(seam, children[i]?.type)) continue;
    if (currentTime > rc.timelineStart && currentTime < rc.timelineEnd) targets.push(i);
  }

  // Highest index first: each split inserts its right half just after the
  // node, so lower indices (and their resolved entries — a split never moves
  // anything in time) stay valid.
  let next = doc;
  for (let k = targets.length - 1; k >= 0; k--) {
    const i = targets[k];
    const rChild = resolved.children[i];
    next =
      ("extension" in rChild
        ? splitExtensionAt(seam, next, i, resolved.children, currentTime)
        : splitChildAt(next, i, rChild, currentTime)) ?? next;
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
  // Signed: a reversed clip/audio runs DOWN its source axis, so everything
  // below works in playback order (`windowIn` = the source time at the node's
  // first output instant, `windowOut` at its last) and both halves come out
  // reversed, the left one keeping the high end.
  const speed =
    rChild.type === "composition" ? rChild.speed : resolvedSignedRate(rChild);
  // A negative authored `duration` (reverse) stays negative on both halves.
  const durSign = child.duration != null && child.duration < 0 ? -1 : 1;

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
    windowIn = resolvedPlayStart(rChild);
    windowOut = rChild.reverse ? rChild.sourceIn : rChild.sourceOut;
    origBase = windowIn;
  }
  const splitSource = windowIn + offset * speed;

  // An authored `duration` is split along with the window, so each half
  // keeps the original's playback rate (and `out` is always materialised).
  const first = {
    ...child,
    in: windowIn,
    out: splitSource,
    ...(child.duration != null ? { duration: durSign * offset } : {}),
  } as Child;
  const { id: _id, ...rightBase } = child;
  const second = withPlacement(
    {
      ...rightBase,
      ...(rightId != null ? { id: rightId } : {}),
      in: splitSource,
      out: windowOut,
      ...(child.duration != null ? { duration: durSign * (origLen - offset) } : {}),
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

import type { Composition, Child, Clip, Empty } from "../types.js";
import type {
  ResolvedTimeline,
  ResolvedChild,
  ResolvedClip,
  ResolvedEmpty,
} from "../resolved-types.js";
import { distributeFlex } from "./flex.js";
import { applyOverflow } from "./overflow.js";
import { applyUnderflow } from "./underflow.js";
import { computeJustifyOffsets } from "./justify.js";

function naturalDuration(child: Child): number {
  switch (child.type) {
    case "clip":
      return child.out - child.in;
    case "empty":
      return child.duration;
    case "composition": {
      if (child.in != null && child.out != null) {
        return child.out - child.in;
      }
      return resolveComposition(child).duration;
    }
  }
}

export function resolveComposition(composition: Composition): ResolvedTimeline {
  const { children, layout } = composition;
  const justify = layout?.justify ?? "start";
  const gap = layout?.gap ?? 0;

  const naturals = children.map((c) => naturalDuration(c));
  const totalGap = gap * Math.max(0, children.length - 1);
  const sumNaturals = naturals.reduce((a, b) => a + b, 0);
  const containerDuration = layout?.duration ?? sumNaturals + totalGap;

  // Compute target durations
  const hasFlex = children.some((c) => c.flex);
  let targetDurations: number[];

  if (hasFlex) {
    targetDurations = distributeFlex(children, naturals, totalGap, containerDuration);
  } else {
    targetDurations = [...naturals];
  }

  // Apply overflow/underflow per child, flatten nested compositions
  const resolvedChildren: ResolvedChild[] = [];
  const actualDurations: number[] = [];

  for (let i = 0; i < children.length; i++) {
    const child = children[i];
    const nat = naturals[i];
    const target = targetDurations[i];

    if (child.type === "empty") {
      resolvedChildren.push({
        type: "empty" as const,
        timelineStart: 0,
        timelineEnd: 0,
      });
      actualDurations.push(target);
      continue;
    }

    if (child.type === "composition") {
      const inner = resolveComposition(child);
      const compIn = child.in ?? 0;
      const compOut = child.out ?? inner.duration;
      const compNatural = compOut - compIn;

      let windowIn = compIn;
      let windowOut = compOut;
      let speed = 1;

      if (target < compNatural) {
        const overflow = child.overflow ?? "trim-end";
        const result = applyOverflow(overflow, compIn, compOut, target);
        windowIn = result.sourceIn;
        windowOut = result.sourceOut;
        speed = result.speed;
      } else if (target > compNatural) {
        const underflow = child.underflow;
        if (underflow) {
          const result = applyUnderflow(underflow, compIn, compOut, target);
          windowIn = result.sourceIn;
          windowOut = result.sourceOut;
          speed = result.speed;
        }
      }

      // Flatten: crop inner children to the visible window
      const flattened = flattenInnerComposition(inner, windowIn, windowOut, speed);
      for (const fc of flattened) {
        resolvedChildren.push(fc);
      }
      const windowDur = speed !== 1
        ? (windowOut - windowIn) / speed
        : windowOut - windowIn;
      actualDurations.push(windowDur);
      continue;
    }

    // Clip
    const clip = child;
    let sourceIn = clip.in;
    let sourceOut = clip.out;
    let speed = 1;

    if (target < nat) {
      const overflow = clip.overflow ?? "trim-end";
      const result = applyOverflow(overflow, sourceIn, sourceOut, target);
      sourceIn = result.sourceIn;
      sourceOut = result.sourceOut;
      speed = result.speed;
    } else if (target > nat) {
      const underflow = clip.underflow;
      if (underflow) {
        const result = applyUnderflow(underflow, sourceIn, sourceOut, target);
        sourceIn = result.sourceIn;
        sourceOut = result.sourceOut;
        speed = result.speed;
      }
    }

    resolvedChildren.push({
      type: "clip" as const,
      source: clip.source,
      sourceIn,
      sourceOut,
      timelineStart: 0,
      timelineEnd: 0,
      speed,
    });

    const clipDur = speed !== 1
      ? (sourceOut - sourceIn) / speed
      : sourceOut - sourceIn;
    actualDurations.push(clipDur);
  }

  // Apply justify to compute timeline positions
  const offsets = computeJustifyOffsets(
    justify,
    actualDurations,
    gap,
    containerDuration
  );

  // Assign timeline positions. Compositions may have produced multiple
  // resolved children for a single logical child, so we walk with two cursors.
  let ri = 0;
  for (let i = 0; i < actualDurations.length; i++) {
    const start = offsets[i];
    const end = start + actualDurations[i];

    // Count how many resolved children belong to this logical child.
    // Non-composition children produce exactly 1. Compositions may produce N.
    // We tagged composition children by collecting them as a group above,
    // but since we push them sequentially, we need to track counts.
    // Simple approach: recount from the children array.
    const child = children[i];
    if (child.type === "composition") {
      const inner = resolveComposition(child);
      const compIn = child.in ?? 0;
      const compOut = child.out ?? inner.duration;
      // Recalculate how many resolved items this produced
      const count = countFlattenedChildren(inner, compIn, compOut);
      // Offset all flattened children relative to this logical child's start
      for (let j = 0; j < count; j++) {
        const rc = resolvedChildren[ri + j];
        resolvedChildren[ri + j] = {
          ...rc,
          timelineStart: start + rc.timelineStart,
          timelineEnd: start + rc.timelineEnd,
        };
      }
      ri += count;
    } else {
      resolvedChildren[ri] = {
        ...resolvedChildren[ri],
        timelineStart: start,
        timelineEnd: end,
      };
      ri += 1;
    }
  }

  return {
    duration: containerDuration,
    children: resolvedChildren,
  };
}

/**
 * Flatten a resolved inner composition into a list of resolved children,
 * cropped to the visible window [windowIn, windowOut] of the inner timeline.
 */
function flattenInnerComposition(
  inner: ResolvedTimeline,
  windowIn: number,
  windowOut: number,
  speed: number
): ResolvedChild[] {
  const result: ResolvedChild[] = [];

  for (const child of inner.children) {
    // Skip children completely outside the window
    if (child.timelineEnd <= windowIn || child.timelineStart >= windowOut) {
      continue;
    }

    // Clamp to window
    const visibleStart = Math.max(child.timelineStart, windowIn);
    const visibleEnd = Math.min(child.timelineEnd, windowOut);
    const offsetStart = (visibleStart - windowIn) / (speed !== 0 ? speed : 1);
    const offsetEnd = (visibleEnd - windowIn) / (speed !== 0 ? speed : 1);

    if (child.type === "clip") {
      const clipStartOffset = visibleStart - child.timelineStart;
      const clipEndOffset = child.timelineEnd - visibleEnd;

      result.push({
        type: "clip",
        source: child.source,
        sourceIn: child.sourceIn + clipStartOffset * child.speed,
        sourceOut: child.sourceOut - clipEndOffset * child.speed,
        timelineStart: offsetStart,
        timelineEnd: offsetEnd,
        speed: child.speed * speed,
      });
    } else {
      result.push({
        type: "empty",
        timelineStart: offsetStart,
        timelineEnd: offsetEnd,
      });
    }
  }

  // If window starts before any children, insert leading empty
  if (result.length === 0) {
    const dur = (windowOut - windowIn) / (speed !== 0 ? speed : 1);
    result.push({ type: "empty", timelineStart: 0, timelineEnd: dur });
  }

  return result;
}

function countFlattenedChildren(
  inner: ResolvedTimeline,
  windowIn: number,
  windowOut: number
): number {
  let count = 0;
  for (const child of inner.children) {
    if (child.timelineEnd <= windowIn || child.timelineStart >= windowOut) {
      continue;
    }
    count++;
  }
  return count || 1; // at least 1 for the empty fallback
}

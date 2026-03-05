import type { Composition, Overlay, Child, Overflow } from "../types.js";
import type {
  ResolvedTimeline,
  ResolvedChild,
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
    case "overlay": {
      if (child.in != null && child.out != null) {
        return child.out - child.in;
      }
      return resolveOverlay(child).duration;
    }
  }
}

/**
 * Resolve a single child to its target duration, applying overflow/underflow.
 * Returns the resolved child (with placeholder timeline positions) and its actual duration.
 */
function resolveChild(
  child: Child,
  nat: number,
  target: number,
  defaultOverflow: Overflow
): { resolved: ResolvedChild; actualDuration: number } {
  if (child.type === "empty") {
    return {
      resolved: { type: "empty" as const, timelineStart: 0, timelineEnd: 0 },
      actualDuration: target,
    };
  }

  if (child.type === "composition" || child.type === "overlay") {
    const inner = child.type === "composition"
      ? resolveComposition(child)
      : resolveOverlay(child);
    const compIn = child.in ?? 0;
    const compOut = child.out ?? inner.duration;
    const compNatural = compOut - compIn;

    let windowIn = compIn;
    let windowOut = compOut;
    let speed = 1;

    if (target < compNatural) {
      const overflow = child.overflow ?? defaultOverflow;
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

    const croppedChildren = cropChildrenToWindow(inner.children, windowIn, windowOut);
    const windowDur = speed !== 1
      ? (windowOut - windowIn) / speed
      : windowOut - windowIn;

    return {
      resolved: {
        type: child.type as "composition",
        timelineStart: 0,
        timelineEnd: 0,
        duration: windowDur,
        speed,
        children: croppedChildren,
      },
      actualDuration: windowDur,
    };
  }

  // Clip
  const clip = child;
  let sourceIn = clip.in;
  let sourceOut = clip.out;
  let speed = 1;

  if (target < nat) {
    const overflow = clip.overflow ?? defaultOverflow;
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

  const clipDur = speed !== 1
    ? (sourceOut - sourceIn) / speed
    : sourceOut - sourceIn;

  return {
    resolved: {
      type: "clip" as const,
      source: clip.source,
      sourceIn,
      sourceOut,
      timelineStart: 0,
      timelineEnd: 0,
      speed,
    },
    actualDuration: clipDur,
  };
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

  // Resolve each child
  const resolvedChildren: ResolvedChild[] = [];
  const actualDurations: number[] = [];

  for (let i = 0; i < children.length; i++) {
    const { resolved, actualDuration } = resolveChild(
      children[i], naturals[i], targetDurations[i], "trim-end"
    );
    resolvedChildren.push(resolved);
    actualDurations.push(actualDuration);
  }

  // Apply justify to compute timeline positions
  const offsets = computeJustifyOffsets(
    justify,
    actualDurations,
    gap,
    containerDuration
  );

  // Assign timeline positions
  for (let i = 0; i < resolvedChildren.length; i++) {
    const start = offsets[i];
    const end = start + actualDurations[i];
    resolvedChildren[i] = {
      ...resolvedChildren[i],
      timelineStart: start,
      timelineEnd: end,
    };
  }

  return {
    duration: containerDuration,
    children: resolvedChildren,
  };
}

export function resolveOverlay(overlay: Overlay): ResolvedTimeline {
  const { children, alignItems = "start" } = overlay;

  const naturals = children.map((c) => naturalDuration(c));
  const containerDuration = overlay.duration ?? Math.max(...naturals);

  // Default overflow depends on alignItems
  const defaultOverflow: Overflow =
    alignItems === "end" ? "trim-start" :
    alignItems === "center" ? "trim-center" :
    "trim-end";

  const resolvedChildren: ResolvedChild[] = [];

  for (let i = 0; i < children.length; i++) {
    const child = children[i];
    const nat = naturals[i];

    // Flex in overlay: any flex > 0 forces target = containerDuration
    // Without flex, children can't exceed the container duration
    const hasFlex = child.type !== "empty" && child.flex && child.flex > 0;
    const target = hasFlex ? containerDuration : Math.min(nat, containerDuration);

    const { resolved, actualDuration } = resolveChild(child, nat, target, defaultOverflow);

    // Position based on alignItems
    let offset: number;
    switch (alignItems) {
      case "end":
        offset = containerDuration - actualDuration;
        break;
      case "center":
        offset = (containerDuration - actualDuration) / 2;
        break;
      default:
        offset = 0;
        break;
    }

    resolvedChildren.push({
      ...resolved,
      timelineStart: offset,
      timelineEnd: offset + actualDuration,
    });
  }

  return {
    duration: containerDuration,
    children: resolvedChildren,
  };
}

/**
 * Crop resolved children to the visible window [windowIn, windowOut]
 * of the inner timeline, preserving nesting. Timeline positions are
 * rebased so the first visible moment maps to time 0.
 */
function cropChildrenToWindow(
  children: ResolvedChild[],
  windowIn: number,
  windowOut: number
): ResolvedChild[] {
  const result: ResolvedChild[] = [];

  for (const child of children) {
    // Skip children completely outside the window
    if (child.timelineEnd <= windowIn || child.timelineStart >= windowOut) {
      continue;
    }

    // Clamp to window
    const visibleStart = Math.max(child.timelineStart, windowIn);
    const visibleEnd = Math.min(child.timelineEnd, windowOut);
    const rebasedStart = visibleStart - windowIn;
    const rebasedEnd = visibleEnd - windowIn;

    if (child.type === "clip") {
      const clipStartOffset = visibleStart - child.timelineStart;
      const clipEndOffset = child.timelineEnd - visibleEnd;

      result.push({
        type: "clip",
        source: child.source,
        sourceIn: child.sourceIn + clipStartOffset * child.speed,
        sourceOut: child.sourceOut - clipEndOffset * child.speed,
        timelineStart: rebasedStart,
        timelineEnd: rebasedEnd,
        speed: child.speed,
      });
    } else if (child.type === "empty") {
      result.push({
        type: "empty",
        timelineStart: rebasedStart,
        timelineEnd: rebasedEnd,
      });
    } else {
      // Nested composition or overlay — crop recursively
      const innerWindowIn = visibleStart - child.timelineStart;
      const innerWindowOut = innerWindowIn + (visibleEnd - visibleStart);
      const croppedInner = cropChildrenToWindow(child.children, innerWindowIn, innerWindowOut);

      result.push({
        type: child.type,
        timelineStart: rebasedStart,
        timelineEnd: rebasedEnd,
        duration: rebasedEnd - rebasedStart,
        speed: child.speed,
        children: croppedInner,
      });
    }
  }

  // If window has no visible children, insert an empty
  if (result.length === 0) {
    const dur = windowOut - windowIn;
    result.push({ type: "empty", timelineStart: 0, timelineEnd: dur });
  }

  return result;
}

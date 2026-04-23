import type {
  Composition,
  Child,
  Overflow,
  TimeAnchor,
} from "../types.js";
import type {
  ResolvedTimeline,
  ResolvedChild,
  SpatialInput,
} from "../resolved-types.js";
import { distributeFlex } from "./flex.js";
import { applyOverflow } from "./overflow.js";
import { applyUnderflow } from "./underflow.js";
import { computeJustifyOffsets } from "./justify.js";
import { inlineRefs } from "../inline.js";

function clipBaseSpeed(clip: { in: number; out: number; speed?: number; duration?: number }): number {
  if (clip.duration != null) return (clip.out - clip.in) / clip.duration;
  return clip.speed ?? 1;
}

function naturalDuration(child: Child): number {
  switch (child.type) {
    case "clip":
      return (child.out - child.in) / clipBaseSpeed(child);
    case "empty":
      return child.duration;
    case "composition": {
      if (child.in != null && child.out != null) {
        return child.out - child.in;
      }
      return resolveCompositionInner(child).duration;
    }
    case "ref":
      throw new Error(
        `internal: ref "${child.source}" reached layout; refs must be inlined before resolve`
      );
  }
}

/**
 * Resolve a single child to its target duration, applying overflow/underflow.
 * Returns the resolved child (with placeholder timeline positions) and its actual duration.
 */
function collectSpatialInput(child: Child): SpatialInput | undefined {
  if (child.type === "empty") return undefined;
  const { position, objectFit, top, left, right, bottom, width, height } = child;
  if (position == null && objectFit == null && top == null && left == null &&
      right == null && bottom == null && width == null && height == null) {
    return undefined;
  }
  return { position, objectFit, top, left, right, bottom, width, height };
}

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

  if (child.type === "ref") {
    throw new Error(
      `internal: ref "${child.source}" reached layout; refs must be inlined before resolve`
    );
  }

  const spatialInput = collectSpatialInput(child);

  if (child.type === "composition") {
    const inner = resolveCompositionInner(child);
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
        type: "composition" as const,
        timelineStart: 0,
        timelineEnd: 0,
        duration: windowDur,
        speed,
        children: croppedChildren,
        ...(spatialInput ? { spatialInput } : {}),
        ...(child.filters?.length ? { filters: child.filters } : {}),
        ...(child.contentWidth != null ? { contentWidth: child.contentWidth } : {}),
        ...(child.contentHeight != null ? { contentHeight: child.contentHeight } : {}),
      },
      actualDuration: windowDur,
    };
  }

  // Clip
  const clip = child;
  let sourceIn = clip.in;
  let sourceOut = clip.out;
  const baseSpeed = clipBaseSpeed(clip);
  let speed = baseSpeed;

  if (target < nat) {
    const overflow = clip.overflow ?? defaultOverflow;
    const sourceTarget = target * baseSpeed;
    const result = applyOverflow(overflow, sourceIn, sourceOut, sourceTarget);
    sourceIn = result.sourceIn;
    sourceOut = result.sourceOut;
    speed = result.speed * baseSpeed;
  } else if (target > nat) {
    const underflow = clip.underflow;
    if (underflow) {
      const sourceTarget = target * baseSpeed;
      const result = applyUnderflow(underflow, sourceIn, sourceOut, sourceTarget);
      sourceIn = result.sourceIn;
      sourceOut = result.sourceOut;
      speed = result.speed * baseSpeed;
    }
  }

  const clipDur = (sourceOut - sourceIn) / speed;

  return {
    resolved: {
      type: "clip" as const,
      source: clip.source,
      sourceIn,
      sourceOut,
      timelineStart: 0,
      timelineEnd: 0,
      speed,
      ...(spatialInput ? { spatialInput } : {}),
      ...(clip.filters?.length ? { filters: clip.filters } : {}),
    },
    actualDuration: clipDur,
  };
}

/**
 * Public entry point: inlines any `ref` children and `refs` dicts before
 * running layout. Call this on top-level (or subtree) inputs that may
 * contain refs.
 */
export function resolveComposition(composition: Composition): ResolvedTimeline {
  return resolveCompositionInner(inlineRefs(composition));
}

/** Inner resolver — assumes the input has already been inlined. */
function resolveCompositionInner(composition: Composition): ResolvedTimeline {
  const { children, layout, unitDuration } = composition;
  const duration = composition.duration;
  const justify = layout?.justify ?? "start";
  const gap = layout?.gap ?? 0;

  const naturals = children.map((c) => naturalDuration(c));
  const totalGap = gap * Math.max(0, children.length - 1);
  const sumNaturals = naturals.reduce((a, b) => a + b, 0);

  let containerDuration: number;
  let targetDurations: number[];

  if (unitDuration != null) {
    const flexValues = children.map((c) => c.flex ?? 1);
    const totalFlex = flexValues.reduce((a, b) => a + b, 0);
    containerDuration = unitDuration * totalFlex + totalGap;
    targetDurations = flexValues.map((f) => unitDuration * f);
  } else {
    containerDuration = duration ?? sumNaturals + totalGap;

    // Compute target durations
    const hasFlex = children.some((c) => c.flex);
    if (hasFlex) {
      targetDurations = distributeFlex(children, naturals, totalGap, containerDuration);
    } else {
      targetDurations = [...naturals];
    }
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

  // Assign timeline positions and build the id map from this composition's
  // direct children. Ids are scoped to the composition — we deliberately
  // don't look into nested children here, so an attachment can only anchor
  // to a sibling.
  const idMap = new Map<string, IdMapEntry>();
  for (let i = 0; i < resolvedChildren.length; i++) {
    const start = offsets[i];
    const end = start + actualDurations[i];
    resolvedChildren[i] = {
      ...resolvedChildren[i],
      timelineStart: start,
      timelineEnd: end,
    };
    const id = getId(children[i]);
    if (id != null) {
      if (idMap.has(id)) {
        throw new Error(`duplicate id "${id}" in composition`);
      }
      idMap.set(id, buildIdMapEntry(children[i], resolvedChildren[i]));
    }
  }

  // Resolve attachments in array order. Each attachment can reference ids of
  // direct children or earlier attachments. Rendered as regular resolved
  // children appended after the sequential ones — later in the array means
  // on top.
  for (const att of composition.attachments ?? []) {
    const resolvedAtt = resolveAttachment(att, idMap);
    resolvedChildren.push(resolvedAtt);
    const id = getId(att);
    if (id != null) {
      if (idMap.has(id)) {
        throw new Error(`duplicate id "${id}" in composition`);
      }
      idMap.set(id, buildIdMapEntry(att, resolvedAtt));
    }
  }

  return {
    duration: containerDuration,
    children: resolvedChildren,
    ...(composition.objectFit ? { objectFit: composition.objectFit } : {}),
    ...(composition.contentWidth != null ? { contentWidth: composition.contentWidth } : {}),
    ...(composition.contentHeight != null ? { contentHeight: composition.contentHeight } : {}),
  };
}

/**
 * Per-id data used to resolve both "output"-mode (percentage of output span)
 * and "source"-mode (pre-trim/pre-window source time) anchors.
 *
 * Inverse mapping from source time to output time, used in source mode:
 *   output_time = start + (source_time - baseSourceTime) / speed
 */
interface IdMapEntry {
  start: number;
  end: number;
  baseSourceTime: number;
  speed: number;
}

function getId(child: Child): string | undefined {
  return (child as { id?: string }).id;
}

function buildIdMapEntry(
  original: Child,
  resolved: ResolvedChild
): IdMapEntry {
  const start = resolved.timelineStart;
  const end = resolved.timelineEnd;
  if (resolved.type === "clip") {
    return {
      start,
      end,
      baseSourceTime: resolved.sourceIn,
      speed: resolved.speed,
    };
  }
  if (resolved.type === "empty") {
    return { start, end, baseSourceTime: 0, speed: 1 };
  }
  // composition — source time is the pre-window inner timeline
  const baseSourceTime =
    original.type === "composition" ? original.in ?? 0 : 0;
  return { start, end, baseSourceTime, speed: resolved.speed };
}

function resolveAnchorTime(
  spec: TimeAnchor,
  idMap: Map<string, IdMapEntry>
): number {
  // No anchor: offset is an absolute seconds value (percentage offset and
  // timeSource don't apply — there's nothing to be a percentage/source of).
  if (spec.anchor == null) {
    if (spec.anchorPoint != null) {
      throw new Error("'anchorPoint' requires an 'anchor'");
    }
    if (spec.timeSource != null) {
      throw new Error("'timeSource' requires an 'anchor'");
    }
    if (typeof spec.offset === "string") {
      throw new Error(
        "percentage offset requires an 'anchor' (there's no anchor to take a percentage of)"
      );
    }
    return spec.offset ?? 0;
  }

  const anchor = idMap.get(spec.anchor);
  if (!anchor) {
    throw new Error(`anchor "${spec.anchor}" not found`);
  }
  const anchorLen = anchor.end - anchor.start;
  if (spec.timeSource == null) {
    throw new Error("'timeSource' is required when 'anchor' is provided");
  }
  const timeSource = spec.timeSource;

  let pointTime: number;
  if (timeSource === "source") {
    if (spec.anchorPoint != null && typeof spec.anchorPoint !== "number") {
      throw new Error(
        `when timeSource is "source", anchorPoint must be a number (seconds)`
      );
    }
    const sourceTime = (spec.anchorPoint as number | undefined) ?? 0;
    pointTime =
      anchor.start + (sourceTime - anchor.baseSourceTime) / anchor.speed;
  } else {
    if (spec.anchorPoint != null && typeof spec.anchorPoint !== "string") {
      throw new Error(
        `when timeSource is "output", anchorPoint must be a percentage string`
      );
    }
    const pointPct = parsePercent(spec.anchorPoint ?? "0%");
    pointTime = anchor.start + anchorLen * pointPct;
  }

  let offsetSec = 0;
  if (spec.offset != null) {
    if (typeof spec.offset === "number") {
      offsetSec = spec.offset;
    } else {
      offsetSec = parsePercent(spec.offset) * anchorLen;
    }
  }

  return pointTime + offsetSec;
}

function parsePercent(s: string): number {
  const m = /^(-?\d+(?:\.\d+)?)%$/.exec(s);
  if (!m) throw new Error(`expected percentage string, got "${s}"`);
  return parseFloat(m[1]) / 100;
}

/**
 * Force a child to render at exactly `target` timeline seconds. Clips adjust
 * via `duration` (which implies speed); composition windows use stretch
 * overflow/underflow so their effective speed scales to fit.
 */
function forceTimelineDuration(child: Child, target: number): Child {
  if (child.type === "clip") {
    const { speed: _s, ...rest } = child;
    return { ...rest, duration: target };
  }
  if (child.type === "empty") {
    return { ...child, duration: target };
  }
  if (child.type === "composition") {
    return { ...child, overflow: "stretch", underflow: "stretch" };
  }
  // ref should've been inlined already
  return child;
}

function resolveAttachment(
  att: Child,
  idMap: Map<string, IdMapEntry>
): ResolvedChild {
  const startT = att.start ? resolveAnchorTime(att.start, idMap) : null;
  const endT = att.end ? resolveAnchorTime(att.end, idMap) : null;

  let effective: Child = att;
  let position: number;
  let target: number;

  if (startT != null && endT != null) {
    if (endT <= startT) {
      throw new Error(
        `attachment end (${endT}) must be after start (${startT})`
      );
    }
    position = startT;
    target = endT - startT;
    effective = forceTimelineDuration(att, target);
  } else if (startT != null) {
    position = startT;
    target = naturalDuration(att);
  } else if (endT != null) {
    target = naturalDuration(att);
    position = endT - target;
  } else {
    position = 0;
    target = naturalDuration(att);
  }

  const nat = naturalDuration(effective);
  const { resolved, actualDuration } = resolveChild(
    effective,
    nat,
    target,
    "stretch"
  );

  return {
    ...resolved,
    timelineStart: position,
    timelineEnd: position + actualDuration,
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
        ...child,
        sourceIn: child.sourceIn + clipStartOffset * child.speed,
        sourceOut: child.sourceOut - clipEndOffset * child.speed,
        timelineStart: rebasedStart,
        timelineEnd: rebasedEnd,
      });
    } else if (child.type === "empty") {
      result.push({
        ...child,
        timelineStart: rebasedStart,
        timelineEnd: rebasedEnd,
      });
    } else {
      // Nested composition — crop recursively
      const innerWindowIn = visibleStart - child.timelineStart;
      const innerWindowOut = innerWindowIn + (visibleEnd - visibleStart);
      const croppedInner = cropChildrenToWindow(child.children, innerWindowIn, innerWindowOut);

      result.push({
        ...child,
        timelineStart: rebasedStart,
        timelineEnd: rebasedEnd,
        duration: rebasedEnd - rebasedStart,
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

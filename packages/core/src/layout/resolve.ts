import type {
  Composition,
  Child,
  Overflow,
  TimeAnchor,
  Underflow,
} from "../types.js";
import type {
  ResolvedTimeline,
  ResolvedChild,
  SpatialInput,
} from "../resolved-types.js";
import { applyOverflow } from "./overflow.js";
import { applyUnderflow } from "./underflow.js";

function clipBaseSpeed(clip: { in: number; out: number; speed?: number; duration?: number }): number {
  if (clip.duration != null) return (clip.out - clip.in) / clip.duration;
  return clip.speed ?? 1;
}

function naturalDuration(child: Child): number {
  switch (child.type) {
    case "clip":
    case "audio":
      return (child.out - child.in) / clipBaseSpeed(child);
    case "empty":
      return child.duration;
    case "data":
      return child.duration ?? 0;
    case "html":
      return child.duration;
    case "composition": {
      if (child.in != null && child.out != null) {
        return child.out - child.in;
      }
      return resolveCompositionInner(child).duration;
    }
  }
}

function collectSpatialInput(child: Child): SpatialInput | undefined {
  if (
    child.type === "empty" ||
    child.type === "audio" ||
    child.type === "data"
  ) {
    return undefined;
  }
  const { position, objectFit, top, left, right, bottom, width, height } = child;
  if (position == null && objectFit == null && top == null && left == null &&
      right == null && bottom == null && width == null && height == null) {
    return undefined;
  }
  return { position, objectFit, top, left, right, bottom, width, height };
}

/**
 * Resolve a single child to its target duration. For sequential children
 * `target` always equals `nat`, so overflow/underflow are no-ops; for
 * attachments with both ends pinned the caller passes a target derived from
 * the anchors and overflow/underflow strategies kick in to fit.
 */
function resolveChild(
  child: Child,
  nat: number,
  target: number,
  defaultOverflow: Overflow,
  defaultUnderflow: Underflow | null
): { resolved: ResolvedChild; actualDuration: number } {
  if (child.type === "empty") {
    return {
      resolved: { type: "empty" as const, timelineStart: 0, timelineEnd: 0 },
      actualDuration: target,
    };
  }

  if (child.type === "data") {
    return {
      resolved: {
        type: "data" as const,
        data: child.data,
        timelineStart: 0,
        timelineEnd: 0,
      },
      actualDuration: target,
    };
  }

  const spatialInput = collectSpatialInput(child);

  if (child.type === "html") {
    // HTML is static — overflow/underflow strategies all collapse to "show
    // the same image for the target span". contentWidth/contentHeight stay
    // as authored (possibly undefined — the spatial pass fills with the
    // display rect, mirroring composition behaviour).
    return {
      resolved: {
        type: "html" as const,
        source: child.source,
        contentWidth: child.contentWidth as number,
        contentHeight: child.contentHeight as number,
        timelineStart: 0,
        timelineEnd: 0,
        ...(spatialInput ? { spatialInput } : {}),
        ...(child.filters?.length ? { filters: child.filters } : {}),
      },
      actualDuration: target,
    };
  }

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
      const underflow = child.underflow ?? defaultUnderflow;
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

  // Clip / Audio — same temporal logic, different leaf shape.
  const leaf = child;
  let sourceIn = leaf.in;
  let sourceOut = leaf.out;
  const baseSpeed = clipBaseSpeed(leaf);
  let speed = baseSpeed;

  if (target < nat) {
    const overflow = leaf.overflow ?? defaultOverflow;
    const sourceTarget = target * baseSpeed;
    const result = applyOverflow(overflow, sourceIn, sourceOut, sourceTarget);
    sourceIn = result.sourceIn;
    sourceOut = result.sourceOut;
    speed = result.speed * baseSpeed;
  } else if (target > nat) {
    const underflow = leaf.underflow ?? defaultUnderflow;
    if (underflow) {
      const sourceTarget = target * baseSpeed;
      const result = applyUnderflow(underflow, sourceIn, sourceOut, sourceTarget);
      sourceIn = result.sourceIn;
      sourceOut = result.sourceOut;
      speed = result.speed * baseSpeed;
    }
  }

  const leafDur = (sourceOut - sourceIn) / speed;

  if (leaf.type === "audio") {
    return {
      resolved: {
        type: "audio" as const,
        source: leaf.source,
        sourceIn,
        sourceOut,
        timelineStart: 0,
        timelineEnd: 0,
        speed,
      },
      actualDuration: leafDur,
    };
  }

  return {
    resolved: {
      type: "clip" as const,
      source: leaf.source,
      sourceIn,
      sourceOut,
      timelineStart: 0,
      timelineEnd: 0,
      speed,
      ...(spatialInput ? { spatialInput } : {}),
      ...(leaf.filters?.length ? { filters: leaf.filters } : {}),
    },
    actualDuration: leafDur,
  };
}

export function resolveComposition(composition: Composition): ResolvedTimeline {
  return resolveCompositionInner(composition);
}

function resolveCompositionInner(composition: Composition): ResolvedTimeline {
  const { children } = composition;

  // Sequential children: each child takes its natural duration. There's no
  // higher-order organizer (no flex, no justify, no container duration) —
  // the composition's length is just the sum of its children.
  const naturals = children.map((c) => naturalDuration(c));
  const containerDuration = naturals.reduce((a, b) => a + b, 0);

  const resolvedChildren: ResolvedChild[] = [];
  const actualDurations: number[] = [];
  for (let i = 0; i < children.length; i++) {
    const { resolved, actualDuration } = resolveChild(
      children[i],
      naturals[i],
      naturals[i],
      "trim-end",
      null
    );
    resolvedChildren.push(resolved);
    actualDurations.push(actualDuration);
  }

  // Place children sequentially and build the id map from this composition's
  // direct children. Ids are scoped to the composition — we deliberately
  // don't look into nested children here, so an attachment can only anchor
  // to a sibling.
  const idMap = new Map<string, IdMapEntry>();
  let pos = 0;
  for (let i = 0; i < resolvedChildren.length; i++) {
    const start = pos;
    const end = pos + actualDurations[i];
    resolvedChildren[i] = {
      ...resolvedChildren[i],
      timelineStart: start,
      timelineEnd: end,
    };
    pos = end;
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
  if (resolved.type === "clip" || resolved.type === "audio") {
    return {
      start,
      end,
      baseSourceTime: resolved.sourceIn,
      speed: resolved.speed,
    };
  }
  if (
    resolved.type === "empty" ||
    resolved.type === "data" ||
    resolved.type === "html"
  ) {
    return { start, end, baseSourceTime: 0, speed: 1 };
  }
  // composition — source time is the pre-window inner timeline
  const baseSourceTime =
    original.type === "composition" ? original.in ?? 0 : 0;
  return { start, end, baseSourceTime, speed: resolved.speed };
}

function resolveAnchorTime(
  spec: TimeAnchor,
  idMap: Map<string, IdMapEntry>,
  attachmentNatDur: number
): number {
  // offset is in OUTPUT seconds. A %-string is interpreted as that fraction
  // of the *attachment's own natural duration* — independent of the anchor,
  // so it works even when no anchor is given.
  let offsetSec = 0;
  if (spec.offset != null) {
    offsetSec =
      typeof spec.offset === "number"
        ? spec.offset
        : parsePercent(spec.offset) * attachmentNatDur;
  }

  // No anchor: offset is the entire position (relative to the composition's
  // start). anchorPoint / timeSource don't apply.
  if (spec.anchor == null) {
    if (spec.anchorPoint != null) {
      throw new Error("'anchorPoint' requires an 'anchor'");
    }
    if (spec.timeSource != null) {
      throw new Error("'timeSource' requires an 'anchor'");
    }
    return offsetSec;
  }

  const anchor = idMap.get(spec.anchor);
  if (!anchor) {
    throw new Error(`anchor "${spec.anchor}" not found`);
  }
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
    const anchorLen = anchor.end - anchor.start;
    pointTime = anchor.start + anchorLen * pointPct;
  }

  return pointTime + offsetSec;
}

function parsePercent(s: string): number {
  const m = /^(-?\d+(?:\.\d+)?)%$/.exec(s);
  if (!m) throw new Error(`expected percentage string, got "${s}"`);
  return parseFloat(m[1]) / 100;
}

function resolveAttachment(
  att: Child,
  idMap: Map<string, IdMapEntry>
): ResolvedChild {
  const attNatDur = naturalDuration(att);
  const startT = att.start
    ? resolveAnchorTime(att.start, idMap, attNatDur)
    : null;
  const endT = att.end ? resolveAnchorTime(att.end, idMap, attNatDur) : null;

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
  } else if (startT != null) {
    position = startT;
    target = attNatDur;
  } else if (endT != null) {
    target = attNatDur;
    position = endT - target;
  } else {
    position = 0;
    target = attNatDur;
  }

  // For attachments, both overflow and underflow default to "stretch" so an
  // overconstrained attachment fills its anchored span by adjusting speed.
  // Authors can opt into trim/extend strategies on the attachment node itself.
  const { resolved, actualDuration } = resolveChild(
    att,
    attNatDur,
    target,
    "stretch",
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

    if (child.type === "clip" || child.type === "audio") {
      const startOffset = visibleStart - child.timelineStart;
      const endOffset = child.timelineEnd - visibleEnd;

      result.push({
        ...child,
        sourceIn: child.sourceIn + startOffset * child.speed,
        sourceOut: child.sourceOut - endOffset * child.speed,
        timelineStart: rebasedStart,
        timelineEnd: rebasedEnd,
      });
    } else if (
      child.type === "empty" ||
      child.type === "data" ||
      child.type === "html"
    ) {
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

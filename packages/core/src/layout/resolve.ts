import type {
  Composition,
  Child,
  Length,
  Overflow,
  TimeAnchor,
  TextRun,
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

/** A composition's playback rate from its `speed`/`duration`, where the
 *  "source" is the inner window of length `span` (`out − in`). Mirrors
 *  `clipBaseSpeed`: `duration` sets the output length (rate = span/duration),
 *  else `speed` (default 1). */
function compositionBaseSpeed(
  comp: { speed?: number; duration?: number },
  span: number,
): number {
  if (comp.duration != null) return span / comp.duration;
  return comp.speed ?? 1;
}

function naturalDuration(child: Child): number {
  switch (child.type) {
    case "clip":
    case "audio":
      return (child.out - child.in) / clipBaseSpeed(child as { in: number; out: number; speed?: number; duration?: number });
    case "static":
      return child.duration;
    case "empty":
      return child.duration;
    case "data":
      return child.duration ?? 0;
    case "text":
      return child.duration ?? 0;
    case "graphic":
      // Graphics carry their own timeline. With both anchors set the
      // anchor span dictates target duration; otherwise we trust the
      // authored `duration`, then fall back to the last keyframe's
      // numeric stamp. (Length-typed stamps default to numeric here —
      // percent stamps need a duration context to resolve, and at this
      // point we have none, so they fall back to 0.)
      if (child.in != null && child.out != null) return child.out - child.in;
      if (typeof child.duration === "number") return child.duration;
      const lastFrame = child.frames[child.frames.length - 1];
      const lastStamp = lastFrame?.[0];
      return typeof lastStamp === "number" ? lastStamp : 0;
    case "composition": {
      const compIn = child.in ?? 0;
      const compOut = child.out ?? resolveCompositionInner(child).duration;
      const span = compOut - compIn;
      return span / compositionBaseSpeed(child, span);
    }
  }
}

/** Wrap any bare strings in `text` into single-text TextRun objects so
 *  callers downstream see a uniform `runs: TextRun[]` shape. */
function normalizeTextRuns(text: string | (string | TextRun)[]): TextRun[] {
  if (typeof text === "string") return [{ text }];
  return text.map((item) => (typeof item === "string" ? { text: item } : item));
}

function collectSpatialInput(child: Child): SpatialInput | undefined {
  if (
    child.type === "empty" ||
    child.type === "audio" ||
    child.type === "data"
  ) {
    return undefined;
  }
  const { objectFit, origin, translation, size, rotation } = child;
  // `inset` (crop) + `insetMode` are composition-only.
  const inset = child.type === "composition" ? child.inset : undefined;
  const insetMode = child.type === "composition" ? child.insetMode : undefined;
  if (
    objectFit == null &&
    origin == null &&
    translation == null &&
    size == null &&
    rotation == null &&
    inset == null
  ) {
    return undefined;
  }
  return { objectFit, origin, translation, size, rotation, inset, insetMode };
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
        ...(child.tags?.length ? { tags: child.tags } : {}),
      },
      actualDuration: target,
    };
  }

  const spatialInput = collectSpatialInput(child);

  if (child.type === "static") {
    // Static is a single frame — overflow/underflow collapse to "show
    // the same image for the target span" (same shape as text). The
    // sourceTime stays exactly as authored regardless of target.
    return {
      resolved: {
        type: "static" as const,
        source: child.source,
        sourceTime: child.in ?? 0,
        timelineStart: 0,
        timelineEnd: 0,
        ...(spatialInput ? { spatialInput } : {}),
        ...(child.filters?.length ? { filters: child.filters } : {}),
        ...(child.opacity != null ? { opacity: child.opacity } : {}),
      },
      actualDuration: target,
    };
  }

  if (child.type === "text") {
    // Text is static — overflow/underflow strategies all collapse to
    // "show the same image for the target span". `contentWidth` /
    // `contentHeight` stay as authored (possibly undefined — the
    // spatial pass fills with the display rect, mirroring composition
    // behaviour). We always emit `runs` as a normalised array so
    // downstream consumers don't need to handle the `string | array`
    // union.
    const runs = normalizeTextRuns(child.text);
    const styleKeys = [
      "fontFamily",
      "fontSize",
      "color",
      "fontWeight",
      "fontStyle",
      "textDecoration",
      "letterHeight",
      "backgroundColor",
      "backgroundPadding",
      "strokeColor",
      "strokeWidth",
      "lineHeight",
      "textAlign",
      "verticalAlign",
      "padding",
    ] as const;
    const carried: Record<string, unknown> = {};
    for (const k of styleKeys) {
      const v = (child as unknown as Record<string, unknown>)[k];
      if (v != null) carried[k] = v;
    }
    return {
      resolved: {
        type: "text" as const,
        runs,
        ...carried,
        contentWidth: child.contentWidth as Length,
        contentHeight: child.contentHeight as Length,
        timelineStart: 0,
        timelineEnd: 0,
        ...(spatialInput ? { spatialInput } : {}),
        ...(child.filters?.length ? { filters: child.filters } : {}),
        ...(child.opacity != null ? { opacity: child.opacity } : {}),
      } as ResolvedChild,
      actualDuration: target,
    };
  }

  if (child.type === "graphic") {
    // Graphic carries its own internal timeline (frames / clips). For the
    // outer layout pass we treat it like static: a single placeable rect
    // with content dimensions for the spatial pass to consume. The
    // animation playhead is driven by the renderer/preview at render
    // time, not here. overflow/underflow collapse to "play at the rate
    // implied by target / natural" — same as text/static — and we leave
    // playback-time mapping (e.g. speed-up) to the consumer.
    return {
      resolved: {
        type: "graphic" as const,
        duration: child.duration,
        loop: child.loop,
        contentWidth: child.contentWidth as Length,
        contentHeight: child.contentHeight as Length,
        clips: child.clips,
        frames: child.frames,
        timelineStart: 0,
        timelineEnd: 0,
        ...(spatialInput ? { spatialInput } : {}),
        ...(child.filters?.length ? { filters: child.filters } : {}),
        ...(child.opacity != null ? { opacity: child.opacity } : {}),
      } as ResolvedChild,
      actualDuration: target,
    };
  }

  if (child.type === "composition") {
    const inner = resolveCompositionInner(child);
    const compIn = child.in ?? 0;
    const compOut = child.out ?? inner.duration;
    const span = compOut - compIn;
    // `speed`/`duration` set the base playback rate of the window (mirror
    // of clips). overflow/underflow then layer on top only when an anchor
    // forces a `target` different from this natural output.
    const baseSpeed = compositionBaseSpeed(child, span);
    const natural = span / baseSpeed;

    let windowIn = compIn;
    let windowOut = compOut;
    let speed = baseSpeed;

    if (target < natural) {
      const overflow = child.overflow ?? defaultOverflow;
      const sourceTarget = target * baseSpeed;
      const result = applyOverflow(overflow, compIn, compOut, sourceTarget);
      windowIn = result.sourceIn;
      windowOut = result.sourceOut;
      speed = result.speed * baseSpeed;
    } else if (target > natural) {
      const underflow = child.underflow ?? defaultUnderflow;
      if (underflow) {
        const sourceTarget = target * baseSpeed;
        const result = applyUnderflow(underflow, compIn, compOut, sourceTarget);
        windowIn = result.sourceIn;
        windowOut = result.sourceOut;
        speed = result.speed * baseSpeed;
      }
    }

    const croppedChildren = cropChildrenToWindow(inner.children, windowIn, windowOut);
    const windowDur = (windowOut - windowIn) / speed;

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
        ...(child.opacity != null ? { opacity: child.opacity } : {}),
        ...(child.backgroundColor != null ? { backgroundColor: child.backgroundColor } : {}),
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
        ...(leaf.volume != null ? { volume: leaf.volume } : {}),
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
      ...(leaf.volume != null ? { volume: leaf.volume } : {}),
      ...(spatialInput ? { spatialInput } : {}),
      ...(leaf.filters?.length ? { filters: leaf.filters } : {}),
      ...(leaf.opacity != null ? { opacity: leaf.opacity } : {}),
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
  // the composition's length is the sum of its children, minus any
  // crossfade overlaps (`transition`), accumulated in the placement loop.
  const naturals = children.map((c) => naturalDuration(c));

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
    // Crossfade overlap: a child with `transition` starts that many seconds
    // before the previous child ends. Clamped so it can't reach past the
    // previous child's start (≤ prev duration) or exceed its own length
    // (≤ own duration). First child ignores it. The composition shrinks by
    // each applied overlap (the cursor `pos` rewinds before placing).
    let overlap = 0;
    if (i > 0) {
      const authored = getTransition(children[i]) ?? 0;
      if (authored > 0) {
        overlap = Math.min(authored, actualDurations[i - 1], actualDurations[i]);
      }
    }
    const start = pos - overlap;
    const end = start + actualDurations[i];
    resolvedChildren[i] = {
      ...resolvedChildren[i],
      timelineStart: start,
      timelineEnd: end,
      ...(overlap > 0 ? { transition: overlap } : {}),
    };
    // Mirror the overlap onto the previous child as `transitionOut` so audio
    // renderers can fade it out over the same window without sibling lookup.
    // (Skip empty/data — they produce nothing and carry no such field.)
    const prev = resolvedChildren[i - 1];
    if (overlap > 0 && prev.type !== "empty" && prev.type !== "data") {
      resolvedChildren[i - 1] = { ...prev, transitionOut: overlap };
    }
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
    // Total = end of the last placed child (sum of durations minus overlaps).
    duration: pos,
    children: resolvedChildren,
    ...(composition.objectFit ? { objectFit: composition.objectFit } : {}),
    ...(composition.backgroundColor != null
      ? { backgroundColor: composition.backgroundColor }
      : {}),
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

/** Authored crossfade overlap (seconds) with the previous sibling. Only
 *  producing types carry it; everything else reads as `undefined`. */
function getTransition(child: Child): number | undefined {
  return (child as { transition?: number }).transition;
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
    resolved.type === "text" ||
    resolved.type === "graphic"
  ) {
    // Graphic's internal playhead is owned by the renderer/preview; from
    // the outer layout's perspective there's no source-time mapping to
    // expose to attachments.
    return { start, end, baseSourceTime: 0, speed: 1 };
  }
  if (resolved.type === "static") {
    // Source time is the (frozen) freeze offset; speed is 1 since the
    // frame is static.
    return { start, end, baseSourceTime: resolved.sourceTime, speed: 1 };
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
      child.type === "text" ||
      child.type === "static" ||
      child.type === "graphic"
    ) {
      result.push({
        ...child,
        timelineStart: rebasedStart,
        timelineEnd: rebasedEnd,
      });
    } else {
      // Nested composition — crop recursively. The child's children live in
      // its INNER-window coords (span = duration × speed), but visibleStart/End
      // are output-time positions, so map the visible output window into inner
      // time by the child's speed. Omitting the ×speed clamped the inner window
      // to the child's output length, cropping/dropping children of a sped or
      // duration-compressed nested comp (e.g. clip2 of a duration:2 comp).
      const innerWindowIn = (visibleStart - child.timelineStart) * child.speed;
      const innerWindowOut = (visibleEnd - child.timelineStart) * child.speed;
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

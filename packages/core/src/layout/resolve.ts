import type {
  Composition,
  Child,
  Keyframed,
  Length,
  Overflow,
  Pin,
  TextRun,
  Underflow,
} from "../types.js";
import type {
  ResolvedTimeline,
  ResolvedChild,
  ResolvedLoop,
  SpatialInput,
} from "../resolved-types.js";
import { applyOverflow } from "./overflow.js";
import { applyUnderflow } from "./underflow.js";
import { loopIterations, loopLocalTime } from "./loop.js";
import {
  clipNaturalDuration,
  clipPlayRange,
  resolvedPlayStart,
  resolvedSignedRate,
} from "./clip-span.js";
import { parseStart } from "./anchor.js";

/**
 * A node's natural output length: its content (`[in, out]` / inner window)
 * played at `speed`, ignoring `duration`. For the duration-only types this is
 * just `duration`.
 */
function naturalDuration(child: Child): number {
  switch (child.type) {
    case "clip":
    case "audio":
      return clipNaturalDuration(child);
    case "static":
    case "text":
    case "rect":
    case "circle":
    case "map":
      return child.duration;
    case "data":
      return child.duration ?? 0;
    case "composition": {
      const compIn = child.in ?? 0;
      const compOut = child.out ?? resolveCompositionInner(child).duration;
      return (compOut - compIn) / (child.speed ?? 1);
    }
  }
}

/** The output length a node occupies: its authored `duration` when it has
 *  one, else its natural length. Where the two differ on a clip / audio /
 *  composition, `overflow` / `underflow` (default `stretch`) decide how the
 *  content fills it. */
function targetDuration(child: Child, nat: number): number {
  if (child.type === "clip" || child.type === "audio") {
    // Negative `duration` = reverse playback; the length is its magnitude.
    return child.duration != null ? Math.abs(child.duration) : nat;
  }
  if (child.type === "composition") return child.duration ?? nat;
  return nat;
}

/** Wrap any bare strings in `text` into single-text TextRun objects so
 *  callers downstream see a uniform `runs: TextRun[]` shape. */
function normalizeTextRuns(text: string | (string | TextRun)[]): TextRun[] {
  if (typeof text === "string") return [{ text }];
  return text.map((item) => (typeof item === "string" ? { text: item } : item));
}

function collectSpatialInput(child: Child): SpatialInput | undefined {
  if (child.type === "audio" || child.type === "data") {
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

/** Per-frame-sampled visual fields every spatial node carries through
 *  resolution verbatim (like `volume`): opacity, the corner mask, and the map
 *  pin. Omitted keys stay omitted so resolved nodes don't grow `undefined`s. */
function spatialExtras(child: {
  opacity?: Keyframed<number>;
  cornerRadius?: Keyframed<Length>;
  pin?: Keyframed<Pin>;
}): { opacity?: Keyframed<number>; cornerRadius?: Keyframed<Length>; pin?: Keyframed<Pin> } {
  return {
    ...(child.opacity != null ? { opacity: child.opacity } : {}),
    ...(child.cornerRadius != null ? { cornerRadius: child.cornerRadius } : {}),
    ...(child.pin != null ? { pin: child.pin } : {}),
  };
}

/**
 * Resolve a single child's content to `target` output seconds (placement
 * comes later). `nat` is its natural length; when `target` differs — a
 * `duration` on a clip / audio / composition — overflow/underflow fit the
 * content, defaulting to `stretch` (i.e. `duration` derives the rate).
 */
function resolveChild(
  child: Child,
  nat: number,
  target: number,
): { resolved: ResolvedChild; actualDuration: number; sourceBase?: number } {
  const defaultOverflow: Overflow = "stretch";
  const defaultUnderflow: Underflow = "stretch";

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
        ...spatialExtras(child),
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
        contentWidth: child.contentWidth,
        contentHeight: child.contentHeight,
        timelineStart: 0,
        timelineEnd: 0,
        ...(spatialInput ? { spatialInput } : {}),
        ...(child.filters?.length ? { filters: child.filters } : {}),
        ...spatialExtras(child),
      } as ResolvedChild,
      actualDuration: target,
    };
  }

  if (child.type === "rect" || child.type === "circle") {
    // Shapes are static leaves like text: overflow/underflow collapse to
    // "show the shape for the target span". Fill/stroke stay keyframed —
    // the renderers sample them per frame.
    return {
      resolved: {
        type: child.type,
        timelineStart: 0,
        timelineEnd: 0,
        ...(child.fill != null ? { fill: child.fill } : {}),
        ...(child.stroke != null ? { stroke: child.stroke } : {}),
        ...(child.strokeWidth != null ? { strokeWidth: child.strokeWidth } : {}),
        ...(spatialInput ? { spatialInput } : {}),
        ...(child.filters?.length ? { filters: child.filters } : {}),
        ...spatialExtras(child),
      } as ResolvedChild,
      actualDuration: target,
    };
  }

  if (child.type === "map") {
    // A map is a static-like leaf for timing (the camera keyframes sample
    // against its span) that also hosts children: placed exactly like a
    // composition's (runs + `start` anchors) in map-local time (0 = map
    // start, speed 1). They never extend the map and are NOT cropped to its
    // span here; the compositor only draws what's active.
    const children = placeChildren(child.children ?? []).children;
    return {
      resolved: {
        type: "map" as const,
        source: child.source,
        timelineStart: 0,
        timelineEnd: 0,
        ...(child.latitude != null ? { latitude: child.latitude } : {}),
        ...(child.longitude != null ? { longitude: child.longitude } : {}),
        ...(child.zoom != null ? { zoom: child.zoom } : {}),
        ...(child.mapOpacity != null ? { mapOpacity: child.mapOpacity } : {}),
        ...(child.theme != null ? { theme: child.theme } : {}),
        ...(child.paths?.length ? { paths: child.paths } : {}),
        children,
        ...(child.contentWidth != null ? { contentWidth: child.contentWidth } : {}),
        ...(child.contentHeight != null ? { contentHeight: child.contentHeight } : {}),
        ...(spatialInput ? { spatialInput } : {}),
        ...(child.filters?.length ? { filters: child.filters } : {}),
        ...spatialExtras(child),
      },
      actualDuration: target,
    };
  }

  if (child.type === "composition") {
    const inner = resolveCompositionInner(child);
    const compIn = child.in ?? 0;
    const compOut = child.out ?? inner.duration;
    const span = compOut - compIn;
    // `speed` is the base playback rate of the window (mirror of clips);
    // overflow/underflow layer on top when `duration` asks for a different
    // output length than `span / speed`.
    const baseSpeed = child.speed ?? 1;
    const natural = span / baseSpeed;

    let windowIn = compIn;
    let windowOut = compOut;
    let speed = baseSpeed;
    let loops = false;

    if (target < natural) {
      const overflow = child.overflow ?? defaultOverflow;
      const sourceTarget = target * baseSpeed;
      const result = applyOverflow(overflow, compIn, compOut, sourceTarget);
      windowIn = result.sourceIn;
      windowOut = result.sourceOut;
      speed = result.speed * baseSpeed;
    } else if (target > natural) {
      const underflow = child.underflow ?? defaultUnderflow;
      const sourceTarget = target * baseSpeed;
      const result = applyUnderflow(underflow, compIn, compOut, sourceTarget);
      windowIn = result.sourceIn;
      windowOut = result.sourceOut;
      speed = result.speed * baseSpeed;
      loops = result.loop === true;
    }

    const croppedChildren = cropChildrenToWindow(inner.children, windowIn, windowOut);
    // Output length of one pass over the window. A looping comp replays it
    // until `target` is filled; `duration` stays the single-cycle length so
    // `duration × speed` is still the inner span the children live in.
    const windowDur = (windowOut - windowIn) / speed;
    const loop: ResolvedLoop | undefined = loops ? { period: windowDur, phase: 0 } : undefined;

    return {
      resolved: {
        type: "composition" as const,
        timelineStart: 0,
        timelineEnd: 0,
        duration: windowDur,
        speed,
        ...(loop ? { loop } : {}),
        children: croppedChildren,
        ...(spatialInput ? { spatialInput } : {}),
        ...(child.filters?.length ? { filters: child.filters } : {}),
        ...spatialExtras(child),
        ...(child.volume != null ? { volume: child.volume } : {}),
        ...(child.pitch != null ? { pitch: child.pitch } : {}),
        ...(child.backgroundColor != null ? { backgroundColor: child.backgroundColor } : {}),
        ...(child.distort != null ? { distort: child.distort } : {}),
        ...(child.contentWidth != null ? { contentWidth: child.contentWidth } : {}),
        ...(child.contentHeight != null ? { contentHeight: child.contentHeight } : {}),
      },
      actualDuration: loop ? target : windowDur,
      // Inner time at the composition's start — the window a non-stretch
      // strategy kept, not necessarily the authored `in`.
      sourceBase: windowIn,
    };
  }

  // Clip / Audio — same temporal logic, different leaf shape.
  // A reversed leaf (`out < in` / negative `duration`) runs the same logic on
  // the NEGATED source axis — there playback is forward again, so "start" /
  // "end" in the overflow/underflow strategies mean playback start/end — and
  // the result is negated back into an ascending `[sourceIn, sourceOut]`.
  const leaf = child;
  const range = clipPlayRange(leaf);
  const reverse = range.reverse;
  let sourceIn = reverse ? -range.start : range.start;
  let sourceOut = reverse ? -range.end : range.end;
  const baseSpeed = leaf.speed ?? 1;
  let speed = baseSpeed;
  let loops = false;

  if (target < nat) {
    const overflow = leaf.overflow ?? defaultOverflow;
    const sourceTarget = target * baseSpeed;
    const result = applyOverflow(overflow, sourceIn, sourceOut, sourceTarget);
    sourceIn = result.sourceIn;
    sourceOut = result.sourceOut;
    speed = result.speed * baseSpeed;
  } else if (target > nat) {
    const underflow = leaf.underflow ?? defaultUnderflow;
    const sourceTarget = target * baseSpeed;
    const result = applyUnderflow(underflow, sourceIn, sourceOut, sourceTarget);
    sourceIn = result.sourceIn;
    sourceOut = result.sourceOut;
    speed = result.speed * baseSpeed;
    loops = result.loop === true;
  }

  // One pass over `[sourceIn, sourceOut]`; a looping leaf replays it until
  // `target` is filled.
  const leafDur = (sourceOut - sourceIn) / speed;
  const loop: ResolvedLoop | undefined = loops ? { period: leafDur, phase: 0 } : undefined;
  const actualDuration = loop ? target : leafDur;
  if (reverse) [sourceIn, sourceOut] = [-sourceOut, -sourceIn];

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
        ...(reverse ? { reverse: true as const } : {}),
        ...(loop ? { loop } : {}),
        ...(leaf.volume != null ? { volume: leaf.volume } : {}),
        ...(leaf.pitch != null ? { pitch: leaf.pitch } : {}),
      },
      actualDuration,
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
      ...(reverse ? { reverse: true as const } : {}),
      ...(loop ? { loop } : {}),
      ...(leaf.orientation != null ? { orientation: leaf.orientation } : {}),
      ...(leaf.volume != null ? { volume: leaf.volume } : {}),
      ...(leaf.pitch != null ? { pitch: leaf.pitch } : {}),
      ...(spatialInput ? { spatialInput } : {}),
      ...(leaf.filters?.length ? { filters: leaf.filters } : {}),
      ...spatialExtras(leaf),
    },
    actualDuration,
  };
}

export interface ResolveOptions {
  /** Keep this composition's direct children exactly 1:1 with the authored
   *  array: nodes that start before time 0 keep their negative
   *  `timelineStart` instead of being cropped / dropped. For tools that map
   *  resolved children back onto the document (editor timeline, distill).
   *  Applies to the top level only; nested compositions crop as usual. */
  uncropped?: boolean;
}

export function resolveComposition(
  composition: Composition,
  options: ResolveOptions = {},
): ResolvedTimeline {
  return resolveCompositionInner(composition, options.uncropped === true);
}

function resolveCompositionInner(composition: Composition, uncropped = false): ResolvedTimeline {
  // Post-compile, `binItem` references are inflated and `children` is
  // always populated; `?? []` keeps the now-optional authored type happy.
  const { children, duration } = placeChildren(composition.children ?? [], uncropped);

  return {
    // The latest end among the children — there is no other organizer.
    duration,
    children,
    ...(composition.objectFit ? { objectFit: composition.objectFit } : {}),
    ...(composition.backgroundColor != null
      ? { backgroundColor: composition.backgroundColor }
      : {}),
    ...(composition.volume != null ? { volume: composition.volume } : {}),
    ...(composition.pitch != null ? { pitch: composition.pitch } : {}),
    ...(composition.contentWidth != null ? { contentWidth: composition.contentWidth } : {}),
    ...(composition.contentHeight != null ? { contentHeight: composition.contentHeight } : {}),
  };
}

/**
 * Resolve and place a `children` array (a composition's or a map's).
 *
 * Each node lands at `(start ?? end of the previous node, 0 for the first)
 * + offset`. A node without `start` therefore continues the previous node's
 * *run*; a node with one heads a new run. Array order is z-order only —
 * anchors may point at ids anywhere in the array, so placement walks the
 * dependency graph (cycles throw).
 *
 * A run member with a negative `offset` overlaps the previous node and
 * cross-fades with it: the effective overlap is stamped as `transition` on
 * the node and `transitionOut` on the previous one. A negative offset on a
 * run head is a plain shift.
 *
 * Anything before time 0 is cropped (a node wholly before 0 is dropped), and
 * `duration` is the latest end.
 */
function placeChildren(
  children: Child[],
  uncropped = false,
): { children: ResolvedChild[]; duration: number } {
  const n = children.length;
  const resolved: ResolvedChild[] = new Array(n);
  const durations: number[] = new Array(n);
  const sourceBases: (number | undefined)[] = new Array(n);
  const indexById = new Map<string, number>();
  for (let i = 0; i < n; i++) {
    const nat = naturalDuration(children[i]);
    const r = resolveChild(children[i], nat, targetDuration(children[i], nat));
    resolved[i] = r.resolved;
    durations[i] = r.actualDuration;
    sourceBases[i] = r.sourceBase;
    const id = children[i].id;
    if (id != null) {
      if (indexById.has(id)) throw new Error(`duplicate id "${id}" in composition`);
      indexById.set(id, i);
    }
  }

  // 0 = unplaced, 1 = in progress, 2 = placed.
  const state = new Uint8Array(n);
  const starts: number[] = new Array(n).fill(0);

  const place = (i: number): void => {
    if (state[i] === 2) return;
    if (state[i] === 1) {
      const id = children[i].id;
      throw new Error(`anchor cycle through ${id != null ? `"${id}"` : `child ${i}`}`);
    }
    state[i] = 1;
    const child = children[i];
    let base: number;
    if (child.start == null) {
      if (i === 0) {
        base = 0;
      } else {
        place(i - 1);
        base = starts[i - 1] + durations[i - 1];
      }
    } else {
      const parsed = parseStart(child.start);
      if (parsed.kind === "absolute") {
        base = parsed.time;
      } else {
        const j = indexById.get(parsed.id);
        if (j == null) throw new Error(`anchor "${parsed.id}" not found`);
        place(j);
        const target = buildIdMapEntry(
          {
            ...resolved[j],
            timelineStart: starts[j],
            timelineEnd: starts[j] + durations[j],
          },
          sourceBases[j],
        );
        if (!parsed.point) {
          base = target.start;
        } else if (parsed.point.kind === "percent") {
          base = target.start + (target.end - target.start) * parsed.point.value;
        } else {
          base = target.start + (parsed.point.value - target.baseSourceTime) / target.speed;
        }
      }
    }
    starts[i] = base + (child.offset ?? 0);
    state[i] = 2;
  };
  for (let i = 0; i < n; i++) place(i);

  let duration = 0;
  let anyNegative = false;
  for (let i = 0; i < n; i++) {
    const start = starts[i];
    const end = start + durations[i];
    resolved[i] = { ...resolved[i], timelineStart: start, timelineEnd: end };
    if (end > duration) duration = end;
    if (start < 0) anyNegative = true;
  }

  // Crossfades: a run member pulled back over the previous node. Clamped so
  // the fade can't outlast either side. `data` produces nothing — no fade.
  for (let i = 1; i < n; i++) {
    const offset = children[i].offset ?? 0;
    if (children[i].start != null || offset >= 0) continue;
    const cur = resolved[i];
    const prev = resolved[i - 1];
    if (cur.type === "data" || prev.type === "data") continue;
    const overlap = Math.min(-offset, durations[i - 1], durations[i]);
    if (overlap <= 0) continue;
    resolved[i] = { ...cur, transition: overlap };
    resolved[i - 1] = { ...prev, transitionOut: overlap };
  }

  return {
    children: anyNegative && !uncropped ? cropChildrenToWindow(resolved, 0, Infinity) : resolved,
    duration,
  };
}

/**
 * Per-id data used to resolve both percent (`id@50%`, fraction of the output
 * span) and source (`id@10`, pre-trim/pre-window source time) anchors.
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

function buildIdMapEntry(resolved: ResolvedChild, compWindowIn = 0): IdMapEntry {
  const start = resolved.timelineStart;
  const end = resolved.timelineEnd;
  if (resolved.type === "clip" || resolved.type === "audio") {
    return {
      start,
      end,
      // Signed for a reversed node: source time falls as output advances.
      baseSourceTime: resolvedPlayStart(resolved),
      speed: resolvedSignedRate(resolved),
    };
  }
  if (
    resolved.type === "data" ||
    resolved.type === "text" ||
    resolved.type === "rect" ||
    resolved.type === "circle" ||
    resolved.type === "map"
  ) {
    // Static-like leaves: source time is just output seconds from the start.
    return { start, end, baseSourceTime: 0, speed: 1 };
  }
  if (resolved.type === "static") {
    // Source time is the (frozen) freeze offset; speed is 1 since the
    // frame is static.
    return { start, end, baseSourceTime: resolved.sourceTime, speed: 1 };
  }
  // composition — source time is its inner timeline; the start shows the
  // window's `in`.
  return { start, end, baseSourceTime: compWindowIn, speed: resolved.speed };
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
    // (A zero-length node sitting exactly on the window start stays.)
    if (
      (child.timelineEnd <= windowIn && child.timelineStart < windowIn) ||
      child.timelineStart >= windowOut
    ) {
      continue;
    }

    // Clamp to window
    const visibleStart = Math.max(child.timelineStart, windowIn);
    const visibleEnd = Math.min(child.timelineEnd, windowOut);
    const rebasedStart = visibleStart - windowIn;
    const rebasedEnd = visibleEnd - windowIn;

    if (
      (child.type === "clip" || child.type === "audio" || child.type === "composition") &&
      child.loop
    ) {
      // A looping node keeps its whole cycle (source range / inner children /
      // single-cycle `duration`); cropping only advances the phase at which
      // the visible part starts and shortens the span.
      const startOffset = visibleStart - child.timelineStart;
      result.push({
        ...child,
        loop: {
          period: child.loop.period,
          phase: loopLocalTime(child.loop, startOffset),
        },
        timelineStart: rebasedStart,
        timelineEnd: rebasedEnd,
      });
    } else if (child.type === "clip" || child.type === "audio") {
      const startOffset = visibleStart - child.timelineStart;
      const endOffset = child.timelineEnd - visibleEnd;

      // The crop's start eats the PLAYBACK start — the high end of a
      // reversed node's source range.
      const headTrim = startOffset * child.speed;
      const tailTrim = endOffset * child.speed;
      result.push({
        ...child,
        sourceIn: child.sourceIn + (child.reverse ? tailTrim : headTrim),
        sourceOut: child.sourceOut - (child.reverse ? headTrim : tailTrim),
        timelineStart: rebasedStart,
        timelineEnd: rebasedEnd,
      });
    } else if (
      child.type === "data" ||
      child.type === "text" ||
      child.type === "static" ||
      child.type === "rect" ||
      child.type === "circle" ||
      child.type === "map"
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

  return result;
}

/**
 * Replace every looping node (`underflow: "loop"`) in `children` by the
 * cycles it actually plays, as plain non-looping siblings in the same
 * container coordinates: a clip/audio becomes one trimmed copy per cycle, a
 * composition one copy per cycle with its children cropped to the part of
 * the inner window that cycle shows. Non-looping nodes pass through
 * untouched (same object). For flat listings / transcription mixes — the
 * compositor and the two output mixers consume the `loop` marker directly so
 * the node's own keyframes keep running over its full span.
 */
export function unrollLoops(children: ResolvedChild[]): ResolvedChild[] {
  const out: ResolvedChild[] = [];
  for (const child of children) {
    if (
      (child.type !== "clip" && child.type !== "audio" && child.type !== "composition") ||
      !child.loop
    ) {
      out.push(child);
      continue;
    }
    const span = child.timelineEnd - child.timelineStart;
    for (const it of loopIterations(child.loop, span)) {
      const len = it.end - it.start;
      const timelineStart = child.timelineStart + it.start;
      const timelineEnd = child.timelineStart + it.end;
      if (child.type === "composition") {
        const { loop: _loop, ...rest } = child;
        const innerIn = it.offset * child.speed;
        out.push({
          ...rest,
          timelineStart,
          timelineEnd,
          duration: len,
          children: cropChildrenToWindow(child.children, innerIn, innerIn + len * child.speed),
        });
      } else {
        const { loop: _loop, ...rest } = child;
        const a = it.offset * child.speed;
        const b = (it.offset + len) * child.speed;
        out.push({
          ...rest,
          sourceIn: child.reverse ? child.sourceOut - b : child.sourceIn + a,
          sourceOut: child.reverse ? child.sourceOut - a : child.sourceIn + b,
          timelineStart,
          timelineEnd,
        } as ResolvedChild);
      }
    }
  }
  return out;
}

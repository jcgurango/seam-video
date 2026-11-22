// The playhead ↔ keyframe relationship, shared by the Properties panel
// (insert a keyframe at the playhead, highlight the active one, go-to), the
// viewport gizmo (edit the keyframe the playhead sits on) and the timeline
// lanes (double-click a diamond to snap the playhead to it).
//
// Keyframe times resolve against a node's OUTPUT span and are sampled in
// node-local output time (`containerTime − timelineStart`), so everything
// here works on a `NodeClock`: the playhead expressed in that time.

import {
  parseTimeExpr,
  resolveEasing,
  resolveTimeExpr,
  sampleColor,
  sampleNumber,
  sampleVolume,
} from "@seam/core";
import type {
  Seam,
  Distort,
  Inset,
  Keyframed,
  Length,
  Point2D,
  ResolvedTimeline,
  SeamFile,
  TimeExpr,
} from "@seam/core";
import {
  DISTORT_CORNERS,
  insetEdges,
  joinLength,
  pointAxis,
  splitLength,
  type PropDef,
} from "./propertyCatalog.js";
import type { NodePath } from "./nodePath.js";
import { descendToContainer, globalSpanOf } from "./resolveLocal.js";
import { classifyTimeExpr } from "./keyframeEdit.js";

type AnyKeyframe = [TimeExpr, unknown] | [TimeExpr, unknown, string];

/** The playhead in a node's own keyframe time. */
export interface NodeClock {
  /** Playhead, seconds from the node's start (unclamped: negative before it,
   *  past `duration` after it). */
  t: number;
  /** The node's output span — what keyframe percentages resolve against. */
  duration: number;
  /** Node-local seconds → global playhead time. */
  toGlobal: (local: number) => number;
}

/**
 * The clock of the node at `path` for a global playhead time. `resolvedRoot`
 * is the editor timeline (root resolved `uncropped`). The root composition
 * (`[]`) runs on global time. Null for bin-rooted paths (no single instance
 * on the timeline) or when a level doesn't resolve.
 */
export function nodeClock(
  seam: Seam,
  resolvedRoot: ResolvedTimeline,
  doc: SeamFile,
  path: NodePath,
  globalTime: number,
): NodeClock | null {
  if (path.length === 0) {
    return { t: globalTime, duration: resolvedRoot.duration, toGlobal: (local) => local };
  }
  const last = path[path.length - 1];
  if (last.field !== "children") return null;
  const container = descendToContainer(seam, resolvedRoot, doc, path.slice(0, -1), globalTime);
  const rNode = container?.rContainer.children[last.index];
  const span = globalSpanOf(seam, resolvedRoot, doc, path);
  if (!container || !rNode || !span) return null;
  const duration = rNode.timelineEnd - rNode.timelineStart;
  return {
    t: container.localTime - rNode.timelineStart,
    duration,
    toGlobal: (local) =>
      duration > 0 ? span.start + (local / duration) * (span.end - span.start) : span.start,
  };
}

/** A node is on screen for `[start, end)`, so a keyframe at (or past) its end
 *  can never have the playhead exactly on it while the node shows. Such a
 *  keyframe is "at" the node's last frame instead. */
export const LAST_FRAME = 1 / 30;
/** How close the playhead must be to count as sitting on a keyframe. */
export const ON_KEYFRAME_EPS = 1 / 120;

function resolveTime(time: TimeExpr, duration: number): number {
  try {
    return resolveTimeExpr(time, duration);
  } catch {
    return 0;
  }
}

/** Where the playhead goes to be on a keyframe: its resolved time, held
 *  inside the node's visible span. */
export function keyframeMoment(time: TimeExpr, duration: number): number {
  const last = Math.max(0, duration - LAST_FRAME);
  return Math.min(Math.max(0, resolveTime(time, duration)), last);
}

/** Index (authored array position) of the keyframe the playhead sits on, or
 *  null. The nearest wins when several are within reach. */
export function activeKeyframeIndex(
  kfs: readonly AnyKeyframe[],
  clock: Pick<NodeClock, "t" | "duration"> | null,
): number | null {
  if (!clock) return null;
  let best: number | null = null;
  let reach = ON_KEYFRAME_EPS;
  kfs.forEach((kf, i) => {
    const dist = Math.abs(keyframeMoment(kf[0], clock.duration) - clock.t);
    if (dist <= reach) {
      reach = dist;
      best = i;
    }
  });
  return best;
}

const roundSec = (s: number): number => Math.round(s * 1000) / 1000;
const roundPct = (p: number): number => Math.round(p * 100) / 100;

/**
 * The time expression for a new keyframe at the playhead: `"0%"` at or before
 * the node's start, `"100%"` at or after its end; in between it takes the
 * FORM of the nearest existing keyframe — that keyframe's percentage with the
 * seconds offset adjusted to land on the playhead, or bare seconds when the
 * neighbour is authored in seconds.
 */
export function timeExprAtPlayhead(
  kfs: readonly AnyKeyframe[],
  clock: Pick<NodeClock, "t" | "duration">,
): TimeExpr {
  const { t, duration } = clock;
  if (t <= 0) return "0%";
  if (t >= duration) return "100%";
  const near = nearestKeyframe(kfs, clock);
  if (near == null || classifyTimeExpr(kfs[near][0]) === "number") return roundSec(t);
  const percent = parseTimeExpr(kfs[near][0]).percent;
  const offset = roundSec(t - percent * duration);
  const pct = `${roundPct(percent * 100)}%`;
  if (offset === 0) return pct;
  return `${pct} ${offset < 0 ? "-" : "+"} ${Math.abs(offset)}`;
}

function nearestKeyframe(
  kfs: readonly AnyKeyframe[],
  clock: Pick<NodeClock, "t" | "duration">,
): number | null {
  let best: number | null = null;
  let dist = Infinity;
  kfs.forEach((kf, i) => {
    const d = Math.abs(resolveTime(kf[0], clock.duration) - clock.t);
    if (d < dist) {
      dist = d;
      best = i;
    }
  });
  return best;
}

/**
 * Insert a keyframe at the playhead, in time order. It starts as a copy of
 * the nearest keyframe's value (no easing) unless `value` is given (see
 * {@link interpolatedValue}). Returns null when a keyframe already sits at
 * that instant — nothing to add.
 */
export function insertKeyframeAtPlayhead<K extends AnyKeyframe>(
  kfs: readonly K[],
  clock: Pick<NodeClock, "t" | "duration">,
  given?: unknown,
): { keyframes: K[]; index: number } | null {
  const time = timeExprAtPlayhead(kfs, clock);
  const at = resolveTime(time, clock.duration);
  if (kfs.some((kf) => Math.abs(resolveTime(kf[0], clock.duration) - at) < 1e-6)) return null;
  const near = nearestKeyframe(kfs, clock);
  const value =
    given !== undefined ? given : near == null ? undefined : structuredClone(kfs[near][1]);
  let index = kfs.findIndex((kf) => resolveTime(kf[0], clock.duration) > at);
  if (index < 0) index = kfs.length;
  const keyframes = [...kfs];
  keyframes.splice(index, 0, [time, value] as unknown as K);
  return { keyframes, index };
}

// ── The animated value at the playhead ─────────────────────────────

/** The two keyframes around `t` and the EASED fraction between them (the
 *  arriving keyframe's easing, as the samplers apply it). Before the first /
 *  after the last keyframe both ends are that keyframe. */
function segmentAt(
  kfs: readonly AnyKeyframe[],
  clock: Pick<NodeClock, "t" | "duration">,
): { a: unknown; b: unknown; f: number } {
  const frames = kfs
    .map((kf) => ({ time: resolveTime(kf[0], clock.duration), value: kf[1], ease: kf[2] }))
    .sort((x, y) => x.time - y.time);
  const first = frames[0];
  const last = frames[frames.length - 1];
  if (clock.t <= first.time) return { a: first.value, b: first.value, f: 0 };
  if (clock.t >= last.time) return { a: last.value, b: last.value, f: 0 };
  for (let i = 0; i < frames.length - 1; i++) {
    const a = frames[i];
    const b = frames[i + 1];
    if (clock.t >= a.time && clock.t <= b.time) {
      if (b.time === a.time) return { a: b.value, b: b.value, f: 0 };
      const f = resolveEasing(b.ease)((clock.t - a.time) / (b.time - a.time));
      return { a: a.value, b: b.value, f };
    }
  }
  return { a: last.value, b: last.value, f: 0 };
}

const round = (n: number, places: number): number => {
  const k = 10 ** places;
  const r = Math.round(n * k) / k;
  return r === 0 ? 0 : r;
};

/** Blend two authored lengths part by part (percent with percent, pixels
 *  with pixels — which is exactly the blend of their resolved values, for
 *  any reference size). Two bare numbers stay a bare number; `undefined`
 *  stands for `percentDefault`%. */
function mixLength(
  a: Length | undefined,
  b: Length | undefined,
  f: number,
  percentDefault: number,
): Length | undefined {
  if (a === b || f === 0) return a;
  const pa = splitLength(a);
  const pb = splitLength(b);
  const px = round((pa.px ?? 0) + ((pb.px ?? 0) - (pa.px ?? 0)) * f, 2);
  if (a != null && b != null && pa.percent == null && pb.percent == null) return px;
  const ca = pa.percent ?? percentDefault;
  const cb = pb.percent ?? percentDefault;
  return joinLength({ percent: round(ca + (cb - ca) * f, 2), px: px === 0 ? null : px });
}

/**
 * The value an animated property has at the playhead, written the way an
 * author would (percent / pixel parts blended separately, shorthands
 * re-collapsed) — what a keyframe added there must hold to leave the motion
 * unchanged. Kinds with nothing to blend take the nearest keyframe's value.
 */
export function interpolatedValue(
  kfs: readonly AnyKeyframe[],
  clock: Pick<NodeClock, "t" | "duration">,
  def: Pick<PropDef, "key" | "kind" | "percentDefault" | "sample">,
): unknown {
  const { t, duration } = clock;
  const { a, b, f } = segmentAt(kfs, clock);
  const pct = def.percentDefault ?? 0;
  try {
    switch (def.kind) {
      case "number":
        // A field with its own interpolation (a map's zoom tweens in scale
        // space) brings its sampler.
        return round(
          def.sample
            ? def.sample(kfs, t, duration)
            : sampleNumber(kfs as Keyframed<number>, t, duration),
          4,
        );
      case "scalar":
        // A decibel string blends as linear gain.
        return a === b ? a : round(sampleVolume(kfs as Keyframed<number | string>, t, duration), 4);
      case "color":
        return a === b ? a : sampleColor(kfs as Keyframed<string>, t, duration);
      case "length":
        return mixLength(a as Length, b as Length, f, pct);
      case "point": {
        const x = mixLength(pointAxis(a as Point2D, "x"), pointAxis(b as Point2D, "x"), f, pct);
        const y = mixLength(pointAxis(a as Point2D, "y"), pointAxis(b as Point2D, "y"), f, pct);
        if (x != null && x === y) return x;
        return { ...(x != null ? { x } : {}), ...(y != null ? { y } : {}) };
      }
      case "inset": {
        const ea = insetEdges(a as Inset);
        const eb = insetEdges(b as Inset);
        const [top, right, bottom, left] = ea.map((e, i) => mixLength(e, eb[i], f, 0) ?? 0);
        if (top === right && top === bottom && top === left) return top;
        if (top === bottom && right === left) return [top, right];
        return [top, right, bottom, left];
      }
      case "distort": {
        const da = (a ?? {}) as Distort;
        const db = (b ?? {}) as Distort;
        const out: Distort = {};
        for (const c of DISTORT_CORNERS) {
          for (const [key, home] of [[c.x, c.homeX], [c.y, c.homeY]] as const) {
            const v = mixLength(da[key], db[key], f, home);
            if (v != null) out[key] = v;
          }
        }
        return out;
      }
    }
  } catch {
    /* an unparsable value — fall through to the nearest keyframe */
  }
  const near = nearestKeyframe(kfs, clock);
  return near == null ? undefined : structuredClone(kfs[near][1]);
}

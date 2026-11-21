// The playhead ↔ keyframe relationship, shared by the Properties panel
// (insert a keyframe at the playhead, highlight the active one, go-to), the
// viewport gizmo (edit the keyframe the playhead sits on) and the timeline
// lanes (double-click a diamond to snap the playhead to it).
//
// Keyframe times resolve against a node's OUTPUT span and are sampled in
// node-local output time (`containerTime − timelineStart`), so everything
// here works on a `NodeClock`: the playhead expressed in that time.

import { parseTimeExpr, resolveTimeExpr } from "@seam/core";
import type { ResolvedTimeline, SeamFile, TimeExpr } from "@seam/core";
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
  const container = descendToContainer(resolvedRoot, doc, path.slice(0, -1), globalTime);
  const rNode = container?.rContainer.children[last.index];
  const span = globalSpanOf(resolvedRoot, doc, path);
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
 * the nearest keyframe's value (no easing). Returns null when a keyframe
 * already sits at that instant — nothing to add.
 */
export function insertKeyframeAtPlayhead<K extends AnyKeyframe>(
  kfs: readonly K[],
  clock: Pick<NodeClock, "t" | "duration">,
): { keyframes: K[]; index: number } | null {
  const time = timeExprAtPlayhead(kfs, clock);
  const at = resolveTime(time, clock.duration);
  if (kfs.some((kf) => Math.abs(resolveTime(kf[0], clock.duration) - at) < 1e-6)) return null;
  const near = nearestKeyframe(kfs, clock);
  const value = near == null ? undefined : structuredClone(kfs[near][1]);
  let index = kfs.findIndex((kf) => resolveTime(kf[0], clock.duration) > at);
  if (index < 0) index = kfs.length;
  const keyframes = [...kfs];
  keyframes.splice(index, 0, [time, value] as unknown as K);
  return { keyframes, index };
}

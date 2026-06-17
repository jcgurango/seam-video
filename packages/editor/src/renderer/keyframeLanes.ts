// Animated-property → keyframe-lane extraction for the timeline panel.
//
// When a timeline block is expanded, we draw one horizontal "lane" per
// animated property of its node: a track spanning the block's width with a
// diamond at each keyframe. A graphic's `frames` array is just another
// keyframe track (the stamp is the keyframe time), so it gets a lane too —
// which is why non-composition nodes can now be expandable.
//
// The shape here is intentionally read-only + pure: it reads the *authored*
// node (so the keyframe arrays match what's in the JSON, and edits write
// back 1:1) but uses the *resolved* node only for the block's output
// timing. Editing tools live in `keyframeEdit.ts`.

import {
  isKeyframed,
  resolveTimeExpr,
  type ResolvedChild,
  type TimeExpr,
} from "@seam/core";

/** One keyframe within a lane, positioned in the block's (enclosing-group)
 *  output-time coordinate so it lines up with the block's pixels. */
export interface LaneDiamond {
  /** Index within the property's keyframe array — the write-back + JSON-jump
   *  key (`<prop>.<index>`). */
  index: number;
  /** Authored time expression (number | "50%" | "50% + 10"). */
  timeExpr: TimeExpr;
  /** Resolved time (s) relative to the block start. */
  localSec: number;
  /** Position in the block's output-time coordinate (s) = outputStart + localSec. */
  outputSec: number;
  /** Easing of the segment arriving *at* this keyframe ("linear" default).
   *  The sampler reads `kf[2]` of the later keyframe, so this is the curve
   *  from the previous keyframe to this one. */
  easing: string;
}

/** One animated property of a node, laid out as a track of keyframes.
 *
 *  Every keyframeable field (spatial, opacity, volume) resolves its times
 *  against the block's *output* span and samples in output-relative time —
 *  uniformly, across the preview and the CLI render. So a keyframe's
 *  position is simply `outputStart + localSec`, and `outputSpan` doubles as
 *  the time domain for the time expressions. */
export interface KeyframeLane {
  /** Display label (the authored field name, e.g. "opacity", "frames"). */
  label: string;
  /** Authored field name holding the keyframe array — write-back + JSON path. */
  prop: string;
  /** `frames` (graphic) writes back differently (Length stamp + objects)
   *  than a plain keyframed property ([time, value, easing]). */
  kind: "keyframed" | "frames";
  /** The block's start in the enclosing group's output coordinate (s). */
  outputStart: number;
  /** The block's output span (s) — its drawn width AND the duration its
   *  time expressions resolve against. */
  outputSpan: number;
  diamonds: LaneDiamond[];
}

// Stable lane ordering: the properties users animate most, first; anything
// else alphabetical after. `frames` sorts last (it's the whole scene).
const PROP_ORDER = [
  "opacity",
  "translation",
  "origin",
  "size",
  "rotation",
  "inset",
  "volume",
];

/** Cheap predicate: does this authored node have any animated property (so
 *  it should get an expand toggle even when it isn't a composition)? Avoids
 *  building full lanes for every block on every render. */
export function hasAnimatedLanes(docChild: unknown): boolean {
  if (docChild == null || typeof docChild !== "object") return false;
  for (const value of Object.values(docChild as Record<string, unknown>)) {
    if (isKeyframed(value as never)) return true;
  }
  return false;
}

/** Build the keyframe lanes for an expanded block. `docChild` is the authored
 *  node (keyframe arrays live here, flat — `node.opacity`, `node.frames`);
 *  `resolved` supplies the block's output timing. */
export function lanesForNode(
  docChild: unknown,
  resolved: ResolvedChild,
): KeyframeLane[] {
  if (docChild == null || typeof docChild !== "object") return [];
  const outputStart = resolved.timelineStart;
  const outputSpan = Math.max(0, resolved.timelineEnd - resolved.timelineStart);

  const lanes: KeyframeLane[] = [];
  for (const [prop, value] of Object.entries(
    docChild as Record<string, unknown>,
  )) {
    if (!isKeyframed(value as never)) continue;
    const kfs = value as Array<[TimeExpr, unknown, string?]>;
    const isFrames = prop === "frames";

    const diamonds: LaneDiamond[] = kfs.map((kf, index) => {
      let localSec = 0;
      try {
        localSec = resolveTimeExpr(kf[0], outputSpan);
      } catch {
        localSec = 0;
      }
      return {
        index,
        timeExpr: kf[0],
        localSec,
        outputSec: outputStart + localSec,
        easing: kf[2] ?? "linear",
      };
    });
    // Display in time order so a diamond's neighbour (for the outgoing-easing
    // shape) is the time-next keyframe. `index` keeps the authored array
    // position so write-back / JSON-jump stay correct after a drag reorders.
    diamonds.sort((a, b) => a.outputSec - b.outputSec);

    lanes.push({
      label: prop,
      prop,
      kind: isFrames ? "frames" : "keyframed",
      outputStart,
      outputSpan,
      diamonds,
    });
  }

  lanes.sort((a, b) => laneRank(a.prop) - laneRank(b.prop) || a.prop.localeCompare(b.prop));
  return lanes;
}

function laneRank(prop: string): number {
  if (prop === "frames") return PROP_ORDER.length + 1;
  const i = PROP_ORDER.indexOf(prop);
  return i === -1 ? PROP_ORDER.length : i;
}

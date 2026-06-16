// Pure interpolation engine for graphic animations. No fabric, no canvas,
// no I/O — just math. The renderer and preview each fill defaults via
// their own fabric build (env-specific) and then call into these
// functions for the per-tick interpolation.
//
// Filled snapshots are flat path-keyed maps: a path-id of either the
// authored object id (when present) or its positional index in the
// parent container, joined by ".". `attachPaths`-style live-tree
// integration is env-specific and lives outside core.

import { interpolateRgb } from "d3-interpolate";
import { resolveEasing } from "./easing.js";

export type FilledObject = Record<string, unknown>;
export type FilledTree = FilledObject[];
export type FlatFrame = Record<string, FilledObject>;

export interface FilledFrame {
  /** Mirrors the authored tree shape — used by env-specific code that
   *  needs to walk the live fabric tree in parallel. */
  tree: FilledTree;
  /** Flat path→state map consumed by interpolateFrames. */
  flat: FlatFrame;
  frameIndex: number;
}

function pathKey(node: FilledObject, index: number): string {
  const id = node.id;
  if (typeof id === "string" && id.length > 0) return id;
  return String(index);
}

/** Walk a filled tree, building the flat path-keyed map. Children of
 *  groups recurse under the parent's path. `objects` is stripped from
 *  each flat entry — the live node's geometry is what the path
 *  identifies, not its descendants. */
export function buildFlat(
  tree: FilledTree,
  parentPath: string,
  flat: FlatFrame,
): void {
  tree.forEach((node, i) => {
    const key = pathKey(node, i);
    const path = parentPath === "" ? key : `${parentPath}.${key}`;
    const { objects: children, ...rest } = node;
    flat[path] = rest;
    if (Array.isArray(children)) {
      buildFlat(children as FilledTree, path, flat);
    }
  });
}

// ── Single-object interpolation ────────────────────────────────────

// Discrete props are never lerped — the prev-side value is preserved.
const DISCRETE_PROPS = new Set<string>([
  "type",
  "id",
  "version",
  "revolutions",
  "angleDirection",
  "easing",
  "visible",
  "flipX",
  "flipY",
  "originX",
  "originY",
  "fontFamily",
  "fontStyle",
  "fontWeight",
  "text",
  "textAlign",
  "textBackgroundColor",
  "underline",
  "overline",
  "linethrough",
  "direction",
  "strokeLineCap",
  "strokeLineJoin",
  "strokeMiterLimit",
  "strokeUniform",
  "strokeDashArray",
  "strokeDashOffset",
  "paintFirst",
  "globalCompositeOperation",
  "selectable",
  "evented",
  "excludeFromExport",
  "objectCaching",
  "absolutePositioned",
  "inverted",
  "centeredScaling",
  "centeredRotation",
  "lockMovementX",
  "lockMovementY",
  "lockRotation",
  "lockScalingX",
  "lockScalingY",
  "lockSkewingX",
  "lockSkewingY",
  "lockScalingFlip",
  "hasBorders",
  "hasControls",
  "noScaleCache",
  "borderColor",
  "cornerColor",
  "cornerStrokeColor",
  "cornerStyle",
  "borderDashArray",
  "cornerDashArray",
  "transparentCorners",
  "hoverCursor",
  "moveCursor",
  "borderOpacityWhenMoving",
  "borderScaleFactor",
  "minScaleLimit",
  "padding",
  "perPixelTargetFind",
  "snapAngle",
  "snapThreshold",
  "splitByGrapheme",
  "styles",
  "subTargetCheck",
  "interactive",
  "layoutManager",
  "clipId",
  "startPosition",
  "repeat",
  "logicalSrc",
  "src",
  "source",
  "crossOrigin",
]);

type Direction = "shortest" | "cw" | "ccw";

function lerpNum(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function computeAngleDelta(
  prev: number,
  next: number,
  revolutions: number,
  dir: Direction,
): number {
  const a = ((prev % 360) + 360) % 360;
  const b = ((next % 360) + 360) % 360;
  let base: number;
  let sign: number;
  if (dir === "cw") {
    base = b - a;
    if (base < 0) base += 360;
    sign = 1;
  } else if (dir === "ccw") {
    base = b - a;
    if (base > 0) base -= 360;
    sign = -1;
  } else {
    base = b - a;
    if (base > 180) base -= 360;
    else if (base < -180) base += 360;
    sign = base >= 0 ? 1 : -1;
  }
  return base + revolutions * 360 * sign;
}

function lerpColor(a: unknown, b: unknown, t: number): string | null {
  if (typeof a !== "string" || typeof b !== "string") return null;
  try {
    return interpolateRgb(a, b)(t);
  } catch {
    return null;
  }
}

type PathCmd = (string | number)[];

function pathsStructureMatch(a: PathCmd[], b: PathCmd[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i].length !== b[i].length) return false;
    if (a[i][0] !== b[i][0]) return false;
  }
  return true;
}

function lerpPathArray(a: PathCmd[], b: PathCmd[], t: number): PathCmd[] {
  return a.map((cmd, i) =>
    cmd.map((val, j) => {
      if (j === 0) return val;
      const bn = b[i][j];
      if (typeof val === "number" && typeof bn === "number") {
        return lerpNum(val, bn, t);
      }
      return val;
    }),
  );
}

function interpolateObject(
  prev: FilledObject,
  next: FilledObject,
  t: number,
): FilledObject {
  const out: FilledObject = {};
  const keys = new Set<string>([...Object.keys(prev), ...Object.keys(next)]);
  for (const k of keys) {
    const a = prev[k];
    const b = next[k];
    if (a === undefined && b === undefined) continue;
    if (DISCRETE_PROPS.has(k)) {
      out[k] = a !== undefined ? a : b;
      continue;
    }
    if (k === "angle") {
      const aa = typeof a === "number" ? a : 0;
      const bb = typeof b === "number" ? b : 0;
      const rev =
        typeof next.revolutions === "number" ? (next.revolutions as number) : 0;
      const rawDir = next.angleDirection;
      const dir: Direction =
        rawDir === "cw" || rawDir === "ccw" ? rawDir : "shortest";
      const delta = computeAngleDelta(aa, bb, rev, dir);
      out.angle = aa + delta * t;
      continue;
    }
    if (k === "fill" || k === "stroke") {
      const lerped = lerpColor(a, b, t);
      out[k] = lerped ?? (a !== undefined ? a : b);
      continue;
    }
    if (
      k === "points" &&
      Array.isArray(a) &&
      Array.isArray(b) &&
      a.length === b.length
    ) {
      out[k] = a.map((pt, i) => ({
        x: lerpNum(
          (pt as { x: number }).x,
          (b as { x: number }[])[i].x,
          t,
        ),
        y: lerpNum(
          (pt as { y: number }).y,
          (b as { y: number }[])[i].y,
          t,
        ),
      }));
      continue;
    }
    if (
      k === "path" &&
      Array.isArray(a) &&
      Array.isArray(b) &&
      pathsStructureMatch(a as PathCmd[], b as PathCmd[])
    ) {
      out[k] = lerpPathArray(a as PathCmd[], b as PathCmd[], t);
      continue;
    }
    if (
      k === "paths" &&
      Array.isArray(a) &&
      Array.isArray(b) &&
      a.length === b.length
    ) {
      // Map paths: per-index merge. Points stay from prev (discrete by
      // design); color, progress, lineWidth interpolate. lineWidth
      // defaults to 4 on either side.
      out.paths = a.map((aPath, i) => {
        const bPath = (b as Array<Record<string, unknown>>)[i];
        const ap = aPath as Record<string, unknown>;
        if (!bPath) return ap;
        const merged: Record<string, unknown> = { ...ap };
        if (typeof ap.color === "string" && typeof bPath.color === "string") {
          const lerped = lerpColor(ap.color, bPath.color, t);
          if (lerped) merged.color = lerped;
        }
        const ap_p = typeof ap.progress === "number" ? ap.progress : 1;
        const bp_p = typeof bPath.progress === "number" ? bPath.progress : 1;
        merged.progress = lerpNum(ap_p, bp_p, t);
        const ap_w = typeof ap.lineWidth === "number" ? ap.lineWidth : 4;
        const bp_w = typeof bPath.lineWidth === "number" ? bPath.lineWidth : 4;
        merged.lineWidth = lerpNum(ap_w, bp_w, t);
        merged.points = ap.points;
        return merged;
      });
      continue;
    }
    if (
      k === "zoom" &&
      prev.type === "Map" &&
      typeof a === "number" &&
      typeof b === "number"
    ) {
      // Map zoom is logarithmic — every +1 doubles world detail. Lerping
      // the zoom value directly gives a curve that creeps near one end
      // and snaps near the other (constant zoom delta == accelerating
      // viewport change). Interpolate in scale-space (2^-zoom, i.e.
      // world units per pixel) instead so the camera move looks steady.
      // `t` is already eased upstream.
      const sA = Math.pow(2, -a);
      const sB = Math.pow(2, -b);
      const scale = sA + (sB - sA) * t;
      out[k] = -Math.log2(scale);
      continue;
    }
    if (typeof a === "number" && typeof b === "number") {
      out[k] = lerpNum(a, b, t);
      continue;
    }
    out[k] = a !== undefined ? a : b;
  }
  return out;
}

// ── Frame-pair interpolation ────────────────────────────────────────

/** Walk prev.flat — for each path: if next has the same path AND same
 *  type, lerp; else freeze at prev. Paths only in `next` are dropped
 *  (they appear discretely at next's stamp, when prev structure flips
 *  to next's, per the "Frame A structure until Frame B" rule).
 *
 *  `frameEasing` is the easing authored on the `next` keyframe (3rd tuple
 *  element) — easing governs the tween *arriving at* a keyframe, matching
 *  core's `sampleFrames` (which uses the destination keyframe's ease) and
 *  every other animated value in the app. The per-object `easing` attribute
 *  on the `next` object overrides it. Easing maps `t` before object
 *  interpolation; every numeric/color/angle lerp inside runs against the
 *  eased fraction. */
export function interpolateFrames(
  prev: FilledFrame,
  next: FilledFrame,
  t: number,
  frameEasing?: string,
): FlatFrame {
  const out: FlatFrame = {};
  for (const path in prev.flat) {
    const a = prev.flat[path];
    const b = next.flat[path];
    if (b && a.type === b.type) {
      const objEasing = typeof b.easing === "string" ? b.easing : undefined;
      const easingFn = resolveEasing(objEasing ?? frameEasing);
      out[path] = interpolateObject(a, b, easingFn(t));
    } else {
      out[path] = { ...a };
    }
  }
  return out;
}

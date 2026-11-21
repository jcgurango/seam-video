// Write-back math for the viewport transform gizmo: a drag (in the node's
// parent content px) → new authored `translation` / `size` / `origin` /
// `rotation` / `distort`.
//
// Length rule: PERCENTAGE FIRST. A drag moves the percentage of a length;
// only when a pixel number is authored (`12`, `"50% + 12"`) does that number
// take the delta instead, percentage untouched. An absent value starts from
// the property's default percentage (translation / origin 50%, size 100%, a
// distort corner its own corner), so nothing jumps and the result stays
// relative to its reference. A snapped origin axis is written as the bare
// percentage whatever was authored.
//
// Animated properties: a keyframed property is editable only while the
// playhead sits ON one of its keyframes — the caller passes that keyframe's
// index per property (`KeyframeTargets`) and the drag rewrites that keyframe's
// value in place, by the same rules. Off a keyframe the property is left
// alone (see `transformCapabilities`).

import { isKeyframed, resolveLength } from "@seam/core";
import type { Child, Distort, Keyframed, Length, Point2D } from "@seam/core";
import { joinLength, pointAxis, splitLength } from "./propertyCatalog.js";
import { rotateVec } from "./viewportLocate.js";

/** What the edit math needs to know about the node at drag start — a
 *  `LocatedNode` satisfies it. */
export interface TransformGeometry {
  parentW: number;
  parentH: number;
  naturalW: number;
  naturalH: number;
  /** Content box in parent px, before rotation. */
  box: { x: number; y: number; width: number; height: number };
  /** Where the origin lands in parent px (the rotation pivot). */
  pivot: { x: number; y: number };
  /** Degrees, clockwise. */
  rotation: number;
  inner?: { width: number; height: number };
}

/** Handle position on the box: 0 = left/top, 0.5 = middle, 1 = right/bottom. */
export type HandlePos = 0 | 0.5 | 1;

export type TransformDrag =
  /** Body drag. `dx`/`dy` in parent content px. */
  | { kind: "move"; dx: number; dy: number }
  /** Origin handle: the origin moves, the box stays put (`translation`
   *  compensates). `dx`/`dy` in parent content px. `snapX`/`snapY` pin that
   *  axis (in the box's own frame) to a box fraction instead — written as the
   *  exact percentage, whatever was authored. */
  | { kind: "origin"; dx: number; dy: number; snapX?: HandlePos; snapY?: HandlePos }
  /** `snap`: quantize the delta to 15° steps. */
  | { kind: "rotate"; deltaDeg: number; snap: boolean }
  /** Corner / midpoint handle; scales about the origin. `dx`/`dy` = pointer
   *  movement in parent content px. `uniform` keeps the aspect ratio. */
  | { kind: "scale"; hx: HandlePos; hy: HandlePos; dx: number; dy: number; uniform: boolean }
  /** Corner pin (compositions). `corner` clockwise from top-left; `dx`/`dy`
   *  in the composition's inner-canvas px. */
  | { kind: "distort"; corner: 0 | 1 | 2 | 3; dx: number; dy: number };

export const ROTATE_SNAP_DEG = 15;

const round = (n: number, places: number): number => {
  const k = 10 ** places;
  const r = Math.round(n * k) / k;
  return r === 0 ? 0 : r; // no -0
};

/**
 * Move a length by `delta` resolved pixels. `ref` is what its percentage
 * resolves against; `defaultPercent` is the percentage an absent value stands
 * for. The percentage moves unless a pixel number is authored, which then
 * takes the delta (also the fallback when `ref` is 0 and a percentage can't
 * express the move).
 */
export function nudgeLength(
  value: Length | undefined,
  delta: number,
  ref: number,
  defaultPercent: number,
): Length | undefined {
  if (delta === 0) return value;
  const parts = splitLength(value);
  if (parts.px == null && ref > 0) {
    const percent = (parts.percent ?? defaultPercent) + (delta / ref) * 100;
    return joinLength({ percent: round(percent, 2), px: null });
  }
  const percent = value == null ? defaultPercent : parts.percent;
  return joinLength({ percent, px: round((parts.px ?? 0) + delta, 1) });
}

type Rec = Record<string, unknown>;
const animated = (v: unknown): boolean => v != null && isKeyframed(v as Keyframed<unknown>);

export interface TransformCapabilities {
  move: boolean;
  scale: boolean;
  rotate: boolean;
  origin: boolean;
  distort: boolean;
}

/** The properties the gizmo writes. */
export const TRANSFORM_PROPS = ["translation", "size", "origin", "rotation", "distort"] as const;
export type TransformProp = (typeof TRANSFORM_PROPS)[number];

/** For each ANIMATED transform property, the index of the keyframe the
 *  playhead sits on (absent = not on one → that property can't be edited). */
export type KeyframeTargets = Partial<Record<TransformProp, number>>;

/** Which transform properties of `node` are keyframed. */
export function animatedTransformProps(node: Child): TransformProp[] {
  const rec = node as unknown as Rec;
  return TRANSFORM_PROPS.filter((key) => animated(rec[key]));
}

/** Which gizmo interactions apply to `node`. A keyframed property keeps its
 *  handle only while `at` names the keyframe the playhead is on. */
export function transformCapabilities(node: Child, at: KeyframeTargets = {}): TransformCapabilities {
  if (node.type === "audio" || node.type === "data") {
    return { move: false, scale: false, rotate: false, origin: false, distort: false };
  }
  const rec = node as unknown as Rec;
  const ok = (key: TransformProp) => !animated(rec[key]) || at[key] != null;
  return {
    move: ok("translation"),
    scale: ok("size"),
    rotate: ok("rotation"),
    origin: ok("translation") && ok("origin"),
    distort: node.type === "composition" && ok("distort"),
  };
}

/** The value a drag edits: the static value, or the targeted keyframe's. */
function readProp(node: Child, key: TransformProp, at: KeyframeTargets): unknown {
  const value = (node as unknown as Rec)[key];
  if (!animated(value)) return value;
  const index = at[key];
  return index == null ? undefined : (value as [unknown, unknown][])[index]?.[1];
}

/** Write a drag's result back: onto the key, or into the targeted keyframe
 *  (time and easing untouched). */
function setKey(node: Child, key: string, value: unknown, at: KeyframeTargets = {}): Child {
  const rec = node as unknown as Rec;
  if (animated(rec[key])) {
    const index = at[key as TransformProp];
    const kfs = rec[key] as unknown[][];
    if (index == null || !kfs[index] || value === undefined || kfs[index][1] === value) return node;
    const next = [...kfs];
    next[index] = [kfs[index][0], value, ...kfs[index].slice(2)];
    return { ...rec, [key]: next } as unknown as Child;
  }
  if (value === undefined) {
    if (!(key in rec)) return node;
    const { [key]: _drop, ...rest } = rec;
    return rest as unknown as Child;
  }
  if (rec[key] === value) return node;
  return { ...rec, [key]: value } as unknown as Child;
}

/** Nudge both axes of a static `translation` / `origin` (default 50%). */
function nudgePoint(
  value: Point2D | undefined,
  dx: number,
  dy: number,
  refX: number,
  refY: number,
): Point2D | undefined {
  return point(
    nudgeLength(pointAxis(value, "x"), dx, refX, 50),
    nudgeLength(pointAxis(value, "y"), dy, refY, 50),
  );
}

/** A `Point2D` from its two axes: a scalar when they agree, `undefined` when
 *  both are unset, else `{x, y}` (x first, unset axes omitted). */
function point(x: Length | undefined, y: Length | undefined): Point2D | undefined {
  if (x == null && y == null) return undefined;
  if (x != null && x === y) return x;
  return { ...(x != null ? { x } : {}), ...(y != null ? { y } : {}) };
}

/** The origin's percent part as a fraction of the box, per axis. A bare
 *  number is `50% + n`; absent is `50%`. */
function originFraction(origin: Point2D | undefined, axis: "x" | "y"): number {
  const parts = splitLength(pointAxis(origin, axis));
  return (parts.percent ?? 50) / 100;
}

/** Apply one drag to the node as it was at drag start. `at` targets the
 *  keyframe to rewrite for each animated property. Returns the same node when
 *  the drag doesn't apply (animated property off its keyframes, wrong type,
 *  no change). */
export function applyTransformDrag(
  node: Child,
  geom: TransformGeometry,
  drag: TransformDrag,
  at: KeyframeTargets = {},
): Child {
  if (node.type === "audio" || node.type === "data") return node;
  const caps = transformCapabilities(node, at);
  const read = (key: TransformProp) => readProp(node, key, at);

  switch (drag.kind) {
    case "move": {
      if (!caps.move) return node;
      const translation = nudgePoint(
        read("translation") as Point2D | undefined,
        drag.dx,
        drag.dy,
        geom.parentW,
        geom.parentH,
      );
      return setKey(node, "translation", translation, at);
    }

    case "origin": {
      if (!caps.origin) return node;
      // The origin lives in the box's own (un-rotated) frame.
      const local = rotateVec({ x: drag.dx, y: drag.dy }, -geom.rotation);
      const current = read("origin") as Point2D | undefined;
      const axis = (
        a: "x" | "y",
        delta: number,
        snap: HandlePos | undefined,
        size: number,
        at: number,
      ): { value: Length | undefined; moved: number } => {
        const value =
          snap != null ? `${snap * 100}%` : nudgeLength(pointAxis(current, a), delta, size, 50);
        // What the written value actually moves the origin by (rounding and
        // snapping included) — `translation` follows that, so the box stays put.
        const landed = value == null ? size / 2 : resolveLength(value, size, 50);
        return { value, moved: landed - at };
      };
      const x = axis("x", local.x, drag.snapX, geom.box.width, geom.pivot.x - geom.box.x);
      const y = axis("y", local.y, drag.snapY, geom.box.height, geom.pivot.y - geom.box.y);
      const shift = rotateVec({ x: x.moved, y: y.moved }, geom.rotation);
      const translation = nudgePoint(
        read("translation") as Point2D | undefined,
        shift.x,
        shift.y,
        geom.parentW,
        geom.parentH,
      );
      return setKey(
        setKey(node, "origin", point(x.value, y.value), at),
        "translation",
        translation,
        at,
      );
    }

    case "rotate": {
      if (!caps.rotate) return node;
      const delta = drag.snap
        ? Math.round(drag.deltaDeg / ROTATE_SNAP_DEG) * ROTATE_SNAP_DEG
        : drag.deltaDeg;
      if (delta === 0) return node;
      const current = (read("rotation") as number | undefined) ?? 0;
      return setKey(node, "rotation", round(current + delta, 1), at);
    }

    case "scale": {
      if (!caps.scale) return node;
      const w0 = geom.box.width;
      const h0 = geom.box.height;
      const local = rotateVec({ x: drag.dx, y: drag.dy }, -geom.rotation);
      // An animated origin between keyframes has no authored value here:
      // take where it currently sits on the box as a pure fraction.
      const originLive = animated(node.origin) && at.origin == null;
      const origin = read("origin") as Point2D | undefined;
      const fraction = (axis: "x" | "y"): number => {
        if (!originLive) return originFraction(origin, axis);
        const size = axis === "x" ? w0 : h0;
        const offset = axis === "x" ? geom.pivot.x - geom.box.x : geom.pivot.y - geom.box.y;
        return size > 0 ? offset / size : 0.5;
      };
      // The origin point stays where it is, so a handle at box fraction `h`
      // sits `(h − originFraction) · size` from it: that factor converts the
      // pointer's travel into a size change. A handle level with the origin
      // can't change the size on that axis.
      const axisDelta = (h: HandlePos, d: number, axis: "x" | "y"): number => {
        if (h === 0.5) return 0;
        const k = h - fraction(axis);
        return Math.abs(k) > 1e-3 ? d / k : 0;
      };
      let w = Math.max(0, w0 + axisDelta(drag.hx, local.x, "x"));
      let h = Math.max(0, h0 + axisDelta(drag.hy, local.y, "y"));
      if (drag.uniform) {
        const kx = drag.hx !== 0.5 && w0 > 0 ? w / w0 : 1;
        const ky = drag.hy !== 0.5 && h0 > 0 ? h / h0 : 1;
        const k = Math.abs(kx - 1) >= Math.abs(ky - 1) ? kx : ky;
        w = w0 * k;
        h = h0 * k;
      }
      const dw = w - w0;
      const dh = h - h0;
      if (dw === 0 && dh === 0) return node;

      const size = read("size") as Point2D | undefined;
      // A wholly absent size is the natural rect on both axes; once one axis
      // is written the other needs its default spelled out (a missing axis
      // of an authored size is 0, not 100%).
      const axis = (a: "x" | "y", d: number, natural: number): Length | undefined => {
        if (size == null && d === 0) return "100%";
        return nudgeLength(pointAxis(size, a), d, natural, size == null ? 100 : 0);
      };
      const nx = axis("x", dw, geom.naturalW);
      const ny = axis("y", dh, geom.naturalH);
      return setKey(node, "size", point(nx, ny), at);
    }

    case "distort": {
      if (!caps.distort || node.type !== "composition" || !geom.inner) return node;
      const current = (read("distort") as Distort | undefined) ?? {};
      const xKey = `x${drag.corner}` as keyof Distort;
      const yKey = `y${drag.corner}` as keyof Distort;
      const next: Distort = { ...current };
      // An absent corner coordinate sits at its own corner of the canvas.
      const homeX = drag.corner === 1 || drag.corner === 2 ? 100 : 0;
      const homeY = drag.corner >= 2 ? 100 : 0;
      const nx = nudgeLength(current[xKey], drag.dx, geom.inner.width, homeX);
      const ny = nudgeLength(current[yKey], drag.dy, geom.inner.height, homeY);
      if (nx === undefined) delete next[xKey];
      else next[xKey] = nx;
      if (ny === undefined) delete next[yKey];
      else next[yKey] = ny;
      if (nx === current[xKey] && ny === current[yKey]) return node;
      return setKey(node, "distort", next, at);
    }
  }
}

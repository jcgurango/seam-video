// Where a node sits in the viewport at the playhead.
//
// The compositor's `buildRenderList` answers this per frame for every node,
// but it walks the PLAYER timeline (scripts run, children cropped to their
// windows), which doesn't map back onto authored paths. This walks one path
// instead, on the compiled (scripts off) document — per level the body is
// resolved `uncropped` so resolved children are 1:1 with authored ones (same
// approach as `resolveLocal.ts`) — and reproduces the compositor's layout
// with the same core functions (`resolveBoxProps`, `computeNaturalSize`,
// `sampleContentDim`, `sampleDistort`).
//
// The result carries everything the transform gizmo needs: the node's content
// box in its parent's content space, the origin point, and a projective
// matrix taking parent content px to root canvas px (rotated / inset /
// distorted ancestors all fold into it).

import {
  computeNaturalSize,
  isKeyframed,
  loopLocalTime,
  resolveBoxProps,
  sampleContentDim,
  sampleDistort,
  isIdentityDistort,
  squareToQuad,
  DEFAULT_CANVAS_HEIGHT,
  DEFAULT_CANVAS_WIDTH,
} from "@seam/core";
import type {
  SpatialFields,
  Seam,
  Child,
  Composition,
  DistortCorners,
  Keyframed,
  Length,
  ObjectFit,
  ResolvedChild,
  SeamFile,
  SpatialInput,
} from "@seam/core";

// ── 3×3 projective matrices (row-major) ────────────────────────────

export type Mat3 = [number, number, number, number, number, number, number, number, number];

export interface Pt {
  x: number;
  y: number;
}

export const IDENTITY: Mat3 = [1, 0, 0, 0, 1, 0, 0, 0, 1];

/** `a · b` — apply `b` first, then `a`. */
export function mul(a: Mat3, b: Mat3): Mat3 {
  const o = new Array<number>(9) as Mat3;
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++) {
      o[r * 3 + c] = a[r * 3] * b[c] + a[r * 3 + 1] * b[3 + c] + a[r * 3 + 2] * b[6 + c];
    }
  }
  return o;
}

export function apply(m: Mat3, p: Pt): Pt {
  const w = m[6] * p.x + m[7] * p.y + m[8];
  const iw = Math.abs(w) > 1e-12 ? 1 / w : 0;
  return {
    x: (m[0] * p.x + m[1] * p.y + m[2]) * iw,
    y: (m[3] * p.x + m[4] * p.y + m[5]) * iw,
  };
}

/** Inverse (up to scale — fine for projective use). Null when singular. */
export function invert(m: Mat3): Mat3 | null {
  const [a, b, c, d, e, f, g, h, i] = m;
  const A = e * i - f * h;
  const B = -(d * i - f * g);
  const C = d * h - e * g;
  const det = a * A + b * B + c * C;
  if (!(Math.abs(det) > 1e-12)) return null;
  const s = 1 / det;
  return [
    A * s,
    -(b * i - c * h) * s,
    (b * f - c * e) * s,
    B * s,
    (a * i - c * g) * s,
    -(a * f - c * d) * s,
    C * s,
    -(a * h - b * g) * s,
    (a * e - b * d) * s,
  ];
}

/** `(x, y) ↦ (tx + x·sx, ty + y·sy)`. */
function scaleTranslate(sx: number, sy: number, tx: number, ty: number): Mat3 {
  return [sx, 0, tx, 0, sy, ty, 0, 0, 1];
}

/** Clockwise (screen-space, y down) rotation by `deg` about `pivot`. */
function rotateAbout(deg: number, pivot: Pt): Mat3 {
  if (deg === 0) return IDENTITY;
  const r = (deg * Math.PI) / 180;
  const c = Math.cos(r);
  const s = Math.sin(r);
  return [
    c, -s, pivot.x - pivot.x * c + pivot.y * s,
    s, c, pivot.y - pivot.x * s - pivot.y * c,
    0, 0, 1,
  ];
}

/** Rotate a vector clockwise by `deg` (screen space). */
export function rotateVec(v: Pt, deg: number): Pt {
  const r = (deg * Math.PI) / 180;
  const c = Math.cos(r);
  const s = Math.sin(r);
  return { x: v.x * c - v.y * s, y: v.x * s + v.y * c };
}

// ── Located node ───────────────────────────────────────────────────

export interface LocatedInner {
  /** The composition's inner canvas (contentWidth × contentHeight), px. */
  width: number;
  height: number;
  /** Inner canvas px → the composition's parent content px, WITHOUT the
   *  distort warp (window placement + rotation only). A distort corner
   *  authored at inner point `c` shows at `toParent · c`. */
  toParent: Mat3;
  /** Sampled distort corners in inner px (identity = the canvas corners). */
  corners: DistortCorners;
  distorted: boolean;
}

export interface LocatedNode {
  type: Child["type"];
  /** Parent content px → root canvas px. */
  parentToCanvas: Mat3;
  parentW: number;
  parentH: number;
  /** Post-objectFit natural size — what `size: "100%"` evaluates to. */
  naturalW: number;
  naturalH: number;
  /** The content box (`size`, placed by `origin`/`translation`, pre-inset)
   *  in parent content px, before rotation. */
  box: { x: number; y: number; width: number; height: number };
  /** The `translation` point in parent px: where `origin` lands, and the
   *  rotation pivot. */
  pivot: Pt;
  /** Degrees, clockwise. */
  rotation: number;
  /** Compositions only. */
  inner?: LocatedInner;
}

export type MediaSizeGetter = (node: {
  type: "clip" | "static";
  source: string;
  orientation?: number;
}) => { w: number; h: number } | null;

interface ResolvedBody {
  children: ResolvedChild[];
}

// Nested bodies re-resolve only when their compiled composition changes
// (the gizmo re-locates on every playhead tick).
const bodyCache = new WeakMap<object, ResolvedBody | null>();
function bodyOf(seam: Seam, comp: Composition): ResolvedBody | null {
  let body = bodyCache.get(comp);
  if (body === undefined) {
    try {
      body = seam.resolveComposition(comp, { uncropped: true });
    } catch {
      body = null;
    }
    bodyCache.set(comp, body);
  }
  return body;
}

function spatialInputOf(node: Child): SpatialInput {
  if (node.type === "audio" || node.type === "data") return {};
  // Only visual nodes reach here (a non-visual extension node — a caption —
  // is never located), so the spatial fields exist.
  const { origin, translation, size, rotation } = node as SpatialFields;
  return {
    origin,
    translation,
    size,
    rotation,
    ...(node.type === "composition" ? { inset: node.inset, insetMode: node.insetMode } : {}),
  };
}

interface Placed {
  naturalW: number;
  naturalH: number;
  box: LocatedNode["box"];
  pivot: Pt;
  rotation: number;
  inner?: LocatedInner;
  /** Inner canvas px → parent px including the distort warp (what children
   *  are actually drawn through). */
  innerToParent?: Mat3;
}

/** Lay one node out in its parent — mirrors `RenderList`'s `dynamicSpatial`
 *  plus the container mapping. `t`/`duration` are node-local. */
function placeNode(
  seam: Seam,
  node: Child,
  parentW: number,
  parentH: number,
  fit: ObjectFit,
  t: number,
  duration: number,
  getMediaSize: MediaSizeGetter,
): Placed | null {
  if (node.type === "audio" || node.type === "data") return null;
  // An extension node with no visual presence (a caption) has no box.
  if (seam.nodeTypes.get(node.type)?.visual === false) return null;

  let naturalW = parentW;
  let naturalH = parentH;
  let innerW = 0;
  let innerH = 0;
  if (node.type === "clip" || node.type === "static") {
    const media = getMediaSize({
      type: node.type,
      source: node.source,
      orientation: node.type === "clip" ? node.orientation : undefined,
    });
    if (media && media.w > 0 && media.h > 0) {
      const n = computeNaturalSize(fit, media.w, media.h, parentW, parentH);
      naturalW = n.naturalWidth;
      naturalH = n.naturalHeight;
    }
  } else if (
    node.type === "composition" ||
    node.type === "text" ||
    // Every extension node type has an inner canvas.
    seam.nodeTypes.has(node.type)
  ) {
    const cw = (node as { contentWidth?: Keyframed<Length> }).contentWidth;
    const ch = (node as { contentHeight?: Keyframed<Length> }).contentHeight;
    innerW = sampleContentDim(cw, t, duration, parentW);
    innerH = sampleContentDim(ch, t, duration, parentH);
    const n = computeNaturalSize(fit, innerW, innerH, parentW, parentH);
    naturalW = n.naturalWidth;
    naturalH = n.naturalHeight;
  }

  const input = spatialInputOf(node);
  // `rotation: 0` when unauthored makes resolveBoxProps report the origin.
  const withRot: SpatialInput = { ...input, rotation: input.rotation ?? 0 };
  const full = resolveBoxProps(
    { ...withRot, inset: undefined },
    parentW,
    parentH,
    naturalW,
    naturalH,
    t,
    duration,
  );
  const pivot = { x: full.x + (full.originX ?? 0), y: full.y + (full.originY ?? 0) };
  const rotation = full.rotation ?? 0;
  const placed: Placed = {
    naturalW,
    naturalH,
    box: { x: full.x, y: full.y, width: full.width, height: full.height },
    pivot,
    rotation,
  };

  if (node.type === "composition" && innerW > 0 && innerH > 0) {
    // The visible window (inset) is what the inner canvas's `sourceRect`
    // fills; without an inset that's the whole content box.
    const out =
      input.inset != null
        ? resolveBoxProps(withRot, parentW, parentH, naturalW, naturalH, t, duration)
        : full;
    const sr = out.sourceRect ?? { u0: 0, v0: 0, u1: 1, v1: 1 };
    const spanU = sr.u1 - sr.u0 > 0 ? sr.u1 - sr.u0 : 1;
    const spanV = sr.v1 - sr.v0 > 0 ? sr.v1 - sr.v0 : 1;
    const rot = rotateAbout(rotation, pivot);
    // unit (u,v) → parent px, then inner px → unit in front of it.
    const win = scaleTranslate(
      out.width / spanU,
      out.height / spanV,
      out.x - (sr.u0 / spanU) * out.width,
      out.y - (sr.v0 / spanV) * out.height,
    );
    const toUnit = scaleTranslate(1 / innerW, 1 / innerH, 0, 0);
    const toParent = mul(rot, mul(win, toUnit));

    const corners = sampleDistort(node.distort ?? {}, t, duration, innerW, innerH);
    const distorted = !isIdentityDistort(corners, innerW, innerH);
    let innerToParent = toParent;
    if (distorted) {
      const h = squareToQuad([
        { x: corners.x0 / innerW, y: corners.y0 / innerH },
        { x: corners.x1 / innerW, y: corners.y1 / innerH },
        { x: corners.x2 / innerW, y: corners.y2 / innerH },
        { x: corners.x3 / innerW, y: corners.y3 / innerH },
      ]);
      const warp: Mat3 = [h.a, h.b, h.c, h.d, h.e, h.f, h.g, h.h, 1];
      innerToParent = mul(rot, mul(win, mul(warp, toUnit)));
    }
    placed.inner = { width: innerW, height: innerH, toParent, corners, distorted };
    placed.innerToParent = innerToParent;
  }
  return placed;
}

/**
 * Locate the node at `indices` (child index per level, from the root) of the
 * compiled document at global time `time`.
 *
 * `rootBody` is the root resolved `uncropped` (the editor timeline) — 1:1
 * with `compiled.children`. Returns null when the node (or an ancestor) isn't
 * on screen at `time`, isn't a visual node, or sits under a non-composition
 * container (map children aren't handled yet).
 */
export function locateNode(
  seam: Seam,
  compiled: SeamFile,
  rootBody: ResolvedBody,
  indices: number[],
  time: number,
  getMediaSize: MediaSizeGetter,
): LocatedNode | null {
  if (indices.length === 0) return null;
  const rootW = compiled.contentWidth ?? DEFAULT_CANVAS_WIDTH;
  const rootH = compiled.contentHeight ?? DEFAULT_CANVAS_HEIGHT;
  if (typeof rootW !== "number" || typeof rootH !== "number") return null;

  let cNode: { children?: Child[] } = compiled;
  let rBody: ResolvedBody = rootBody;
  let parentW = rootW;
  let parentH = rootH;
  let fit: ObjectFit = compiled.objectFit ?? "fit";
  let toCanvas: Mat3 = IDENTITY;
  let t = time;

  for (let depth = 0; depth < indices.length; depth++) {
    const index = indices[depth];
    const cChild = (cNode.children ?? [])[index];
    const rChild = rBody.children[index];
    if (!cChild || !rChild || cChild.type !== rChild.type) return null;
    if (!(t >= rChild.timelineStart && t < rChild.timelineEnd)) return null;
    const local = t - rChild.timelineStart;
    const duration = rChild.timelineEnd - rChild.timelineStart;

    const placed = placeNode(seam, cChild, parentW, parentH, fit, local, duration, getMediaSize);
    if (!placed) return null;

    if (depth === indices.length - 1) {
      return {
        type: cChild.type,
        parentToCanvas: toCanvas,
        parentW,
        parentH,
        naturalW: placed.naturalW,
        naturalH: placed.naturalH,
        box: placed.box,
        pivot: placed.pivot,
        rotation: placed.rotation,
        ...(placed.inner ? { inner: placed.inner } : {}),
      };
    }

    // Descend into a composition.
    if (cChild.type !== "composition" || rChild.type !== "composition") return null;
    if (!placed.inner || !placed.innerToParent) return null;
    const body = bodyOf(seam, cChild);
    if (!body) return null;
    t = (cChild.in ?? 0) + loopLocalTime(rChild.loop, local) * rChild.speed;
    toCanvas = mul(toCanvas, placed.innerToParent);
    parentW = placed.inner.width;
    parentH = placed.inner.height;
    fit = cChild.objectFit ?? fit;
    cNode = cChild;
    rBody = body;
  }
  return null;
}

/** True when a (possibly absent) authored value is a keyframe array. */
export function isAnimated(value: unknown): boolean {
  return value != null && isKeyframed(value as Keyframed<unknown>);
}

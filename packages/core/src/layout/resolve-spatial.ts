// Spatial resolution pass.
//
// Model: every node has size + origin + translation. We resolve these
// from the input fields against parent dims (or item dims, for origin),
// then place the node so its origin point inside the item lines up with
// the translation point in the parent. The output is a `SpatialRect`
// in parent space, ready for renderers to consume directly.
//
// Process per node:
//   1. Resolve contentWidth/contentHeight (Length, against parent dims)
//      → intrinsic inner canvas, used by compositions and text.
//   2. Resolve intrinsic media size for the node:
//        clip / static            → unknown to core; fall through to the
//                                   parent dims unless overridden later
//                                   by a renderer (preview probes media)
//        composition / text       → contentWidth × contentHeight
//   3. Compute post-objectFit "natural" size from intrinsic vs parent dims.
//   4. Resolve `size` against natural size → final width/height in px.
//   5. Resolve `origin` against final size → origin point in item space.
//   6. Resolve `translation` against parent dims → point in parent space.
//   7. Final rect: `{x: translation.x - origin.x, y: ..., width/height}`.

import type {
  ResolvedTimeline,
  ResolvedChild,
  SpatialRect,
  SpatialInput,
} from "../resolved-types.js";
import type { Length, ObjectFit, Point2D, Keyframed } from "../types.js";
import { resolveLength, hasPercent } from "./units.js";
import { isKeyframed, sampleLength, sampleNumber, sampleInset } from "../animation/keyframes.js";

/** Fallback canvas dimensions used when the root composition doesn't set
 *  `contentWidth` / `contentHeight`. Portrait 1080×1920 — picked once so
 *  the editor, preview, and exported renders all agree. */
export const DEFAULT_CANVAS_WIDTH = 1080;
export const DEFAULT_CANVAS_HEIGHT = 1920;

// Percent-defaults per property, used when the author writes a bare
// pixel number with no percentage component:
//   origin / translation → 50%  (center)
//   size                 →  0%  (literal pixels)
const ORIGIN_DEFAULT_PCT = 50;
const TRANSLATION_DEFAULT_PCT = 50;
const SIZE_DEFAULT_PCT = 0;

/** True if any of the input's spatial fields are keyframed — the renderer
 *  needs to keep `spatialInput` on the resolved node to re-sample per frame. */
export function hasAnimatedSpatialInput(input: SpatialInput | undefined): boolean {
  if (!input) return false;
  return (
    isKeyframedPoint(input.origin) ||
    isKeyframedPoint(input.translation) ||
    isKeyframedPoint(input.size) ||
    (input.rotation != null && isKeyframed(input.rotation)) ||
    (input.inset != null && isKeyframed(input.inset))
  );
}

function isKeyframedPoint(value: Keyframed<Point2D> | undefined): boolean {
  if (value == null) return false;
  if (!isKeyframed(value)) {
    // Static value — definitely not animated.
    return false;
  }
  return true;
}

export function resolveSpatial(
  timeline: ResolvedTimeline,
  canvasWidth: number,
  canvasHeight: number,
): ResolvedTimeline {
  const rootObjectFit = timeline.objectFit ?? "fit";
  // Root contentWidth/Height must be pixel numbers — no parent reference.
  const rootInnerW = resolveContentDim(
    timeline.contentWidth,
    canvasWidth,
    canvasWidth,
    "contentWidth (root)",
  );
  const rootInnerH = resolveContentDim(
    timeline.contentHeight,
    canvasHeight,
    canvasHeight,
    "contentHeight (root)",
  );
  return {
    ...timeline,
    width: canvasWidth,
    height: canvasHeight,
    contentWidth: rootInnerW,
    contentHeight: rootInnerH,
    children: resolveChildren(timeline.children, rootInnerW, rootInnerH, rootObjectFit),
  };
}

function resolveChildren(
  children: ResolvedChild[],
  parentW: number,
  parentH: number,
  parentObjectFit: ObjectFit,
): ResolvedChild[] {
  return children.map((c) => resolveNode(c, parentW, parentH, parentObjectFit));
}

function resolveNode(
  node: ResolvedChild,
  parentW: number,
  parentH: number,
  parentObjectFit: ObjectFit,
): ResolvedChild {
  if (node.type === "empty" || node.type === "audio" || node.type === "data") {
    return node;
  }

  const input = node.spatialInput;
  const ownObjectFit: ObjectFit = input?.objectFit ?? parentObjectFit;
  const fitForSelf: ObjectFit = parentObjectFit;
  const animated = hasAnimatedSpatialInput(input);

  // Step 1+2: figure out the intrinsic dimensions. Core knows them for
  // compositions and text; for clip/static it's a renderer concern
  // (intrinsic media size is probed later), so we treat the parent
  // dims as a stand-in for the natural size to keep the pipeline simple.
  let intrinsicW: number | undefined;
  let intrinsicH: number | undefined;
  if (
    node.type === "composition" ||
    node.type === "text" ||
    node.type === "graphic"
  ) {
    intrinsicW = resolveContentDim(node.contentWidth, parentW, parentW);
    intrinsicH = resolveContentDim(node.contentHeight, parentH, parentH);
  }

  // Step 3: post-objectFit natural size (the value of `size: "100%"`).
  const { naturalWidth, naturalHeight } = computeNaturalSize(
    fitForSelf,
    intrinsicW,
    intrinsicH,
    parentW,
    parentH,
  );

  // Step 4–7: resolve size / origin / translation → final SpatialRect.
  const spatial = input
    ? resolveBoxProps(input, parentW, parentH, naturalWidth, naturalHeight)
    : undefined;

  const stripIfStatic = <T extends { spatialInput?: SpatialInput }>(n: T): T => {
    if (animated) return n;
    const { spatialInput: _, ...rest } = n;
    return rest as T;
  };

  if (node.type === "composition") {
    const displayW = spatial ? spatial.width : naturalWidth;
    const displayH = spatial ? spatial.height : naturalHeight;
    // Inner-canvas dim — the inside of the composition's window. Used
    // both as the recursion's parent dims and as the child node's
    // intrinsic size when this composition is itself nested.
    const innerW = intrinsicW ?? displayW;
    const innerH = intrinsicH ?? displayH;
    return stripIfStatic({
      ...node,
      contentWidth: innerW,
      contentHeight: innerH,
      intrinsicWidth: intrinsicW,
      intrinsicHeight: intrinsicH,
      naturalWidth,
      naturalHeight,
      spatial,
      objectFit: fitForSelf,
      children: resolveChildren(node.children, innerW, innerH, ownObjectFit),
    });
  }

  if (node.type === "text" || node.type === "graphic") {
    const displayW = spatial ? spatial.width : naturalWidth;
    const displayH = spatial ? spatial.height : naturalHeight;
    return stripIfStatic({
      ...node,
      contentWidth: intrinsicW ?? displayW,
      contentHeight: intrinsicH ?? displayH,
      intrinsicWidth: intrinsicW,
      intrinsicHeight: intrinsicH,
      naturalWidth,
      naturalHeight,
      spatial,
      objectFit: fitForSelf,
    });
  }

  // clip / static: ALWAYS retain `spatialInput` so the renderer can
  // re-evaluate against the probed intrinsic media size. The resolver
  // doesn't know media dims, so its `spatial` and `naturalWidth/Height`
  // bake against parent dims as a stand-in — close enough for static
  // tooling but stale once the real media size is known. The renderer's
  // `dynamicSpatial` prefers `spatialInput` (re-eval) over `spatial`
  // (baked) for these nodes.
  return {
    ...node,
    intrinsicWidth: intrinsicW,
    intrinsicHeight: intrinsicH,
    naturalWidth,
    naturalHeight,
    spatial,
    objectFit: fitForSelf,
    ...(input ? { spatialInput: input } : {}),
  };
}

/** Resolve a Length contentWidth/Height. Pixel default = 0% (i.e. literal
 *  pixels). `parentDim` is the reference for percentages; `fallback` is
 *  returned when the value is absent. `errorContext` is included in the
 *  error when a root-level Length uses a percentage. */
function resolveContentDim(
  value: Length | undefined,
  parentDim: number,
  fallback: number,
  errorContext?: string,
): number {
  if (value == null) return fallback;
  if (errorContext && hasPercent(value)) {
    throw new Error(
      `${errorContext} cannot use a percentage — root composition has no parent to resolve against`,
    );
  }
  return resolveLength(value, parentDim, SIZE_DEFAULT_PCT);
}

/** Post-objectFit "100% size" reference: scale the intrinsic content to
 *  fit / cover / center within the parent box. Exported so renderers can
 *  reproduce the resolver's math once they've probed the real intrinsic
 *  dims (the core resolver itself does no I/O, so it falls back to the
 *  parent box when intrinsics are unknown). */
export function computeNaturalSize(
  objectFit: ObjectFit,
  intrinsicW: number | undefined,
  intrinsicH: number | undefined,
  parentW: number,
  parentH: number,
): { naturalWidth: number; naturalHeight: number } {
  // Without an intrinsic size we treat the natural box as the parent.
  // Renderers may override later when they probe media dims.
  if (intrinsicW == null || intrinsicH == null) {
    return { naturalWidth: parentW, naturalHeight: parentH };
  }
  let scale: number;
  switch (objectFit) {
    case "fit":
      scale = Math.min(parentW / intrinsicW, parentH / intrinsicH);
      break;
    case "cover":
      scale = Math.max(parentW / intrinsicW, parentH / intrinsicH);
      break;
    case "center":
      scale = 1;
      break;
  }
  return {
    naturalWidth: intrinsicW * scale,
    naturalHeight: intrinsicH * scale,
  };
}

/** Resolve `size` / `origin` / `translation` (at time `t`) into the final
 *  parent-space SpatialRect for a node. `natural*` is the post-objectFit
 *  "100% size" reference. Exported so the renderers can re-evaluate per
 *  frame against the same math. */
export function resolveBoxProps(
  input: SpatialInput,
  parentW: number,
  parentH: number,
  naturalW: number,
  naturalH: number,
  t: number = 0,
  duration: number = 0,
): SpatialRect {
  // size → content box. `origin`/`translation` place THIS box (decoupled from
  // any inset), so cropping never silently drifts the placement.
  const sizeXY = samplePoint(input.size, t, duration, naturalW, naturalH, SIZE_DEFAULT_PCT);
  const contentW = sizeXY?.x ?? naturalW;
  const contentH = sizeXY?.y ?? naturalH;

  // origin → point on the content box (defaults to 50% — center).
  const originXY = samplePoint(input.origin, t, duration, contentW, contentH, ORIGIN_DEFAULT_PCT);
  const originX = originXY?.x ?? contentW / 2;
  const originY = originXY?.y ?? contentH / 2;

  // translation → point in parent (default 50% — center).
  const transXY = samplePoint(
    input.translation,
    t,
    duration,
    parentW,
    parentH,
    TRANSLATION_DEFAULT_PCT,
  );
  const transX = transXY?.x ?? parentW / 2;
  const transY = transXY?.y ?? parentH / 2;

  // The content box placed in parent space ("full" rect, pre-inset).
  const fullX = transX - originX;
  const fullY = transY - originY;

  // inset (crop): clip the content box to a visible window. `sourceRect`
  // records which fraction of the content fills the output; `insetMode` decides
  // how that window maps within the full rect (default: stay put — "window").
  let outX = fullX;
  let outY = fullY;
  let outW = contentW;
  let outH = contentH;
  let sourceRect: SpatialRect["sourceRect"];
  if (input.inset != null && contentW > 0 && contentH > 0) {
    const edges = sampleInset(input.inset, t, duration, contentW, contentH);
    const l = Math.max(0, edges.left);
    const r = Math.max(0, edges.right);
    const tEdge = Math.max(0, edges.top);
    const b = Math.max(0, edges.bottom);
    const winW = Math.max(0, contentW - l - r);
    const winH = Math.max(0, contentH - tEdge - b);
    const u0 = clamp01(l / contentW);
    const v0 = clamp01(tEdge / contentH);
    const u1 = Math.max(u0, clamp01((contentW - r) / contentW));
    const v1 = Math.max(v0, clamp01((contentH - b) / contentH));
    sourceRect = { u0, v0, u1, v1 };

    const mode = input.insetMode ?? "window";
    if (mode === "cover") {
      // Cover: scale the window aspect-preserving to fill the whole content
      // box, cropping the overflow. We can't add a second clip region (it'd
      // need another sub-`.mlt`), so instead we tighten the *source* sub-rect
      // to a centered, box-aspect crop of the window — the part cover would
      // have shown — and output at the full box. Same visible result, reusing
      // the existing sourceRect + output-rect pipeline, no extra clip.
      const boxAspect = contentW / contentH;
      const winAspect = winW > 0 && winH > 0 ? winW / winH : boxAspect;
      let cropW = winW;
      let cropH = winH;
      let cropX = l;
      let cropY = tEdge;
      if (winAspect > boxAspect) {
        // Window too wide → crop its sides.
        cropW = winH * boxAspect;
        cropX = l + (winW - cropW) / 2;
      } else if (winAspect < boxAspect) {
        // Window too tall → crop top/bottom.
        cropH = winW / boxAspect;
        cropY = tEdge + (winH - cropH) / 2;
      }
      sourceRect = {
        u0: clamp01(cropX / contentW),
        v0: clamp01(cropY / contentH),
        u1: Math.max(clamp01(cropX / contentW), clamp01((cropX + cropW) / contentW)),
        v1: Math.max(clamp01(cropY / contentH), clamp01((cropY + cropH) / contentH)),
      };
      outX = fullX;
      outY = fullY;
      outW = contentW;
      outH = contentH;
    } else if (mode === "fit") {
      // Scale the window (aspect-preserving) to fit the content box, centred.
      const k = winW > 0 && winH > 0 ? Math.min(contentW / winW, contentH / winH) : 1;
      outW = winW * k;
      outH = winH * k;
      outX = fullX + (contentW - outW) / 2;
      outY = fullY + (contentH - outH) / 2;
    } else if (mode === "center") {
      // Window at its own size, centred within the content box.
      outW = winW;
      outH = winH;
      outX = fullX + (contentW - winW) / 2;
      outY = fullY + (contentH - winH) / 2;
    } else {
      // "window" (default): just a clip — the window stays where it sits.
      outW = winW;
      outH = winH;
      outX = fullX + l;
      outY = fullY + tEdge;
    }
  }

  const rect: SpatialRect = { x: outX, y: outY, width: outW, height: outH };
  if (sourceRect) rect.sourceRect = sourceRect;

  // Rotation pivots about the authored `origin` — i.e. the `translation` point
  // in parent space, regardless of how `insetMode` moved/scaled the window.
  // Carry it only when authored (non-rotated rects stay plain `{x,y,w,h}`).
  if (input.rotation != null) {
    rect.rotation = sampleNumber(input.rotation, t, duration);
    rect.originX = transX - outX;
    rect.originY = transY - outY;
  }

  return rect;
}

function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

interface XY {
  x: number;
  y: number;
}

/** Sample a Point2D (object or scalar shorthand). Returns null when the
 *  field is absent so callers can apply their own default. */
function samplePoint(
  value: Keyframed<Point2D> | undefined,
  t: number,
  duration: number,
  refX: number,
  refY: number,
  percentDefault: number,
): XY | null {
  if (value == null) return null;

  // Keyframed Point2D: each keyframe value is itself a Point2D (scalar
  // or {x,y}). We expand each side per-frame so axes interpolate
  // independently and a scalar `"50%"` doesn't mean "the same pixel
  // value on both axes" when refX !== refY.
  if (isKeyframed(value)) {
    const xVal = sampleAxis(value, t, duration, refX, percentDefault, "x");
    const yVal = sampleAxis(value, t, duration, refY, percentDefault, "y");
    return { x: xVal, y: yVal };
  }

  // Static — scalar or object form.
  if (typeof value === "number" || typeof value === "string") {
    return {
      x: resolveLength(value, refX, percentDefault),
      y: resolveLength(value, refY, percentDefault),
    };
  }
  return {
    x: value.x != null ? resolveLength(value.x, refX, percentDefault) : refX * (percentDefault / 100),
    y: value.y != null ? resolveLength(value.y, refY, percentDefault) : refY * (percentDefault / 100),
  };
}

/** Project a Keyframed<Point2D> onto a single axis and sample at `t`. */
function sampleAxis(
  kf: Exclude<Keyframed<Point2D>, Point2D>,
  t: number,
  duration: number,
  ref: number,
  percentDefault: number,
  axis: "x" | "y",
): number {
  const projected = kf.map((entry) => {
    const v = entry[1];
    const length: Length =
      typeof v === "number" || typeof v === "string" ? v : (v[axis] ?? `${percentDefault}%`);
    return entry.length === 3
      ? ([entry[0], length, entry[2]] as [typeof entry[0], Length, string])
      : ([entry[0], length] as [typeof entry[0], Length]);
  });
  return sampleLength(projected, t, duration, ref, percentDefault);
}

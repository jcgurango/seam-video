import type { ResolvedTimeline, ResolvedChild, SpatialRect, SpatialInput, SpatialAnchor, ObjectFit, Position } from "../resolved-types.js";
import { sampleDimension, isKeyframed } from "../animation/keyframes.js";

const SPATIAL_DIM_KEYS = ["top", "left", "right", "bottom", "width", "height"] as const;
type SpatialDimKey = typeof SPATIAL_DIM_KEYS[number];

export function hasAnimatedSpatialInput(input: SpatialInput | undefined): boolean {
  if (!input) return false;
  return SPATIAL_DIM_KEYS.some((k) => isKeyframed(input[k] as never));
}

export function resolveSpatial(
  timeline: ResolvedTimeline,
  canvasWidth: number,
  canvasHeight: number
): ResolvedTimeline {
  const rootObjectFit = timeline.objectFit ?? "fit";
  const innerW = timeline.contentWidth ?? canvasWidth;
  const innerH = timeline.contentHeight ?? canvasHeight;
  return {
    ...timeline,
    width: canvasWidth,
    height: canvasHeight,
    children: resolveChildren(timeline.children, innerW, innerH, rootObjectFit),
  };
}

function resolveChildren(
  children: ResolvedChild[],
  parentW: number,
  parentH: number,
  parentObjectFit: ObjectFit
): ResolvedChild[] {
  return children.map((child) => resolveNode(child, parentW, parentH, parentObjectFit));
}

function resolveNode(
  node: ResolvedChild,
  parentW: number,
  parentH: number,
  parentObjectFit: ObjectFit
): ResolvedChild {
  // Empty, audio, and data have no spatial state — pass through.
  if (
    node.type === "empty" ||
    node.type === "audio" ||
    node.type === "data"
  ) {
    return node;
  }

  const input = node.spatialInput;

  // Determine this node's own objectFit policy for its children
  const ownObjectFit: ObjectFit = input?.objectFit ?? "fit";

  if (!input) {
    // No spatial props — still propagate objectFit
    if (node.type === "composition") {
      const intrinsicW = node.contentWidth ?? parentW;
      const intrinsicH = node.contentHeight ?? parentH;
      const hasCustomIntrinsic = intrinsicW !== parentW || intrinsicH !== parentH;
      const spatial = hasCustomIntrinsic
        ? computeObjectFitRect(parentObjectFit, intrinsicW, intrinsicH, parentW, parentH)
        : undefined;
      return {
        ...node,
        objectFit: parentObjectFit,
        spatial,
        children: resolveChildren(node.children, intrinsicW, intrinsicH, ownObjectFit),
      };
    }
    if (node.type === "text") {
      // Mirror composition for sizing but no children to recurse into.
      const intrinsicW = node.contentWidth ?? parentW;
      const intrinsicH = node.contentHeight ?? parentH;
      const hasCustomIntrinsic = intrinsicW !== parentW || intrinsicH !== parentH;
      const spatial = hasCustomIntrinsic
        ? computeObjectFitRect(parentObjectFit, intrinsicW, intrinsicH, parentW, parentH)
        : undefined;
      return {
        ...node,
        contentWidth: intrinsicW,
        contentHeight: intrinsicH,
        objectFit: parentObjectFit,
        spatial,
      };
    }
    // Clip: receives parent's objectFit for its own sizing
    return { ...node, objectFit: parentObjectFit };
  }

  // Resolve explicit box props to pixel rect + anchor. For animated spatial,
  // this is the t=0 fallback; the renderer re-resolves per frame.
  const { spatial, anchor } = resolveBoxProps(input, parentW, parentH);
  const position: Position = input.position ?? "relative";
  // Strip spatialInput from the resolved tree when nothing's animated —
  // baked `spatial`/`anchor` are sufficient. Animated nodes keep the input
  // so the renderer can sample it per frame.
  const animated = hasAnimatedSpatialInput(input);
  const stripIfStatic = <T extends { spatialInput?: SpatialInput }>(n: T): T => {
    if (animated) return n;
    const { spatialInput: _, ...rest } = n;
    return rest as T;
  };

  if (node.type === "clip") {
    // When both dimensions are explicitly set, the clip is overconstrained — stretch
    const widthExplicit = input.width != null || (input.left != null && input.right != null);
    const heightExplicit = input.height != null || (input.top != null && input.bottom != null);
    const overconstrained = widthExplicit && heightExplicit;
    return stripIfStatic({ ...node, spatial, anchor, position, objectFit: overconstrained ? undefined : parentObjectFit });
  }

  if (node.type === "text") {
    const displayW = spatial ? spatial.width : parentW;
    const displayH = spatial ? spatial.height : parentH;
    const innerW = node.contentWidth ?? displayW;
    const innerH = node.contentHeight ?? displayH;
    return stripIfStatic({
      ...node,
      contentWidth: innerW,
      contentHeight: innerH,
      spatial,
      anchor,
      position,
      objectFit: parentObjectFit,
    });
  }

  // Composition: display size from spatial or parent, inner from contentWidth/contentHeight
  const displayW = spatial ? spatial.width : parentW;
  const displayH = spatial ? spatial.height : parentH;
  const innerW = node.contentWidth ?? displayW;
  const innerH = node.contentHeight ?? displayH;
  return stripIfStatic({
    ...node,
    spatial,
    anchor,
    position,
    objectFit: parentObjectFit,
    children: resolveChildren(node.children, innerW, innerH, ownObjectFit),
  });
}

function computeObjectFitRect(
  objectFit: ObjectFit,
  intrinsicW: number,
  intrinsicH: number,
  parentW: number,
  parentH: number
): SpatialRect {
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
  const w = intrinsicW * scale;
  const h = intrinsicH * scale;
  return {
    x: (parentW - w) / 2,
    y: (parentH - h) / 2,
    width: w,
    height: h,
  };
}

/** Resolve spatial input to a concrete rect at a given local time `t` (in
 *  seconds, relative to the node's start; defaults to 0 for the static
 *  resolve pass). `duration` lets percent-time keyframe expressions resolve
 *  against the node's lifetime. */
export function resolveBoxProps(
  input: SpatialInput,
  parentW: number,
  parentH: number,
  t: number = 0,
  duration: number = 0
): { spatial: SpatialRect | undefined; anchor: SpatialAnchor | undefined } {
  const hasX = input.left != null || input.right != null || input.width != null;
  const hasY = input.top != null || input.bottom != null || input.height != null;

  if (!hasX && !hasY) return { spatial: undefined, anchor: undefined };

  const left = input.left != null ? sampleDimension(input.left, t, duration, parentW) : undefined;
  const right = input.right != null ? sampleDimension(input.right, t, duration, parentW) : undefined;
  const width = input.width != null ? sampleDimension(input.width, t, duration, parentW) : undefined;
  const top = input.top != null ? sampleDimension(input.top, t, duration, parentH) : undefined;
  const bottom = input.bottom != null ? sampleDimension(input.bottom, t, duration, parentH) : undefined;
  const height = input.height != null ? sampleDimension(input.height, t, duration, parentH) : undefined;

  const anchor: SpatialAnchor = {
    ...(left != null ? { left } : {}),
    ...(right != null ? { right } : {}),
    ...(top != null ? { top } : {}),
    ...(bottom != null ? { bottom } : {}),
  };

  return {
    spatial: {
      x: resolveAxis(left, right, width, parentW),
      y: resolveAxis(top, bottom, height, parentH),
      width: resolveSize(left, right, width, parentW),
      height: resolveSize(top, bottom, height, parentH),
    },
    anchor: Object.keys(anchor).length > 0 ? anchor : undefined,
  };
}

function resolveAxis(
  start: number | undefined,
  end: number | undefined,
  size: number | undefined,
  parentSize: number
): number {
  if (start != null) return start;
  if (end != null && size != null) return parentSize - end - size;
  if (end != null) return parentSize - end - parentSize; // fallback: full parent
  if (size != null) return (parentSize - size) / 2; // center when only size is given
  return 0;
}

function resolveSize(
  start: number | undefined,
  end: number | undefined,
  size: number | undefined,
  parentSize: number
): number {
  if (size != null) return size;
  if (start != null && end != null) return parentSize - start - end;
  return parentSize;
}

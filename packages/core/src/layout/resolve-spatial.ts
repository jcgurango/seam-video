import type { ResolvedTimeline, ResolvedChild, SpatialRect, SpatialInput, SpatialAnchor, ObjectFit, Position } from "../resolved-types.js";
import { resolveDimension } from "./units.js";

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
  if (node.type === "empty") return node;

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
    // Clip: receives parent's objectFit for its own sizing
    return { ...node, objectFit: parentObjectFit };
  }

  // Resolve explicit box props to pixel rect + anchor
  const { spatial, anchor } = resolveBoxProps(input, parentW, parentH);
  const position: Position = input.position ?? "relative";

  if (node.type === "clip") {
    const { spatialInput: _, ...rest } = node;
    // When both dimensions are explicitly set, the clip is overconstrained — stretch
    const widthExplicit = input.width != null || (input.left != null && input.right != null);
    const heightExplicit = input.height != null || (input.top != null && input.bottom != null);
    const overconstrained = widthExplicit && heightExplicit;
    return { ...rest, spatial, anchor, position, objectFit: overconstrained ? undefined : parentObjectFit };
  }

  // Container nodes: display size from spatial or parent, inner from contentWidth/contentHeight
  const displayW = spatial ? spatial.width : parentW;
  const displayH = spatial ? spatial.height : parentH;
  const innerW = node.contentWidth ?? displayW;
  const innerH = node.contentHeight ?? displayH;
  const { spatialInput: _, ...rest } = node;
  return {
    ...rest,
    spatial,
    anchor,
    position,
    objectFit: parentObjectFit,
    children: resolveChildren(node.children, innerW, innerH, ownObjectFit),
  };
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

function resolveBoxProps(
  input: SpatialInput,
  parentW: number,
  parentH: number
): { spatial: SpatialRect | undefined; anchor: SpatialAnchor | undefined } {
  const hasX = input.left != null || input.right != null || input.width != null;
  const hasY = input.top != null || input.bottom != null || input.height != null;

  if (!hasX && !hasY) return { spatial: undefined, anchor: undefined };

  const left = input.left != null ? resolveDimension(input.left, parentW) : undefined;
  const right = input.right != null ? resolveDimension(input.right, parentW) : undefined;
  const width = input.width != null ? resolveDimension(input.width, parentW) : undefined;
  const top = input.top != null ? resolveDimension(input.top, parentH) : undefined;
  const bottom = input.bottom != null ? resolveDimension(input.bottom, parentH) : undefined;
  const height = input.height != null ? resolveDimension(input.height, parentH) : undefined;

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

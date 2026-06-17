// The keyframe glyph drawn on a lane. A plain rhombus for linear easing;
// its left edges (the segment arriving at this keyframe) and right edges
// (the segment leaving toward the next keyframe) bow to reflect the easing
// curve — concave for a slow start (ease-in), convex for a fast start
// (ease-out). So the diamond's shape reads the easing at a glance.

import React from "react";
import { resolveEasing } from "@seam/core";

/** How far the easing's midpoint deviates from linear, in [-0.5, 0.5].
 *  Negative = slow start (ease-in), positive = fast start (ease-out). */
function easingDeviation(easing: string | undefined): number {
  if (!easing || easing === "linear") return 0;
  try {
    return Math.max(-0.5, Math.min(0.5, resolveEasing(easing)(0.5) - 0.5));
  } catch {
    return 0;
  }
}

/** Build the diamond outline. Vertices: top, right, bottom, left of an
 *  `2r`×`2r` box centred at (r, r). Each edge bows outward (convex) or
 *  inward (concave) by `bow` px along the edge's outward normal. */
function diamondPath(r: number, incomingBow: number, outgoingBow: number): string {
  const c = r; // centre
  const top = { x: c, y: c - r };
  const right = { x: c + r, y: c };
  const bottom = { x: c, y: c + r };
  const left = { x: c - r, y: c };

  // Quadratic control point for an edge P0→P1 bowed by `b` along the
  // outward normal (direction from the centre through the edge midpoint).
  const ctrl = (p0: { x: number; y: number }, p1: { x: number; y: number }, b: number) => {
    const mx = (p0.x + p1.x) / 2;
    const my = (p0.y + p1.y) / 2;
    const dx = mx - c;
    const dy = my - c;
    const len = Math.hypot(dx, dy) || 1;
    return `${mx + (dx / len) * b} ${my + (dy / len) * b}`;
  };

  // Right side = outgoing easing; left side = incoming easing.
  return [
    `M ${top.x} ${top.y}`,
    `Q ${ctrl(top, right, outgoingBow)} ${right.x} ${right.y}`,
    `Q ${ctrl(right, bottom, outgoingBow)} ${bottom.x} ${bottom.y}`,
    `Q ${ctrl(bottom, left, incomingBow)} ${left.x} ${left.y}`,
    `Q ${ctrl(left, top, incomingBow)} ${top.x} ${top.y}`,
    "Z",
  ].join(" ");
}

export const KEYFRAME_DIAMOND_SIZE = 12;

export default function KeyframeDiamond({
  incomingEasing,
  outgoingEasing,
  selected,
  onPointerDown,
  onClick,
  onDoubleClick,
}: {
  /** Easing arriving at this keyframe (its own `kf[2]`). */
  incomingEasing: string;
  /** Easing of the next keyframe (the segment leaving this one). */
  outgoingEasing?: string;
  selected?: boolean;
  onPointerDown?: (e: React.PointerEvent) => void;
  onClick?: (e: React.MouseEvent) => void;
  onDoubleClick?: (e: React.MouseEvent) => void;
}) {
  const r = KEYFRAME_DIAMOND_SIZE / 2;
  const bowScale = r * 0.85;
  const path = diamondPath(
    r,
    easingDeviation(incomingEasing) * bowScale,
    easingDeviation(outgoingEasing) * bowScale,
  );
  return (
    <svg
      width={KEYFRAME_DIAMOND_SIZE}
      height={KEYFRAME_DIAMOND_SIZE}
      viewBox={`0 0 ${KEYFRAME_DIAMOND_SIZE} ${KEYFRAME_DIAMOND_SIZE}`}
      onPointerDown={onPointerDown}
      onClick={onClick}
      onDoubleClick={onDoubleClick}
      style={{
        display: "block",
        cursor: onPointerDown ? "ew-resize" : onClick ? "pointer" : "default",
        overflow: "visible",
      }}
    >
      <path
        d={path}
        fill={selected ? "#ffcc00" : "#e6d24a"}
        stroke={selected ? "#fff" : "#7a6a12"}
        strokeWidth={1}
      />
    </svg>
  );
}

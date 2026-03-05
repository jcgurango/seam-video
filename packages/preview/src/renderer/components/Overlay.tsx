import React from "react";
import type { ResolvedOverlay } from "@seam/core";
import { useTimeline, TimelineContext } from "./TimelineContext.js";
import NodeRenderer from "./NodeRenderer.js";

interface OverlayProps {
  overlay: ResolvedOverlay;
}

export default function Overlay({ overlay }: OverlayProps) {
  const parent = useTimeline();
  const { currentTime } = parent;

  const preloadStart = overlay.timelineStart - 0.1;
  const isInDOM =
    currentTime >= preloadStart && currentTime < overlay.timelineEnd;
  const isActive =
    currentTime >= overlay.timelineStart &&
    currentTime < overlay.timelineEnd;

  if (!isInDOM) return null;

  const localTime = isActive
    ? Math.min(
        (currentTime - overlay.timelineStart) * overlay.speed,
        overlay.duration
      )
    : 0;

  const localContext = {
    ...parent,
    currentTime: localTime,
    totalDuration: overlay.duration,
  };

  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        opacity: isActive ? 1 : 0,
      }}
    >
      <TimelineContext.Provider value={localContext}>
        {overlay.children.map((child, i) => (
          <NodeRenderer key={i} node={child} />
        ))}
      </TimelineContext.Provider>
    </div>
  );
}

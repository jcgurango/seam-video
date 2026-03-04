import React from "react";
import type { ResolvedComposition } from "@seam/core";
import { useTimeline, TimelineContext } from "./TimelineContext.js";
import NodeRenderer from "./NodeRenderer.js";

interface CompositionProps {
  composition: ResolvedComposition;
}

export default function Composition({ composition }: CompositionProps) {
  const parent = useTimeline();
  const { currentTime } = parent;

  const preloadStart = composition.timelineStart - 0.1;
  const isInDOM =
    currentTime >= preloadStart && currentTime < composition.timelineEnd;
  const isActive =
    currentTime >= composition.timelineStart &&
    currentTime < composition.timelineEnd;

  if (!isInDOM) return null;

  const localTime = isActive
    ? Math.min(
        (currentTime - composition.timelineStart) * composition.speed,
        composition.duration
      )
    : 0;

  const localContext = {
    ...parent,
    currentTime: localTime,
    totalDuration: composition.duration,
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
        {composition.children.map((child, i) => (
          <NodeRenderer key={i} node={child} />
        ))}
      </TimelineContext.Provider>
    </div>
  );
}

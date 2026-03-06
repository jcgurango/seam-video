import React from "react";
import type { ResolvedComposition } from "@seam/core";
import { useTimeline, TimelineContext } from "./TimelineContext.js";
import NodeRenderer from "./NodeRenderer.js";
import { shouldBeInDOM } from "./preload.js";

interface CompositionProps {
  composition: ResolvedComposition;
}

export default function Composition({ composition }: CompositionProps) {
  const parent = useTimeline();
  const { currentTime } = parent;

  const isInDOM = shouldBeInDOM(currentTime, composition.timelineStart, composition.timelineEnd);
  const isActive =
    currentTime >= composition.timelineStart &&
    currentTime < composition.timelineEnd;

  if (!isInDOM) return null;

  const localTime = Math.min(
    (currentTime - composition.timelineStart) * composition.speed,
    composition.duration
  );

  const s = composition.spatial;
  const displayW = s ? s.width : parent.canvasWidth;
  const displayH = s ? s.height : parent.canvasHeight;
  const innerW = composition.contentWidth ?? displayW;
  const innerH = composition.contentHeight ?? displayH;

  const localContext = {
    ...parent,
    currentTime: localTime,
    totalDuration: composition.duration,
    canvasWidth: innerW,
    canvasHeight: innerH,
  };

  const style: React.CSSProperties = s
    ? {
        position: "absolute",
        left: s.x,
        top: s.y,
        width: s.width,
        height: s.height,
        overflow: "hidden",
        opacity: isActive ? 1 : 0,
      }
    : {
        position: "absolute",
        inset: 0,
        opacity: isActive ? 1 : 0,
      };

  const needsInnerScale = innerW !== displayW || innerH !== displayH;

  return (
    <div style={style}>
      <TimelineContext.Provider value={localContext}>
        {needsInnerScale ? (
          <div
            style={{
              width: innerW,
              height: innerH,
              transform: `scale(${displayW / innerW}, ${displayH / innerH})`,
              transformOrigin: "0 0",
              position: "relative",
            }}
          >
            {composition.children.map((child, i) => (
              <NodeRenderer key={i} node={child} />
            ))}
          </div>
        ) : (
          composition.children.map((child, i) => (
            <NodeRenderer key={i} node={child} />
          ))
        )}
      </TimelineContext.Provider>
    </div>
  );
}

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

  const isActive =
    currentTime >= overlay.timelineStart &&
    currentTime < overlay.timelineEnd;

  if (!isActive) return null;

  const localTime = Math.min(
    (currentTime - overlay.timelineStart) * overlay.speed,
    overlay.duration
  );

  const s = overlay.spatial;
  const displayW = s ? s.width : parent.canvasWidth;
  const displayH = s ? s.height : parent.canvasHeight;
  const innerW = overlay.contentWidth ?? displayW;
  const innerH = overlay.contentHeight ?? displayH;

  const localContext = {
    ...parent,
    currentTime: localTime,
    totalDuration: overlay.duration,
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
      }
    : {
        position: "absolute",
        inset: 0,
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
            {overlay.children.map((child, i) => (
              <NodeRenderer key={i} node={child} />
            ))}
          </div>
        ) : (
          overlay.children.map((child, i) => (
            <NodeRenderer key={i} node={child} />
          ))
        )}
      </TimelineContext.Provider>
    </div>
  );
}

import React from "react";
import type { ResolvedTimeline } from "@seam/core";
import Timeline from "./Timeline.js";
import VideoCanvas from "./VideoCanvas.js";
import TransportControls from "./TransportControls.js";

interface PlayerProps {
  timeline: ResolvedTimeline;
  basePath: string;
  width?: number;
  height?: number;
}

export default function Player({ timeline, basePath, width, height }: PlayerProps) {
  return (
    <Timeline timeline={timeline} basePath={basePath}>
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          height: "100%",
          background: "#1a1a1a",
          color: "#fff",
          fontFamily: "sans-serif",
          minHeight: 0,
        }}
      >
        <VideoCanvas width={timeline.contentWidth ?? width} height={timeline.contentHeight ?? height} />
        <TransportControls />
      </div>
    </Timeline>
  );
}

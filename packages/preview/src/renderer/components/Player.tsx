import React from "react";
import type { ResolvedTimeline } from "@seam/core";
import Timeline from "./Timeline.js";
import TransportControls from "./TransportControls.js";

interface PlayerProps {
  timeline: ResolvedTimeline;
  basePath: string;
  width?: number;
  height?: number;
}

export default function Player({ timeline, basePath, width, height }: PlayerProps) {
  return (
    <Timeline timeline={timeline} basePath={basePath} width={width} height={height}>
      <TransportControls />
    </Timeline>
  );
}

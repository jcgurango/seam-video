import React from "react";
import type { ResolvedTimeline } from "@seam/core";
import Timeline from "./Timeline.js";
import TransportControls from "./TransportControls.js";

interface PlayerProps {
  timeline: ResolvedTimeline;
  basePath: string;
}

export default function Player({ timeline, basePath }: PlayerProps) {
  return (
    <Timeline timeline={timeline} basePath={basePath}>
      <TransportControls />
    </Timeline>
  );
}

import React, { useState, useRef, useCallback, useEffect } from "react";
import type { ResolvedTimeline } from "@seam/core";
import { TimelineContext } from "./TimelineContext.js";
import NodeRenderer from "./NodeRenderer.js";

interface TimelineProps {
  timeline: ResolvedTimeline;
  basePath: string;
  children?: React.ReactNode;
}

export default function Timeline({
  timeline,
  basePath,
  children,
}: TimelineProps) {
  const [currentTime, setCurrentTime] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const rafRef = useRef<number>(0);
  const prevFrameRef = useRef<number>(0);

  // Reset when timeline changes
  const prevTimelineRef = useRef(timeline);
  useEffect(() => {
    if (prevTimelineRef.current !== timeline) {
      prevTimelineRef.current = timeline;
      setCurrentTime(0);
      setIsPlaying(false);
    }
  }, [timeline]);

  // rAF loop
  useEffect(() => {
    if (!isPlaying) {
      prevFrameRef.current = 0;
      return;
    }

    const tick = (timestamp: number) => {
      if (prevFrameRef.current === 0) {
        prevFrameRef.current = timestamp;
      }
      const delta = (timestamp - prevFrameRef.current) / 1000;
      prevFrameRef.current = timestamp;

      setCurrentTime((prev) => {
        const next = prev + delta;
        if (next >= timeline.duration) {
          setIsPlaying(false);
          return timeline.duration;
        }
        return next;
      });

      rafRef.current = requestAnimationFrame(tick);
    };

    rafRef.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafRef.current);
  }, [isPlaying, timeline.duration]);

  const play = useCallback(() => {
    setCurrentTime((prev) => (prev >= timeline.duration ? 0 : prev));
    setIsPlaying(true);
  }, [timeline.duration]);
  const pause = useCallback(() => setIsPlaying(false), []);
  const restart = useCallback(() => {
    setCurrentTime(0);
    setIsPlaying(true);
  }, []);
  const seek = useCallback((time: number) => {
    setCurrentTime(time);
  }, []);

  const ctx = {
    currentTime,
    totalDuration: timeline.duration,
    isPlaying,
    basePath,
    play,
    pause,
    restart,
    seek,
  };

  return (
    <TimelineContext.Provider value={ctx}>
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          height: "100vh",
          background: "#1a1a1a",
          color: "#fff",
          fontFamily: "sans-serif",
        }}
      >
        {/* Video area */}
        <div
          style={{
            flex: 1,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            overflow: "hidden",
          }}
        >
          <div
            style={{
              position: "relative",
              aspectRatio: "16 / 9",
              maxWidth: "100%",
              maxHeight: "100%",
              width: "100%",
              background: "#000",
              overflow: "hidden",
            }}
          >
            {timeline.children.map((child, i) => (
              <NodeRenderer key={i} node={child} />
            ))}
          </div>
        </div>

        {/* Transport controls slot */}
        {children}
      </div>
    </TimelineContext.Provider>
  );
}

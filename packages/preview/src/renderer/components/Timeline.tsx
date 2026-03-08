import React, { useState, useRef, useCallback, useEffect } from "react";
import type { ResolvedTimeline } from "@seam/core";
import { TimelineContext } from "./TimelineContext.js";
import NodeRenderer from "./NodeRenderer.js";
import { MediaStore } from "../media/MediaStore.js";
import { AudioScheduler } from "../media/AudioScheduler.js";
import { FrameCoordinator } from "../media/FrameCoordinator.js";

interface TimelineProps {
  timeline: ResolvedTimeline;
  basePath: string;
  width?: number;
  height?: number;
  children?: React.ReactNode;
}

export default function Timeline({
  timeline,
  basePath,
  width = 1920,
  height = 1080,
  children,
}: TimelineProps) {
  const [currentTime, setCurrentTime] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [loop, setLoop] = useState(false);
  const [containerWidth, setContainerWidth] = useState(0);
  const [, setFrameTick] = useState(0);
  const rafRef = useRef<number>(0);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const outerRef = useRef<HTMLDivElement>(null);

  // Persistent instances
  const mediaStoreRef = useRef<MediaStore | null>(null);
  const audioSchedulerRef = useRef<AudioScheduler | null>(null);
  const coordinatorRef = useRef<FrameCoordinator | null>(null);

  if (!mediaStoreRef.current) mediaStoreRef.current = new MediaStore();
  if (!audioSchedulerRef.current) audioSchedulerRef.current = new AudioScheduler();
  if (!coordinatorRef.current) coordinatorRef.current = new FrameCoordinator();

  const mediaStore = mediaStoreRef.current;
  const audioScheduler = audioSchedulerRef.current;
  const coordinator = coordinatorRef.current;

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      coordinatorRef.current?.dispose();
      audioSchedulerRef.current?.dispose();
      mediaStoreRef.current?.dispose();
    };
  }, []);

  // Wire up frame-available callback for re-renders on async seek
  useEffect(() => {
    coordinator.onFrameAvailable = () => setFrameTick((n) => n + 1);
    return () => { coordinator.onFrameAvailable = null; };
  }, [coordinator]);

  // Initialize coordinator when timeline changes
  useEffect(() => {
    setCurrentTime(0);
    setIsPlaying(false);
    audioScheduler.pause();
    void coordinator.setTimeline(timeline, basePath, mediaStore, audioScheduler);
  }, [timeline, basePath, mediaStore, audioScheduler, coordinator]);

  // Refs for rAF access to latest state
  const loopRef = useRef(loop);
  loopRef.current = loop;
  const durationRef = useRef(timeline.duration);
  durationRef.current = timeline.duration;

  // Playback loop — rAF for smooth rendering, setInterval as fallback when window is hidden
  useEffect(() => {
    if (!isPlaying) return;

    const tick = () => {
      const duration = durationRef.current;
      let t = audioScheduler.currentTime;

      if (t >= duration) {
        if (loopRef.current) {
          const wrapped = t % duration;
          audioScheduler.seekAll(wrapped);
          coordinator.onPlay(wrapped);
          t = wrapped;
        } else {
          setCurrentTime(duration);
          setIsPlaying(false);
          audioScheduler.pause();
          return;
        }
      }

      coordinator.tick(t, true, duration, loopRef.current);
      setCurrentTime(t);

      rafRef.current = requestAnimationFrame(tick);
    };

    intervalRef.current = setInterval(() => tick(), 16);

    return () => {
      cancelAnimationFrame(rafRef.current);
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [isPlaying, audioScheduler, coordinator]);

  // ResizeObserver for scaling
  useEffect(() => {
    const el = outerRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        setContainerWidth(entry.contentRect.width);
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const scale = containerWidth > 0 ? containerWidth / width : 1;

  const play = useCallback(() => {
    setCurrentTime((prev) => {
      const startTime = prev >= timeline.duration ? 0 : prev;
      coordinator.onPlay(startTime);
      void audioScheduler.play(startTime);
      setIsPlaying(true);
      return startTime;
    });
  }, [timeline.duration, audioScheduler, coordinator]);

  const pause = useCallback(() => {
    audioScheduler.pause();
    const t = audioScheduler.currentTime;
    setCurrentTime(t);
    setIsPlaying(false);
  }, [audioScheduler]);

  const restart = useCallback(() => {
    setCurrentTime(0);
    coordinator.onPlay(0);
    void audioScheduler.play(0);
    setIsPlaying(true);
  }, [audioScheduler, coordinator]);

  const seek = useCallback(
    (time: number) => {
      setCurrentTime(time);
      coordinator.onSeek(time, timeline.duration, loopRef.current);
      audioScheduler.seekAll(time);
    },
    [audioScheduler, coordinator, timeline.duration]
  );

  const getFrame = useCallback(
    (clip: Parameters<typeof coordinator.getFrame>[0]) => coordinator.getFrame(clip),
    [coordinator]
  );
  const getIntrinsicSize = useCallback(
    (clip: Parameters<typeof coordinator.getIntrinsicSize>[0]) => coordinator.getIntrinsicSize(clip),
    [coordinator]
  );

  const ctx = {
    currentTime,
    totalDuration: timeline.duration,
    isPlaying,
    loop,
    basePath,
    canvasWidth: width,
    canvasHeight: height,
    getFrame,
    getIntrinsicSize,
    play,
    pause,
    restart,
    seek,
    setLoop,
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
            ref={outerRef}
            style={{
              position: "relative",
              aspectRatio: `${width} / ${height}`,
              maxWidth: "100%",
              maxHeight: "100%",
              width: "100%",
              background: "#000",
              overflow: "hidden",
            }}
          >
            <div
              style={{
                width: `${width}px`,
                height: `${height}px`,
                transform: `scale(${scale})`,
                transformOrigin: "0 0",
                position: "relative",
              }}
            >
              {timeline.children.map((child, i) => (
                <NodeRenderer key={i} node={child} />
              ))}
            </div>
          </div>
        </div>

        {/* Transport controls slot */}
        {children}
      </div>
    </TimelineContext.Provider>
  );
}

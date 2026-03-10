import React, { useState, useRef, useCallback, useEffect } from "react";
import type { ResolvedTimeline } from "@seam/core";
import { TimelineContext } from "./TimelineContext.js";
import { MediaStore } from "../media/MediaStore.js";
import { AudioScheduler } from "../media/AudioScheduler.js";
import { FrameCoordinator } from "../media/FrameCoordinator.js";
import { WebGPURenderer } from "../media/gpu/WebGPURenderer.js";
import { buildRenderList } from "../media/gpu/RenderList.js";

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
  const rafRef = useRef<number>(0);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  // Persistent instances
  const mediaStoreRef = useRef<MediaStore | null>(null);
  const audioSchedulerRef = useRef<AudioScheduler | null>(null);
  const coordinatorRef = useRef<FrameCoordinator | null>(null);
  const rendererRef = useRef<WebGPURenderer | null>(null);

  if (!mediaStoreRef.current) mediaStoreRef.current = new MediaStore();
  if (!audioSchedulerRef.current)
    audioSchedulerRef.current = new AudioScheduler();
  if (!coordinatorRef.current)
    coordinatorRef.current = new FrameCoordinator();
  if (!rendererRef.current) rendererRef.current = new WebGPURenderer();

  const mediaStore = mediaStoreRef.current;
  const audioScheduler = audioSchedulerRef.current;
  const coordinator = coordinatorRef.current;
  const renderer = rendererRef.current;

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      coordinatorRef.current?.dispose();
      audioSchedulerRef.current?.dispose();
      mediaStoreRef.current?.dispose();
      rendererRef.current?.dispose();
    };
  }, []);

  // Initialize WebGPU when canvas mounts
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || renderer.ready) return;

    void renderer.init(canvas).catch((err) => {
      console.error("WebGPU init failed:", err);
    });
  }, [renderer]);

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
  const timelineRef = useRef(timeline);
  timelineRef.current = timeline;

  // GPU render function (called imperatively, not dependent on React)
  const gpuRender = useCallback(
    (time: number) => {
      if (!renderer.ready) return;
      renderer.resize(width, height);

      const commands = buildRenderList(
        timelineRef.current,
        time,
        width,
        height,
        (clip) => coordinator.getIntrinsicSize(clip),
      );

      renderer.render(commands, (clip) => coordinator.getFrame(clip));
    },
    [renderer, coordinator, width, height],
  );

  // Wire up frame-available callback for re-renders on async seek
  const currentTimeRef = useRef(currentTime);
  currentTimeRef.current = currentTime;

  useEffect(() => {
    coordinator.onFrameAvailable = () => {
      gpuRender(currentTimeRef.current);
    };
    return () => {
      coordinator.onFrameAvailable = null;
    };
  }, [coordinator, gpuRender]);

  // Playback loop — rAF only (no setInterval to avoid tick accumulation)
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
      gpuRender(t);
      setCurrentTime(t);

      rafRef.current = requestAnimationFrame(tick);
    };

    rafRef.current = requestAnimationFrame(tick);

    return () => {
      cancelAnimationFrame(rafRef.current);
    };
  }, [isPlaying, audioScheduler, coordinator, gpuRender]);

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
    gpuRender(t);
  }, [audioScheduler, gpuRender]);

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
      gpuRender(time);
    },
    [audioScheduler, coordinator, timeline.duration, gpuRender],
  );

  const ctx = {
    currentTime,
    totalDuration: timeline.duration,
    isPlaying,
    loop,
    basePath,
    canvasWidth: width,
    canvasHeight: height,
    getFrame: () => null,
    getIntrinsicSize: () => null,
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
          <canvas
            ref={canvasRef}
            width={width}
            height={height}
            style={{
              maxWidth: "100%",
              maxHeight: "100%",
              background: "#000",
            }}
          />
        </div>

        {/* Transport controls slot */}
        {children}
      </div>
    </TimelineContext.Provider>
  );
}

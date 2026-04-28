import React, { useState, useRef, useCallback, useEffect, useMemo } from "react";
import type { ResolvedTimeline } from "@seam/core";
import {
  TimelineContext,
  TimelineCanvasContext,
  type TimelineCanvasContextValue,
} from "./TimelineContext.js";
import { MediaStore } from "../media/MediaStore.js";
import { AudioScheduler } from "../media/AudioScheduler.js";
import { FrameCoordinator } from "../media/FrameCoordinator.js";
import { WebGPURenderer } from "../media/gpu/WebGPURenderer.js";
import { buildRenderList } from "../media/gpu/RenderList.js";

interface TimelineProps {
  timeline: ResolvedTimeline;
  basePath: string;
  preserveTime?: boolean;
  initialTime?: number;
  children?: React.ReactNode;
}

interface CanvasMount {
  canvas: HTMLCanvasElement;
  width: number;
  height: number;
}

export default function Timeline({
  timeline,
  basePath,
  preserveTime = false,
  initialTime = 0,
  children,
}: TimelineProps) {
  const [currentTime, setCurrentTime] = useState(initialTime);
  const [isPlaying, setIsPlaying] = useState(false);
  const [loop, setLoop] = useState(false);
  const rafRef = useRef<number>(0);

  // The <VideoCanvas> registered with us, if any. Stored as state so
  // the WebGPU init effect re-runs on (re)mount and as a ref so
  // gpuRender can read the latest dimensions without re-binding.
  const [canvasMount, setCanvasMount] = useState<CanvasMount | null>(null);
  const canvasMountRef = useRef<CanvasMount | null>(null);
  canvasMountRef.current = canvasMount;

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

  // Initialize WebGPU when the canvas mounts
  useEffect(() => {
    if (!canvasMount || renderer.ready) return;
    void renderer.init(canvasMount.canvas).catch((err) => {
      console.error("WebGPU init failed:", err);
    });
  }, [renderer, canvasMount]);

  // Ref for latest currentTime — used by setTimeline to prime buffers at the
  // actual playhead on document changes, and by the frame-available callback.
  const currentTimeRef = useRef(currentTime);
  currentTimeRef.current = currentTime;

  // Initialize coordinator when timeline changes
  useEffect(() => {
    const priming = preserveTime ? currentTimeRef.current : 0;
    if (!preserveTime) {
      setCurrentTime(0);
    }
    setIsPlaying(false);
    audioScheduler.pause();
    void coordinator.setTimeline(
      timeline,
      basePath,
      mediaStore,
      audioScheduler,
      priming
    );
  }, [timeline, basePath, mediaStore, audioScheduler, coordinator, preserveTime]);

  // Refs for rAF access to latest state
  const loopRef = useRef(loop);
  loopRef.current = loop;
  const durationRef = useRef(timeline.duration);
  durationRef.current = timeline.duration;
  const timelineRef = useRef(timeline);
  timelineRef.current = timeline;
  const isPlayingRef = useRef(isPlaying);
  isPlayingRef.current = isPlaying;

  // GPU render function (called imperatively, not dependent on React)
  const gpuRender = useCallback(
    (time: number) => {
      if (!renderer.ready) return;
      const mount = canvasMountRef.current;
      if (!mount) return;
      renderer.resize(mount.width, mount.height);

      const commands = buildRenderList(
        timelineRef.current,
        time,
        mount.width,
        mount.height,
        (clip) => coordinator.getIntrinsicSize(clip),
      );

      renderer.render(commands, (clip) => coordinator.getFrame(clip, time));
    },
    [renderer, coordinator],
  );

  // Wire up frame-available callback for re-renders on async seek / reload
  useEffect(() => {
    coordinator.onFrameAvailable = () => {
      gpuRender(currentTimeRef.current);
    };
    return () => {
      coordinator.onFrameAvailable = null;
    };
  }, [coordinator, gpuRender]);

  // Re-render when the canvas (re)mounts or its dimensions change.
  useEffect(() => {
    if (canvasMount) gpuRender(currentTimeRef.current);
  }, [canvasMount, gpuRender]);

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
      // Audible scrub feedback while paused. seekAll() above already cancelled
      // any previous scrub, so repeated fast seeks just keep replacing the
      // current one.
      if (!isPlayingRef.current) {
        coordinator.scrub(time);
      }
    },
    [audioScheduler, coordinator, timeline.duration, gpuRender],
  );

  const ctx = {
    currentTime,
    totalDuration: timeline.duration,
    isPlaying,
    loop,
    basePath,
    play,
    pause,
    restart,
    seek,
    setLoop,
  };

  const canvasCtx = useMemo<TimelineCanvasContextValue>(
    () => ({
      registerCanvas: (canvas, width, height) => {
        setCanvasMount({ canvas, width, height });
      },
      unregisterCanvas: (canvas) => {
        setCanvasMount((cur) => (cur?.canvas === canvas ? null : cur));
      },
    }),
    [],
  );

  return (
    <TimelineContext.Provider value={ctx}>
      <TimelineCanvasContext.Provider value={canvasCtx}>
        {children}
      </TimelineCanvasContext.Provider>
    </TimelineContext.Provider>
  );
}

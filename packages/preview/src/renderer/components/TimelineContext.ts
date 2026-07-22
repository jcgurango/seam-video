import { createContext, useContext } from "react";

export interface TimelineContextValue {
  currentTime: number;
  totalDuration: number;
  isPlaying: boolean;
  loop: boolean;
  basePath: string;
  play: () => void;
  pause: () => void;
  restart: () => void;
  seek: (time: number) => void;
  setLoop: (loop: boolean) => void;
}

export const TimelineContext = createContext<TimelineContextValue | null>(null);

export function useTimeline(): TimelineContextValue {
  const ctx = useContext(TimelineContext);
  if (!ctx) {
    throw new Error("useTimeline must be used within a <Timeline>");
  }
  return ctx;
}

// Internal context used by <VideoCanvas> to mount its <canvas> element with
// <Timeline>. Not part of the public API — consumers should compose
// <VideoCanvas> instead of touching this directly.
export interface TimelineCanvasContextValue {
  registerCanvas: (
    canvas: HTMLCanvasElement,
    width: number,
    height: number
  ) => void;
  unregisterCanvas: (canvas: HTMLCanvasElement) => void;
}

export const TimelineCanvasContext =
  createContext<TimelineCanvasContextValue | null>(null);

// Composited-frame pixel subscription. Lets read-side consumers (e.g. the
// editor's Scopes panel) tap the composited RGBA after each render without
// owning the canvas or the GPU pipeline. The producer (Timeline) downscales
// the swapchain canvas and pushes pixels to every subscriber; subscribing
// while paused primes an immediate frame. The seam is deliberately small so a
// future true-offscreen-readback producer can replace it transparently.
export interface TimelineFramePixels {
  /** Tightly packed RGBA, row-major, `width*height*4` bytes. */
  data: Uint8ClampedArray;
  width: number;
  height: number;
}

export type TimelineFrameCallback = (frame: TimelineFramePixels) => void;

export interface TimelineFrameContextValue {
  /** Register `cb` for composited frames. Returns an unsubscribe fn. */
  subscribeFrame: (cb: TimelineFrameCallback) => () => void;
}

export const TimelineFrameContext =
  createContext<TimelineFrameContextValue | null>(null);

export function useTimelineFrame(): TimelineFrameContextValue {
  const ctx = useContext(TimelineFrameContext);
  if (!ctx) {
    throw new Error("useTimelineFrame must be used within a <Timeline>");
  }
  return ctx;
}

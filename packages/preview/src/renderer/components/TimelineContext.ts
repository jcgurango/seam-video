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

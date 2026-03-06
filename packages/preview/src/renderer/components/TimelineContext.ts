import { createContext, useContext } from "react";

export interface TimelineContextValue {
  currentTime: number;
  totalDuration: number;
  isPlaying: boolean;
  loop: boolean;
  basePath: string;
  canvasWidth: number;
  canvasHeight: number;
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

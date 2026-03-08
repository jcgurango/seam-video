import { createContext, useContext } from "react";
import type { ResolvedClip } from "@seam/core";

export interface TimelineContextValue {
  currentTime: number;
  totalDuration: number;
  isPlaying: boolean;
  loop: boolean;
  basePath: string;
  canvasWidth: number;
  canvasHeight: number;
  getFrame: (clip: ResolvedClip) => HTMLCanvasElement | OffscreenCanvas | null;
  getIntrinsicSize: (clip: ResolvedClip) => { w: number; h: number } | null;
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

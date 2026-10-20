import { describe, it, expect } from "vitest";
import { cutsFromTimeline } from "../cuts.js";
import type { ResolvedTimeline } from "@seam/core";

const clip = (source: string, sourceIn: number, sourceOut: number, start: number, end: number, speed = 1) => ({
  type: "clip" as const,
  source,
  sourceIn,
  sourceOut,
  timelineStart: start,
  timelineEnd: end,
  speed,
});

describe("cutsFromTimeline", () => {
  it("flattens root clips and nested compositions into absolute cuts", () => {
    const timeline = {
      duration: 10,
      children: [
        clip("a.mp4", 5, 7, 0, 2),
        {
          type: "composition" as const,
          timelineStart: 2,
          timelineEnd: 4,
          duration: 2,
          speed: 2, // 2 s of output = 4 s of inner time
          children: [
            clip("b.mp4", 0, 3, 0, 3),
            clip("c.mp4", 10, 20, 3, 6), // inner 3..6 clamped to the 4 s inner span
          ],
        },
        { type: "audio" as const, source: "d.m4a", sourceIn: 1, sourceOut: 2, timelineStart: 4, timelineEnd: 5, speed: 1 },
        { type: "empty" as const, timelineStart: 5, timelineEnd: 6 },
      ],
    } as unknown as ResolvedTimeline;
    const cuts = cutsFromTimeline(timeline, (s) => `https://x/${s}`);
    expect(cuts).toEqual([
      { id: "0", kind: "clip", source: "https://x/a.mp4", sourceIn: 5, sourceOut: 7, start: 0, end: 2 },
      { id: "1.0", kind: "clip", source: "https://x/b.mp4", sourceIn: 0, sourceOut: 3, start: 2, end: 3.5 },
      { id: "1.1", kind: "clip", source: "https://x/c.mp4", sourceIn: 10, sourceOut: 11, start: 3.5, end: 4 },
      { id: "2", kind: "audio", source: "https://x/d.m4a", sourceIn: 1, sourceOut: 2, start: 4, end: 5 },
    ]);
  });
});

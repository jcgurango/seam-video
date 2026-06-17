import { describe, it, expect } from "vitest";
import { buildFfmpegAudioCommand } from "../ffmpeg-audio.js";
import type { ResolvedTimeline } from "@seam/core";

// Minimal resolved clip — only the fields the audio builder reads.
function clip(source: string, start: number, end: number): unknown {
  return {
    type: "clip",
    source,
    sourceIn: 0,
    sourceOut: end - start,
    timelineStart: start,
    timelineEnd: end,
    speed: 1,
  };
}

function timeline(children: unknown[]): ResolvedTimeline {
  return { duration: 10, children } as unknown as ResolvedTimeline;
}

describe("ffmpeg audio — audioless sources", () => {
  it("skips a clip whose source has no audio stream", () => {
    const tl = timeline([clip("a.mp4", 0, 5), clip("silent.mp4", 5, 10)]);
    const cmd = buildFfmpegAudioCommand(tl, "/out.m4a", {
      basePath: "/base",
      audiolessSources: new Set(["/base/silent.mp4"]),
    });
    // Only the audio-bearing source becomes an ffmpeg input.
    expect(cmd.inputs.map((i) => i.path)).toEqual(["/base/a.mp4"]);
    // Its chain is present; there's no second input to reference.
    expect(cmd.filterComplex).toContain("[0:a]");
    expect(cmd.filterComplex).not.toContain("[1:a]");
  });

  it("includes both clips when neither is flagged audioless", () => {
    const tl = timeline([clip("a.mp4", 0, 5), clip("b.mp4", 5, 10)]);
    const cmd = buildFfmpegAudioCommand(tl, "/out.m4a", { basePath: "/base" });
    expect(cmd.inputs.length).toBe(2);
    expect(cmd.filterComplex).toContain("[1:a]");
  });

  it("produces a pure-silence track when every source is audioless", () => {
    const tl = timeline([clip("v1.mp4", 0, 5), clip("v2.mp4", 5, 10)]);
    const cmd = buildFfmpegAudioCommand(tl, "/out.m4a", {
      basePath: "/base",
      audiolessSources: new Set(["/base/v1.mp4", "/base/v2.mp4"]),
    });
    // No inputs, no `[N:a]` refs — just anullsrc, so the mux still has a track.
    expect(cmd.inputs.length).toBe(0);
    expect(cmd.filterComplex).toContain("anullsrc");
    expect(cmd.filterComplex).not.toContain(":a]");
  });
});

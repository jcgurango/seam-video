import { describe, it, expect } from "vitest";
import { buildFfmpegCommand } from "../ffmpeg-builder.js";
import type { ResolvedTimeline } from "@seam/core";

describe("buildFfmpegCommand", () => {
  it("builds a simple two-clip timeline", () => {
    const timeline: ResolvedTimeline = {
      duration: 8,
      children: [
        {
          type: "clip",
          source: "a.mp4",
          sourceIn: 0,
          sourceOut: 3,
          timelineStart: 0,
          timelineEnd: 3,
          speed: 1,
        },
        {
          type: "clip",
          source: "b.mp4",
          sourceIn: 5,
          sourceOut: 10,
          timelineStart: 3,
          timelineEnd: 8,
          speed: 1,
        },
      ],
    };

    const cmd = buildFfmpegCommand(timeline, "out.mp4");

    expect(cmd.inputs).toEqual(["a.mp4", "b.mp4"]);
    expect(cmd.filterComplex).toContain("[0:v]trim=0:3");
    expect(cmd.filterComplex).toContain("[1:v]trim=5:10");
    // Unified assembly: black base + overlay each child
    expect(cmd.filterComplex).toContain("color=c=black");
    expect(cmd.filterComplex).toContain("overlay=0:0:eof_action=pass");
    // Second clip starts at t=3, so it gets delayed
    expect(cmd.filterComplex).toContain("tpad=start_duration=3");
    expect(cmd.outputArgs).toContain("libx264");
    expect(cmd.outputArgs).toContain("out.mp4");
  });

  it("gives each clip its own input (no dedup)", () => {
    const timeline: ResolvedTimeline = {
      duration: 6,
      children: [
        {
          type: "clip",
          source: "video.mp4",
          sourceIn: 0,
          sourceOut: 3,
          timelineStart: 0,
          timelineEnd: 3,
          speed: 1,
        },
        {
          type: "clip",
          source: "video.mp4",
          sourceIn: 5,
          sourceOut: 8,
          timelineStart: 3,
          timelineEnd: 6,
          speed: 1,
        },
      ],
    };

    const cmd = buildFfmpegCommand(timeline, "out.mp4");
    expect(cmd.inputs).toEqual(["video.mp4", "video.mp4"]);
    expect(cmd.filterComplex).toContain("[0:v]trim=0:3");
    expect(cmd.filterComplex).toContain("[1:v]trim=5:8");
  });

  it("handles speed with setpts and atempo", () => {
    const timeline: ResolvedTimeline = {
      duration: 5,
      children: [
        {
          type: "clip",
          source: "video.mp4",
          sourceIn: 0,
          sourceOut: 10,
          timelineStart: 0,
          timelineEnd: 5,
          speed: 2,
        },
      ],
    };

    const cmd = buildFfmpegCommand(timeline, "out.mp4");
    // setpts=PTS*0.5 for 2x speed
    expect(cmd.filterComplex).toContain("setpts=PTS*0.5");
    expect(cmd.filterComplex).toContain("atempo=2");
  });

  it("handles empty segments with color and anullsrc", () => {
    const timeline: ResolvedTimeline = {
      duration: 8,
      children: [
        {
          type: "clip",
          source: "a.mp4",
          sourceIn: 0,
          sourceOut: 3,
          timelineStart: 0,
          timelineEnd: 3,
          speed: 1,
        },
        {
          type: "empty",
          timelineStart: 3,
          timelineEnd: 5,
        },
        {
          type: "clip",
          source: "b.mp4",
          sourceIn: 0,
          sourceOut: 3,
          timelineStart: 5,
          timelineEnd: 8,
          speed: 1,
        },
      ],
    };

    const cmd = buildFfmpegCommand(timeline, "out.mp4");
    expect(cmd.inputs).toEqual(["a.mp4", "b.mp4"]);
    expect(cmd.filterComplex).toContain("color=c=black");
    expect(cmd.filterComplex).toContain("overlay=0:0:eof_action=pass");
    // Empty segment is skipped, second clip delayed to t=5
    expect(cmd.filterComplex).toContain("tpad=start_duration=5");
  });

  it("traverses nested compositions", () => {
    const timeline: ResolvedTimeline = {
      duration: 8,
      children: [
        {
          type: "clip",
          source: "a.mp4",
          sourceIn: 0,
          sourceOut: 3,
          timelineStart: 0,
          timelineEnd: 3,
          speed: 1,
        },
        {
          type: "composition",
          timelineStart: 3,
          timelineEnd: 8,
          duration: 5,
          speed: 1,
          children: [
            {
              type: "clip",
              source: "inner.mp4",
              sourceIn: 0,
              sourceOut: 5,
              timelineStart: 0,
              timelineEnd: 5,
              speed: 1,
            },
          ],
        },
      ],
    };

    const cmd = buildFfmpegCommand(timeline, "out.mp4");
    expect(cmd.inputs).toEqual(["a.mp4", "inner.mp4"]);
    expect(cmd.filterComplex).toContain("[0:v]trim=0:3");
    expect(cmd.filterComplex).toContain("[1:v]trim=0:5");
    // Nested composition gets its own black base, then overlaid on parent
    expect(cmd.filterComplex).toContain("overlay=0:0:eof_action=pass");
  });

  it("compounds speed through nested compositions", () => {
    const timeline: ResolvedTimeline = {
      duration: 5,
      children: [
        {
          type: "composition",
          timelineStart: 0,
          timelineEnd: 5,
          duration: 5,
          speed: 2,
          children: [
            {
              type: "clip",
              source: "fast.mp4",
              sourceIn: 0,
              sourceOut: 10,
              timelineStart: 0,
              timelineEnd: 10,
              speed: 1,
            },
          ],
        },
      ],
    };

    const cmd = buildFfmpegCommand(timeline, "out.mp4");
    // Parent speed 2 * clip speed 1 = effective 2
    expect(cmd.filterComplex).toContain("setpts=PTS*0.5");
    expect(cmd.filterComplex).toContain("atempo=2");
  });

  it("builds overlay with overlay filter", () => {
    const timeline: ResolvedTimeline = {
      duration: 5,
      children: [
        {
          type: "overlay",
          timelineStart: 0,
          timelineEnd: 5,
          duration: 5,
          speed: 1,
          children: [
            {
              type: "clip",
              source: "bg.mp4",
              sourceIn: 0,
              sourceOut: 5,
              timelineStart: 0,
              timelineEnd: 5,
              speed: 1,
            },
            {
              type: "clip",
              source: "fg.mp4",
              sourceIn: 0,
              sourceOut: 3,
              timelineStart: 1,
              timelineEnd: 4,
              speed: 1,
            },
          ],
        },
      ],
    };

    const cmd = buildFfmpegCommand(timeline, "out.mp4");
    expect(cmd.inputs).toEqual(["bg.mp4", "fg.mp4"]);
    expect(cmd.filterComplex).toContain("overlay=0:0:eof_action=pass");
    // Second child has delay=1s, so tpad should appear
    expect(cmd.filterComplex).toContain("tpad=start_duration=1");
    expect(cmd.filterComplex).toContain("adelay=1000|1000");
  });

  it("mixes overlay audio with amix", () => {
    const timeline: ResolvedTimeline = {
      duration: 5,
      children: [
        {
          type: "overlay",
          timelineStart: 0,
          timelineEnd: 5,
          duration: 5,
          speed: 1,
          children: [
            {
              type: "clip",
              source: "a.mp4",
              sourceIn: 0,
              sourceOut: 5,
              timelineStart: 0,
              timelineEnd: 5,
              speed: 1,
            },
            {
              type: "clip",
              source: "b.mp4",
              sourceIn: 0,
              sourceOut: 5,
              timelineStart: 0,
              timelineEnd: 5,
              speed: 1,
            },
          ],
        },
      ],
    };

    const cmd = buildFfmpegCommand(timeline, "out.mp4");
    expect(cmd.filterComplex).toContain("amix=inputs=2:duration=longest:normalize=0");
  });

  it("handles slow speed with chained atempo", () => {
    const timeline: ResolvedTimeline = {
      duration: 40,
      children: [
        {
          type: "clip",
          source: "video.mp4",
          sourceIn: 0,
          sourceOut: 10,
          timelineStart: 0,
          timelineEnd: 40,
          speed: 0.25,
        },
      ],
    };

    const cmd = buildFfmpegCommand(timeline, "out.mp4");
    // 0.25 speed needs chained atempo: 0.5 * 0.5
    expect(cmd.filterComplex).toContain("atempo=0.5,atempo=0.5");
  });
});

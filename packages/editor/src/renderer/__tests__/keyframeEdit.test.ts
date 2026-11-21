import { describe, expect, it } from "vitest";
import type { Child, SeamFile } from "@seam/core";
import { setKeyframeTime } from "../keyframeEdit.js";
import { setNodeVolume } from "../normalizeTool.js";
import { parsePath } from "../nodePath.js";

const doc: SeamFile = {
  type: "composition",
  bin: [
    {
      id: "intro",
      children: [{ type: "clip", source: "i.mp4", in: 0, out: 1, opacity: [[0, 0], [1, 1]] } as unknown as Child],
    },
  ],
  children: [
    { type: "clip", source: "a.mp4", in: 0, out: 5 } as Child,
    {
      type: "composition",
      children: [
        { type: "clip", source: "b.mp4", in: 0, out: 5, start: 0, opacity: [[0, 0], ["50%", 1]] } as unknown as Child,
      ],
    } as Child,
  ],
};

const nodeAt = (d: SeamFile, i: number, j: number) =>
  (d.children![i] as unknown as SeamFile).children![j] as unknown as Record<string, unknown>;

describe("setKeyframeTime", () => {
  it("rewrites one keyframe's time on a nested node, leaving the rest alone", () => {
    const next = setKeyframeTime(doc, parsePath("children.1.children.0"), "opacity", 1, "75%");
    expect(nodeAt(next, 1, 0).opacity).toEqual([[0, 0], ["75%", 1]]);
    expect(nodeAt(next, 1, 0).start).toBe(0);
    expect(next.children![0]).toBe(doc.children![0]);
  });

  it("reaches bin-rooted nodes", () => {
    const next = setKeyframeTime(doc, parsePath("bin.intro.children.0"), "opacity", 0, 0.5);
    expect((next.bin![0].children[0] as unknown as Record<string, unknown>).opacity).toEqual([
      [0.5, 0],
      [1, 1],
    ]);
  });

  it("no-ops on a missing prop / keyframe / path", () => {
    expect(setKeyframeTime(doc, parsePath("children.0"), "opacity", 0, 1)).toBe(doc);
    expect(setKeyframeTime(doc, parsePath("children.1.children.0"), "opacity", 5, 1)).toBe(doc);
    expect(setKeyframeTime(doc, [], "opacity", 0, 1)).toBe(doc);
  });
});

describe("setNodeVolume", () => {
  it("sets volume on a clip at any depth and ignores non clip/audio nodes", () => {
    const next = setNodeVolume(doc, parsePath("children.1.children.0"), "3.0dB");
    expect(nodeAt(next, 1, 0).volume).toBe("3.0dB");
    expect(setNodeVolume(doc, parsePath("children.1"), "3.0dB")).toBe(doc);
    expect(setNodeVolume(doc, [], "3.0dB")).toBe(doc);
  });
});

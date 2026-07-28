import { describe, expect, it } from "vitest";
import type { Child, SeamFile } from "@seam/core";
import { resizeChild } from "../resizeTool.js";

const docWith = (child: Child): SeamFile => ({
  type: "composition",
  children: [child],
});

const childOf = (doc: SeamFile) => (doc.children ?? [])[0] as Child & {
  in: number;
  out: number;
  duration?: number;
};

describe("resizeChild rate-aware in/out", () => {
  it("right handle on a speed-1 clip moves out 1:1 (regression)", () => {
    const doc = docWith({
      type: "clip",
      source: "a.mp4",
      in: 0,
      out: 10,
    } as Child);
    const next = resizeChild(doc, 0, false, "right", 1);
    expect(childOf(next).out).toBe(11);
  });

  it("scales the delta by clip speed (right handle)", () => {
    const doc = docWith({
      type: "clip",
      source: "a.mp4",
      in: 0,
      out: 10,
      speed: 2,
    } as Child);
    // 1s of output growth consumes 2s of source at 2x.
    const next = resizeChild(doc, 0, false, "right", 1);
    expect(childOf(next).out).toBe(12);
  });

  it("scales the delta by clip speed (left handle)", () => {
    const doc = docWith({
      type: "clip",
      source: "a.mp4",
      in: 4,
      out: 10,
      speed: 2,
    } as Child);
    const next = resizeChild(doc, 0, false, "left", 1);
    expect(childOf(next).in).toBe(6);
  });

  it("slow clips consume less source per output second", () => {
    const doc = docWith({
      type: "clip",
      source: "a.mp4",
      in: 2,
      out: 4,
      speed: 0.5,
    } as Child);
    const next = resizeChild(doc, 0, false, "left", -1);
    expect(childOf(next).in).toBe(1.5);
  });

  it("adjusts a duration override alongside in/out at the implied rate", () => {
    // Window 10s over duration 5s → rate 2. Right +1s output ⇒ out +2,
    // duration +1, so the playback rate is preserved and the edge follows
    // the cursor (previously this drag was a visual no-op).
    const doc = docWith({
      type: "clip",
      source: "a.mp4",
      in: 0,
      out: 10,
      duration: 5,
    } as Child);
    const next = resizeChild(doc, 0, false, "right", 1);
    expect(childOf(next).out).toBe(12);
    expect(childOf(next).duration).toBe(6);
  });

  it("clamps at in=0 and only applies the achievable duration delta", () => {
    // rate 2; dragging left by −2s wants in −4 → clamps at 0 (only −1s of
    // output was achievable), so duration grows by 1, not 2.
    const doc = docWith({
      type: "clip",
      source: "a.mp4",
      in: 2,
      out: 10,
      duration: 4,
    } as Child);
    const next = resizeChild(doc, 0, false, "left", -2);
    expect(childOf(next).in).toBe(0);
    expect(childOf(next).duration).toBe(5);
  });

  it("scales composition window resizes by comp speed", () => {
    const doc = docWith({
      type: "composition",
      speed: 2,
      in: 0,
      out: 10,
      children: [{ type: "clip", source: "a.mp4", in: 0, out: 10 } as Child],
    } as Child);
    const next = resizeChild(doc, 0, false, "right", 1);
    expect(childOf(next).out).toBe(12);
  });

  it("leaves duration-based types on the plain output axis", () => {
    const doc = docWith({
      type: "static",
      source: "a.png",
      duration: 5,
    } as Child);
    const next = resizeChild(doc, 0, false, "left", 1);
    expect(childOf(next).duration).toBe(4);
  });
});

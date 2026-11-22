import { describe, it, expect } from "vitest";
import {
  resolveSpatial,
  type Composition,
  type ResolvedRect,
} from "../index.js";
import { createSeam } from "../seam.js";

const { parseSeamFile, resolveComposition } = createSeam();

function parse(doc: unknown) {
  return parseSeamFile(JSON.stringify(doc));
}

describe("rect / circle schema", () => {
  it("accepts a rect with keyframed fill, stroke and cornerRadius", () => {
    const r = parse({
      type: "composition",
      children: [
        {
          type: "rect",
          duration: 2,
          fill: [[0, "red"], [1, "blue", "ease-in-out"]],
          stroke: "black",
          strokeWidth: [[0, 0], ["100%", 8]],
          cornerRadius: "50%",
          size: { x: 300, y: 40 },
          origin: "0%",
          translation: "0%",
        },
      ],
    });
    expect(r.success, r.success ? "" : r.errors.join("\n")).toBe(true);
  });

  it("accepts an anchored circle, but always requires a duration", () => {
    const doc = (circle: object) => ({
      type: "composition",
      children: [
        { type: "clip", id: "c", source: "a.mp4", in: 0, out: 5 },
        { type: "circle", fill: "white", size: 120, start: "c", ...circle },
      ],
    });
    const r = parse(doc({ duration: 5 }));
    expect(r.success, r.success ? "" : r.errors.join("\n")).toBe(true);
    expect(parse(doc({})).success).toBe(false);
  });

  it("rejects a rect without duration, and unknown fields", () => {
    expect(parse({ type: "composition", children: [{ type: "rect" }] }).success).toBe(false);
    expect(
      parse({ type: "composition", children: [{ type: "rect", start: 0, offset: 1 }] }).success,
    ).toBe(false);
    expect(
      parse({ type: "composition", children: [{ type: "rect", duration: 1, radius: 4 }] }).success,
    ).toBe(false);
  });

  it("rejects the removed graphic type", () => {
    const r = parse({
      type: "composition",
      children: [{ type: "graphic", duration: 1, frames: [[0, []]] }],
    });
    expect(r.success).toBe(false);
  });
});

describe("shape resolution", () => {
  it("places a rect by size/origin/translation with no intrinsic dims", () => {
    const doc: Composition = {
      type: "composition",
      contentWidth: 1000,
      contentHeight: 500,
      children: [
        {
          type: "rect",
          duration: 1,
          fill: "red",
          size: { x: 200, y: 50 },
          origin: "0%",
          translation: { x: "0% + 10", y: "0% + 20" },
          cornerRadius: 8,
        },
      ],
    };
    const timeline = resolveSpatial(resolveComposition(doc), 1000, 500);
    const r = timeline.children[0] as ResolvedRect;
    expect(r.type).toBe("rect");
    expect(r.intrinsicWidth).toBeUndefined();
    expect(r.naturalWidth).toBe(1000);
    expect(r.spatial).toEqual({ x: 10, y: 20, width: 200, height: 50 });
    expect(r.fill).toBe("red");
    expect(r.cornerRadius).toBe(8);
    // Static spatial → no spatialInput retained.
    expect(r.spatialInput).toBeUndefined();
  });

  it("a rect with no size fills the parent", () => {
    const doc: Composition = {
      type: "composition",
      contentWidth: 640,
      contentHeight: 480,
      children: [{ type: "circle", duration: 1 }],
    };
    const timeline = resolveSpatial(resolveComposition(doc), 640, 480);
    const c = timeline.children[0];
    expect(c.type).toBe("circle");
    // No authored spatial → no baked rect; the renderer centers the natural box.
    expect((c as ResolvedRect).naturalWidth).toBe(640);
    expect((c as ResolvedRect).naturalHeight).toBe(480);
  });
});

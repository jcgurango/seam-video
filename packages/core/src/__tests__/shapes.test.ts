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

describe("fitSelf — a node's own fit into its parent", () => {
  // A 400×200 inner canvas in a 1080×1920 parent, holding a 100×50 one.
  const inner = { type: "composition", contentWidth: 100, contentHeight: 50, children: [{ type: "rect", duration: 1 }] };
  const natural = (rootFit: object, node: object) => {
    const comp = resolveComposition({
      type: "composition",
      ...rootFit,
      children: [{ type: "composition", contentWidth: 400, contentHeight: 200, children: [inner], ...node }],
    } as unknown as Composition);
    const outer = resolveSpatial(comp, 1080, 1920).children[0] as unknown as {
      naturalWidth: number;
      naturalHeight: number;
      children: { naturalWidth: number; naturalHeight: number }[];
    };
    return {
      outer: [outer.naturalWidth, outer.naturalHeight],
      child: [outer.children[0].naturalWidth, outer.children[0].naturalHeight],
    };
  };

  it("a node is fitted by its parent's objectFit, never by its own", () => {
    expect(natural({}, {}).outer).toEqual([1080, 540]); // parent default: fit
    expect(natural({ objectFit: "center" }, {}).outer).toEqual([400, 200]);
    // Its own objectFit is for ITS children.
    expect(natural({}, { objectFit: "center" })).toEqual({ outer: [1080, 540], child: [100, 50] });
  });

  it("fitSelf overrides the parent's objectFit for that node alone", () => {
    expect(natural({}, { fitSelf: "center" }).outer).toEqual([400, 200]);
    expect(natural({}, { fitSelf: "cover" }).outer).toEqual([3840, 1920]);
    expect(natural({ objectFit: "center" }, { fitSelf: "fit" }).outer).toEqual([1080, 540]);
    // It does not pass down: the child is still fitted by the node's objectFit
    // (inherited from the root here: fit → 400×200 for a 2:1 child).
    expect(natural({}, { fitSelf: "center" }).child).toEqual([400, 200]);
    expect(natural({}, { fitSelf: "center", objectFit: "center" }).child).toEqual([100, 50]);
  });

  it("is a schema field on visual nodes, and refused on the root", () => {
    const ok = parse({ type: "composition", children: [{ type: "rect", duration: 1, fitSelf: "cover" }] });
    expect(ok.success).toBe(true);
    expect(parse({ type: "composition", children: [{ type: "rect", duration: 1, fitSelf: "stretch" }] }).success).toBe(false);
    expect(parse({ type: "composition", children: [{ type: "audio", source: "a.mp3", in: 0, out: 1, fitSelf: "fit" }] }).success).toBe(false);
    const root = parse({ type: "composition", fitSelf: "center", children: [] });
    expect(root.success).toBe(false);
    if (!root.success) expect(root.errors.join()).toMatch(/not allowed on the root/);
  });
});

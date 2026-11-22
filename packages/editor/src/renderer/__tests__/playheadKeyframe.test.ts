import { describe, expect, it } from "vitest";
import { createSeam, type Child, type SeamFile } from "@seam/core";
import {
  LAST_FRAME,
  activeKeyframeIndex,
  insertKeyframeAtPlayhead,
  interpolatedValue,
  keyframeMoment,
  nodeClock,
  timeExprAtPlayhead,
} from "../playheadKeyframe.js";
import { parsePath } from "../nodePath.js";
import { applyTransformDrag, transformCapabilities } from "../transformEdit.js";
import { insetEdges, withDistortCoord, withInsetEdge } from "../propertyCatalog.js";
import { locateNode } from "../viewportLocate.js";

const seam = createSeam();
const { resolveComposition } = seam;

const clock = (t: number, duration = 10) => ({ t, duration });

describe("nodeClock", () => {
  const doc: SeamFile = {
    type: "composition",
    children: [
      { type: "rect", duration: 4 } as Child,
      {
        type: "composition",
        speed: 2,
        children: [
          { type: "rect", duration: 2 } as Child,
          { type: "rect", duration: 6 } as Child,
        ],
      } as Child,
    ],
  };
  const resolved = resolveComposition(doc, { uncropped: true });

  it("puts the playhead in a root node's own time", () => {
    const c = nodeClock(seam, resolved, doc, parsePath("children.1"), 5)!;
    expect(c.t).toBeCloseTo(1);
    expect(c.duration).toBeCloseTo(4);
    expect(c.toGlobal(1)).toBeCloseTo(5);
  });
  it("maps through a sped composition both ways", () => {
    // Comp starts at 4 and plays 2×: global 6 → inner 4 → 2s into the 2nd rect.
    const c = nodeClock(seam, resolved, doc, parsePath("children.1.children.1"), 6)!;
    expect(c.t).toBeCloseTo(2);
    expect(c.duration).toBeCloseTo(6);
    expect(c.toGlobal(2)).toBeCloseTo(6);
    expect(c.toGlobal(0)).toBeCloseTo(5);
  });
  it("runs the root on global time and has no clock for bin-rooted paths", () => {
    expect(nodeClock(seam, resolved, doc, [], 3)!.t).toBe(3);
    expect(nodeClock(seam, resolved, doc, parsePath("bin.x.children.0"), 3)).toBeNull();
  });
});

describe("activeKeyframeIndex", () => {
  const kfs: [number | string, number][] = [[0, 1], ["50%", 2], ["100%", 3]];
  it("finds the keyframe the playhead is on, and nothing in between", () => {
    expect(activeKeyframeIndex(kfs, clock(0))).toBe(0);
    expect(activeKeyframeIndex(kfs, clock(5.001))).toBe(1);
    expect(activeKeyframeIndex(kfs, clock(5.2))).toBeNull();
    expect(activeKeyframeIndex(kfs, null)).toBeNull();
  });
  it("treats a keyframe at the node's end as sitting on its last frame", () => {
    expect(keyframeMoment("100%", 10)).toBeCloseTo(10 - LAST_FRAME);
    expect(activeKeyframeIndex(kfs, clock(10 - LAST_FRAME))).toBe(2);
  });
});

describe("timeExprAtPlayhead", () => {
  it("clamps to 0% / 100% outside the node", () => {
    expect(timeExprAtPlayhead([[2, 0]], clock(-1))).toBe("0%");
    expect(timeExprAtPlayhead([[2, 0]], clock(0))).toBe("0%");
    expect(timeExprAtPlayhead([[2, 0]], clock(10))).toBe("100%");
    expect(timeExprAtPlayhead([[2, 0]], clock(12))).toBe("100%");
  });
  it("keeps the nearest keyframe's percentage and adjusts the seconds", () => {
    const kfs: [number | string, number][] = [["0%", 0], ["100%", 1]];
    expect(timeExprAtPlayhead(kfs, clock(2))).toBe("0% + 2");
    expect(timeExprAtPlayhead(kfs, clock(8.5))).toBe("100% - 1.5");
    expect(timeExprAtPlayhead([["50% + 1", 0]], clock(5))).toBe("50%");
  });
  it("uses bare seconds next to a seconds keyframe", () => {
    expect(timeExprAtPlayhead([[0, 0], ["100%", 1]], clock(2))).toBe(2);
  });
});

describe("insertKeyframeAtPlayhead", () => {
  const kfs: [number | string, unknown][] = [["0%", { x: 1 }], ["100%", { x: 9 }]];
  it("inserts in time order with the nearest keyframe's value", () => {
    const r = insertKeyframeAtPlayhead(kfs, clock(7))!;
    expect(r.index).toBe(1);
    expect(r.keyframes).toEqual([["0%", { x: 1 }], ["100% - 3", { x: 9 }], ["100%", { x: 9 }]]);
    expect(r.keyframes[1][1]).not.toBe(kfs[1][1]); // a copy
  });
  it("appends / prepends at the ends", () => {
    expect(insertKeyframeAtPlayhead([[2, 5]], clock(20))!.keyframes).toEqual([[2, 5], ["100%", 5]]);
    expect(insertKeyframeAtPlayhead([[2, 5]], clock(-3))!.keyframes).toEqual([["0%", 5], [2, 5]]);
  });
  it("is null when a keyframe is already there", () => {
    expect(insertKeyframeAtPlayhead(kfs, clock(0))).toBeNull();
    expect(insertKeyframeAtPlayhead(kfs, clock(15))).toBeNull();
  });
});

describe("interpolatedValue", () => {
  const point = { key: "translation", kind: "point", percentDefault: 50 } as const;
  it("blends numbers through the arriving keyframe's easing", () => {
    const def = { key: "rotation", kind: "number" } as const;
    expect(interpolatedValue([[0, 0], ["100%", 90]], clock(2.5), def)).toBe(22.5);
    expect(interpolatedValue([[0, 0], ["100%", 90, "discrete"]], clock(2.5), def)).toBe(0);
    // Outside the keyframes it holds the end value.
    expect(interpolatedValue([[2, 5], [4, 9]], clock(1), def)).toBe(5);
  });
  it("blends length parts separately and keeps the authored form", () => {
    const kfs: [number | string, unknown][] = [[0, { x: "30%", y: "50%" }], ["100%", { x: "70%", y: "50% + 40" }]];
    expect(interpolatedValue(kfs, clock(5), point)).toEqual({ x: "50%", y: "50% + 20" });
    // Two bare numbers stay bare; a bare number against a percentage uses the default percent.
    expect(interpolatedValue([[0, 0], ["100%", 100]], clock(2.5), point)).toBe(25);
    expect(interpolatedValue([[0, 10], ["100%", "70%"]], clock(5), point)).toBe("60% + 5");
  });
  it("blends colours, insets and distort corners", () => {
    expect(
      interpolatedValue([[0, "#000000"], ["100%", "#ffffff"]], clock(5), { key: "fill", kind: "color" }),
    ).toBe("rgb(128, 128, 128)");
    expect(
      interpolatedValue([[0, 0], ["100%", [100, 0]]], clock(5), { key: "inset", kind: "inset" }),
    ).toEqual([50, 0]);
    expect(
      interpolatedValue([[0, {}], ["100%", { x1: "50%", y2: -40 }]], clock(5), { key: "distort", kind: "distort" }),
    ).toEqual({ x1: "75%", y2: "100% - 20" });
  });
  it("feeds the inserted keyframe", () => {
    const kfs: [number | string, unknown][] = [["0%", 0], ["100%", 10]];
    const value = interpolatedValue(kfs, clock(7), { key: "opacity", kind: "number" });
    expect(insertKeyframeAtPlayhead(kfs, clock(7), value)!.keyframes[1]).toEqual(["100% - 3", 7]);
  });
});

describe("transform drags on keyframes", () => {
  const node = {
    type: "rect",
    duration: 10,
    start: 0,
    size: { x: 200, y: 100 },
    translation: [[0, { x: "10%", y: "50%" }], ["100%", { x: "90%", y: "50%" }, "ease-in"]],
  } as unknown as Child;
  const doc = { type: "composition", contentWidth: 1000, contentHeight: 500, children: [node] } as SeamFile;
  const geom = locateNode(seam, doc, resolveComposition(doc, { uncropped: true }), [0], 0, () => null)!;

  it("off a keyframe the animated property can't be edited, static ones can", () => {
    const caps = transformCapabilities(node);
    expect(caps.move).toBe(false);
    expect(caps.origin).toBe(false);
    expect(caps.scale).toBe(true);
    expect(applyTransformDrag(node, geom, { kind: "move", dx: 100, dy: 0 })).toBe(node);
  });
  it("on a keyframe the drag rewrites that keyframe's value only", () => {
    expect(transformCapabilities(node, { translation: 1 }).move).toBe(true);
    const next = applyTransformDrag(node, geom, { kind: "move", dx: 100, dy: 50 }, { translation: 1 });
    expect((next as { translation: unknown }).translation).toEqual([
      [0, { x: "10%", y: "50%" }],
      ["100%", { x: "100%", y: "60%" }, "ease-in"],
    ]);
  });
  it("an origin drag writes the static origin and the translation keyframe", () => {
    const next = applyTransformDrag(node, geom, { kind: "origin", dx: 20, dy: 0 }, { translation: 0 });
    // Only the dragged axis is written; the untouched one stays at its default.
    expect((next as { origin: unknown }).origin).toEqual({ x: "60%" });
    expect((next as { translation: unknown[][] }).translation[0][1]).toEqual({ x: "12%", y: "50%" });
  });
});

describe("inset / distort value helpers", () => {
  it("expands and re-collapses the inset shorthand", () => {
    expect(insetEdges(10)).toEqual([10, 10, 10, 10]);
    expect(insetEdges([1, 2])).toEqual([1, 2, 1, 2]);
    expect(withInsetEdge(undefined, 0, "10%")).toEqual(["10%", 0, 0, 0]);
    expect(withInsetEdge([5, 0, 0, 0], 2, 5)).toEqual([5, 0]);
    expect(withInsetEdge([5, 5], 1, 9)).toEqual([5, 9, 5, 5]);
    expect(withInsetEdge(5, 3, 5)).toBe(5);
    expect(withInsetEdge(undefined, 1, undefined)).toBeUndefined();
  });
  it("sets and clears distort coordinates", () => {
    expect(withDistortCoord(undefined, "x1", -20)).toEqual({ x1: -20 });
    expect(withDistortCoord({ x1: -20 }, "x1", undefined)).toBeUndefined();
    expect(withDistortCoord({ x1: -20, y2: "90%" }, "x1", undefined)).toEqual({ y2: "90%" });
  });
});

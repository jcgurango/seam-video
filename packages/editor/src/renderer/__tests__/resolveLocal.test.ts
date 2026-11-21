import { describe, expect, it } from "vitest";
import { resolveComposition, type Child, type SeamFile } from "@seam/core";
import { descendToContainer, globalSpanOf } from "../resolveLocal.js";
import { parsePath } from "../nodePath.js";

const resolve = (doc: SeamFile) => resolveComposition(doc, { uncropped: true });

// The playhead→inner-time descent must wrap into the current cycle of a
// looping composition (`underflow: "loop"`), so slice/attach inside one land
// on the content actually showing under the playhead.

describe("descendToContainer — looping composition", () => {
  const doc: SeamFile = {
    type: "composition",
    children: [
      { id: "bed", type: "data", data: null, duration: 10 },
      {
        type: "composition",
        underflow: "loop",
        in: 0.5,
        duration: 10,
        start: "bed",
        children: [{ type: "clip", source: "v.mp4", in: 0, out: 2.5 }],
      },
    ],
  };
  const resolved = resolve(doc);
  const path = parsePath("children.1");

  it("maps a global time in a later cycle back into the 2s inner window", () => {
    // Window is [0.5, 2.5] → 2s period. Global 5.3s = cycle 2 + 1.3s →
    // inner 0.5 + 1.3 = 1.8.
    const d = descendToContainer(resolved, doc, path, 5.3);
    expect(d).not.toBeNull();
    expect(d!.localTime).toBeCloseTo(1.8);
  });

  it("first cycle is the plain mapping", () => {
    const d = descendToContainer(resolved, doc, path, 0.7);
    expect(d!.localTime).toBeCloseTo(1.2);
  });
});

describe("descendToContainer — resolved container is 1:1 with the authored one", () => {
  // The comp shows inner [4, 10): its first clip [0,3) is outside the
  // window, and its overlay starts before 0. Both are dropped/rebased in the
  // windowed resolved tree — the descent must still hand back all three, in
  // un-windowed inner time.
  const doc: SeamFile = {
    type: "composition",
    children: [
      { type: "clip", source: "x.mp4", in: 0, out: 5 },
      {
        type: "composition",
        in: 4,
        speed: 2,
        children: [
          { type: "clip", source: "a.mp4", in: 0, out: 3 },
          { type: "clip", source: "b.mp4", in: 0, out: 7 },
          { type: "clip", source: "c.mp4", in: 0, out: 1, start: -5 },
        ],
      } as Child,
    ],
  };
  const resolved = resolve(doc);

  it("keeps every child, positioned in inner coordinates", () => {
    // Comp spans global [5, 8). Global 6 → inner 4 + 1·2 = 6.
    const d = descendToContainer(resolved, doc, parsePath("children.1"), 6)!;
    expect(d.localTime).toBe(6);
    expect(d.rContainer.children.map((c) => [c.timelineStart, c.timelineEnd])).toEqual([
      [0, 3],
      [3, 10],
      [-5, -4],
    ]);
    expect(d.aContainer).toBe(doc.children![1]);
  });

  it("root path returns the root unchanged", () => {
    const d = descendToContainer(resolved, doc, [], 6)!;
    expect(d.localTime).toBe(6);
    expect(d.rContainer).toBe(resolved);
    expect(d.aContainer).toBe(doc);
  });

  it("globalSpanOf maps inner spans up through window + speed", () => {
    // b: inner [3, 10) → global 5 + (t − 4)/2 → [4.5, 8).
    expect(globalSpanOf(resolved, doc, parsePath("children.1.children.1"))).toEqual({
      start: 4.5,
      end: 8,
    });
    expect(globalSpanOf(resolved, doc, parsePath("children.0"))).toEqual({ start: 0, end: 5 });
  });

  it("returns null for bin roots and non-composition segments", () => {
    expect(descendToContainer(resolved, doc, parsePath("children.0"), 1)).toBeNull();
    expect(globalSpanOf(resolved, doc, parsePath("children.0.children.0"))).toBeNull();
    expect(globalSpanOf(resolved, doc, parsePath("bin.x.children.0"))).toBeNull();
  });
});

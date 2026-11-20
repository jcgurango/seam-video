import { describe, expect, it } from "vitest";
import { resolveComposition } from "@seam/core";
import type { Child, SeamFile } from "@seam/core";
import { resizeChild } from "../resizeTool.js";
import { sliceAtPlayhead } from "../splitTool.js";

// Editor tools on REVERSED clips (`out < in` / negative `duration`): the
// handles and the split keep editing the playback start / end, and the
// direction survives.

const docWith = (...children: Child[]): SeamFile => ({ type: "composition", children });
const childOf = (doc: SeamFile, i = 0) =>
  (doc.children ?? [])[i] as Child & { in: number; out?: number; duration?: number };
const span = (doc: SeamFile, i = 0) => {
  const r = resolveComposition(doc).children[i];
  return r.timelineEnd - r.timelineStart;
};

describe("resizeChild on a reversed clip", () => {
  const rev = { type: "clip", source: "a.mp4", in: 10, out: 4 } as Child;

  it("right handle extends the playback end (lower `out`)", () => {
    const next = resizeChild(docWith(rev), 0, "right", 1);
    expect(childOf(next)).toMatchObject({ in: 10, out: 3 });
    expect(span(next)).toBe(7);
  });

  it("right handle shrinks toward `in` and stops there", () => {
    expect(childOf(resizeChild(docWith(rev), 0, "right", -2)).out).toBe(6);
    expect(childOf(resizeChild(docWith(rev), 0, "right", -99)).out).toBe(10);
  });

  it("left handle trims the playback start (lower `in`)", () => {
    const next = resizeChild(docWith(rev), 0, "left", 1);
    expect(childOf(next)).toMatchObject({ in: 9, out: 4 });
    expect(span(next)).toBe(5);
    // Dragging left reveals more of the high end.
    expect(childOf(resizeChild(docWith(rev), 0, "left", -2)).in).toBe(12);
  });

  it("scales by speed", () => {
    const fast = { ...rev, speed: 2 } as Child;
    expect(childOf(resizeChild(docWith(fast), 0, "right", 1)).out).toBe(2);
    expect(childOf(resizeChild(docWith(fast), 0, "left", 1)).in).toBe(8);
  });

  it("keeps a negative `duration` negative and the rate constant", () => {
    // {in: 5, duration: -3} ≡ plays 5 → 2 at 1×.
    const doc = docWith({ type: "clip", source: "a.mp4", in: 5, duration: -3 } as Child);
    const left = childOf(resizeChild(doc, 0, "left", 1));
    expect(left).toMatchObject({ in: 4, duration: -2 });
    const right = childOf(resizeChild(doc, 0, "right", 1));
    expect(right).toMatchObject({ in: 5, out: 1, duration: -4 });
    expect(resolveComposition(docWith(right)).children[0]).toMatchObject({
      sourceIn: 1, sourceOut: 5, speed: 1, reverse: true,
    });
  });
});

describe("sliceAtPlayhead on a reversed clip", () => {
  it("splits into two reversed halves that play the same frames", () => {
    const doc = docWith(
      { type: "clip", source: "b.mp4", in: 0, out: 1 } as Child,
      { type: "clip", source: "a.mp4", in: 10, out: 4, speed: 2 } as Child,
    );
    // Clip spans output [1, 4]; playhead at 2 = 1 s in = source 8.
    const next = sliceAtPlayhead(doc, 2)!;
    expect(childOf(next, 1)).toMatchObject({ in: 10, out: 8, speed: 2 });
    expect(childOf(next, 2)).toMatchObject({ in: 8, out: 4, speed: 2 });
    const r = resolveComposition(next);
    expect(r.duration).toBe(4);
    expect(r.children[1]).toMatchObject({ reverse: true, timelineStart: 1, timelineEnd: 2 });
    expect(r.children[2]).toMatchObject({ reverse: true, timelineStart: 2, timelineEnd: 4 });
  });

  it("materialises in/out from a negative-duration shorthand, keeping its sign", () => {
    const doc = docWith({ type: "clip", source: "a.mp4", in: 5, duration: -3 } as Child);
    const next = sliceAtPlayhead(doc, 1)!;
    expect(childOf(next, 0)).toMatchObject({ in: 5, out: 4, duration: -1 });
    expect(childOf(next, 1)).toMatchObject({ in: 4, out: 2, duration: -2 });
  });

  it("re-points a source-mode anchor at the half that holds its moment", () => {
    const doc = docWith(
      { type: "clip", id: "rev", source: "a.mp4", in: 10, out: 4 } as Child,
      { type: "text", text: "x", duration: 1, start: "rev@5" } as Child,
    );
    const before = resolveComposition(doc).children[1].timelineStart;
    expect(before).toBe(5); // source 5 is 5 s into a 10 → 4 clip
    const next = sliceAtPlayhead(doc, 2)!;
    // Source 5 lives in the right half (8 → 4).
    expect((next.children![2] as { start?: unknown }).start).toBe("rev_split@5");
    expect(resolveComposition(next).children[2].timelineStart).toBe(before);
  });
});

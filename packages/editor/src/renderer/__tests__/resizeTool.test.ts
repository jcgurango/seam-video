import { describe, expect, it } from "vitest";
import type { Child, SeamFile } from "@seam/core";
import { createSeam } from "@seam/core";
import { resizeChild, resizeChildInPlace } from "../resizeTool.js";

const seam = createSeam();
const { resolveComposition } = seam;

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
    const next = resizeChild(seam, doc, 0, "right", 1);
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
    const next = resizeChild(seam, doc, 0, "right", 1);
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
    const next = resizeChild(seam, doc, 0, "left", 1);
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
    const next = resizeChild(seam, doc, 0, "left", -1);
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
    const next = resizeChild(seam, doc, 0, "right", 1);
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
    const next = resizeChild(seam, doc, 0, "left", -2);
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
    const next = resizeChild(seam, doc, 0, "right", 1);
    expect(childOf(next).out).toBe(12);
  });

  it("leaves duration-based types on the plain output axis", () => {
    const doc = docWith({
      type: "static",
      source: "a.png",
      duration: 5,
    } as Child);
    const next = resizeChild(seam, doc, 0, "left", 1);
    expect(childOf(next).duration).toBe(4);
  });
});

describe("resizeChild with an omitted out (in + duration shorthand)", () => {
  it("right handle materialises out = in + duration, then extends it", () => {
    const doc = docWith({ type: "clip", source: "a.mp4", in: 2, duration: 3 } as Child);
    const next = childOf(resizeChild(seam, doc, 0, "right", 1));
    // Rate is 1 (span == duration), so +1s output = +1s source.
    expect(next.out).toBe(6);
    expect(next.duration).toBe(4);
    expect(next.in).toBe(2);
  });

  it("left handle trims in and shrinks duration without needing out", () => {
    const doc = docWith({ type: "clip", source: "a.mp4", in: 2, duration: 3 } as Child);
    const next = childOf(resizeChild(seam, doc, 0, "left", 1));
    expect(next.in).toBe(3);
    expect(next.duration).toBe(2);
    expect(next.out).toBeUndefined();
  });
});

describe("resizeChild with duration + a non-stretch strategy", () => {
  it("overflow trim-end: duration is just the output length, rate = speed", () => {
    // 10s of source at speed 2 is 5s natural; duration 3 trims rather than
    // stretching, so the rate stays 2 (not 10/3).
    const doc = docWith({
      type: "clip",
      source: "a.mp4",
      in: 0,
      out: 10,
      speed: 2,
      duration: 3,
      overflow: "trim-end",
    } as Child);
    const next = childOf(resizeChild(seam, doc, 0, "right", 1));
    expect(next.out).toBe(12);
    expect(next.duration).toBe(4);
  });

  it("underflow loop without speed: rate 1", () => {
    const doc = docWith({
      type: "clip",
      source: "a.mp4",
      in: 2,
      out: 4,
      duration: 10,
      underflow: "loop",
    } as Child);
    const next = childOf(resizeChild(seam, doc, 0, "left", 1));
    expect(next.in).toBe(3);
    expect(next.duration).toBe(9);
  });

  it("only the strategy in effect counts: a non-stretch underflow doesn't affect an overflowing clip", () => {
    // duration 5 < natural 10 → overflow (default stretch) applies → rate 2.
    const doc = docWith({
      type: "clip",
      source: "a.mp4",
      in: 0,
      out: 10,
      duration: 5,
      underflow: "loop",
    } as Child);
    const next = childOf(resizeChild(seam, doc, 0, "right", 1));
    expect(next.out).toBe(12);
    expect(next.duration).toBe(6);
  });

  it("composition with duration + trim-end resizes its window at comp speed", () => {
    const doc = docWith({
      type: "composition",
      in: 0,
      out: 10,
      duration: 4,
      overflow: "trim-end",
      children: [{ type: "clip", source: "a.mp4", in: 0, out: 10 } as Child],
    } as Child);
    const next = childOf(resizeChild(seam, doc, 0, "right", 1));
    expect(next.out).toBe(11);
    expect(next.duration).toBe(5);
  });
});

describe("resizeChild leaves placement alone", () => {
  it("keeps start/offset on the resized node and its neighbours", () => {
    const doc: SeamFile = {
      type: "composition",
      children: [
        { type: "clip", source: "a.mp4", in: 0, out: 10 } as Child,
        { type: "clip", source: "b.mp4", in: 2, out: 6, start: 3, offset: 0.5 } as Child,
        { type: "clip", source: "c.mp4", in: 0, out: 1, offset: -0.25 } as Child,
      ],
    };
    const next = resizeChild(seam, doc, 1, "left", 1);
    expect(next.children![1]).toEqual({ ...doc.children![1], in: 3 });
    expect(next.children![0]).toBe(doc.children![0]);
    expect(next.children![2]).toBe(doc.children![2]);
  });
});

describe("resizeChildInPlace (Shift-drag): downstream stays put", () => {
  const c = (extra: Record<string, unknown> = {}): Child =>
    ({ type: "clip", source: "a.mp4", in: 2, out: 7, ...extra }) as Child;
  const run = (...children: Child[]): SeamFile => ({ type: "composition", children });
  const spans = (d: SeamFile) =>
    resolveComposition(d, { uncropped: true }).children.map((r) => [r.timelineStart, r.timelineEnd]);
  const offsets = (d: SeamFile) => d.children!.map((n) => (n as { offset?: number }).offset ?? 0);

  it("left: the node's own offset absorbs the trim; its right edge holds", () => {
    const d = run(c(), c(), c());
    const next = resizeChildInPlace(seam, d, 1, "left", 1);
    expect(offsets(next)).toEqual([0, 1, 0]);
    expect(spans(next)).toEqual([[0, 5], [6, 10], [10, 15]]);
    // Extending left pulls the offset negative (an overlap with the previous).
    expect(spans(resizeChildInPlace(seam, d, 1, "left", -1))).toEqual([[0, 5], [4, 10], [10, 15]]);
  });

  it("right: the nearest earlier offset in the run absorbs it (itself first)", () => {
    const d = run(c(), c({ offset: 2 }), c(), c());
    // Node 2 has no offset → node 1's does the work.
    const next = resizeChildInPlace(seam, d, 2, "right", 1);
    expect(offsets(next)).toEqual([0, 1, 0, 0]);
    expect(spans(next)).toEqual([[0, 5], [6, 11], [11, 17], [17, 22]]);
    // Node 1 has its own offset → it absorbs.
    expect(offsets(resizeChildInPlace(seam, d, 1, "right", -1))).toEqual([0, 3, 0, 0]);
  });

  it("right: with no offset in the run, the run head takes it", () => {
    const d = run(c(), c({ start: 10 }), c(), c());
    const next = resizeChildInPlace(seam, d, 2, "right", -1);
    expect(offsets(next)).toEqual([0, 1, 0, 0]);
    expect(spans(next)).toEqual([[0, 5], [11, 16], [16, 20], [20, 25]]);
  });

  it("uses the applied (clamped, rate-scaled) change", () => {
    // Left-extend runs out of source at in=0: only 2s of the 5s drag applies.
    const d = run(c(), c({ speed: 2 }), c());
    const next = resizeChildInPlace(seam, d, 1, "left", -5);
    expect(offsets(next)).toEqual([0, -1, 0]);
    expect(spans(next)[2]).toEqual(spans(d)[2]);
  });
});

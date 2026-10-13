import { describe, it, expect } from "vitest";
import {
  resolveComposition,
  unrollLoops,
  loopLocalTime,
  loopIterations,
  flattenResolved,
  parseSeamFile,
  type Composition,
  type ResolvedClip,
  type ResolvedComposition,
} from "../index.js";

// `underflow: "loop"` — an attachment whose anchored span exceeds its natural
// length replays its content from the start until the span is filled. The
// resolved node keeps ONE cycle (source range / inner window) plus a `loop`
// marker; consumers wrap content time with `loopLocalTime` or enumerate the
// cycles with `loopIterations` / `unrollLoops`.

const span10 = {
  start: { anchor: "target", timeSource: "output" as const, anchorPoint: "0%" },
  end: { anchor: "target", timeSource: "output" as const, anchorPoint: "100%" },
};

function comp(fields: Partial<Composition>): Composition {
  return { type: "composition", ...fields } as Composition;
}

describe("underflow: loop — resolver", () => {
  it("marks a looping clip with its single cycle and the full target span", () => {
    const result = resolveComposition(
      comp({
        children: [{ id: "target", type: "clip", source: "a.mp4", in: 0, out: 10 }],
        attachments: [
          { type: "clip", source: "b.mp4", in: 5, out: 8, underflow: "loop", ...span10 },
        ],
      }),
    );
    expect(result.children[1]).toMatchObject({
      type: "clip",
      sourceIn: 5,
      sourceOut: 8,
      speed: 1,
      timelineStart: 0,
      timelineEnd: 10,
      loop: { period: 3, phase: 0 },
    });
    expect(result.duration).toBe(10);
  });

  it("keeps the clip's own rate: the period is the sped cycle length", () => {
    const result = resolveComposition(
      comp({
        children: [{ id: "target", type: "clip", source: "a.mp4", in: 0, out: 5 }],
        attachments: [
          { type: "audio", source: "b.wav", in: 0, out: 4, duration: 2, underflow: "loop", ...span10 },
        ],
      }),
    );
    expect(result.children[1]).toMatchObject({
      type: "audio",
      sourceIn: 0,
      sourceOut: 4,
      speed: 2,
      timelineEnd: 5,
      loop: { period: 2, phase: 0 },
    });
  });

  it("a looping composition keeps one inner window; duration = one cycle", () => {
    // JC's example: a comp holding clip [0.5, 1.5] stretched over 10s should
    // show that second over and over.
    const result = resolveComposition(
      comp({
        children: [{ id: "target", type: "clip", source: "a.mp4", in: 0, out: 10 }],
        attachments: [
          {
            type: "composition",
            underflow: "loop",
            children: [{ type: "clip", in: 0.5, out: 1.5, source: "video.mp4" }],
            ...span10,
          },
        ],
      }),
    );
    const c = result.children[1] as ResolvedComposition;
    expect(c).toMatchObject({
      type: "composition",
      timelineStart: 0,
      timelineEnd: 10,
      duration: 1,
      speed: 1,
      loop: { period: 1, phase: 0 },
    });
    expect(c.children).toHaveLength(1);
    expect(c.children[0]).toMatchObject({
      type: "clip",
      sourceIn: 0.5,
      sourceOut: 1.5,
      timelineStart: 0,
      timelineEnd: 1,
    });
  });

  it("does not loop when the span fits (no underflow)", () => {
    const result = resolveComposition(
      comp({
        children: [{ id: "target", type: "clip", source: "a.mp4", in: 0, out: 2 }],
        attachments: [
          { type: "clip", source: "b.mp4", in: 0, out: 4, underflow: "loop", ...span10 },
        ],
      }),
    );
    // 4s natural into a 2s span is an OVERFLOW → default stretch, no loop.
    const c = result.children[1] as ResolvedClip;
    expect(c.loop).toBeUndefined();
    expect(c.speed).toBe(2);
  });

  it("a window crop advances the phase instead of trimming the cycle", () => {
    // Outer comp windows the inner one from 1s..9s (in/out). The looping
    // attachment inside spans 0..10 with period 3, so the visible part starts
    // 1s into its first cycle.
    const result = resolveComposition(
      comp({
        children: [
          {
            type: "composition",
            in: 1,
            out: 9,
            children: [{ id: "target", type: "clip", source: "a.mp4", in: 0, out: 10 }],
            attachments: [
              { type: "clip", source: "b.mp4", in: 5, out: 8, underflow: "loop", ...span10 },
            ],
          },
        ],
      }),
    );
    const outer = result.children[0] as ResolvedComposition;
    expect(outer.children[1]).toMatchObject({
      type: "clip",
      sourceIn: 5,
      sourceOut: 8,
      timelineStart: 0,
      timelineEnd: 8,
      loop: { period: 3, phase: 1 },
    });
  });

  it("validates", () => {
    const r = parseSeamFile(
      JSON.stringify(
        comp({
          children: [{ id: "t", type: "clip", source: "a.mp4", in: 0, out: 10 }],
          attachments: [{ type: "clip", source: "b.mp4", in: 0, out: 1, underflow: "loop", ...span10 }],
        }),
      ),
    );
    expect(r.success).toBe(true);
  });
});

describe("loop helpers", () => {
  it("loopLocalTime wraps with phase", () => {
    const loop = { period: 3, phase: 1 };
    expect(loopLocalTime(loop, 0)).toBe(1);
    expect(loopLocalTime(loop, 1.5)).toBe(2.5);
    expect(loopLocalTime(loop, 2)).toBe(0);
    expect(loopLocalTime(loop, 7.5)).toBeCloseTo(2.5);
    expect(loopLocalTime(undefined, 42)).toBe(42);
  });

  it("loopIterations tiles the span, first cycle shortened by the phase", () => {
    expect(loopIterations({ period: 3, phase: 0 }, 10)).toEqual([
      { index: 0, start: 0, end: 3, offset: 0 },
      { index: 1, start: 3, end: 6, offset: 0 },
      { index: 2, start: 6, end: 9, offset: 0 },
      { index: 3, start: 9, end: 10, offset: 0 },
    ]);
    expect(loopIterations({ period: 3, phase: 1 }, 8)).toEqual([
      { index: 0, start: 0, end: 2, offset: 1 },
      { index: 1, start: 2, end: 5, offset: 0 },
      { index: 2, start: 5, end: 8, offset: 0 },
    ]);
    expect(loopIterations(undefined, 4)).toEqual([{ index: 0, start: 0, end: 4, offset: 0 }]);
  });

  it("unrollLoops expands a looping clip into trimmed plain clips", () => {
    const result = resolveComposition(
      comp({
        children: [{ id: "target", type: "clip", source: "a.mp4", in: 0, out: 7 }],
        attachments: [
          { type: "clip", source: "b.mp4", in: 5, out: 8, underflow: "loop", ...span10 },
        ],
      }),
    );
    const flat = unrollLoops(result.children);
    expect(flat[0]).toBe(result.children[0]); // untouched passthrough
    const cycles = flat.slice(1) as ResolvedClip[];
    expect(cycles.map((c) => [c.sourceIn, c.sourceOut, c.timelineStart, c.timelineEnd])).toEqual([
      [5, 8, 0, 3],
      [5, 8, 3, 6],
      [5, 6, 6, 7],
    ]);
    expect(cycles.every((c) => c.loop === undefined)).toBe(true);
  });

  it("unrollLoops crops a looping composition's children per cycle", () => {
    const result = resolveComposition(
      comp({
        children: [{ id: "target", type: "clip", source: "a.mp4", in: 0, out: 2.5 }],
        attachments: [
          {
            type: "composition",
            underflow: "loop",
            children: [{ type: "clip", in: 0.5, out: 1.5, source: "video.mp4" }],
            ...span10,
          },
        ],
      }),
    );
    const cycles = unrollLoops(result.children).slice(1) as ResolvedComposition[];
    expect(cycles).toHaveLength(3);
    expect(cycles[2]).toMatchObject({ timelineStart: 2, timelineEnd: 2.5, duration: 0.5 });
    expect(cycles[2].children[0]).toMatchObject({ sourceIn: 0.5, sourceOut: 1, timelineEnd: 0.5 });
    // flattenResolved sees the same cycles as absolute leaves.
    const leaves = flattenResolved(result.children).filter((l) => l.type === "clip" && l.source === "video.mp4");
    expect(leaves.map((l) => [l.timelineStart, l.timelineEnd])).toEqual([[0, 1], [1, 2], [2, 2.5]]);
  });
});

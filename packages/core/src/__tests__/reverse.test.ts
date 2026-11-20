import { describe, it, expect } from "vitest";
import {
  clipIsReversed,
  clipNaturalDuration,
  clipPlayRange,
  clipSourceTime,
  flattenResolved,
  parseSeamFile,
  resolveComposition,
  unrollLoops,
  type Composition,
  type ResolvedClip,
  type ResolvedComposition,
} from "../index.js";

// Reverse playback: `out < in` or a negative `duration` on clip/audio. The
// resolved node keeps an ascending [sourceIn, sourceOut] + positive speed and
// carries `reverse: true`; `clipSourceTime` is the time mapping.

const comp = (children: Composition["children"]): Composition => ({
  type: "composition",
  children,
});

describe("reverse playback — authored helpers", () => {
  it("out < in and negative duration both reverse", () => {
    expect(clipIsReversed({ in: 2, out: 5 })).toBe(false);
    expect(clipIsReversed({ in: 5, out: 2 })).toBe(true);
    expect(clipIsReversed({ in: 5, duration: -3 })).toBe(true);
    expect(clipIsReversed({ in: 5, duration: 3 })).toBe(false);
    // Either signal reverses; they never cancel.
    expect(clipIsReversed({ in: 5, out: 2, duration: -6 })).toBe(true);
    expect(clipIsReversed({ in: 2, out: 5, duration: -3 })).toBe(true);
  });

  it("clipPlayRange is the span in playback order", () => {
    expect(clipPlayRange({ in: 2, out: 5 })).toEqual({ start: 2, end: 5, reverse: false });
    expect(clipPlayRange({ in: 5, out: 2 })).toEqual({ start: 5, end: 2, reverse: true });
    expect(clipPlayRange({ in: 5, duration: -3 })).toEqual({ start: 5, end: 2, reverse: true });
    expect(clipPlayRange({ in: 2, out: 5, duration: -3 })).toEqual({ start: 5, end: 2, reverse: true });
    // Natural length ignores `duration` (a target the strategies fill).
    expect(clipNaturalDuration({ in: 5, out: 2, speed: 2 })).toBe(1.5);
    expect(clipNaturalDuration({ in: 5, out: 1, duration: 8 })).toBe(4);
    expect(clipNaturalDuration({ in: 5, duration: -3 })).toBe(3);
  });

  it("schema accepts reversed spans, rejects empty ones", () => {
    const parse = (child: unknown) =>
      parseSeamFile(JSON.stringify({ type: "composition", children: [child] })).success;
    expect(parse({ type: "clip", source: "a.mp4", in: 5, out: 2 })).toBe(true);
    expect(parse({ type: "clip", source: "a.mp4", in: 5, out: 0 })).toBe(true);
    expect(parse({ type: "clip", source: "a.mp4", in: 5, duration: -3 })).toBe(true);
    expect(parse({ type: "audio", source: "a.wav", in: 5, out: 2 })).toBe(true);
    expect(parse({ type: "audio", source: "a.wav", in: 5, duration: -3 })).toBe(true);
    expect(parse({ type: "clip", source: "a.mp4", in: 5, out: 5 })).toBe(false);
    expect(parse({ type: "clip", source: "a.mp4", in: 5, duration: 0 })).toBe(false);
    expect(parse({ type: "audio", source: "a.wav", in: 1, duration: -3 })).toBe(false);
  });
});

describe("reverse playback — resolver", () => {
  it("resolves to an ascending range + reverse flag", () => {
    const r = resolveComposition(
      comp([
        { type: "clip", source: "a.mp4", in: 5, out: 2 },
        { type: "audio", source: "a.wav", in: 4, duration: -3 },
        { type: "clip", source: "b.mp4", in: 0, out: 2 },
      ]),
    );
    expect(r.children[0]).toMatchObject({
      sourceIn: 2, sourceOut: 5, speed: 1, reverse: true, timelineStart: 0, timelineEnd: 3,
    });
    expect(r.children[1]).toMatchObject({
      sourceIn: 1, sourceOut: 4, speed: 1, reverse: true, timelineStart: 3, timelineEnd: 6,
    });
    expect((r.children[2] as ResolvedClip).reverse).toBeUndefined();
    expect(r.duration).toBe(8);

    const c = r.children[0] as ResolvedClip;
    expect(clipSourceTime(c, 0)).toBe(5);
    expect(clipSourceTime(c, 1)).toBe(4);
    expect(clipSourceTime(c, 3)).toBe(2);
    expect(clipSourceTime(r.children[2] as ResolvedClip, 0.5)).toBe(0.5);
  });

  it("speed and duration set the magnitude", () => {
    const r = resolveComposition(
      comp([
        { type: "clip", source: "a.mp4", in: 6, out: 0, speed: 2 },
        { type: "clip", source: "a.mp4", in: 6, out: 0, duration: 12 },
        { type: "clip", source: "a.mp4", in: 6, out: 0, duration: -12 },
        { type: "clip", source: "a.mp4", in: 0, out: 6, duration: -3 },
      ]),
    );
    expect(r.children[0]).toMatchObject({ sourceIn: 0, sourceOut: 6, speed: 2, reverse: true, timelineEnd: 3 });
    expect(r.children[1]).toMatchObject({ speed: 0.5, reverse: true, timelineStart: 3, timelineEnd: 15 });
    expect(r.children[2]).toMatchObject({ speed: 0.5, reverse: true, timelineStart: 15, timelineEnd: 27 });
    expect(r.children[3]).toMatchObject({ sourceIn: 0, sourceOut: 6, speed: 2, reverse: true, timelineEnd: 30 });
  });

  it("overflow strategies trim in PLAYBACK order", () => {
    const att = (overflow: "trim-end" | "trim-start" | "trim-center" | "stretch") =>
      resolveComposition(
        comp([{ type: "clip", source: "a.mp4", in: 10, out: 4, duration: 2, overflow }]),
      ).children[0] as ResolvedClip;
    // 6s reversed (10 → 4) into 2s. trim-end keeps the first 2s played: 10 → 8.
    expect(att("trim-end")).toMatchObject({ sourceIn: 8, sourceOut: 10, speed: 1, reverse: true });
    // trim-start keeps the last 2s played: 6 → 4.
    expect(att("trim-start")).toMatchObject({ sourceIn: 4, sourceOut: 6, speed: 1, reverse: true });
    expect(att("trim-center")).toMatchObject({ sourceIn: 6, sourceOut: 8, speed: 1, reverse: true });
    expect(att("stretch")).toMatchObject({ sourceIn: 4, sourceOut: 10, speed: 3, reverse: true });
  });

  it("a negative duration with a non-stretch strategy keeps `speed` as the rate", () => {
    const r = resolveComposition(
      comp([
        { type: "clip", source: "a.mp4", in: 10, out: 4, speed: 2, duration: -2, overflow: "trim-end" },
      ]),
    );
    // 6 source-s at 2× = 3s natural, trimmed to 2s: plays 10 → 6.
    expect(r.children[0]).toMatchObject({
      sourceIn: 6, sourceOut: 10, speed: 2, reverse: true, timelineEnd: 2,
    });
  });

  it("underflow extend-end keeps playing past the low end", () => {
    const r = resolveComposition(
      comp([
        { type: "clip", source: "a.mp4", in: 10, out: 8, duration: 5, underflow: "extend-end" },
      ]),
    );
    expect(r.children[0]).toMatchObject({ sourceIn: 5, sourceOut: 10, speed: 1, reverse: true, timelineEnd: 5 });
  });

  it("source-mode anchors land on the reversed node's content moment", () => {
    const r = resolveComposition(
      comp([
        { type: "clip", source: "b.mp4", in: 0, out: 1 },
        { type: "clip", id: "rev", source: "a.mp4", in: 10, out: 4, speed: 2 },
        { type: "text", text: "x", duration: 1, start: "rev@8" },
      ]),
    );
    // rev starts at t=1 showing source 10, falling 2 source-s per output-s:
    // source 8 is 1s in → t=2.
    expect(r.children[2]).toMatchObject({ timelineStart: 2, timelineEnd: 3 });
  });

  it("a composition window crops the playback start off the high end", () => {
    const r = resolveComposition(
      comp([
        {
          type: "composition",
          in: 1,
          out: 4,
          children: [{ type: "clip", source: "a.mp4", in: 10, out: 4 }],
        },
      ]),
    );
    const inner = (r.children[0] as ResolvedComposition).children[0] as ResolvedClip;
    // Clip plays 10 → 4 over inner [0, 6]; window [1, 4] shows 9 → 6.
    expect(inner).toMatchObject({ sourceIn: 6, sourceOut: 9, reverse: true, timelineStart: 0, timelineEnd: 3 });
    expect(clipSourceTime(inner, 0)).toBe(9);
  });

  it("a reversed loop unrolls into reversed cycles", () => {
    const r = resolveComposition(
      comp([{ type: "clip", source: "a.mp4", in: 8, out: 5, duration: 7, underflow: "loop" }]),
    );
    expect(r.children[0]).toMatchObject({
      sourceIn: 5, sourceOut: 8, reverse: true, loop: { period: 3, phase: 0 }, timelineEnd: 7,
    });
    const cycles = unrollLoops(r.children) as ResolvedClip[];
    expect(cycles.map((c) => [c.sourceIn, c.sourceOut, c.timelineStart, c.timelineEnd, c.reverse])).toEqual([
      [5, 8, 0, 3, true],
      [5, 8, 3, 6, true],
      // Last cycle cut short: plays 8 → 7.
      [7, 8, 6, 7, true],
    ]);
    const leaves = flattenResolved(r.children).filter((l) => l.type === "clip") as ResolvedClip[];
    expect(leaves.every((l) => l.reverse === true)).toBe(true);
  });
});

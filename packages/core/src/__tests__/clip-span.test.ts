import { describe, it, expect } from "vitest";
import { clipOut, type Composition } from "../index.js";
import { createSeam } from "../seam.js";

const { parseSeamFile, resolveComposition } = createSeam();

// `in` + `duration` with no `out` on clips/audio: out = in + duration at speed 1.

describe("clip span shorthand", () => {
  it("clipOut defaults to in + duration", () => {
    expect(clipOut({ in: 2, out: 9 })).toBe(9);
    expect(clipOut({ in: 2, duration: 3 })).toBe(5);
    expect(clipOut({ in: 2, out: 9, duration: 3 })).toBe(9);
  });

  it("validates in + duration, rejects neither", () => {
    const ok = parseSeamFile(
      JSON.stringify({
        type: "composition",
        children: [
          { type: "clip", source: "a.mp4", in: 2, duration: 3 },
          { type: "audio", source: "a.wav", in: 0, duration: 1 },
        ],
      }),
    );
    expect(ok.success).toBe(true);
    const bad = parseSeamFile(
      JSON.stringify({ type: "composition", children: [{ type: "clip", source: "a.mp4", in: 2 }] }),
    );
    expect(bad.success).toBe(false);
    if (!bad.success) expect(bad.errors.join(" ")).toMatch(/'out' or 'duration'/);
  });

  it("resolves to [in, in + duration] at speed 1", () => {
    const doc: Composition = {
      type: "composition",
      children: [
        { type: "clip", source: "a.mp4", in: 2, duration: 3 },
        { type: "audio", source: "a.wav", in: 1, duration: 2 },
      ],
    };
    const r = resolveComposition(doc);
    expect(r.children[0]).toMatchObject({ sourceIn: 2, sourceOut: 5, speed: 1, timelineStart: 0, timelineEnd: 3 });
    expect(r.children[1]).toMatchObject({ sourceIn: 1, sourceOut: 3, speed: 1, timelineStart: 3, timelineEnd: 5 });
    expect(r.duration).toBe(5);
  });

  it("an explicit out still derives the rate from duration", () => {
    const r = resolveComposition({
      type: "composition",
      children: [{ type: "clip", source: "a.mp4", in: 0, out: 6, duration: 3 }],
    });
    expect(r.children[0]).toMatchObject({ sourceOut: 6, speed: 2, timelineEnd: 3 });
  });
});

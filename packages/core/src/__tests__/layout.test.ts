import { describe, it, expect } from "vitest";
import { resolveComposition } from "../layout/resolve.js";
import type { Composition } from "../types.js";

function comp(overrides: Partial<Composition> & { children: Composition["children"] }): Composition {
  return {
    type: "composition",
    ...overrides,
  };
}

describe("resolveComposition", () => {
  describe("sequential (no layout)", () => {
    it("places clips sequentially", () => {
      const result = resolveComposition(
        comp({
          children: [
            { type: "clip", source: "a.mp4", in: 0, out: 3, overflow: "trim-end" },
            { type: "clip", source: "b.mp4", in: 5, out: 10, overflow: "trim-end" },
          ],
        })
      );

      expect(result.duration).toBe(8); // 3 + 5
      expect(result.children).toHaveLength(2);
      expect(result.children[0]).toMatchObject({
        type: "clip",
        source: "a.mp4",
        sourceIn: 0,
        sourceOut: 3,
        timelineStart: 0,
        timelineEnd: 3,
        speed: 1,
      });
      expect(result.children[1]).toMatchObject({
        type: "clip",
        source: "b.mp4",
        sourceIn: 5,
        sourceOut: 10,
        timelineStart: 3,
        timelineEnd: 8,
        speed: 1,
      });
    });

    it("handles empty segments", () => {
      const result = resolveComposition(
        comp({
          children: [
            { type: "clip", source: "a.mp4", in: 0, out: 3, overflow: "trim-end" },
            { type: "empty", duration: 2 },
            { type: "clip", source: "b.mp4", in: 0, out: 3, overflow: "trim-end" },
          ],
        })
      );

      expect(result.duration).toBe(8);
      expect(result.children[1]).toMatchObject({
        type: "empty",
        timelineStart: 3,
        timelineEnd: 5,
      });
      expect(result.children[2]).toMatchObject({
        timelineStart: 5,
        timelineEnd: 8,
      });
    });
  });

  describe("gap", () => {
    it("adds gap between children", () => {
      const result = resolveComposition(
        comp({
          layout: { justify: "start", gap: 1 },
          children: [
            { type: "clip", source: "a.mp4", in: 0, out: 3, overflow: "trim-end" },
            { type: "clip", source: "b.mp4", in: 0, out: 3, overflow: "trim-end" },
            { type: "clip", source: "c.mp4", in: 0, out: 3, overflow: "trim-end" },
          ],
        })
      );

      // 3 clips of 3s + 2 gaps of 1s = 11s
      expect(result.duration).toBe(11);
      expect(result.children[0]).toMatchObject({ timelineStart: 0, timelineEnd: 3 });
      expect(result.children[1]).toMatchObject({ timelineStart: 4, timelineEnd: 7 });
      expect(result.children[2]).toMatchObject({ timelineStart: 8, timelineEnd: 11 });
    });
  });

  describe("justify", () => {
    it("justify start (default)", () => {
      const result = resolveComposition(
        comp({
          duration: 20,
          layout: { justify: "start", gap: 0 },
          children: [
            { type: "clip", source: "a.mp4", in: 0, out: 5, overflow: "trim-end" },
            { type: "clip", source: "b.mp4", in: 0, out: 5, overflow: "trim-end" },
          ],
        })
      );

      expect(result.children[0]).toMatchObject({ timelineStart: 0, timelineEnd: 5 });
      expect(result.children[1]).toMatchObject({ timelineStart: 5, timelineEnd: 10 });
    });

    it("justify end", () => {
      const result = resolveComposition(
        comp({
          duration: 20,
          layout: { justify: "end", gap: 0 },
          children: [
            { type: "clip", source: "a.mp4", in: 0, out: 5, overflow: "trim-end" },
            { type: "clip", source: "b.mp4", in: 0, out: 5, overflow: "trim-end" },
          ],
        })
      );

      expect(result.children[0]).toMatchObject({ timelineStart: 10, timelineEnd: 15 });
      expect(result.children[1]).toMatchObject({ timelineStart: 15, timelineEnd: 20 });
    });

    it("justify center", () => {
      const result = resolveComposition(
        comp({
          duration: 20,
          layout: { justify: "center", gap: 0 },
          children: [
            { type: "clip", source: "a.mp4", in: 0, out: 5, overflow: "trim-end" },
            { type: "clip", source: "b.mp4", in: 0, out: 5, overflow: "trim-end" },
          ],
        })
      );

      expect(result.children[0]).toMatchObject({ timelineStart: 5, timelineEnd: 10 });
      expect(result.children[1]).toMatchObject({ timelineStart: 10, timelineEnd: 15 });
    });

    it("justify space-between", () => {
      const result = resolveComposition(
        comp({
          duration: 20,
          layout: { justify: "space-between", gap: 0 },
          children: [
            { type: "clip", source: "a.mp4", in: 0, out: 5, overflow: "trim-end" },
            { type: "clip", source: "b.mp4", in: 0, out: 5, overflow: "trim-end" },
          ],
        })
      );

      // 20 - 10 content = 10 space, 1 gap = 10 between
      expect(result.children[0]).toMatchObject({ timelineStart: 0, timelineEnd: 5 });
      expect(result.children[1]).toMatchObject({ timelineStart: 15, timelineEnd: 20 });
    });
  });

  describe("flex", () => {
    it("distributes equal flex", () => {
      const result = resolveComposition(
        comp({
          duration: 20,
          layout: { justify: "start", gap: 0 },
          children: [
            { type: "clip", source: "a.mp4", in: 0, out: 3, flex: 1, overflow: "trim-end", underflow: "extend-end" },
            { type: "clip", source: "b.mp4", in: 0, out: 3, flex: 1, overflow: "trim-end", underflow: "extend-end" },
          ],
        })
      );

      expect(result.children[0]).toMatchObject({ timelineStart: 0, timelineEnd: 10 });
      expect(result.children[1]).toMatchObject({ timelineStart: 10, timelineEnd: 20 });
    });

    it("distributes proportional flex", () => {
      const result = resolveComposition(
        comp({
          duration: 30,
          layout: { justify: "start", gap: 0 },
          children: [
            { type: "clip", source: "a.mp4", in: 0, out: 5, flex: 1, overflow: "trim-end", underflow: "extend-end" },
            { type: "clip", source: "b.mp4", in: 0, out: 5, flex: 2, overflow: "trim-end", underflow: "extend-end" },
          ],
        })
      );

      expect(result.children[0]).toMatchObject({ timelineStart: 0, timelineEnd: 10 });
      expect(result.children[1]).toMatchObject({ timelineStart: 10, timelineEnd: 30 });
    });

    it("respects non-flex children", () => {
      const result = resolveComposition(
        comp({
          duration: 20,
          layout: { justify: "start", gap: 0 },
          children: [
            { type: "clip", source: "a.mp4", in: 0, out: 5, overflow: "trim-end" },
            { type: "clip", source: "b.mp4", in: 0, out: 3, flex: 1, overflow: "trim-end", underflow: "extend-end" },
          ],
        })
      );

      // non-flex takes 5s, flex gets remaining 15s
      expect(result.children[0]).toMatchObject({ timelineStart: 0, timelineEnd: 5 });
      expect(result.children[1]).toMatchObject({ timelineStart: 5, timelineEnd: 20 });
    });
  });

  describe("overflow", () => {
    it("trim-end cuts the end", () => {
      const result = resolveComposition(
        comp({
          duration: 6,
          layout: { justify: "start", gap: 0 },
          children: [
            { type: "clip", source: "a.mp4", in: 10, out: 20, flex: 1, overflow: "trim-end" },
          ],
        })
      );

      const clip = result.children[0];
      expect(clip.type).toBe("clip");
      if (clip.type === "clip") {
        expect(clip.sourceIn).toBe(10);
        expect(clip.sourceOut).toBe(16);
        expect(clip.speed).toBe(1);
      }
    });

    it("trim-start cuts the start", () => {
      const result = resolveComposition(
        comp({
          duration: 6,
          layout: { justify: "start", gap: 0 },
          children: [
            { type: "clip", source: "a.mp4", in: 10, out: 20, flex: 1, overflow: "trim-start" },
          ],
        })
      );

      const clip = result.children[0];
      if (clip.type === "clip") {
        expect(clip.sourceIn).toBe(14);
        expect(clip.sourceOut).toBe(20);
      }
    });

    it("trim-center trims both ends", () => {
      const result = resolveComposition(
        comp({
          duration: 6,
          layout: { justify: "start", gap: 0 },
          children: [
            { type: "clip", source: "a.mp4", in: 10, out: 20, flex: 1, overflow: "trim-center" },
          ],
        })
      );

      const clip = result.children[0];
      if (clip.type === "clip") {
        expect(clip.sourceIn).toBe(12);
        expect(clip.sourceOut).toBe(18);
      }
    });

    it("stretch speeds up the clip", () => {
      const result = resolveComposition(
        comp({
          duration: 5,
          layout: { justify: "start", gap: 0 },
          children: [
            { type: "clip", source: "a.mp4", in: 0, out: 10, flex: 1, overflow: "stretch" },
          ],
        })
      );

      const clip = result.children[0];
      if (clip.type === "clip") {
        expect(clip.sourceIn).toBe(0);
        expect(clip.sourceOut).toBe(10);
        expect(clip.speed).toBe(2); // 10s content in 5s = 2x speed
      }
    });
  });

  describe("underflow", () => {
    it("extend-end extends the out point", () => {
      const result = resolveComposition(
        comp({
          duration: 10,
          layout: { justify: "start", gap: 0 },
          children: [
            { type: "clip", source: "a.mp4", in: 5, out: 8, flex: 1, overflow: "trim-end", underflow: "extend-end" },
          ],
        })
      );

      const clip = result.children[0];
      if (clip.type === "clip") {
        expect(clip.sourceIn).toBe(5);
        expect(clip.sourceOut).toBe(15);
      }
    });

    it("extend-start extends the in point", () => {
      const result = resolveComposition(
        comp({
          duration: 10,
          layout: { justify: "start", gap: 0 },
          children: [
            { type: "clip", source: "a.mp4", in: 5, out: 8, flex: 1, overflow: "trim-end", underflow: "extend-start" },
          ],
        })
      );

      const clip = result.children[0];
      if (clip.type === "clip") {
        expect(clip.sourceIn).toBe(-2);
        expect(clip.sourceOut).toBe(8);
      }
    });

    it("extend-center extends both ends", () => {
      const result = resolveComposition(
        comp({
          duration: 10,
          layout: { justify: "start", gap: 0 },
          children: [
            { type: "clip", source: "a.mp4", in: 10, out: 14, flex: 1, overflow: "trim-end", underflow: "extend-center" },
          ],
        })
      );

      const clip = result.children[0];
      if (clip.type === "clip") {
        // natural = 4, target = 10, extra = 6, each side = 3
        expect(clip.sourceIn).toBe(7);
        expect(clip.sourceOut).toBe(17);
      }
    });

    it("stretch slows down the clip", () => {
      const result = resolveComposition(
        comp({
          duration: 10,
          layout: { justify: "start", gap: 0 },
          children: [
            { type: "clip", source: "a.mp4", in: 0, out: 5, flex: 1, overflow: "trim-end", underflow: "stretch" },
          ],
        })
      );

      const clip = result.children[0];
      if (clip.type === "clip") {
        expect(clip.sourceIn).toBe(0);
        expect(clip.sourceOut).toBe(5);
        expect(clip.speed).toBe(0.5); // 5s content over 10s = 0.5x speed
      }
    });

    it("no underflow strategy leaves silence", () => {
      const result = resolveComposition(
        comp({
          duration: 10,
          layout: { justify: "start", gap: 0 },
          children: [
            { type: "clip", source: "a.mp4", in: 0, out: 3, flex: 1, overflow: "trim-end" },
          ],
        })
      );

      const clip = result.children[0];
      if (clip.type === "clip") {
        // Without underflow, clip keeps its natural 3s duration
        expect(clip.sourceIn).toBe(0);
        expect(clip.sourceOut).toBe(3);
        expect(clip.speed).toBe(1);
      }
    });
  });

  describe("unitDuration", () => {
    it("assigns unitDuration to each child", () => {
      const result = resolveComposition(
        comp({
          unitDuration: 5,
          children: [
            { type: "clip", source: "a.mp4", in: 0, out: 10, overflow: "trim-end" },
            { type: "clip", source: "b.mp4", in: 0, out: 10, overflow: "trim-end" },
            { type: "clip", source: "c.mp4", in: 0, out: 10, overflow: "trim-end" },
          ],
        })
      );

      // 3 children × flex 1 × unitDuration 5 = 15s
      expect(result.duration).toBe(15);
      expect(result.children[0]).toMatchObject({ timelineStart: 0, timelineEnd: 5 });
      expect(result.children[1]).toMatchObject({ timelineStart: 5, timelineEnd: 10 });
      expect(result.children[2]).toMatchObject({ timelineStart: 10, timelineEnd: 15 });
    });

    it("includes gap in container duration", () => {
      const result = resolveComposition(
        comp({
          unitDuration: 5,
          layout: { justify: "start", gap: 1 },
          children: [
            { type: "clip", source: "a.mp4", in: 0, out: 10, overflow: "trim-end" },
            { type: "clip", source: "b.mp4", in: 0, out: 10, overflow: "trim-end" },
            { type: "clip", source: "c.mp4", in: 0, out: 10, overflow: "trim-end" },
          ],
        })
      );

      // 3 × 5 + 2 gaps × 1 = 17s
      expect(result.duration).toBe(17);
      expect(result.children[0]).toMatchObject({ timelineStart: 0, timelineEnd: 5 });
      expect(result.children[1]).toMatchObject({ timelineStart: 6, timelineEnd: 11 });
      expect(result.children[2]).toMatchObject({ timelineStart: 12, timelineEnd: 17 });
    });

    it("respects flex weights", () => {
      const result = resolveComposition(
        comp({
          unitDuration: 5,
          children: [
            { type: "clip", source: "a.mp4", in: 0, out: 10, overflow: "trim-end" },
            { type: "clip", source: "b.mp4", in: 0, out: 20, flex: 2, overflow: "trim-end" },
            { type: "clip", source: "c.mp4", in: 0, out: 10, overflow: "trim-end" },
          ],
        })
      );

      // flex values: 1, 2, 1 → totalFlex = 4 → container = 5 * 4 = 20s
      expect(result.duration).toBe(20);
      expect(result.children[0]).toMatchObject({ timelineStart: 0, timelineEnd: 5 });
      expect(result.children[1]).toMatchObject({ timelineStart: 5, timelineEnd: 15 });
      expect(result.children[2]).toMatchObject({ timelineStart: 15, timelineEnd: 20 });
    });
  });

  describe("promoted duration", () => {
    it("works at top level (same as old layout.duration)", () => {
      const result = resolveComposition(
        comp({
          duration: 20,
          children: [
            { type: "clip", source: "a.mp4", in: 0, out: 5, overflow: "trim-end" },
            { type: "clip", source: "b.mp4", in: 0, out: 5, overflow: "trim-end" },
          ],
        })
      );

      expect(result.duration).toBe(20);
      expect(result.children[0]).toMatchObject({ timelineStart: 0, timelineEnd: 5 });
      expect(result.children[1]).toMatchObject({ timelineStart: 5, timelineEnd: 10 });
    });
  });

  describe("nested compositions", () => {
    it("resolves a nested composition preserving hierarchy", () => {
      const result = resolveComposition(
        comp({
          children: [
            { type: "clip", source: "a.mp4", in: 0, out: 3, overflow: "trim-end" },
            {
              type: "composition",
              overflow: "trim-end",
              children: [
                { type: "clip", source: "inner.mp4", in: 0, out: 5, overflow: "trim-end" },
              ],
              in: 0,
              out: 5,
            },
          ],
        })
      );

      expect(result.duration).toBe(8);
      expect(result.children).toHaveLength(2);
      expect(result.children[0]).toMatchObject({
        type: "clip",
        source: "a.mp4",
        timelineStart: 0,
        timelineEnd: 3,
      });

      const nested = result.children[1];
      expect(nested.type).toBe("composition");
      if (nested.type === "composition") {
        expect(nested.timelineStart).toBe(3);
        expect(nested.timelineEnd).toBe(8);
        expect(nested.duration).toBe(5);
        expect(nested.speed).toBe(1);
        expect(nested.children).toHaveLength(1);
        expect(nested.children[0]).toMatchObject({
          type: "clip",
          source: "inner.mp4",
          sourceIn: 0,
          sourceOut: 5,
        });
      }
    });

    it("crops nested composition to window", () => {
      const result = resolveComposition(
        comp({
          duration: 5,
          layout: { justify: "start", gap: 0 },
          children: [
            {
              type: "composition",
              overflow: "trim-end",
              flex: 1,
              children: [
                { type: "clip", source: "x.mp4", in: 0, out: 4, overflow: "trim-end" },
                { type: "clip", source: "y.mp4", in: 0, out: 6, overflow: "trim-end" },
              ],
              in: 0,
              out: 10,
            },
          ],
        })
      );

      // Container is 5s, inner composition has 10s natural → trim-end to 5s
      const nested = result.children[0];
      expect(nested.type).toBe("composition");
      if (nested.type === "composition") {
        expect(nested.duration).toBe(5);
        // x.mp4 (0-4) is fully inside window 0-5
        // y.mp4 (4-10) is cropped to 4-5
        expect(nested.children).toHaveLength(2);
        expect(nested.children[0]).toMatchObject({
          type: "clip",
          source: "x.mp4",
          sourceIn: 0,
          sourceOut: 4,
          timelineStart: 0,
          timelineEnd: 4,
        });
        expect(nested.children[1]).toMatchObject({
          type: "clip",
          source: "y.mp4",
          sourceIn: 0,
          sourceOut: 1,
          timelineStart: 4,
          timelineEnd: 5,
        });
      }
    });
  });
});

describe("resolveComposition (speed & filters)", () => {
  describe("clip speed and duration", () => {
    it("clip speed changes natural duration", () => {
      const result = resolveComposition(
        comp({
          children: [
            { type: "clip", source: "a.mp4", in: 0, out: 10, speed: 2 },
          ],
        })
      );

      expect(result.duration).toBe(5); // 10 / 2
      const clip = result.children[0];
      expect(clip.type).toBe("clip");
      if (clip.type === "clip") {
        expect(clip.speed).toBe(2);
        expect(clip.sourceIn).toBe(0);
        expect(clip.sourceOut).toBe(10);
      }
    });

    it("clip duration stretches to fit", () => {
      const result = resolveComposition(
        comp({
          children: [
            { type: "clip", source: "a.mp4", in: 0, out: 10, duration: 20 },
          ],
        })
      );

      expect(result.duration).toBe(20);
      const clip = result.children[0];
      if (clip.type === "clip") {
        expect(clip.speed).toBe(0.5); // 10 / 20
        expect(clip.sourceIn).toBe(0);
        expect(clip.sourceOut).toBe(10);
      }
    });

    it("clip speed compounds with overflow stretch", () => {
      const result = resolveComposition(
        comp({
          duration: 2.5,
          children: [
            { type: "clip", source: "a.mp4", in: 0, out: 10, speed: 2, flex: 1, overflow: "stretch" },
          ],
        })
      );

      // nat = 10/2 = 5, target = 2.5, overflow stretch
      // sourceTarget = 2.5 * 2 = 5, overflowSpeed = 10/5 = 2, final = 2 * 2 = 4
      const clip = result.children[0];
      if (clip.type === "clip") {
        expect(clip.speed).toBe(4);
        expect(clip.sourceIn).toBe(0);
        expect(clip.sourceOut).toBe(10);
      }
    });

    it("clip speed compounds with overflow trim", () => {
      const result = resolveComposition(
        comp({
          duration: 2.5,
          children: [
            { type: "clip", source: "a.mp4", in: 0, out: 10, speed: 2, flex: 1, overflow: "trim-end" },
          ],
        })
      );

      // nat = 5, target = 2.5, trim-end
      // sourceTarget = 2.5 * 2 = 5, trim to sourceOut = 0 + 5 = 5
      const clip = result.children[0];
      if (clip.type === "clip") {
        expect(clip.speed).toBe(2);
        expect(clip.sourceIn).toBe(0);
        expect(clip.sourceOut).toBe(5);
        expect(clip.timelineEnd - clip.timelineStart).toBeCloseTo(2.5);
      }
    });

    it("clips with speed are placed sequentially using adjusted duration", () => {
      const result = resolveComposition(
        comp({
          children: [
            { type: "clip", source: "a.mp4", in: 0, out: 10, speed: 2 },
            { type: "clip", source: "b.mp4", in: 0, out: 6, speed: 3 },
          ],
        })
      );

      expect(result.duration).toBe(7); // 5 + 2
      expect(result.children[0].timelineStart).toBe(0);
      expect(result.children[0].timelineEnd).toBe(5);
      expect(result.children[1].timelineStart).toBe(5);
      expect(result.children[1].timelineEnd).toBe(7);
    });
  });

  it("passes filters through to resolved clips", () => {
    const filters = [
      { type: "adjust" as const, brightness: 0.5 },
      { type: "opacity" as const, value: 0.8 },
    ];
    const result = resolveComposition(
      comp({
        children: [
          { type: "clip", source: "v.mp4", in: 0, out: 5, filters },
        ],
      })
    );
    const clip = result.children[0];
    expect(clip.type).toBe("clip");
    if (clip.type === "clip") {
      expect(clip.filters).toEqual(filters);
    }
  });

  it("passes filters through to resolved compositions", () => {
    const filters = [{ type: "adjust" as const, saturation: 0 }];
    const result = resolveComposition(
      comp({
        children: [
          {
            type: "composition",
            filters,
            children: [
              { type: "clip", source: "v.mp4", in: 0, out: 5 },
            ],
          },
        ],
      })
    );
    const child = result.children[0];
    expect(child.type).toBe("composition");
    if (child.type === "composition") {
      expect(child.filters).toEqual(filters);
    }
  });
});

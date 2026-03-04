import { describe, it, expect } from "vitest";
import { resolveComposition } from "../layout/resolve.js";
import type { Composition } from "../types.js";

function comp(overrides: Partial<Composition> & { children: Composition["children"] }): Composition {
  return {
    type: "composition",
    overflow: "trim-end",
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
          layout: { duration: 20, justify: "start", gap: 0 },
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
          layout: { duration: 20, justify: "end", gap: 0 },
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
          layout: { duration: 20, justify: "center", gap: 0 },
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
          layout: { duration: 20, justify: "space-between", gap: 0 },
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
          layout: { duration: 20, justify: "start", gap: 0 },
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
          layout: { duration: 30, justify: "start", gap: 0 },
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
          layout: { duration: 20, justify: "start", gap: 0 },
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
          layout: { duration: 6, justify: "start", gap: 0 },
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
          layout: { duration: 6, justify: "start", gap: 0 },
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
          layout: { duration: 6, justify: "start", gap: 0 },
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
          layout: { duration: 5, justify: "start", gap: 0 },
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
          layout: { duration: 10, justify: "start", gap: 0 },
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
          layout: { duration: 10, justify: "start", gap: 0 },
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
          layout: { duration: 10, justify: "start", gap: 0 },
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
          layout: { duration: 10, justify: "start", gap: 0 },
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
          layout: { duration: 10, justify: "start", gap: 0 },
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

  describe("nested compositions", () => {
    it("resolves a nested composition", () => {
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
    });
  });
});

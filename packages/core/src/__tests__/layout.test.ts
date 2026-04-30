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
  describe("sequential placement", () => {
    it("places clips sequentially", () => {
      const result = resolveComposition(
        comp({
          children: [
            { type: "clip", source: "a.mp4", in: 0, out: 3 },
            { type: "clip", source: "b.mp4", in: 5, out: 10 },
          ],
        })
      );

      expect(result.duration).toBe(8);
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
            { type: "clip", source: "a.mp4", in: 0, out: 3 },
            { type: "empty", duration: 2 },
            { type: "clip", source: "b.mp4", in: 0, out: 3 },
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

  describe("clip speed and duration", () => {
    it("clip speed changes natural duration", () => {
      const result = resolveComposition(
        comp({
          children: [
            { type: "clip", source: "a.mp4", in: 0, out: 10, speed: 2 },
          ],
        })
      );

      expect(result.duration).toBe(5);
      const clip = result.children[0];
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
        expect(clip.speed).toBe(0.5);
        expect(clip.sourceIn).toBe(0);
        expect(clip.sourceOut).toBe(10);
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

      expect(result.duration).toBe(7);
      expect(result.children[0].timelineStart).toBe(0);
      expect(result.children[0].timelineEnd).toBe(5);
      expect(result.children[1].timelineStart).toBe(5);
      expect(result.children[1].timelineEnd).toBe(7);
    });
  });

  describe("filters", () => {
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
      if (child.type === "composition") {
        expect(child.filters).toEqual(filters);
      }
    });
  });

  describe("nested compositions", () => {
    it("resolves a nested composition preserving hierarchy", () => {
      const result = resolveComposition(
        comp({
          children: [
            { type: "clip", source: "a.mp4", in: 0, out: 3 },
            {
              type: "composition",
              children: [
                { type: "clip", source: "inner.mp4", in: 0, out: 5 },
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

    it("crops nested composition to its in/out window", () => {
      const result = resolveComposition(
        comp({
          children: [
            {
              type: "composition",
              children: [
                { type: "clip", source: "x.mp4", in: 0, out: 4 },
                { type: "clip", source: "y.mp4", in: 0, out: 6 },
              ],
              in: 0,
              out: 5,
            },
          ],
        })
      );

      const nested = result.children[0];
      if (nested.type === "composition") {
        expect(nested.duration).toBe(5);
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

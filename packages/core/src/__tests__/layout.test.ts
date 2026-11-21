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

    it("expresses a gap with a positive offset", () => {
      const result = resolveComposition(
        comp({
          children: [
            { type: "clip", source: "a.mp4", in: 0, out: 3 },
            { type: "clip", source: "b.mp4", in: 0, out: 3, offset: 2 },
          ],
        })
      );

      expect(result.duration).toBe(8);
      expect(result.children).toHaveLength(2);
      expect(result.children[1]).toMatchObject({
        timelineStart: 5,
        timelineEnd: 8,
      });
    });
  });

  describe("negative offset (crossfade overlap)", () => {
    it("overlaps a child with its previous sibling and shrinks the total", () => {
      // A (5s) + B (5s, pulled back 1s) = 9s; B starts at 4, overlap [4,5].
      const result = resolveComposition(
        comp({
          children: [
            { type: "clip", source: "a.mp4", in: 0, out: 5 },
            { type: "clip", source: "b.mp4", in: 0, out: 5, offset: -1 },
          ],
        })
      );
      expect(result.duration).toBe(9);
      expect(result.children[0]).toMatchObject({
        timelineStart: 0,
        timelineEnd: 5,
        transitionOut: 1,
      });
      expect(result.children[1]).toMatchObject({
        timelineStart: 4,
        timelineEnd: 9,
        transition: 1,
      });
      // First child never carries a transition.
      expect((result.children[0] as { transition?: number }).transition).toBeUndefined();
    });

    it("a negative offset on the first child is a crop, never a transition", () => {
      const result = resolveComposition(
        comp({
          children: [
            { type: "clip", source: "a.mp4", in: 0, out: 5, offset: -2 },
            { type: "clip", source: "b.mp4", in: 0, out: 5 },
          ],
        })
      );
      // A lands at [-2, 3] → cropped to [0, 3] (source [2, 5]); B follows.
      expect(result.duration).toBe(8);
      expect(result.children[0]).toMatchObject({
        sourceIn: 2,
        sourceOut: 5,
        timelineStart: 0,
        timelineEnd: 3,
      });
      expect(result.children[1]).toMatchObject({ timelineStart: 3, timelineEnd: 8 });
      expect((result.children[0] as { transition?: number }).transition).toBeUndefined();
      expect((result.children[1] as { transition?: number }).transition).toBeUndefined();
    });

    it("clamps the fade (not the position) to the shorter of the two neighbours", () => {
      // B is pulled back 2.5s over a 2s A: the fade clamps to A's 2s, but B's
      // position uses the raw offset (3 + 2 − 2.5 = 2.5).
      const result = resolveComposition(
        comp({
          children: [
            { type: "clip", source: "lead.mp4", in: 0, out: 3 },
            { type: "clip", source: "a.mp4", in: 0, out: 2 },
            { type: "clip", source: "b.mp4", in: 0, out: 4, offset: -2.5 },
          ],
        })
      );
      expect(result.children[1]).toMatchObject({ timelineStart: 3, timelineEnd: 5, transitionOut: 2 });
      expect(result.children[2]).toMatchObject({
        timelineStart: 2.5,
        timelineEnd: 6.5,
        transition: 2,
      });
      expect(result.duration).toBe(6.5);
    });

    it("chains overlaps across several children", () => {
      // 5 + (5-1) + (5-1) = 13.
      const result = resolveComposition(
        comp({
          children: [
            { type: "clip", source: "a.mp4", in: 0, out: 5 },
            { type: "clip", source: "b.mp4", in: 0, out: 5, offset: -1 },
            { type: "clip", source: "c.mp4", in: 0, out: 5, offset: -1 },
          ],
        })
      );
      expect(result.duration).toBe(13);
      expect(result.children[1]).toMatchObject({ timelineStart: 4, timelineEnd: 9 });
      expect(result.children[2]).toMatchObject({ timelineStart: 8, timelineEnd: 13 });
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

  describe("composition speed and duration", () => {
    // Inner timeline is 6s (two 3s clips); the window defaults to [0, 6].
    const inner = () => [
      { type: "clip" as const, source: "a.mp4", in: 0, out: 3 },
      { type: "clip" as const, source: "b.mp4", in: 0, out: 3 },
    ];

    it("speed shortens the composition's output and is carried through", () => {
      const result = resolveComposition(
        comp({
          children: [{ type: "composition", children: inner(), speed: 2 }],
        })
      );
      const nested = result.children[0];
      expect(nested.type).toBe("composition");
      if (nested.type === "composition") {
        expect(nested.speed).toBe(2);
        expect(nested.duration).toBe(3); // 6s window / 2
        expect(nested.timelineStart).toBe(0);
        expect(nested.timelineEnd).toBe(3);
        // Window covers the whole inner timeline — both children survive.
        expect(nested.children).toHaveLength(2);
      }
      expect(result.duration).toBe(3);
    });

    it("explicit duration sets output and derives the speed (no trim)", () => {
      const result = resolveComposition(
        comp({
          children: [{ type: "composition", children: inner(), duration: 12 }],
        })
      );
      const nested = result.children[0];
      if (nested.type === "composition") {
        expect(nested.duration).toBe(12);
        expect(nested.speed).toBe(0.5); // 6s window / 12s output
        // Time-scaled, not trimmed: both inner children remain.
        expect(nested.children).toHaveLength(2);
      }
    });

    it("speed composes with an in/out window", () => {
      // Window [1, 5] is 4s of inner timeline; speed 2 → 2s output.
      const result = resolveComposition(
        comp({
          children: [
            { type: "composition", children: inner(), in: 1, out: 5, speed: 2 },
          ],
        })
      );
      const nested = result.children[0];
      if (nested.type === "composition") {
        expect(nested.speed).toBe(2);
        expect(nested.duration).toBe(2);
      }
    });

    it("an explicit duration shorter than the window speeds it up", () => {
      const result = resolveComposition(
        comp({
          children: [{ type: "composition", children: inner(), duration: 2 }],
        })
      );
      const nested = result.children[0];
      expect(nested.type).toBe("composition");
      if (nested.type === "composition") {
        expect(nested.duration).toBe(2);
        expect(nested.speed).toBe(3);
        expect(nested.children).toHaveLength(2);
      }
      expect(result.duration).toBe(2);
    });

    it("a non-stretch strategy layers on top of the base speed", () => {
      // speed 2 → natural output 3s; `duration: 2` with trim-end keeps the
      // rate and cuts the window to the first 4 inner seconds.
      const result = resolveComposition(
        comp({
          children: [
            { type: "clip", source: "bg.mp4", in: 0, out: 6, id: "bg" },
            {
              type: "composition",
              children: inner(),
              speed: 2,
              duration: 2,
              overflow: "trim-end",
              start: "bg",
            },
          ],
        })
      );
      const over = result.children[1];
      expect(over.type).toBe("composition");
      if (over.type === "composition") {
        expect(over.timelineStart).toBe(0);
        expect(over.timelineEnd).toBe(2);
        expect(over.duration).toBe(2);
        expect(over.speed).toBe(2);
        expect(over.children).toHaveLength(2);
        expect(over.children[1]).toMatchObject({
          sourceIn: 0,
          sourceOut: 1,
          timelineStart: 3,
          timelineEnd: 4,
        });
      }
      expect(result.duration).toBe(6);
    });
  });

  describe("filters", () => {
    it("passes filters + opacity through to resolved clips", () => {
      const filters = [{ type: "adjust" as const, brightness: 0.5 }];
      const result = resolveComposition(
        comp({
          children: [
            { type: "clip", source: "v.mp4", in: 0, out: 5, filters, opacity: 0.8 },
          ],
        })
      );
      const clip = result.children[0];
      if (clip.type === "clip") {
        expect(clip.filters).toEqual(filters);
        expect(clip.opacity).toBe(0.8);
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

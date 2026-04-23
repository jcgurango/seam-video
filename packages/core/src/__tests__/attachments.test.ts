import { describe, it, expect } from "vitest";
import { resolveComposition } from "../layout/resolve.js";
import type { Composition } from "../types.js";

function comp(
  overrides: Partial<Composition> & { children: Composition["children"] }
): Composition {
  return { type: "composition", ...overrides };
}

describe("attachments", () => {
  it("positions an attachment with no start/end at composition t=0", () => {
    const result = resolveComposition(
      comp({
        children: [{ type: "clip", source: "a.mp4", in: 0, out: 5 }],
        attachments: [{ type: "clip", source: "b.mp4", in: 0, out: 2 }],
      })
    );

    expect(result.children).toHaveLength(2);
    expect(result.children[1]).toMatchObject({
      source: "b.mp4",
      timelineStart: 0,
      timelineEnd: 2,
    });
  });

  it("places an attachment at an absolute offset when no anchor is given", () => {
    const result = resolveComposition(
      comp({
        children: [{ type: "clip", source: "a.mp4", in: 0, out: 10 }],
        attachments: [
          {
            type: "clip",
            source: "b.mp4",
            in: 0,
            out: 2,
            start: { offset: 3 },
          },
        ],
      })
    );

    expect(result.children[1]).toMatchObject({
      source: "b.mp4",
      timelineStart: 3,
      timelineEnd: 5,
    });
  });

  it("anchors start to a child by id with default anchorPoint=0%", () => {
    const result = resolveComposition(
      comp({
        children: [
          { type: "clip", source: "a.mp4", in: 0, out: 4 },
          { id: "target", type: "clip", source: "b.mp4", in: 0, out: 6 },
        ],
        attachments: [
          {
            type: "clip",
            source: "c.mp4",
            in: 0,
            out: 2,
            start: { anchor: "target" },
          },
        ],
      })
    );

    // target occupies [4, 10]; attachment starts at 4.
    expect(result.children[2]).toMatchObject({
      source: "c.mp4",
      timelineStart: 4,
      timelineEnd: 6,
    });
  });

  it("anchors to a percentage point of the anchor", () => {
    const result = resolveComposition(
      comp({
        children: [
          { id: "target", type: "clip", source: "a.mp4", in: 0, out: 10 },
        ],
        attachments: [
          {
            type: "clip",
            source: "b.mp4",
            in: 0,
            out: 2,
            start: { anchor: "target", anchorPoint: "50%" },
          },
        ],
      })
    );

    // 50% of [0, 10] = 5
    expect(result.children[1]).toMatchObject({
      timelineStart: 5,
      timelineEnd: 7,
    });
  });

  it("supports numeric offset with an anchor", () => {
    const result = resolveComposition(
      comp({
        children: [
          { id: "target", type: "clip", source: "a.mp4", in: 0, out: 10 },
        ],
        attachments: [
          {
            type: "clip",
            source: "b.mp4",
            in: 0,
            out: 2,
            start: { anchor: "target", anchorPoint: "100%", offset: -3 },
          },
        ],
      })
    );

    // 100% of [0, 10] = 10; offset -3 → 7
    expect(result.children[1]).toMatchObject({
      timelineStart: 7,
      timelineEnd: 9,
    });
  });

  it("supports percentage offset as a fraction of the anchor length", () => {
    const result = resolveComposition(
      comp({
        children: [
          { id: "target", type: "clip", source: "a.mp4", in: 0, out: 8 },
        ],
        attachments: [
          {
            type: "clip",
            source: "b.mp4",
            in: 0,
            out: 2,
            start: { anchor: "target", offset: "25%" },
          },
        ],
      })
    );

    // anchorPoint 0% = 0, + 25% of 8 = 2
    expect(result.children[1]).toMatchObject({
      timelineStart: 2,
      timelineEnd: 4,
    });
  });

  it("stretches a clip to fit when both start and end are anchored", () => {
    const result = resolveComposition(
      comp({
        children: [
          { id: "target", type: "clip", source: "a.mp4", in: 0, out: 10 },
        ],
        attachments: [
          {
            type: "clip",
            source: "b.mp4",
            in: 0,
            out: 4,
            start: { anchor: "target", anchorPoint: "0%" },
            end: { anchor: "target", anchorPoint: "100%" },
          },
        ],
      })
    );

    // natural 4s stretched to 10s on timeline → speed 0.4
    expect(result.children[1]).toMatchObject({
      source: "b.mp4",
      sourceIn: 0,
      sourceOut: 4,
      timelineStart: 0,
      timelineEnd: 10,
      speed: 0.4,
    });
  });

  it("anchors end only, positioning relative to the anchored end time", () => {
    const result = resolveComposition(
      comp({
        children: [
          { id: "target", type: "clip", source: "a.mp4", in: 0, out: 10 },
        ],
        attachments: [
          {
            type: "clip",
            source: "b.mp4",
            in: 0,
            out: 3,
            end: { anchor: "target", anchorPoint: "100%" },
          },
        ],
      })
    );

    // end at 10, natural 3 → start 7
    expect(result.children[1]).toMatchObject({
      timelineStart: 7,
      timelineEnd: 10,
    });
  });

  it("renders attachments after children (last on top in z-order)", () => {
    const result = resolveComposition(
      comp({
        children: [{ type: "clip", source: "base.mp4", in: 0, out: 5 }],
        attachments: [
          { type: "clip", source: "over1.mp4", in: 0, out: 2 },
          { type: "clip", source: "over2.mp4", in: 0, out: 2 },
        ],
      })
    );

    expect(result.children.map((c) => (c as { source?: string }).source)).toEqual([
      "base.mp4",
      "over1.mp4",
      "over2.mp4",
    ]);
  });

  it("throws on unknown anchor id", () => {
    expect(() =>
      resolveComposition(
        comp({
          children: [{ type: "clip", source: "a.mp4", in: 0, out: 5 }],
          attachments: [
            {
              type: "clip",
              source: "b.mp4",
              in: 0,
              out: 2,
              start: { anchor: "missing" },
            },
          ],
        })
      )
    ).toThrow(/anchor "missing" not found/);
  });

  it("throws on duplicate ids", () => {
    expect(() =>
      resolveComposition(
        comp({
          children: [
            { id: "x", type: "clip", source: "a.mp4", in: 0, out: 2 },
            { id: "x", type: "clip", source: "b.mp4", in: 0, out: 2 },
          ],
        })
      )
    ).toThrow(/duplicate id/);
  });

  it("throws when end is before start", () => {
    expect(() =>
      resolveComposition(
        comp({
          children: [
            { id: "target", type: "clip", source: "a.mp4", in: 0, out: 10 },
          ],
          attachments: [
            {
              type: "clip",
              source: "b.mp4",
              in: 0,
              out: 2,
              start: { anchor: "target", anchorPoint: "80%" },
              end: { anchor: "target", anchorPoint: "20%" },
            },
          ],
        })
      )
    ).toThrow(/end .* must be after start/);
  });

  it("resolves attachments inside a ref def (inlined wrapper preserves id/start/end)", () => {
    const result = resolveComposition(
      comp({
        refs: {
          overlay_clip: { type: "clip", source: "over.mp4", in: 0, out: 2 },
        },
        children: [
          { id: "base", type: "clip", source: "a.mp4", in: 0, out: 10 },
        ],
        attachments: [
          {
            type: "ref",
            source: "overlay_clip",
            start: { anchor: "base", anchorPoint: "50%" },
          },
        ],
      })
    );

    // ref inlines to a composition wrapper carrying start; anchor "base" is
    // at [0, 10], 50% = 5. Wrapper's inner (the clip) is 2s long.
    expect(result.children[1]).toMatchObject({
      type: "composition",
      timelineStart: 5,
      timelineEnd: 7,
    });
  });

  it("lets a later attachment anchor to an earlier attachment by id", () => {
    const result = resolveComposition(
      comp({
        children: [{ type: "clip", source: "a.mp4", in: 0, out: 5 }],
        attachments: [
          {
            id: "first",
            type: "clip",
            source: "b.mp4",
            in: 0,
            out: 3,
            start: { offset: 1 },
          },
          {
            type: "clip",
            source: "c.mp4",
            in: 0,
            out: 2,
            start: { anchor: "first", anchorPoint: "100%" },
          },
        ],
      })
    );

    // first runs [1, 4], second starts at end of first → [4, 6]
    expect(result.children[2]).toMatchObject({
      source: "c.mp4",
      timelineStart: 4,
      timelineEnd: 6,
    });
  });
});

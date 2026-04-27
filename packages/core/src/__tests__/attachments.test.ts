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
            start: { anchor: "target", timeSource: "output" },
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
            start: { anchor: "target", timeSource: "output", anchorPoint: "50%" },
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
            start: { anchor: "target", timeSource: "output", anchorPoint: "100%", offset: -3 },
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

  it("supports percentage offset as a fraction of the attachment's natural duration", () => {
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
            start: { anchor: "target", timeSource: "output", offset: "25%" },
          },
        ],
      })
    );

    // anchorPoint 0% = 0, + 25% of attachment's 2s natural = 0.5
    expect(result.children[1]).toMatchObject({
      timelineStart: 0.5,
      timelineEnd: 2.5,
    });
  });

  it("allows percentage offset without an anchor (relative to attachment)", () => {
    const result = resolveComposition(
      comp({
        children: [{ type: "clip", source: "a.mp4", in: 0, out: 10 }],
        attachments: [
          {
            type: "clip",
            source: "b.mp4",
            in: 0,
            out: 4,
            start: { offset: "50%" },
          },
        ],
      })
    );

    // 50% of attachment's 4s natural = 2 → start at 2 from composition origin
    expect(result.children[1]).toMatchObject({
      source: "b.mp4",
      timelineStart: 2,
      timelineEnd: 6,
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
            start: { anchor: "target", timeSource: "output", anchorPoint: "0%" },
            end: { anchor: "target", timeSource: "output", anchorPoint: "100%" },
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
            end: { anchor: "target", timeSource: "output", anchorPoint: "100%" },
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
              start: { anchor: "missing", timeSource: "output" },
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
              start: { anchor: "target", timeSource: "output", anchorPoint: "80%" },
              end: { anchor: "target", timeSource: "output", anchorPoint: "20%" },
            },
          ],
        })
      )
    ).toThrow(/end .* must be after start/);
  });

  it("throws when an anchor is given without timeSource", () => {
    expect(() =>
      resolveComposition(
        comp({
          children: [
            { id: "target", type: "clip", source: "a.mp4", in: 0, out: 5 },
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
      )
    ).toThrow(/'timeSource' is required/);
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
            start: { anchor: "base", timeSource: "output", anchorPoint: "50%" },
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

  describe("timeSource: source", () => {
    it("reverse-engineers source time to negative timeline when anchorPoint is before the clip's sourceIn", () => {
      // The user's example: myclip is in=2 out=4 (source window [2,4]);
      // anchoring to source time 1 should land at output t=-1.
      const result = resolveComposition(
        comp({
          children: [
            { id: "myclip", type: "clip", source: "video.mp4", in: 2, out: 4 },
          ],
          attachments: [
            {
              type: "clip",
              source: "othervideo.mp4",
              in: 0,
              out: 5,
              start: {
                anchor: "myclip",
                timeSource: "source",
                anchorPoint: 1,
                offset: 0,
              },
            },
          ],
        })
      );

      expect(result.children[1]).toMatchObject({
        source: "othervideo.mp4",
        timelineStart: -1,
        timelineEnd: 4,
      });
    });

    it("maps source seconds to output time, accounting for speed", () => {
      const result = resolveComposition(
        comp({
          children: [
            // clip plays source [0, 10] at 2x speed → output [0, 5]
            {
              id: "fast",
              type: "clip",
              source: "a.mp4",
              in: 0,
              out: 10,
              speed: 2,
            },
          ],
          attachments: [
            {
              type: "clip",
              source: "b.mp4",
              in: 0,
              out: 1,
              start: {
                anchor: "fast",
                timeSource: "source",
                anchorPoint: 6,
              },
            },
          ],
        })
      );

      // source_time 6 on a 2x clip → output_time = 0 + (6 - 0) / 2 = 3
      expect(result.children[1]).toMatchObject({
        source: "b.mp4",
        timelineStart: 3,
        timelineEnd: 4,
      });
    });

    it("anchors to a source time inside a composition's inner timeline (pre-window)", () => {
      // Inner comp has children summing to 10s. Windowed to [2, 8] on inner.
      // Source time 4 should land at output (4 - 2) / 1 = 2 of the windowed
      // composition's visible range.
      const result = resolveComposition(
        comp({
          children: [
            {
              id: "comp",
              type: "composition",
              in: 2,
              out: 8,
              children: [
                { type: "clip", source: "a.mp4", in: 0, out: 5 },
                { type: "clip", source: "b.mp4", in: 0, out: 5 },
              ],
            },
          ],
          attachments: [
            {
              type: "clip",
              source: "x.mp4",
              in: 0,
              out: 1,
              start: {
                anchor: "comp",
                timeSource: "source",
                anchorPoint: 4,
              },
            },
          ],
        })
      );

      // comp output = [0, 6]. source 4 → output 0 + (4-2)/1 = 2
      expect(result.children[1]).toMatchObject({
        timelineStart: 2,
        timelineEnd: 3,
      });
    });

    it("offset still applies in output seconds regardless of timeSource", () => {
      const result = resolveComposition(
        comp({
          children: [
            { id: "x", type: "clip", source: "a.mp4", in: 0, out: 10, speed: 2 },
          ],
          attachments: [
            {
              type: "clip",
              source: "b.mp4",
              in: 0,
              out: 1,
              start: {
                anchor: "x",
                timeSource: "source",
                anchorPoint: 6,
                offset: 0.5,
              },
            },
          ],
        })
      );

      // anchorPoint maps to output 3 (see earlier test); + 0.5 output-seconds
      expect(result.children[1]).toMatchObject({
        timelineStart: 3.5,
        timelineEnd: 4.5,
      });
    });

    it("defaults anchorPoint to 0 seconds when omitted in source mode", () => {
      const result = resolveComposition(
        comp({
          children: [
            { id: "x", type: "clip", source: "a.mp4", in: 2, out: 5 },
          ],
          attachments: [
            {
              type: "clip",
              source: "b.mp4",
              in: 0,
              out: 1,
              start: { anchor: "x", timeSource: "source" },
            },
          ],
        })
      );

      // source time 0 on a clip with sourceIn=2, speed=1 → output = 0 + (0-2)/1 = -2
      expect(result.children[1]).toMatchObject({
        timelineStart: -2,
        timelineEnd: -1,
      });
    });

    it("throws when source-mode anchorPoint is not a number", () => {
      expect(() =>
        resolveComposition(
          comp({
            children: [
              { id: "x", type: "clip", source: "a.mp4", in: 0, out: 5 },
            ],
            attachments: [
              {
                type: "clip",
                source: "b.mp4",
                in: 0,
                out: 1,
                start: {
                  anchor: "x",
                  timeSource: "source",
                  anchorPoint: "50%" as unknown as number,
                },
              },
            ],
          })
        )
      ).toThrow(/anchorPoint must be a number/);
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
            start: { anchor: "first", timeSource: "output", anchorPoint: "100%" },
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

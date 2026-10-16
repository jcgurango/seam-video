import { describe, expect, it } from "vitest";
import {
  DEFAULT_CANVAS_HEIGHT,
  DEFAULT_CANVAS_WIDTH,
  resolveComposition,
  resolveSpatial,
} from "@seam/core";
import type { Child, ResolvedTimeline, SeamFile } from "@seam/core";
import { playheadAfterDelete } from "../deletePlayhead.js";
import { parsePath } from "../nodePath.js";

const resolve = (doc: SeamFile): ResolvedTimeline =>
  resolveSpatial(
    resolveComposition(doc),
    DEFAULT_CANVAS_WIDTH,
    DEFAULT_CANVAS_HEIGHT,
  );

const clip = (fields: Record<string, unknown>): Child =>
  ({ type: "clip", source: "a.mp4", ...fields }) as unknown as Child;

const after = (doc: SeamFile, keys: string[], t: number) =>
  playheadAfterDelete(resolve(doc), doc, keys.map(parsePath), t);

// Root: A [0,5) B [5,10) C [10,15)
const flat: SeamFile = {
  type: "composition",
  children: [
    clip({ id: "A", in: 0, out: 5 }),
    clip({ id: "B", in: 0, out: 5 }),
    clip({ id: "C", in: 0, out: 5 }),
  ],
};

describe("playheadAfterDelete — root children", () => {
  it("playhead before the item: untouched", () => {
    expect(after(flat, ["children.1"], 2)).toBe(2);
  });

  it("playhead after the item: moves back by its length", () => {
    expect(after(flat, ["children.1"], 12)).toBe(7);
  });

  it("playhead on the item: clamps to its start", () => {
    expect(after(flat, ["children.1"], 7)).toBe(5);
  });

  it("multiple items sum their spans and clamp to the earliest start", () => {
    expect(after(flat, ["children.0", "children.1"], 12)).toBe(2);
    expect(after(flat, ["children.0", "children.1"], 7)).toBe(0);
    // Only the one before the playhead counts.
    expect(after(flat, ["children.0", "children.2"], 7)).toBe(2);
  });

  it("deleting an attachment never moves the playhead", () => {
    const doc: SeamFile = {
      ...flat,
      attachments: [
        clip({
          in: 0,
          out: 2,
          start: { anchor: "A", timeSource: "source", anchorPoint: 0 },
        }),
      ],
    };
    expect(after(doc, ["attachments.0"], 12)).toBe(12);
    // Mixed: only the child contributes.
    expect(after(doc, ["attachments.0", "children.0"], 12)).toBe(7);
  });
});

// Nested: X [0,5) then comp [5,15) { P [0,5) Q [5,10) } then Y [15,20)
const nest = (compFields: Record<string, unknown>): SeamFile => ({
  type: "composition",
  children: [
    clip({ id: "X", in: 0, out: 5 }),
    {
      type: "composition",
      ...compFields,
      children: [
        clip({ id: "P", in: 0, out: 5 }),
        clip({ id: "Q", in: 0, out: 5 }),
      ],
    } as unknown as Child,
    clip({ id: "Y", in: 0, out: 5 }),
  ],
});

describe("playheadAfterDelete — nested children", () => {
  it("no fixed-length ancestor: the chain shortens, playhead follows anywhere after", () => {
    const doc = nest({});
    expect(after(doc, ["children.1.children.0"], 17)).toBe(12); // on Y
    expect(after(doc, ["children.1.children.0"], 12)).toBe(7); // on Q
    expect(after(doc, ["children.1.children.0"], 2)).toBe(2); // on X
  });

  it("fixed `duration` ancestor: bails when the playhead is past it", () => {
    const doc = nest({ duration: 10 });
    expect(after(doc, ["children.1.children.0"], 17)).toBe(17);
  });

  it("fixed `in`+`out` ancestor: bails when the playhead is past it", () => {
    const doc = nest({ in: 0, out: 10 });
    expect(after(doc, ["children.1.children.0"], 17)).toBe(17);
  });

  it("fixed ancestor with the playhead on it: still moves (content inside shifted)", () => {
    const doc = nest({ duration: 10 });
    expect(after(doc, ["children.1.children.0"], 12)).toBe(7);
  });

  it("`in` alone or `out` alone isn't fixed", () => {
    expect(after(nest({ in: 0 }), ["children.1.children.0"], 17)).toBe(12);
    expect(after(nest({ out: 10 }), ["children.1.children.0"], 17)).toBe(12);
  });

  it("folds the enclosing comp's speed into the global shift", () => {
    const doc = nest({ speed: 2 }); // comp [5,10), P occupies [5,7.5)
    expect(after(doc, ["children.1.children.0"], 12)).toBe(9.5);
  });

  it("deleting a child together with its ancestor counts the ancestor once", () => {
    const doc = nest({});
    expect(after(doc, ["children.1", "children.1.children.0"], 17)).toBe(7);
  });
});

// Attached comp anchored to A's start: A [0,10) ; att comp [2,12) { P [0,5) Q [5,10) }
const attached = (compFields: Record<string, unknown>): SeamFile => ({
  type: "composition",
  children: [clip({ id: "A", in: 0, out: 10 })],
  attachments: [
    {
      type: "composition",
      start: { anchor: "A", timeSource: "source", anchorPoint: 2 },
      ...compFields,
      children: [
        clip({ id: "P", in: 0, out: 5 }),
        clip({ id: "Q", in: 0, out: 5 }),
      ],
    } as unknown as Child,
  ],
});

describe("playheadAfterDelete — children inside an attached composition", () => {
  it("the attachment itself: untouched", () => {
    expect(after(attached({}), ["attachments.0"], 9)).toBe(9);
  });

  it("a child inside it: moves (the attachment shrinks)", () => {
    expect(after(attached({}), ["attachments.0.children.0"], 9)).toBe(4);
    expect(after(attached({}), ["attachments.0.children.0"], 1)).toBe(1);
  });

  it("fixed `duration` on the attachment: moves only while the playhead is on it", () => {
    expect(after(attached({ duration: 10 }), ["attachments.0.children.0"], 9)).toBe(4);
    expect(after(attached({ duration: 10 }), ["attachments.0.children.0"], 13)).toBe(13);
  });

  it("both ends anchored (fixed length): same gating", () => {
    // Attachments default to `stretch`: 10 s of content in an 8 s slot
    // plays at 1.25×, so P spans [2, 6) and the shift is 4 s.
    const doc = attached({
      end: { anchor: "A", timeSource: "source", anchorPoint: 10 },
    });
    expect(after(doc, ["attachments.0.children.0"], 9)).toBe(5);
    expect(after(doc, ["attachments.0.children.0"], 11)).toBe(11);
  });
});

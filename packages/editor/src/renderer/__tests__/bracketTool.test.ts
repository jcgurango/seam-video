import { describe, expect, it } from "vitest";
import {
  createSeam,
  DEFAULT_CANVAS_HEIGHT,
  DEFAULT_CANVAS_WIDTH,
  resolveSpatial,
} from "@seam/core";
import type { Child, ResolvedTimeline, SeamFile } from "@seam/core";
import { applyBracket } from "../bracketTool.js";

const seam = createSeam();
const { resolveComposition } = seam;

const resolve = (doc: SeamFile): ResolvedTimeline =>
  resolveSpatial(
    resolveComposition(doc, { uncropped: true }),
    DEFAULT_CANVAS_WIDTH,
    DEFAULT_CANVAS_HEIGHT,
  );

const clip = (fields: Record<string, unknown>): Child =>
  ({ type: "clip", source: "a.mp4", ...fields }) as unknown as Child;

type Loose = Child & { in: number; out: number; offset?: number; start?: unknown };
const at = (doc: SeamFile | null, i: number) => doc!.children![i] as Loose;

describe("applyBracket — attached to the primary", () => {
  // A [0,10); B anchored at A's source second 5 → [5,7).
  const doc: SeamFile = {
    type: "composition",
    children: [
      clip({ id: "A", in: 0, out: 10 }),
      clip({ in: 0, out: 2, start: "A@5" }),
    ],
  };

  it("bracket start: shifts the offset so starts align", () => {
    const next = applyBracket(seam, doc, resolve(doc), 0, "children.0", ["children.1"], "start");
    expect(at(next, 1).offset).toBe(-5);
    expect(at(next, 1).start).toBe("A@5");
    expect(at(next, 1).in).toBe(0);
    const r = resolve(next!);
    expect(r.children[1].timelineStart).toBe(r.children[0].timelineStart);
  });

  it("bracket end: right-trims so ends align (the node doesn't move)", () => {
    const next = applyBracket(seam, doc, resolve(doc), 0, "children.0", ["children.1"], "end");
    expect(at(next, 1).out).toBe(5);
    expect(at(next, 1).offset).toBeUndefined();
    const r = resolve(next!);
    expect(r.children[1].timelineStart).toBe(5);
    expect(r.children[1].timelineEnd).toBe(r.children[0].timelineEnd);
  });

  it("bracket end is speed-aware", () => {
    // B at 0.5× spans [5,9); 1 more output second = 0.5 source seconds.
    const slow: SeamFile = {
      type: "composition",
      children: [
        clip({ id: "A", in: 0, out: 10 }),
        clip({ in: 0, out: 2, speed: 0.5, start: "A@5" }),
      ],
    };
    const next = applyBracket(seam, slow, resolve(slow), 0, "children.0", ["children.1"], "end");
    expect(at(next, 1).out).toBe(2.5);
    expect(resolve(next!).children[1].timelineEnd).toBe(10);
  });

  it("an anchor to another node isn't 'attached': legato instead", () => {
    // B anchors to X, not the primary A [5,10) → bracket start meets A's END.
    const other: SeamFile = {
      type: "composition",
      children: [
        clip({ id: "X", in: 0, out: 5 }),
        clip({ id: "A", in: 0, out: 5 }),
        clip({ in: 0, out: 2, start: "X@1" }),
      ],
    };
    const next = applyBracket(seam, other, resolve(other), 0, "children.1", ["children.2"], "start");
    expect(at(next, 2).offset).toBe(9);
    expect(resolve(next!).children[2].timelineStart).toBe(10);
  });
});

describe("applyBracket — legato (primary not the anchor)", () => {
  // X [0,5), primary A [5,10), then the secondary.
  const legatoDoc = (secondary: Child): SeamFile => ({
    type: "composition",
    children: [clip({ in: 0, out: 5 }), clip({ id: "A", in: 0, out: 5 }), secondary],
  });

  it("bracket end: right-trims to the primary's start", () => {
    const doc = legatoDoc(clip({ in: 0, out: 2, start: 1 }));
    const next = applyBracket(seam, doc, resolve(doc), 0, "children.1", ["children.2"], "end");
    expect(at(next, 2).out).toBe(4);
    const r = resolve(next!);
    expect(r.children[2].timelineStart).toBe(1);
    expect(r.children[2].timelineEnd).toBe(5);
  });

  it("bracket start on a run head: offset shifts so the start meets the primary's end", () => {
    const doc = legatoDoc(clip({ in: 0, out: 2, start: 1, offset: 0.5 }));
    const next = applyBracket(seam, doc, resolve(doc), 0, "children.1", ["children.2"], "start");
    expect(at(next, 2).start).toBe(1);
    expect(at(next, 2).offset).toBe(9);
    expect(resolve(next!).children[2].timelineStart).toBe(10);
  });

  it("bracket start on a run member: left-trims instead of moving it", () => {
    // P [0,5), X [5,10), B [10,15) continues the run. Target = P's end (5):
    // 5 s earlier → `in` 6 → 1; B keeps following X.
    const doc: SeamFile = {
      type: "composition",
      children: [
        clip({ id: "P", in: 0, out: 5 }),
        clip({ in: 0, out: 5 }),
        clip({ in: 6, out: 11 }),
      ],
    };
    const next = applyBracket(seam, doc, resolve(doc), 0, "children.0", ["children.2"], "start");
    expect(at(next, 2).in).toBe(1);
    expect(at(next, 2).start).toBeUndefined();
    expect(at(next, 2).offset).toBeUndefined();
    const r = resolve(next!);
    expect(r.children[2].timelineStart).toBe(10);
    expect(r.children[2].timelineEnd).toBe(20);
  });

  it("converts the delta into a nested container's local time scale", () => {
    // C is a 2x comp spanning [10, 15]; its overlay B sits at local [2, 4]
    // (global [11, 12]). Bracket start against root child A (ends at global
    // 10) must move B's local start to 0 — a local delta of −2 for a global
    // delta of −1.
    const doc: SeamFile = {
      type: "composition",
      children: [
        clip({ id: "A", in: 0, out: 10 }),
        {
          type: "composition",
          speed: 2,
          children: [clip({ in: 0, out: 10 }), clip({ in: 0, out: 2, start: 2 })],
        } as unknown as Child,
      ],
    };
    const next = applyBracket(seam, doc, resolve(doc), 0, "children.0", ["children.1.children.1"], "start");
    const nested = next!.children![1] as unknown as SeamFile;
    expect(at(nested, 1).offset).toBe(-2);
    const rNested = resolve(next!).children[1] as unknown as {
      children: { timelineStart: number }[];
    };
    expect(rNested.children[1].timelineStart).toBe(0);
  });

  it("no-ops (returns null) when everything is already in place", () => {
    // B already ends exactly at the primary's start.
    const doc = legatoDoc(clip({ in: 0, out: 2, start: 3 }));
    expect(applyBracket(seam, doc, resolve(doc), 0, "children.1", ["children.2"], "end")).toBeNull();
  });
});

describe("applyBracket — primary only, against the playhead", () => {
  it("bracket start on a run head: shifts the offset to the playhead", () => {
    const doc: SeamFile = {
      type: "composition",
      children: [clip({ id: "A", in: 0, out: 10 }), clip({ in: 0, out: 2, start: "A@5" })],
    };
    // B starts at 5; playhead at 7 → offset +2.
    const next = applyBracket(seam, doc, resolve(doc), 7, "children.1", [], "start");
    expect(at(next, 1).offset).toBe(2);
    expect(resolve(next!).children[1].timelineStart).toBe(7);
  });

  it("bracket start on a run member: trims its head to the playhead", () => {
    // A [0,5), B [5,10). Playhead 7 → B loses its first 2 s and still
    // follows A.
    const doc: SeamFile = {
      type: "composition",
      children: [clip({ in: 0, out: 5 }), clip({ in: 0, out: 5 })],
    };
    const next = applyBracket(seam, doc, resolve(doc), 7, "children.1", [], "start");
    expect(at(next, 1).in).toBe(2);
    expect(at(next, 1).offset).toBeUndefined();
    const r = resolve(next!);
    expect(r.children[1].timelineStart).toBe(5);
    expect(r.children[1].timelineEnd).toBe(8);
  });

  it("bracket start on the first child (implicit head, no `start`): trims", () => {
    const doc: SeamFile = { type: "composition", children: [clip({ in: 0, out: 5 })] };
    const next = applyBracket(seam, doc, resolve(doc), 2, "children.0", [], "start");
    expect(at(next, 0).in).toBe(2);
    expect(at(next, 0).offset).toBeUndefined();
  });

  it("bracket end: right-resizes to the playhead, speed-aware", () => {
    // A 2x clip spanning [0, 2]; playhead at 3 → +1s of output = +2s of
    // source on `out`.
    const doc: SeamFile = {
      type: "composition",
      children: [clip({ in: 0, out: 4, speed: 2 })],
    };
    const next = applyBracket(seam, doc, resolve(doc), 3, "children.0", [], "end");
    expect(at(next, 0).out).toBe(6);
    expect(resolve(next!).children[0].timelineEnd).toBe(3);
  });

  it("maps the playhead into a nested primary's container-local time", () => {
    // C is a 2x comp spanning [10, 15]; its overlay B sits at local [2, 4].
    // Playhead at global 11 = local 2 → bracket end pulls B's end (local 4)
    // back by a local delta of −2: out 2 → 0.
    const doc: SeamFile = {
      type: "composition",
      children: [
        clip({ in: 0, out: 10 }),
        {
          type: "composition",
          speed: 2,
          children: [clip({ in: 0, out: 10 }), clip({ in: 0, out: 2, start: 2 })],
        } as unknown as Child,
      ],
    };
    const next = applyBracket(seam, doc, resolve(doc), 11, "children.1.children.1", [], "end");
    const nested = next!.children![1] as unknown as SeamFile;
    expect(at(nested, 1).out).toBe(0);
  });

  it("measures inside a WINDOWED composition in its un-windowed inner time", () => {
    // Comp shows inner [2, 10) at global [0, 8). B sits at inner [5, 7) =
    // global [3, 5). Playhead 4 = inner 6 → offset +1.
    const doc: SeamFile = {
      type: "composition",
      children: [
        {
          type: "composition",
          in: 2,
          children: [clip({ in: 0, out: 10 }), clip({ in: 0, out: 2, start: 5 })],
        } as unknown as Child,
      ],
    };
    const next = applyBracket(seam, doc, resolve(doc), 4, "children.0.children.1", [], "start");
    const nested = next!.children![0] as unknown as SeamFile;
    expect(at(nested, 1).offset).toBe(1);
  });

  it("no-ops (returns null) when the edge is already at the playhead", () => {
    const doc: SeamFile = {
      type: "composition",
      children: [clip({ in: 0, out: 5 })],
    };
    expect(applyBracket(seam, doc, resolve(doc), 5, "children.0", [], "end")).toBeNull();
  });
});

import { describe, expect, it } from "vitest";
import { createSeam, type Child, type Composition, type SeamFile } from "@seam/core";
import { keepRanges, normalizeRanges } from "../cutTool.js";
import { parsePath } from "../nodePath.js";

const seam = createSeam();

const clip = (source: string, out: number, extra: object = {}): Child =>
  ({ type: "clip", source, in: 0, out, ...extra }) as Child;
const body = (): Child[] => [clip("a.mp4", 10)];
const comp = (extra: object = {}): Child => ({ type: "composition", children: body(), ...extra }) as Child;
const doc = (children: Child[], extra: object = {}): SeamFile => ({ type: "composition", children, ...extra }) as SeamFile;
const cut = (d: SeamFile, key: string, ranges: [number, number][]) =>
  keepRanges(seam, d, parsePath(key), ranges.map(([start, end]) => ({ start, end })));
const kids = (d: SeamFile) => d.children as (Composition & { id?: string; start?: unknown; offset?: number })[];
const spans = (d: SeamFile) =>
  seam.resolveComposition(seam.compileSeamFile(d).doc).children.map((c) => [c.timelineStart, c.timelineEnd]);

describe("normalizeRanges", () => {
  it("sorts, clamps and merges", () => {
    expect(
      normalizeRanges(
        [
          { start: 6, end: 8 },
          { start: -2, end: 1 },
          { start: 0.5, end: 2 },
          { start: 9, end: 20 },
          { start: 4, end: 4 }, // empty
          { start: 3, end: 2.5 }, // reversed
        ],
        0,
        10,
      ),
    ).toEqual([
      { start: 0, end: 2 },
      { start: 2.5, end: 3 },
      { start: 6, end: 8 },
      { start: 9, end: 10 },
    ]);
  });
});

describe("keepRanges", () => {
  it("replaces the composition with a run of windowed pieces that butt together", () => {
    const r = cut(doc([clip("lead.mp4", 1), comp(), clip("tail.mp4", 1)]), "children.1", [[1, 3], [6, 7]]);
    if (!r.ok) throw new Error(r.error);
    const c = kids(r.doc);
    expect(c.map((n) => n.type)).toEqual(["clip", "composition", "composition", "clip"]);
    expect([c[1].in, c[1].out, c[2].in, c[2].out]).toEqual([1, 3, 6, 7]);
    // Same body in every piece: nothing inside is touched.
    expect(c[1].children).toEqual(c[2].children);
    expect(spans(r.doc)).toEqual([[0, 1], [1, 3], [3, 4], [4, 5]]);
    expect(r.pieces.map((p) => p[0].index)).toEqual([1, 2]);
  });

  it("is what slicing and deleting by hand gives: ranges play in source order, merged", () => {
    const r = cut(doc([comp()]), "children.0", [[6, 7], [1, 2], [1.5, 3]]);
    if (!r.ok) throw new Error(r.error);
    expect(kids(r.doc).map((n) => [n.in, n.out])).toEqual([[1, 3], [6, 7]]);
  });

  it("the first piece takes over the slot; the rest are plain run members", () => {
    const r = cut(doc([clip("lead.mp4", 1, { id: "lead" }), comp({ id: "c", start: "lead@100%", offset: 0.5 })]), "children.1", [
      [2, 3],
      [5, 6],
    ]);
    if (!r.ok) throw new Error(r.error);
    const [, a, b] = kids(r.doc);
    expect(a).toMatchObject({ id: "c", start: "lead@100%", offset: 0.5 });
    expect("id" in b || "start" in b || "offset" in b).toBe(false);
    expect(spans(r.doc)).toEqual([[0, 1], [1.5, 2.5], [2.5, 3.5]]);
  });

  it("respects the existing window, and the inner length when there is no `out`", () => {
    const windowed = cut(doc([comp({ in: 2, out: 8 })]), "children.0", [[0, 3], [7, 20]]);
    if (!windowed.ok) throw new Error(windowed.error);
    expect(kids(windowed.doc).map((n) => [n.in, n.out])).toEqual([[2, 3], [7, 8]]);
    const open = cut(doc([comp()]), "children.0", [[8, 99]]);
    if (!open.ok) throw new Error(open.error);
    expect(kids(open.doc).map((n) => [n.in, n.out])).toEqual([[8, 10]]);
  });

  it("works on a bin reference, at any depth", () => {
    const d = doc(
      [{ type: "composition", children: [{ type: "composition", binItem: "take" } as Child] } as Child],
      { bin: [{ id: "take", children: body() }] },
    );
    const r = cut(d, "children.0.children.0", [[1, 2], [4, 9]]);
    if (!r.ok) throw new Error(r.error);
    const inner = (r.doc.children![0] as Composition).children as (Composition & { binItem?: string })[];
    expect(inner.map((n) => [n.binItem, n.in, n.out])).toEqual([["take", 1, 2], ["take", 4, 9]]);
    expect(r.pieces.map((p) => p.map((s) => s.index))).toEqual([[0, 0], [0, 1]]);
  });

  it("a stretched duration is shared out in proportion; speed carries over", () => {
    const r = cut(doc([comp({ duration: 5 })]), "children.0", [[0, 2], [6, 10]]);
    if (!r.ok) throw new Error(r.error);
    expect(kids(r.doc).map((n) => n.duration)).toEqual([1, 2]);
    const s = cut(doc([comp({ speed: 2 })]), "children.0", [[0, 2], [6, 10]]);
    if (!s.ok) throw new Error(s.error);
    expect(kids(s.doc).map((n) => n.speed)).toEqual([2, 2]);
    expect(spans(s.doc)).toEqual([[0, 1], [1, 3]]);
  });

  describe("siblings anchored to the composition", () => {
    const anchored = (start: string, extra: object = {}): Child =>
      ({ type: "rect", duration: 1, start, ...extra }) as Child;

    it("keep pointing at the same moment, on the piece that holds it", () => {
      const d = doc([comp({ id: "c" }), anchored("c@1.5"), anchored("c@6.25", { offset: 0.25 })]);
      const before = spans(d);
      const r = cut(d, "children.0", [[1, 3], [6, 7]]);
      if (!r.ok) throw new Error(r.error);
      const c = kids(r.doc);
      expect(c[0].id).toBe("c");
      expect(c[1].id).toBe("c_2");
      expect((c[2] as { start?: unknown }).start).toBe("c@1.5");
      expect(c[3]).toMatchObject({ start: "c_2@6.25", offset: 0.25 });
      // Source second 1.5 was 1.5 s in; with [0,1) cut away it is 0.5 s in.
      const after = spans(r.doc);
      expect(before[1][0]).toBe(1.5);
      expect(after[2][0]).toBe(0.5);
      // Second 6.25: piece 2 starts at output 2, +0.25 in, +0.25 offset.
      expect(after[3][0]).toBe(2.5);
    });

    it("are removed with the cut when their moment is cut out — and so is what hangs off them", () => {
      const d = doc([
        comp({ id: "c" }),
        anchored("c@4", { id: "gone" }),
        { type: "rect", duration: 1 } as Child, // rides in the removed run
        anchored("gone@50%"), // anchored to the removed node
        anchored("c@2"),
      ]);
      const r = cut(d, "children.0", [[1, 3], [6, 7]]);
      if (!r.ok) throw new Error(r.error);
      const c = kids(r.doc);
      expect(c.map((n) => n.type)).toEqual(["composition", "composition", "rect"]);
      expect((c[2] as { start?: unknown }).start).toBe("c@2");
    });

    it("a bare id means the composition's start: kept only if the start is kept", () => {
      const keep = cut(doc([comp({ id: "c" }), anchored("c")]), "children.0", [[0, 2], [5, 6]]);
      if (!keep.ok) throw new Error(keep.error);
      expect(kids(keep.doc)).toHaveLength(3);
      expect((kids(keep.doc)[2] as { start?: unknown }).start).toBe("c");
      const drop = cut(doc([comp({ id: "c" }), anchored("c")]), "children.0", [[1, 2]]);
      if (!drop.ok) throw new Error(drop.error);
      expect(kids(drop.doc).map((n) => n.type)).toEqual(["composition"]);
    });

    it("a percentage is re-expressed against the piece that holds the moment", () => {
      // 50% of [0,10] = second 5, inside the piece [4,8] → 25% of it.
      const r = cut(doc([comp({ id: "c" }), anchored("c@50%")]), "children.0", [[0, 2], [4, 8]]);
      if (!r.ok) throw new Error(r.error);
      expect((kids(r.doc)[2] as { start?: unknown }).start).toBe("c_2@25%");
    });

    it("a sibling removed before the composition shifts the reported piece paths", () => {
      const d = doc([anchored("c@9"), comp({ id: "c", start: 0 })]);
      const r = cut(d, "children.1", [[0, 2]]);
      if (!r.ok) throw new Error(r.error);
      expect(kids(r.doc).map((n) => n.type)).toEqual(["composition"]);
      expect(r.pieces.map((p) => p[0].index)).toEqual([0]);
    });
  });

  it("refuses what it can't cut", () => {
    expect(cut(doc([clip("a.mp4", 5)]), "children.0", [[0, 1]])).toMatchObject({ ok: false });
    expect(cut(doc([comp({ duration: 30, underflow: "loop" })]), "children.0", [[0, 1]])).toMatchObject({ ok: false });
    expect(cut(doc([comp({ duration: 3, overflow: "trim-end" })]), "children.0", [[0, 1]])).toMatchObject({ ok: false });
    expect(cut(doc([comp()]), "children.0", [[20, 30]])).toMatchObject({ ok: false });
    expect(cut(doc([comp()]), "", [[0, 1]])).toMatchObject({ ok: false });
  });

  it("produces a valid document", () => {
    const r = cut(doc([comp({ id: "c" }), { type: "rect", duration: 1, start: "c@6.5" } as Child]), "children.0", [
      [1, 3],
      [6, 7],
    ]);
    if (!r.ok) throw new Error(r.error);
    expect(seam.validate(r.doc).success).toBe(true);
  });
});

import { describe, expect, it } from "vitest";
import { createSeam } from "@seam/core";
import type { Child, SeamFile } from "@seam/core";
import { sliceAtPlayhead } from "../splitTool.js";

const seam = createSeam();
const { resolveComposition } = seam;

const clip = (fields: Record<string, unknown>): Child =>
  ({ type: "clip", source: "a.mp4", ...fields }) as unknown as Child;
const doc = (...children: Child[]): SeamFile => ({ type: "composition", children });
const spans = (d: SeamFile) =>
  resolveComposition(d, { uncropped: true }).children.map((c) => [c.timelineStart, c.timelineEnd]);

describe("sliceAtPlayhead — halves", () => {
  it("splits a clip by source time; the right half is a plain run member", () => {
    const d = doc(clip({ in: 2, out: 12 }), clip({ in: 0, out: 3 }));
    const next = sliceAtPlayhead(seam, d, 4)!;
    expect(next.children).toEqual([
      clip({ in: 2, out: 6 }),
      clip({ in: 6, out: 12 }),
      clip({ in: 0, out: 3 }),
    ]);
    // The follower still follows.
    expect(spans(next)).toEqual([
      [0, 4],
      [4, 10],
      [10, 13],
    ]);
  });

  it("left keeps id/start/offset; right gets neither start nor offset", () => {
    const d = doc(
      clip({ in: 0, out: 20 }),
      clip({ id: "B", in: 0, out: 10, start: 3, offset: 1 }),
      clip({ in: 0, out: 1 }),
    );
    const next = sliceAtPlayhead(seam, { ...d, children: d.children!.slice(1) }, 8)!;
    expect(next.children![0]).toEqual(clip({ id: "B", in: 0, out: 4, start: 3, offset: 1 }));
    expect(next.children![1]).toEqual(clip({ id: "B_split", in: 4, out: 10 }));
    expect(spans(next)).toEqual([
      [4, 8],
      [8, 14],
      [14, 15],
    ]);
  });

  it("a crossfaded member: the fade stays on the left half only", () => {
    const d = doc(clip({ in: 0, out: 5 }), clip({ in: 0, out: 5, offset: -1 }));
    const next = sliceAtPlayhead(seam, d, 6)!;
    expect(next.children![1]).toEqual(clip({ in: 0, out: 2, offset: -1 }));
    expect(next.children![2]).toEqual(clip({ in: 2, out: 5 }));
  });

  it("is speed-aware", () => {
    const next = sliceAtPlayhead(seam, doc(clip({ in: 0, out: 10, speed: 2 })), 2)!;
    expect(next.children).toEqual([
      clip({ in: 0, out: 4, speed: 2 }),
      clip({ in: 4, out: 10, speed: 2 }),
    ]);
  });

  it("splits a stretched `duration` along with the window (rate preserved)", () => {
    // 10 s of source in 5 s → rate 2.
    const next = sliceAtPlayhead(seam, doc(clip({ in: 0, out: 10, duration: 5 })), 2)!;
    expect(next.children).toEqual([
      clip({ in: 0, out: 4, duration: 2 }),
      clip({ in: 4, out: 10, duration: 3 }),
    ]);
    expect(spans(next)).toEqual([
      [0, 2],
      [2, 5],
    ]);
  });

  it("materialises `out` for the in + duration shorthand", () => {
    const next = sliceAtPlayhead(seam, doc(clip({ in: 2, duration: 6 })), 2)!;
    expect(next.children).toEqual([
      clip({ in: 2, out: 4, duration: 2 }),
      clip({ in: 4, out: 8, duration: 4 }),
    ]);
  });

  it("non-stretch duration: cuts the window that is actually playing", () => {
    // trim-start keeps the LAST 4 s of [0, 10) → plays [6, 10).
    const next = sliceAtPlayhead(seam,
      doc(clip({ in: 0, out: 10, duration: 4, overflow: "trim-start" })),
      1,
    )!;
    expect(next.children).toEqual([
      clip({ in: 6, out: 7, duration: 1, overflow: "trim-start" }),
      clip({ in: 7, out: 10, duration: 3, overflow: "trim-start" }),
    ]);
  });

  it("splits a composition by its inner window, at its speed", () => {
    const comp = {
      type: "composition",
      speed: 2,
      children: [clip({ in: 0, out: 10 })],
    } as unknown as Child;
    const next = sliceAtPlayhead(seam, doc(comp), 2)!;
    expect(next.children).toEqual([
      { ...comp, in: 0, out: 4 },
      { ...comp, in: 4, out: 10 },
    ]);
    expect(spans(next)).toEqual([
      [0, 2],
      [2, 5],
    ]);
  });

  it("splits a windowed composition inside its window", () => {
    const comp = {
      type: "composition",
      in: 2,
      out: 8,
      children: [clip({ in: 0, out: 10 })],
    } as unknown as Child;
    const next = sliceAtPlayhead(seam, doc(comp), 1)!;
    expect(next.children).toEqual([
      { ...comp, in: 2, out: 3 },
      { ...comp, in: 3, out: 8 },
    ]);
  });

  it("splits a binItem reference using the bin body's duration", () => {
    const d: SeamFile = {
      type: "composition",
      bin: [{ id: "intro", children: [clip({ in: 0, out: 6 })] }],
      children: [{ type: "composition", binItem: "intro" } as unknown as Child],
    };
    const next = sliceAtPlayhead(seam, d, 2)!;
    expect(next.children).toEqual([
      { type: "composition", binItem: "intro", in: 0, out: 2 },
      { type: "composition", binItem: "intro", in: 2, out: 6 },
    ]);
  });
});

describe("sliceAtPlayhead — target selection", () => {
  it("returns null when nothing splittable is under the playhead", () => {
    expect(sliceAtPlayhead(seam, doc(clip({ in: 0, out: 5 })), 7)).toBeNull();
    // Exactly on an edge is not inside.
    expect(sliceAtPlayhead(seam, doc(clip({ in: 0, out: 5 })), 5)).toBeNull();
    expect(
      sliceAtPlayhead(seam, doc({ type: "data", data: null, duration: 5 } as Child), 2),
    ).toBeNull();
  });

  it("splits everything splittable under the playhead in one go", () => {
    const d = doc(
      { type: "rect", duration: 10 } as unknown as Child,
      clip({ in: 0, out: 5, start: 0 }),
      clip({ source: "over.mp4", in: 0, out: 5, start: 0 }),
      clip({ source: "later.mp4", in: 0, out: 5, start: 8 }),
    );
    const next = sliceAtPlayhead(seam, d, 2)!;
    expect(next.children).toHaveLength(6);
    expect(next.children![0]).toBe(d.children![0]);
    expect(next.children![1]).toEqual(clip({ in: 0, out: 2, start: 0 }));
    expect(next.children![2]).toEqual(clip({ in: 2, out: 5 }));
    expect(next.children![3]).toEqual(clip({ source: "over.mp4", in: 0, out: 2, start: 0 }));
    expect(next.children![4]).toEqual(clip({ source: "over.mp4", in: 2, out: 5 }));
    expect(next.children![5]).toBe(d.children![3]);
    // Nothing moved in time.
    const starts = (c: SeamFile) =>
      resolveComposition(c, { uncropped: true }).children.map((r) => [r.timelineStart, r.timelineEnd]);
    expect(starts(next)).toEqual([[0, 10], [0, 2], [2, 5], [0, 2], [2, 5], [8, 13]]);
  });

  it("with `only`, splits just those indices", () => {
    const d = doc(
      clip({ in: 0, out: 5, start: 0 }),
      clip({ source: "over.mp4", in: 0, out: 5, start: 0 }),
    );
    const next = sliceAtPlayhead(seam, d, 2, new Set([1]))!;
    expect(next.children).toHaveLength(3);
    expect(next.children![0]).toBe(d.children![0]);
    expect(next.children![1]).toEqual(clip({ source: "over.mp4", in: 0, out: 2, start: 0 }));
    // A selected node that isn't under the playhead: nothing to do.
    expect(sliceAtPlayhead(seam, d, 7, new Set([1]))).toBeNull();
  });

  it("splits two anchored nodes with ids without colliding", () => {
    const d = doc(
      clip({ in: 0, out: 5, id: "a" }),
      clip({ source: "o.mp4", in: 0, out: 5, start: "a", id: "a_split" }),
    );
    const next = sliceAtPlayhead(seam, d, 2)!;
    const ids = next.children!.map((c) => (c as { id?: string }).id);
    expect(new Set(ids).size).toBe(4);
    expect(() => resolveComposition(next)).not.toThrow();
  });

  it("does not split a looping node", () => {
    const d = doc(clip({ in: 0, out: 2, duration: 10, underflow: "loop" }));
    expect(sliceAtPlayhead(seam, d, 5)).toBeNull();
  });
});

describe("sliceAtPlayhead — sibling anchors keep their moment", () => {
  // A plays source [10, 20) at [0, 10); split at 4 (source 14).
  const base = (start: string): SeamFile =>
    doc(clip({ id: "A", in: 10, out: 20 }), clip({ source: "o.mp4", in: 0, out: 1, start }));
  const startOf = (d: SeamFile) => (d.children![2] as { start?: unknown }).start;
  const landsAt = (d: SeamFile) => spans(d)[2][0];

  it("bare id stays on the left half", () => {
    const next = sliceAtPlayhead(seam, base("A"), 4)!;
    expect(startOf(next)).toBe("A");
    expect(landsAt(next)).toBe(0);
  });

  it("source point in the left half: unchanged", () => {
    const next = sliceAtPlayhead(seam, base("A@12"), 4)!;
    expect(startOf(next)).toBe("A@12");
    expect(landsAt(next)).toBe(2);
  });

  it("source point in the right half: retargets to the right half's id", () => {
    const next = sliceAtPlayhead(seam, base("A@17"), 4)!;
    expect((next.children![1] as { id?: string }).id).toBe("A_split");
    expect(startOf(next)).toBe("A_split@17");
    expect(landsAt(next)).toBe(7);
  });

  it("percent in the left half: re-expressed against the left half", () => {
    const next = sliceAtPlayhead(seam, base("A@20%"), 4)!;
    expect(startOf(next)).toBe("A@50%");
    expect(landsAt(next)).toBe(2);
  });

  it("percent in the right half: re-expressed against the right half", () => {
    const next = sliceAtPlayhead(seam, base("A@70%"), 4)!;
    expect(startOf(next)).toBe("A_split@50%");
    expect(landsAt(next)).toBe(7);
  });

  it("100% keeps pointing at the node's end", () => {
    const next = sliceAtPlayhead(seam, base("A@100%"), 4)!;
    expect(startOf(next)).toBe("A_split@100%");
    expect(landsAt(next)).toBe(10);
  });

  it("the anchoring node's offset is left alone", () => {
    const d = doc(
      clip({ id: "A", in: 10, out: 20 }),
      clip({ source: "o.mp4", in: 0, out: 1, start: "A@17", offset: -5 }),
    );
    const next = sliceAtPlayhead(seam, d, 4)!;
    expect(next.children![2]).toEqual(
      clip({ source: "o.mp4", in: 0, out: 1, start: "A_split@17", offset: -5 }),
    );
    expect(landsAt(next)).toBe(2);
  });

  it("forward references (an anchoring node BEFORE the split node) are rewritten too", () => {
    const d = doc(
      clip({ source: "o.mp4", in: 0, out: 1, start: "A@17" }),
      clip({ id: "A", in: 10, out: 20, start: 0 }),
    );
    const next = sliceAtPlayhead(seam, d, 4)!;
    expect((next.children![0] as { start?: unknown }).start).toBe("A_split@17");
  });

  it("de-duplicates the generated id against the whole document", () => {
    const d = doc(
      clip({ id: "A", in: 0, out: 10 }),
      {
        type: "composition",
        start: 0,
        children: [clip({ id: "A_split", in: 0, out: 1 })],
      } as unknown as Child,
    );
    const next = sliceAtPlayhead(seam, d, 4)!;
    expect((next.children![1] as { id?: string }).id).toBe("A_split_2");
  });

  it("composition source anchors are inner-timeline seconds", () => {
    // Comp shows inner [2, 10) at 2× → [0, 4). Split at 1 (inner 4).
    const comp = {
      id: "C",
      type: "composition",
      in: 2,
      speed: 2,
      children: [clip({ in: 0, out: 10 })],
    } as unknown as Child;
    const d = doc(comp, clip({ source: "o.mp4", in: 0, out: 1, start: "C@8" }));
    const before = spans(d)[1][0];
    const next = sliceAtPlayhead(seam, d, 1)!;
    expect(startOf(next)).toBe("C_split@8");
    expect(landsAt(next)).toBe(before);
  });
});

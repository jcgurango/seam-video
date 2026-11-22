import { describe, it, expect } from "vitest";
import {
  parseStart,
  formatStart,
  startAnchorId,
  runsOf,
  runHeadIndex,
  isRunMember,
  type Child,
  type Composition,
  type ResolvedChild,
  type ResolvedClip,
  type ResolvedComposition,
  type ResolvedExtensionNode,
} from "../index.js";
import { createSeam } from "../seam.js";
import { stage } from "./stageExtension.js";

// `stage` is a stand-in extension container (see stageExtension.ts).
const { validate, resolveComposition } = createSeam([stage]);

// The placement model: one `children` array, array order = z-order only.
// Every node lands at
//
//   (start ?? end of the previous node in the array, 0 for the first) + offset
//
// so a node WITHOUT `start` continues the previous node's run and a node WITH
// one heads a new run. See `layout/anchor.ts` + `placeChildren`.

function comp(
  overrides: Partial<Composition> & { children: Composition["children"] }
): Composition {
  return { type: "composition", ...overrides };
}

/** A plain clip of `seconds` (source `[0, seconds]`), named after its source. */
function clip(source: string, seconds: number, extra: Partial<Child> = {}): Child {
  return { type: "clip", source, in: 0, out: seconds, ...extra } as Child;
}

function resolve(children: Child[]) {
  return resolveComposition(comp({ children }));
}

/** `[timelineStart, timelineEnd]` of every resolved child, in order. */
function spans(children: ResolvedChild[]): [number, number][] {
  return children.map((c) => [c.timelineStart, c.timelineEnd]);
}

function sources(children: ResolvedChild[]): (string | undefined)[] {
  return children.map((c) => (c as { source?: string }).source);
}

type Fades = { transition?: number; transitionOut?: number };
function fades(children: ResolvedChild[]): [number | undefined, number | undefined][] {
  return children.map((c) => [(c as Fades).transition, (c as Fades).transitionOut]);
}

describe("runs: implicit placement", () => {
  it("places the first node at 0 and each following node at the previous one's end", () => {
    const r = resolve([clip("a.mp4", 3), clip("b.mp4", 5), clip("c.mp4", 2)]);
    expect(spans(r.children)).toEqual([[0, 3], [3, 8], [8, 10]]);
    expect(r.duration).toBe(10);
  });

  it("resolves an empty children array to a zero-length timeline", () => {
    const r = resolve([]);
    expect(r.children).toEqual([]);
    expect(r.duration).toBe(0);
  });

  it("a positive offset on a run member is a gap after the previous node", () => {
    const r = resolve([clip("a.mp4", 3), clip("b.mp4", 5, { offset: 2 }), clip("c.mp4", 2)]);
    // The gap pushes everything after it in the run.
    expect(spans(r.children)).toEqual([[0, 3], [5, 10], [10, 12]]);
    expect(r.duration).toBe(12);
    expect(fades(r.children)).toEqual([
      [undefined, undefined],
      [undefined, undefined],
      [undefined, undefined],
    ]);
  });

  it("a positive offset on the first node delays the whole run", () => {
    const r = resolve([clip("a.mp4", 3, { offset: 1.5 }), clip("b.mp4", 2)]);
    expect(spans(r.children)).toEqual([[1.5, 4.5], [4.5, 6.5]]);
    expect(r.duration).toBe(6.5);
  });

  it("a zero-duration data node doesn't move the run", () => {
    const r = resolve([clip("a.mp4", 3), { type: "data", data: 1 }, clip("b.mp4", 2)]);
    expect(spans(r.children)).toEqual([[0, 3], [3, 3], [3, 5]]);
  });

  it("uses each node's own output length (speed, duration) to advance the run", () => {
    const r = resolve([
      clip("a.mp4", 10, { speed: 2 }), // 5s
      clip("b.mp4", 4, { duration: 8 }), // 8s
      { type: "static", source: "s.png", duration: 1 },
      { type: "rect", duration: 2 },
      { type: "composition", children: [clip("x.mp4", 1), clip("y.mp4", 2)] }, // 3s
      clip("c.mp4", 1),
    ]);
    expect(spans(r.children)).toEqual([[0, 5], [5, 13], [13, 14], [14, 16], [16, 19], [19, 20]]);
  });
});

describe("runs: negative offset cross-fades", () => {
  it("overlaps the previous node and stamps transition / transitionOut", () => {
    const r = resolve([clip("a.mp4", 5), clip("b.mp4", 5, { offset: -1 })]);
    expect(spans(r.children)).toEqual([[0, 5], [4, 9]]);
    expect(fades(r.children)).toEqual([[undefined, 1], [1, undefined]]);
    expect(r.duration).toBe(9);
  });

  it("chains across several run members", () => {
    const r = resolve([
      clip("a.mp4", 5),
      clip("b.mp4", 5, { offset: -1 }),
      clip("c.mp4", 5, { offset: -2 }),
      clip("d.mp4", 5),
    ]);
    expect(spans(r.children)).toEqual([[0, 5], [4, 9], [7, 12], [12, 17]]);
    expect(fades(r.children)).toEqual([
      [undefined, 1],
      [1, 2],
      [2, undefined],
      [undefined, undefined],
    ]);
    expect(r.duration).toBe(17);
  });

  it("clamps the fade to the previous node's duration; the position keeps the raw offset", () => {
    const r = resolve([clip("lead.mp4", 4), clip("a.mp4", 2), clip("b.mp4", 5, { offset: -3 })]);
    // b = end of a (6) − 3 = 3, i.e. it starts before a does.
    expect(spans(r.children)).toEqual([[0, 4], [4, 6], [3, 8]]);
    expect(fades(r.children)).toEqual([[undefined, undefined], [undefined, 2], [2, undefined]]);
  });

  it("clamps the fade to the node's own duration", () => {
    const r = resolve([clip("a.mp4", 5), clip("b.mp4", 1, { offset: -3 })]);
    expect(spans(r.children)).toEqual([[0, 5], [2, 3]]);
    expect(fades(r.children)).toEqual([[undefined, 1], [1, undefined]]);
    expect(r.duration).toBe(5);
  });

  it("fades between any producing types", () => {
    const r = resolve([
      { type: "static", source: "s.png", duration: 3 },
      { type: "rect", duration: 3, offset: -1 },
      { type: "rect", duration: 3, offset: -1 },
      { type: "audio", source: "a.wav", in: 0, out: 3, offset: -1 },
      { type: "composition", children: [clip("x.mp4", 3)], offset: -1 },
    ]);
    expect(spans(r.children)).toEqual([[0, 3], [2, 5], [4, 7], [6, 9], [8, 11]]);
    expect(fades(r.children)).toEqual([
      [undefined, 1],
      [1, 1],
      [1, 1],
      [1, 1],
      [1, undefined],
    ]);
  });

  it("never fades on the first node (its negative offset is a crop)", () => {
    const r = resolve([clip("a.mp4", 5, { offset: -1 }), clip("b.mp4", 5)]);
    expect(spans(r.children)).toEqual([[0, 4], [4, 9]]);
    expect(fades(r.children)).toEqual([[undefined, undefined], [undefined, undefined]]);
  });

  it("never fades on a run head: its negative offset is a plain shift", () => {
    const r = resolve([
      clip("a.mp4", 5, { id: "a" }),
      clip("b.mp4", 5, { start: "a@100%", offset: -1 }),
      clip("c.mp4", 5, { start: 9, offset: -1 }),
    ]);
    // Same positions a crossfading run would give — but no stamps.
    expect(spans(r.children)).toEqual([[0, 5], [4, 9], [8, 13]]);
    expect(fades(r.children)).toEqual([
      [undefined, undefined],
      [undefined, undefined],
      [undefined, undefined],
    ]);
  });

  it("fades with the previous node in the ARRAY, whatever headed its run", () => {
    const r = resolve([
      clip("a.mp4", 10, { id: "a" }),
      clip("o1.mp4", 2, { start: "a@50%" }),
      clip("o2.mp4", 2, { offset: -0.5 }),
    ]);
    expect(spans(r.children)).toEqual([[0, 10], [5, 7], [6.5, 8.5]]);
    expect(fades(r.children)).toEqual([
      [undefined, undefined],
      [undefined, 0.5],
      [0.5, undefined],
    ]);
  });

  it("data nodes neither get nor give a fade", () => {
    const r = resolve([
      clip("a.mp4", 5),
      { type: "data", data: null, duration: 2, offset: -1 },
      clip("b.mp4", 5, { offset: -1 }),
    ]);
    expect(spans(r.children)).toEqual([[0, 5], [4, 6], [5, 10]]);
    expect(fades(r.children)).toEqual([
      [undefined, undefined],
      [undefined, undefined],
      [undefined, undefined],
    ]);
  });

  it("stamps nothing when there is nothing to overlap (zero-length previous node)", () => {
    const r = resolve([
      { type: "data", data: null, start: 4 },
      clip("b.mp4", 5, { offset: -1 }),
    ]);
    expect(spans(r.children)).toEqual([[4, 4], [3, 8]]);
    expect(fades(r.children)).toEqual([[undefined, undefined], [undefined, undefined]]);
  });
});

describe("runs: `start`", () => {
  it("a bare number is an absolute position in the container", () => {
    const r = resolve([clip("a.mp4", 10), clip("b.mp4", 2, { start: 3 })]);
    expect(spans(r.children)).toEqual([[0, 10], [3, 5]]);
    expect(r.duration).toBe(10);
  });

  it("start: 0 overlays from the top (old: attachment with no anchors)", () => {
    const r = resolve([clip("a.mp4", 5), clip("b.mp4", 2, { start: 0 })]);
    expect(spans(r.children)).toEqual([[0, 5], [0, 2]]);
  });

  it('"id" is the start of that sibling', () => {
    const r = resolve([
      clip("a.mp4", 4),
      clip("b.mp4", 6, { id: "target" }),
      clip("c.mp4", 2, { start: "target" }),
    ]);
    expect(spans(r.children)).toEqual([[0, 4], [4, 10], [4, 6]]);
  });

  it('"id@<n>%" is a fraction of the sibling\'s OUTPUT span', () => {
    const at = (start: string) =>
      resolve([
        clip("lead.mp4", 2),
        // source [10, 30] at 4× → output [2, 7]
        { type: "clip", source: "t.mp4", in: 10, out: 30, speed: 4, id: "t" },
        clip("o.mp4", 1, { start }),
      ]).children[2].timelineStart;
    expect(at("t@0%")).toBe(2);
    expect(at("t@50%")).toBe(4.5);
    expect(at("t@100%")).toBe(7);
    expect(at("t@12.5%")).toBe(2.625);
    // May leave the span.
    expect(at("t@200%")).toBe(12);
    expect(at("t@-20%")).toBe(1);
  });

  it('"id@<seconds>" is SOURCE time on a trimmed + sped clip', () => {
    const at = (start: string) =>
      resolve([
        clip("lead.mp4", 3),
        // source [4, 12] at 2× → output [3, 7]
        { type: "clip", source: "t.mp4", in: 4, out: 12, speed: 2, id: "t" },
        clip("o.mp4", 1, { start }),
      ]).children[2].timelineStart;
    // output = start + (source − in) / speed
    expect(at("t@10")).toBe(6);
    expect(at("t@4")).toBe(3);
    expect(at("t@12")).toBe(7);
    expect(at("t@5.5")).toBe(3.75);
    // Source times outside [in, out] extrapolate past the clip's ends.
    expect(at("t@2")).toBe(2);
    expect(at("t@20")).toBe(11);
  });

  it("source time honours a rate derived from `duration`", () => {
    const r = resolve([
      { type: "clip", source: "t.mp4", in: 2, out: 12, duration: 5, id: "t" }, // 2×
      clip("o.mp4", 1, { start: "t@8" }),
    ]);
    expect(r.children[1].timelineStart).toBe(3);
  });

  it("source time follows the range a non-stretch strategy kept (clip trim-start)", () => {
    const r = resolve([
      // 10s into 4s, trim-start → plays source [6, 10] at [0, 4].
      { type: "clip", source: "t.mp4", in: 0, out: 10, duration: 4, overflow: "trim-start", id: "t" },
      clip("o.mp4", 1, { start: "t@8" }),
    ]);
    expect(r.children[0]).toMatchObject({ sourceIn: 6, sourceOut: 10, timelineEnd: 4 });
    expect(r.children[1].timelineStart).toBe(2);
  });

  it("source time works on audio", () => {
    const r = resolve([
      { type: "audio", source: "t.wav", in: 5, out: 15, id: "t" },
      clip("o.mp4", 1, { start: "t@9" }),
    ]);
    expect(r.children[1].timelineStart).toBe(4);
  });

  it("source time on a windowed composition is its pre-window inner time", () => {
    const inner = [clip("a.mp4", 5), clip("b.mp4", 5)];
    const at = (extra: Partial<Composition>, start: string) =>
      resolve([
        clip("lead.mp4", 1),
        { type: "composition", id: "c", in: 2, out: 8, children: inner, ...extra } as Child,
        clip("o.mp4", 1, { start }),
      ]).children[2].timelineStart;
    // Window [2, 8] at [1, 7]: inner 4 → 1 + (4 − 2) = 3.
    expect(at({}, "c@4")).toBe(3);
    expect(at({}, "c@2")).toBe(1);
    // …at 2× ([1, 4]): 1 + (4 − 2) / 2 = 2.
    expect(at({ speed: 2 }, "c@4")).toBe(2);
    // …or a rate derived from `duration` (6s window in 12s = 0.5×).
    expect(at({ duration: 12 }, "c@4")).toBe(5);
    // Un-windowed: inner time maps straight through.
    expect(at({ in: undefined, out: undefined }, "c@4")).toBe(5);
  });

  it("source time follows the window a non-stretch strategy kept (composition trim-start)", () => {
    // KNOWN FAILING — suspected source bug (resolve.ts `buildIdMapEntry`): a
    // composition's source base is the AUTHORED `in`, not the window the
    // overflow strategy actually kept, so this resolves to 8. Clips use the
    // resolved `sourceIn` and get it right (previous test).
    // Mirror of the clip case above: a 10s inner timeline into 4s with
    // trim-start shows inner [6, 10] at [0, 4], so inner second 8 is on
    // screen at output 2.
    const r = resolve([
      {
        type: "composition",
        id: "c",
        duration: 4,
        overflow: "trim-start",
        children: [clip("a.mp4", 10)],
      },
      clip("o.mp4", 1, { start: "c@8" }),
    ]);
    const c = r.children[0] as ResolvedComposition;
    expect(c.children[0]).toMatchObject({ sourceIn: 6, sourceOut: 10, timelineStart: 0, timelineEnd: 4 });
    expect(r.children[1].timelineStart).toBe(2);
  });

  it("source time on a static counts from its `in` freeze time", () => {
    const r = resolve([
      { type: "static", source: "s.mp4", in: 3, duration: 5, id: "s", start: 1 },
      clip("o.mp4", 1, { start: "s@5" }),
      { type: "static", source: "p.png", duration: 5, id: "p", start: 1 },
      clip("o.mp4", 1, { start: "p@2" }),
    ]);
    expect(r.children[1].timelineStart).toBe(3); // 1 + (5 − 3)
    expect(r.children[3].timelineStart).toBe(3); // 1 + 2
  });

  it("source time on the other static-like nodes is output seconds from their start", () => {
    const at = (target: Child) =>
      resolve([
        clip("lead.mp4", 2),
        { ...target, id: "t" } as Child,
        clip("o.mp4", 1, { start: "t@1.5" }),
      ]).children[2].timelineStart;
    expect(at({ type: "rect", duration: 4 })).toBe(3.5);
    expect(at({ type: "rect", duration: 4 })).toBe(3.5);
    expect(at({ type: "circle", duration: 4 })).toBe(3.5);
    expect(at({ type: "data", data: null, duration: 4 })).toBe(3.5);
    expect(at({ type: "stage", source: "m.bin", duration: 4 } as unknown as Child)).toBe(3.5);
  });

  it("`offset` on a head shifts off the anchor, in output seconds", () => {
    const r = resolve([
      { type: "clip", source: "t.mp4", in: 0, out: 10, speed: 2, id: "t" }, // [0, 5]
      clip("o1.mp4", 1, { start: 3, offset: 2 }),
      clip("o2.mp4", 1, { start: "t", offset: 0.5 }),
      clip("o3.mp4", 1, { start: "t@100%", offset: -3 }),
      // source 6 → output 3, then + 0.5 OUTPUT seconds (not scaled by speed).
      clip("o4.mp4", 1, { start: "t@6", offset: 0.5 }),
    ]);
    expect(spans(r.children).slice(1)).toEqual([[5, 6], [0.5, 1.5], [2, 3], [3.5, 4.5]]);
  });

  it("anchors may reference ids anywhere in the array (forward references)", () => {
    const r = resolve([
      clip("over.mp4", 1, { start: "b@50%" }),
      clip("a.mp4", 4, { start: 0 }),
      clip("b.mp4", 6, { id: "b" }),
    ]);
    expect(spans(r.children)).toEqual([[7, 8], [0, 4], [4, 10]]);
  });

  it("chains anchors through several nodes regardless of array order", () => {
    const r = resolve([
      clip("c.mp4", 1, { id: "c", start: "b@100%" }),
      clip("b.mp4", 2, { id: "b", start: "a@100%" }),
      clip("a.mp4", 3, { id: "a", start: 1 }),
    ]);
    expect(spans(r.children)).toEqual([[6, 7], [4, 6], [1, 4]]);
    expect(r.duration).toBe(7);
  });

  it("a node after an anchored head continues THAT run", () => {
    const r = resolve([
      clip("a.mp4", 5, { id: "a" }),
      clip("b.mp4", 5),
      clip("o1.mp4", 1, { start: "a@50%" }),
      clip("o2.mp4", 2),
      clip("o3.mp4", 1, { offset: 0.5 }),
      clip("p1.mp4", 1, { start: 20 }),
      clip("p2.mp4", 1),
    ]);
    expect(spans(r.children)).toEqual([
      [0, 5],
      [5, 10],
      [2.5, 3.5],
      [3.5, 5.5],
      [6, 7],
      [20, 21],
      [21, 22],
    ]);
    expect(r.duration).toBe(22);
  });

  it("a run can anchor to a member of an earlier run that itself hangs off an anchor", () => {
    const r = resolve([
      clip("a.mp4", 10, { id: "a" }),
      clip("o1.mp4", 1, { start: "a@20%" }),
      clip("o2.mp4", 2, { id: "o2" }),
      clip("q.mp4", 1, { start: "o2@100%" }),
    ]);
    expect(spans(r.children)).toEqual([[0, 10], [2, 3], [3, 5], [5, 6]]);
  });

  it("the first node may carry a `start` too", () => {
    const r = resolve([clip("a.mp4", 2, { start: 3 }), clip("b.mp4", 2)]);
    expect(spans(r.children)).toEqual([[3, 5], [5, 7]]);
  });

  it("ids are scoped to their own children array", () => {
    // Same id at two levels is fine; each anchor sees its own siblings.
    const r = resolve([
      clip("a.mp4", 4, { id: "x" }),
      {
        type: "composition",
        start: "x@50%",
        children: [clip("i.mp4", 3, { id: "x" }), clip("j.mp4", 1, { start: "x@100%", offset: 1 })],
      },
    ]);
    const nested = r.children[1] as ResolvedComposition;
    expect(nested).toMatchObject({ timelineStart: 2, timelineEnd: 7 });
    expect(spans(nested.children)).toEqual([[0, 3], [4, 5]]);

    // …and an id inside a nested composition is invisible from outside.
    expect(() =>
      resolve([
        { type: "composition", children: [clip("i.mp4", 3, { id: "inner" })] },
        clip("o.mp4", 1, { start: "inner" }),
      ])
    ).toThrow(/anchor "inner" not found/);
  });
});

describe("runs: errors", () => {
  it("throws on an unknown anchor id", () => {
    expect(() => resolve([clip("a.mp4", 5), clip("b.mp4", 2, { start: "missing" })])).toThrow(
      /anchor "missing" not found/
    );
    expect(() => resolve([clip("a.mp4", 5), clip("b.mp4", 2, { start: "missing@50%" })])).toThrow(
      /anchor "missing" not found/
    );
  });

  it("throws on duplicate ids", () => {
    expect(() => resolve([clip("a.mp4", 2, { id: "x" }), clip("b.mp4", 2, { id: "x" })])).toThrow(
      /duplicate id "x" in composition/
    );
    // Whether or not anything anchors to it, and across runs.
    expect(() =>
      resolve([clip("a.mp4", 2, { id: "x" }), clip("b.mp4", 2), clip("c.mp4", 2, { id: "x", start: 0 })])
    ).toThrow(/duplicate id "x" in composition/);
  });

  it("throws on a two-node anchor cycle", () => {
    expect(() =>
      resolve([clip("a.mp4", 2, { id: "a", start: "b" }), clip("b.mp4", 2, { id: "b", start: "a@100%" })])
    ).toThrow(/anchor cycle through "a"/);
  });

  it("throws when a node anchors to itself", () => {
    expect(() => resolve([clip("a.mp4", 2, { id: "a", start: "a@50%" })])).toThrow(
      /anchor cycle through "a"/
    );
  });

  it("throws on a longer cycle", () => {
    expect(() =>
      resolve([
        clip("lead.mp4", 2),
        clip("a.mp4", 2, { id: "a", start: "c" }),
        clip("b.mp4", 2, { id: "b", start: "a" }),
        clip("c.mp4", 2, { id: "c", start: "b" }),
      ])
    ).toThrow(/anchor cycle through "a"/);
  });

  it("throws when a head anchors to a later member of its own run", () => {
    // `tail` follows `head` (no start), so its position depends on `head`.
    expect(() =>
      resolve([clip("head.mp4", 2, { id: "head", start: "tail@100%" }), clip("tail.mp4", 2, { id: "tail" })])
    ).toThrow(/anchor cycle through "head"/);
  });

  it("names a cycle through an id-less node by its index", () => {
    expect(() =>
      resolve([clip("lead.mp4", 1), clip("head.mp4", 2, { start: "tail" }), clip("tail.mp4", 2, { id: "tail" })])
    ).toThrow(/anchor cycle through child 1/);
  });

  it("a cycle inside a nested composition or an extension container throws too", () => {
    const cyc = [clip("a.mp4", 2, { id: "a", start: "b" }), clip("b.mp4", 2, { id: "b", start: "a" })];
    expect(() => resolve([{ type: "composition", children: cyc }])).toThrow(/anchor cycle/);
    expect(() =>
      resolve([{ type: "stage", source: "m.bin", duration: 3, children: cyc } as unknown as Child])
    ).toThrow(/anchor cycle/);
  });
});

describe("runs: composition duration = latest end", () => {
  it("is the max end, not the sum", () => {
    const r = resolve([clip("a.mp4", 5), clip("b.mp4", 5, { start: 0 }), clip("c.mp4", 3, { start: 1 })]);
    expect(r.duration).toBe(5);
  });

  it("an overlay shorter than the main run doesn't change it", () => {
    const r = resolve([clip("a.mp4", 5, { id: "a" }), clip("b.mp4", 5), clip("o.mp4", 2, { start: "a@50%" })]);
    expect(r.duration).toBe(10);
  });

  it("a node running past the main run extends it", () => {
    const r = resolve([clip("a.mp4", 5, { id: "a" }), clip("b.mp4", 5), clip("o.mp4", 4, { start: "a@100%", offset: 3 })]);
    expect(r.children[2]).toMatchObject({ timelineStart: 8, timelineEnd: 12 });
    expect(r.duration).toBe(12);
  });

  it("the last array element need not be the latest", () => {
    const r = resolve([clip("late.mp4", 2, { start: 30 }), clip("a.mp4", 5, { start: 0 }), clip("b.mp4", 5)]);
    expect(r.duration).toBe(32);
  });

  it("a trailing data node with a duration pads the tail; a zero-length one at the end doesn't", () => {
    expect(resolve([clip("a.mp4", 5), { type: "data", data: null, duration: 2 }]).duration).toBe(7);
    expect(resolve([clip("a.mp4", 5), { type: "data", data: null, offset: 2 }]).duration).toBe(7);
    expect(resolve([clip("a.mp4", 5), { type: "data", data: null }]).duration).toBe(5);
  });

  it("a nested composition's natural length is its own latest end, and that advances the parent run", () => {
    const r = resolve([
      {
        type: "composition",
        children: [clip("a.mp4", 4, { id: "a" }), clip("o.mp4", 5, { start: "a@50%" })],
      },
      clip("next.mp4", 1),
    ]);
    expect(r.children[0]).toMatchObject({ timelineStart: 0, timelineEnd: 7, duration: 7 });
    expect(r.children[1]).toMatchObject({ timelineStart: 7, timelineEnd: 8 });
    expect(r.duration).toBe(8);
  });

  it("the default window of a nested composition is [0, latest end]", () => {
    const r = resolve([
      {
        type: "composition",
        speed: 2,
        children: [clip("a.mp4", 4), clip("o.mp4", 6, { start: 2 })],
      },
    ]);
    expect(r.children[0]).toMatchObject({ timelineEnd: 4, duration: 4, speed: 2 });
  });
});

describe("runs: crop at 0", () => {
  it("trims a node that starts before 0, advancing its source by cropped × speed", () => {
    const r = resolve([
      // source [1, 11] at 2× → [-2, 3]; 2 output seconds = 4 source seconds cropped.
      { type: "clip", source: "a.mp4", in: 1, out: 11, speed: 2, start: -2 },
    ]);
    expect(r.children).toHaveLength(1);
    expect(r.children[0]).toMatchObject({
      sourceIn: 5,
      sourceOut: 11,
      speed: 2,
      timelineStart: 0,
      timelineEnd: 3,
    });
    expect(r.duration).toBe(3);
  });

  it("drops a node wholly before 0 (and one ending exactly at 0)", () => {
    const r = resolve([
      clip("gone.mp4", 2, { start: -5 }),
      clip("edge.mp4", 2, { start: -2 }),
      clip("kept.mp4", 4, { start: 0 }),
    ]);
    expect(sources(r.children)).toEqual(["kept.mp4"]);
    expect(r.duration).toBe(4);
  });

  it("a run keeps flowing from a dropped / cropped predecessor's real position", () => {
    const r = resolve([clip("a.mp4", 2, { start: -5 }), clip("b.mp4", 5), clip("c.mp4", 1)]);
    // a = [-5, -3] (dropped), b = [-3, 2] → cropped to [0, 2], c = [2, 3].
    expect(sources(r.children)).toEqual(["b.mp4", "c.mp4"]);
    expect(r.children[0]).toMatchObject({ sourceIn: 3, sourceOut: 5, timelineStart: 0, timelineEnd: 2 });
    expect(r.children[1]).toMatchObject({ timelineStart: 2, timelineEnd: 3 });
    expect(r.duration).toBe(3);
  });

  it("anchors resolve against the un-cropped target", () => {
    const r = resolve([
      clip("a.mp4", 6, { id: "a", start: -2 }), // really [-2, 4]
      clip("o1.mp4", 1, { start: "a@50%" }),
      clip("o2.mp4", 1, { start: "a@3" }),
      clip("gone.mp4", 1, { id: "gone", start: -10 }),
      clip("o3.mp4", 1, { start: "gone", offset: 12 }),
    ]);
    expect(sources(r.children)).toEqual(["a.mp4", "o1.mp4", "o2.mp4", "o3.mp4"]);
    expect(r.children[0]).toMatchObject({ sourceIn: 2, timelineStart: 0, timelineEnd: 4 });
    expect(spans(r.children).slice(1)).toEqual([[1, 2], [1, 2], [2, 3]]);
  });

  it("a source anchor before the target's `in` lands before it — cropped when that is before 0", () => {
    // Old model: these resolved to negative timeline times.
    const r = resolve([
      { type: "clip", source: "video.mp4", in: 2, out: 4, id: "myclip" },
      clip("other.mp4", 5, { start: "myclip@1" }), // [-1, 4]
      clip("gone.mp4", 1, { start: "myclip@0" }), // [-2, -1]
    ]);
    expect(sources(r.children)).toEqual(["video.mp4", "other.mp4"]);
    expect(r.children[1]).toMatchObject({ sourceIn: 1, sourceOut: 5, timelineStart: 0, timelineEnd: 4 });
  });

  it("trims static-like nodes without touching their content", () => {
    const r = resolve([
      { type: "static", source: "s.mp4", in: 3, duration: 5, start: -2 },
      { type: "rect", duration: 5, start: -1 },
      { type: "data", data: { k: 1 }, duration: 5, start: -4 },
    ]);
    expect(r.children[0]).toMatchObject({ type: "static", sourceTime: 3, timelineStart: 0, timelineEnd: 3 });
    expect(r.children[1]).toMatchObject({ type: "rect", timelineStart: 0, timelineEnd: 4 });
    expect(r.children[2]).toMatchObject({ type: "data", data: { k: 1 }, timelineStart: 0, timelineEnd: 1 });
  });

  it("crops a composition's children through its speed", () => {
    const r = resolve([
      {
        type: "composition",
        speed: 2,
        start: -1,
        children: [clip("x.mp4", 3), clip("y.mp4", 5)], // inner 8s → [-1, 3]
      },
    ]);
    const c = r.children[0] as ResolvedComposition;
    // 1 output second = 2 inner seconds cropped.
    expect(c).toMatchObject({ timelineStart: 0, timelineEnd: 3, duration: 3, speed: 2 });
    expect(c.children).toHaveLength(2);
    expect(c.children[0]).toMatchObject({ sourceIn: 2, sourceOut: 3, timelineStart: 0, timelineEnd: 1 });
    expect(c.children[1]).toMatchObject({ sourceIn: 0, sourceOut: 5, timelineStart: 1, timelineEnd: 6 });
  });

  it("applies inside nested compositions", () => {
    const r = resolve([
      clip("lead.mp4", 1),
      { type: "composition", children: [clip("x.mp4", 4, { offset: -1 }), clip("y.mp4", 2)] },
    ]);
    const c = r.children[1] as ResolvedComposition;
    expect(c).toMatchObject({ timelineStart: 1, timelineEnd: 6, duration: 5 });
    expect(c.children[0]).toMatchObject({ sourceIn: 1, timelineStart: 0, timelineEnd: 3 });
    expect(c.children[1]).toMatchObject({ timelineStart: 3, timelineEnd: 5 });
  });

  it("leaves untouched nodes alone", () => {
    const r = resolve([clip("a.mp4", 2, { start: -1 }), clip("b.mp4", 3, { start: 4 })]);
    expect(r.children[1]).toMatchObject({ sourceIn: 0, sourceOut: 3, timelineStart: 4, timelineEnd: 7 });
    expect(r.duration).toBe(7);
  });

  it("keeps a zero-length marker at 0 whether or not a sibling got cropped", () => {
    // KNOWN FAILING — suspected source bug (resolve.ts `placeChildren` →
    // `cropChildrenToWindow(resolved, 0, Infinity)`): the crop pass only runs
    // when some node starts before 0, and its `timelineEnd <= windowIn` test
    // then also drops a zero-length node sitting exactly at 0.
    const marker: Child = { type: "data", data: "cue", start: 0 };
    expect(resolve([clip("a.mp4", 2), marker]).children).toHaveLength(2);
    expect(resolve([clip("a.mp4", 2, { start: -1 }), marker]).children).toHaveLength(2);
  });
});

describe("runs: z-order", () => {
  it("resolved children stay 1:1 with the authored array, whatever their times", () => {
    const r = resolve([
      clip("over-late.mp4", 1, { start: "base@100%", offset: -1 }),
      clip("base.mp4", 5, { id: "base", start: 0 }),
      clip("over-early.mp4", 1, { start: 0 }),
      clip("tail.mp4", 2),
    ]);
    expect(sources(r.children)).toEqual(["over-late.mp4", "base.mp4", "over-early.mp4", "tail.mp4"]);
    expect(spans(r.children)).toEqual([[4, 5], [0, 5], [0, 1], [1, 3]]);
  });

  it("overlays between main-run segments keep their slot (old: appended after children)", () => {
    const r = resolve([
      clip("base1.mp4", 5, { id: "b1" }),
      clip("over1.mp4", 2, { start: "b1" }),
      clip("base2.mp4", 5, { start: "b1@100%" }),
      clip("over2.mp4", 2, { start: 0 }),
    ]);
    expect(sources(r.children)).toEqual(["base1.mp4", "over1.mp4", "base2.mp4", "over2.mp4"]);
    expect(r.duration).toBe(10);
  });

  it("a composition window drops children outside it but keeps the order of the rest", () => {
    const r = resolve([
      {
        type: "composition",
        in: 4,
        out: 8,
        children: [
          clip("late.mp4", 2, { start: 5 }),
          clip("early.mp4", 2, { start: 0 }),
          clip("mid.mp4", 3, { start: 3 }),
        ],
      },
    ]);
    const c = r.children[0] as ResolvedComposition;
    expect(sources(c.children)).toEqual(["late.mp4", "mid.mp4"]);
    expect(spans(c.children)).toEqual([[1, 3], [0, 2]]);
    expect(c.children[1]).toMatchObject({ sourceIn: 1, sourceOut: 3 });
  });
});

describe("runs: inside an extension container's children", () => {
  const map = (children: Child[], extra: object = {}): Child =>
    ({ type: "stage", source: "area.bin", duration: 6, children, ...extra }) as unknown as Child;
  const kids = (children: Child[]) =>
    (resolve([clip("lead.mp4", 2), map(children)]).children[1] as unknown as ResolvedExtensionNode).children!;

  it("places children in map-local time with the same run rules", () => {
    const c = kids([
      { type: "rect", duration: 2, id: "a" },
      { type: "rect", duration: 1, offset: 0.5 },
      { type: "rect", duration: 1, start: "a@50%" },
      { type: "rect", duration: 1 },
      { type: "circle", duration: 1, start: 4 },
      clip("c.mp4", 4, { start: "later@2", in: 0, out: 4 }),
      { type: "clip", source: "l.mp4", in: 1, out: 5, speed: 2, id: "later", start: 3 },
    ]);
    expect(spans(c)).toEqual([[0, 2], [2.5, 3.5], [1, 2], [2, 3], [4, 5], [3.5, 7.5], [3, 5]]);
  });

  it("cross-fades run members and crops at the map's 0", () => {
    const c = kids([
      clip("a.mp4", 3, { offset: -1 }),
      clip("b.mp4", 3, { offset: -1 }),
      clip("gone.mp4", 1, { start: -4 }),
    ]);
    expect(sources(c)).toEqual(["a.mp4", "b.mp4"]);
    expect(c[0]).toMatchObject({ sourceIn: 1, timelineStart: 0, timelineEnd: 2, transitionOut: 1 });
    expect(c[1]).toMatchObject({ timelineStart: 1, timelineEnd: 4, transition: 1 });
  });

  it("children never change the map's authored duration, and aren't cropped to it", () => {
    const short = resolve([map([{ type: "rect", duration: 1 }]), clip("next.mp4", 1)]);
    expect(short.children[0]).toMatchObject({ timelineStart: 0, timelineEnd: 6 });
    expect(short.children[1]).toMatchObject({ timelineStart: 6, timelineEnd: 7 });

    const long = resolve([
      map([clip("a.mp4", 5), clip("b.mp4", 4), { type: "rect", duration: 2, start: 20 }]),
      clip("next.mp4", 1),
    ]);
    const m = long.children[0] as unknown as ResolvedExtensionNode;
    expect(m).toMatchObject({ timelineStart: 0, timelineEnd: 6 });
    expect(spans(m.children!)).toEqual([[0, 5], [5, 9], [20, 22]]);
    expect(long.children[1]).toMatchObject({ timelineStart: 6, timelineEnd: 7 });
    expect(long.duration).toBe(7);

    expect((resolve([map([])]).children[0] as unknown as ResolvedExtensionNode).children!).toEqual([]);
  });

  it("the map itself is an ordinary run member / head / anchor target", () => {
    const r = resolve([
      clip("a.mp4", 4, { id: "a" }),
      map([], { id: "m", start: "a@50%" }),
      clip("after.mp4", 1),
      clip("o.mp4", 1, { start: "m@50%" }),
      map([], { offset: -0.5 }),
    ]);
    expect(spans(r.children)).toEqual([[0, 4], [2, 8], [8, 9], [5, 6], [5.5, 11.5]]);
    expect(fades(r.children)[3]).toEqual([undefined, 0.5]);
    expect(fades(r.children)[4]).toEqual([0.5, undefined]);
  });

  it("errors surface from map children", () => {
    expect(() => resolve([map([{ type: "rect", duration: 1, start: "nope" }])])).toThrow(
      /anchor "nope" not found/
    );
    expect(() =>
      resolve([map([{ type: "rect", duration: 1, id: "d" }, { type: "rect", duration: 1, id: "d" }])])
    ).toThrow(/duplicate id "d"/);
    // A map child can't see the map's own siblings.
    expect(() =>
      resolve([clip("a.mp4", 1, { id: "outer" }), map([{ type: "rect", duration: 1, start: "outer" }])])
    ).toThrow(/anchor "outer" not found/);
  });
});

describe("`duration` + overflow / underflow", () => {
  const one = (c: Child) => resolve([c]).children[0] as ResolvedClip;
  const base = { type: "clip" as const, source: "b.mp4" };

  it("no duration: the natural length, untouched", () => {
    expect(one({ ...base, in: 2, out: 8 })).toMatchObject({
      sourceIn: 2,
      sourceOut: 8,
      speed: 1,
      timelineEnd: 6,
    });
  });

  it("stretches by default when the content is longer (overflow)", () => {
    // old: start+end pinned over a shorter span
    expect(one({ ...base, in: 0, out: 6, duration: 3 })).toMatchObject({
      sourceIn: 0,
      sourceOut: 6,
      timelineStart: 0,
      timelineEnd: 3,
      speed: 2,
    });
  });

  it("stretches by default when the content is shorter (underflow)", () => {
    expect(one({ ...base, in: 0, out: 4, duration: 10 })).toMatchObject({
      sourceIn: 0,
      sourceOut: 4,
      timelineEnd: 10,
      speed: 0.4,
    });
  });

  it("an explicit `stretch` is the same as the default", () => {
    expect(one({ ...base, in: 0, out: 6, duration: 3, overflow: "stretch" }).speed).toBe(2);
    expect(one({ ...base, in: 0, out: 4, duration: 10, underflow: "stretch" }).speed).toBe(0.4);
  });

  it("a duration equal to the natural length changes nothing", () => {
    const c = one({ ...base, in: 1, out: 5, duration: 4, overflow: "trim-start", underflow: "loop" });
    expect(c).toMatchObject({ sourceIn: 1, sourceOut: 5, speed: 1, timelineEnd: 4 });
    expect(c.loop).toBeUndefined();
  });

  it("`{in, duration}` without `out` plays `duration` source seconds at speed 1", () => {
    expect(one({ ...base, in: 3, duration: 4 })).toMatchObject({
      sourceIn: 3,
      sourceOut: 7,
      speed: 1,
      timelineEnd: 4,
    });
  });

  it("overflow trim-end / trim-start / trim-center keep the rate and cut the source", () => {
    const c = (overflow: "trim-end" | "trim-start" | "trim-center") =>
      one({ ...base, in: 2, out: 8, duration: 3, overflow });
    expect(c("trim-end")).toMatchObject({ sourceIn: 2, sourceOut: 5, speed: 1, timelineEnd: 3 });
    expect(c("trim-start")).toMatchObject({ sourceIn: 5, sourceOut: 8, speed: 1, timelineEnd: 3 });
    expect(c("trim-center")).toMatchObject({ sourceIn: 3.5, sourceOut: 6.5, speed: 1, timelineEnd: 3 });
  });

  it("underflow extend-end / extend-start / extend-center keep the rate and widen the source", () => {
    const c = (underflow: "extend-end" | "extend-start" | "extend-center") =>
      one({ ...base, in: 5, out: 8, duration: 7, underflow });
    expect(c("extend-end")).toMatchObject({ sourceIn: 5, sourceOut: 12, speed: 1, timelineEnd: 7 });
    expect(c("extend-start")).toMatchObject({ sourceIn: 1, sourceOut: 8, speed: 1, timelineEnd: 7 });
    expect(c("extend-center")).toMatchObject({ sourceIn: 3, sourceOut: 10, speed: 1, timelineEnd: 7 });
  });

  it("only the strategy for the actual direction applies", () => {
    // Underflowing: `overflow` is irrelevant → default stretch.
    expect(one({ ...base, in: 0, out: 4, duration: 8, overflow: "trim-end" })).toMatchObject({
      sourceOut: 4,
      speed: 0.5,
      timelineEnd: 8,
    });
    // Overflowing: `underflow` is irrelevant → default stretch.
    expect(one({ ...base, in: 0, out: 4, duration: 2, underflow: "extend-end" })).toMatchObject({
      sourceOut: 4,
      speed: 2,
      timelineEnd: 2,
    });
  });

  it("underflow loop: a 1s clip with duration 10 loops 10 times", () => {
    const r = resolve([{ ...base, in: 2, out: 3, duration: 10, underflow: "loop" }, clip("next.mp4", 1)]);
    expect(r.children[0]).toMatchObject({
      sourceIn: 2,
      sourceOut: 3,
      speed: 1,
      timelineStart: 0,
      timelineEnd: 10,
      loop: { period: 1, phase: 0 },
    });
    // The run continues after the whole looped span.
    expect(r.children[1]).toMatchObject({ timelineStart: 10, timelineEnd: 11 });
    expect(r.duration).toBe(11);
  });

  it("speed + duration + loop: `speed` is the per-cycle rate", () => {
    expect(one({ ...base, in: 0, out: 4, speed: 2, duration: 10, underflow: "loop" })).toMatchObject({
      sourceIn: 0,
      sourceOut: 4,
      speed: 2,
      timelineEnd: 10,
      loop: { period: 2, phase: 0 },
    });
  });

  it("speed + duration + trim / extend: the cut is measured at that rate", () => {
    // 10 source seconds at 2× = 5s natural; 3s output keeps 6 source seconds.
    expect(one({ ...base, in: 0, out: 10, speed: 2, duration: 3, overflow: "trim-end" })).toMatchObject({
      sourceIn: 0,
      sourceOut: 6,
      speed: 2,
      timelineEnd: 3,
    });
    // 4 source seconds at 2× = 2s natural; 5s output needs 10 source seconds.
    expect(one({ ...base, in: 0, out: 4, speed: 2, duration: 5, underflow: "extend-end" })).toMatchObject({
      sourceIn: 0,
      sourceOut: 10,
      speed: 2,
      timelineEnd: 5,
    });
  });

  it("works on anchored nodes (old: both ends pinned to a target)", () => {
    const r = resolve([
      clip("target.mp4", 10, { id: "target" }),
      { ...base, in: 0, out: 6, start: "target", duration: 3, overflow: "trim-end" },
      { ...base, in: 5, out: 8, start: "target@50%", duration: 5, underflow: "extend-end" },
      { ...base, in: 0, out: 4, start: "target", duration: 10 },
    ]);
    expect(r.children[1]).toMatchObject({ sourceIn: 0, sourceOut: 3, timelineStart: 0, timelineEnd: 3, speed: 1 });
    expect(r.children[2]).toMatchObject({ sourceIn: 5, sourceOut: 10, timelineStart: 5, timelineEnd: 10, speed: 1 });
    expect(r.children[3]).toMatchObject({ sourceIn: 0, sourceOut: 4, timelineStart: 0, timelineEnd: 10, speed: 0.4 });
    expect(r.duration).toBe(10);
  });

  it("applies to audio the same way", () => {
    const r = resolve([
      { type: "audio", source: "a.wav", in: 0, out: 2, duration: 7, underflow: "loop" },
      { type: "audio", source: "b.wav", in: 0, out: 8, duration: 2, overflow: "trim-start" },
    ]);
    expect(r.children[0]).toMatchObject({ type: "audio", timelineEnd: 7, loop: { period: 2, phase: 0 } });
    expect(r.children[1]).toMatchObject({ type: "audio", sourceIn: 6, sourceOut: 8, speed: 1, timelineStart: 7, timelineEnd: 9 });
  });

  describe("on a composition (content = the inner window at `speed`)", () => {
    const inner = () => [clip("a.mp4", 3), clip("b.mp4", 3)];
    const nested = (extra: Partial<Composition>) =>
      resolve([{ type: "composition", children: inner(), ...extra } as Child, clip("next.mp4", 1)]);

    it("stretches by default, both directions", () => {
      const slow = nested({ duration: 12 });
      expect(slow.children[0]).toMatchObject({ timelineEnd: 12, duration: 12, speed: 0.5 });
      expect((slow.children[0] as ResolvedComposition).children).toHaveLength(2);
      expect(slow.children[1].timelineStart).toBe(12);

      const fast = nested({ duration: 2 });
      expect(fast.children[0]).toMatchObject({ timelineEnd: 2, duration: 2, speed: 3 });
      expect(fast.children[1].timelineStart).toBe(2);
    });

    it("stretches the in/out window, not the whole inner timeline", () => {
      const r = nested({ in: 1, out: 5, duration: 8 });
      const c = r.children[0] as ResolvedComposition;
      expect(c).toMatchObject({ timelineEnd: 8, duration: 8, speed: 0.5 });
      expect(spans(c.children)).toEqual([[0, 2], [2, 4]]);
    });

    it("overflow trim-end crops the inner children", () => {
      const r = nested({ duration: 4, overflow: "trim-end" });
      const c = r.children[0] as ResolvedComposition;
      expect(c).toMatchObject({ timelineEnd: 4, duration: 4, speed: 1 });
      expect(c.children[1]).toMatchObject({ sourceIn: 0, sourceOut: 1, timelineStart: 3, timelineEnd: 4 });
      expect(r.children[1].timelineStart).toBe(4);
    });

    it("overflow trim-start keeps the tail of the window", () => {
      const c = nested({ duration: 2, overflow: "trim-start" }).children[0] as ResolvedComposition;
      expect(c).toMatchObject({ timelineEnd: 2, duration: 2, speed: 1 });
      expect(c.children).toHaveLength(1);
      expect(c.children[0]).toMatchObject({ source: "b.mp4", sourceIn: 1, sourceOut: 3, timelineStart: 0, timelineEnd: 2 });
    });

    it("underflow extend-end holds the output open past the content", () => {
      const r = nested({ duration: 9, underflow: "extend-end" });
      const c = r.children[0] as ResolvedComposition;
      expect(c).toMatchObject({ timelineEnd: 9, duration: 9, speed: 1 });
      expect(spans(c.children)).toEqual([[0, 3], [3, 6]]);
      expect(r.children[1].timelineStart).toBe(9);
    });

    it("underflow loop replays the window; `duration` stays one cycle", () => {
      const r = nested({ duration: 15, underflow: "loop" });
      const c = r.children[0] as ResolvedComposition;
      expect(c).toMatchObject({
        timelineStart: 0,
        timelineEnd: 15,
        duration: 6,
        speed: 1,
        loop: { period: 6, phase: 0 },
      });
      expect(spans(c.children)).toEqual([[0, 3], [3, 6]]);
      expect(r.children[1].timelineStart).toBe(15);
    });

    it("speed + duration + loop: one cycle is the window at `speed`", () => {
      const c = nested({ speed: 2, duration: 10, underflow: "loop" }).children[0] as ResolvedComposition;
      expect(c).toMatchObject({ timelineEnd: 10, duration: 3, speed: 2, loop: { period: 3, phase: 0 } });
      expect(c.children).toHaveLength(2);
    });
  });
});

describe("schema: id / start / offset", () => {
  const withNode = (fields: object) =>
    validate({
      type: "composition",
      children: [
        { type: "clip", source: "a.mp4", in: 0, out: 5, id: "a" },
        { type: "clip", source: "b.mp4", in: 0, out: 5, ...fields },
      ],
    });
  const ok = (fields: object) => {
    const r = withNode(fields);
    expect(r.success, r.success ? "" : `${JSON.stringify(fields)}: ${r.errors.join("\n")}`).toBe(true);
  };
  const bad = (fields: object) =>
    expect(withNode(fields).success, JSON.stringify(fields)).toBe(false);

  it("accepts every `start` form", () => {
    for (const start of [0, 3, 2.5, -1, "a", "a@50%", "a@0%", "a@100%", "a@12.5%", "a@150%", "a@-20%", "a@10", "a@0", "a@2.75", "a@-3"]) {
      ok({ start });
    }
  });

  it("accepts ids with ordinary punctuation and references to them", () => {
    for (const id of ["intro", "clip-1", "clip_1", "a.b", "1st", "take 2", "50%", "日本語"]) {
      ok({ id });
      ok({ start: id });
      ok({ start: `${id}@50%` });
    }
  });

  it("rejects malformed `start` strings", () => {
    for (const start of ["", "a@", "@50%", "a@b", "a@50%%", "a@50 %", "a@ 50%", "a@1@2", "a@1e3", "a@.5", "a@5.", "a@50%+1", "a@50% + 1"]) {
      bad({ start });
    }
  });

  it("rejects a numeric string as `start` (an absolute position must be a number)", () => {
    for (const start of ["5", "0", "-2", "2.5", " 5 "]) bad({ start });
  });

  it("rejects non-number / non-string `start`s, including the legacy object form", () => {
    bad({ start: null });
    bad({ start: true });
    bad({ start: ["a"] });
    bad({ start: { anchor: "a", timeSource: "output" } });
    bad({ start: { anchor: "a", timeSource: "output", anchorPoint: "50%" } });
    bad({ start: { anchor: "a", timeSource: "source", anchorPoint: 2 } });
    bad({ start: { offset: 3 } });
  });

  it("rejects ids that contain '@', read as a number, or have surrounding whitespace", () => {
    for (const id of ["", "a@b", "@", "a@", "5", "-2", "2.5", " a", "a ", " 5 "]) bad({ id });
  });

  it("rejects non-string ids", () => {
    bad({ id: 5 });
    bad({ id: null });
  });

  it("accepts a numeric `offset` of either sign, with or without `start`", () => {
    ok({ offset: 0 });
    ok({ offset: 2 });
    ok({ offset: -1.5 });
    ok({ start: "a@50%", offset: -1.5 });
    ok({ start: 4, offset: 2 });
  });

  it("rejects a non-numeric `offset` (percent offsets are gone)", () => {
    bad({ offset: "25%" });
    bad({ offset: "2" });
    bad({ offset: null });
  });

  it("rejects the removed `end` anchor and `transition`", () => {
    bad({ end: "a@100%" });
    bad({ end: 5 });
    bad({ end: { anchor: "a", timeSource: "output", anchorPoint: "100%" } });
    bad({ transition: 1 });
    bad({ transition: 0 });
    bad({ timeSource: "source" });
  });

  it("carries id / start / offset on every node type", () => {
    const place = { id: "n", start: "a@50%", offset: -0.5 };
    const nodes: object[] = [
      { type: "clip", source: "v.mp4", in: 0, out: 1 },
      { type: "audio", source: "a.wav", in: 0, out: 1 },
      { type: "static", source: "s.png", duration: 1 },
      { type: "data", data: null },
      { type: "rect", duration: 1 },
      { type: "rect", duration: 1 },
      { type: "circle", duration: 1 },
      { type: "stage", source: "m.bin", duration: 1 },
      { type: "composition", children: [] },
    ];
    for (const node of nodes) {
      const r = validate({
        type: "composition",
        children: [{ type: "clip", source: "a.mp4", in: 0, out: 5, id: "a" }, { ...node, ...place }],
      });
      expect(r.success, r.success ? "" : `${JSON.stringify(node)}: ${r.errors.join("\n")}`).toBe(true);
      // …and none of them takes the removed fields.
      for (const legacy of [{ end: "a" }, { transition: 1 }]) {
        expect(
          validate({ type: "composition", children: [{ ...node, ...legacy }] }).success,
          JSON.stringify({ node, legacy }),
        ).toBe(false);
      }
    }
  });

  it("rejects `attachments` on a composition (root and nested) and on a map", () => {
    const overlay = [{ type: "clip", source: "o.mp4", in: 0, out: 1 }];
    expect(validate({ type: "composition", children: [], attachments: overlay }).success).toBe(false);
    expect(validate({ type: "composition", children: [], attachments: [] }).success).toBe(false);
    expect(
      validate({
        type: "composition",
        children: [{ type: "composition", children: [], attachments: overlay }],
      }).success
    ).toBe(false);
    expect(
      validate({
        type: "composition",
        children: [{ type: "stage", source: "m.bin", duration: 1, attachments: overlay }],
      }).success
    ).toBe(false);
    expect(
      validate({
        type: "composition",
        children: [{ type: "stage", source: "m.bin", duration: 1, children: overlay }],
      }).success
    ).toBe(true);
  });

  it('rejects the removed `type: "empty"`', () => {
    expect(
      validate({ type: "composition", children: [{ type: "empty", duration: 2 }] }).success
    ).toBe(false);
  });

  it("rect / circle always need a duration, anchored or not", () => {
    for (const node of [{ type: "rect" }, { type: "circle" }]) {
      bad({ ...node, in: undefined, out: undefined, source: undefined });
      const r = (extra: object) =>
        validate({
          type: "composition",
          children: [{ type: "clip", source: "a.mp4", in: 0, out: 5, id: "a" }, { ...node, ...extra }],
        }).success;
      expect(r({}), JSON.stringify(node)).toBe(false);
      expect(r({ start: "a" }), JSON.stringify(node)).toBe(false);
      expect(r({ start: "a", duration: 2 }), JSON.stringify(node)).toBe(true);
    }
  });

  it("speed + duration needs a non-stretch overflow/underflow (clip, audio, composition)", () => {
    const nodes: object[] = [
      { type: "clip", source: "v.mp4", in: 0, out: 4 },
      { type: "audio", source: "a.wav", in: 0, out: 4 },
      { type: "composition", children: [{ type: "clip", source: "v.mp4", in: 0, out: 4 }] },
    ];
    for (const node of nodes) {
      const r = (extra: object) =>
        validate({ type: "composition", children: [{ ...node, speed: 2, duration: 10, ...extra }] });
      const plain = r({});
      expect(plain.success, JSON.stringify(node)).toBe(false);
      if (!plain.success) {
        expect(plain.errors.join("\n")).toMatch(/'speed' and 'duration' together need a non-stretch/);
      }
      expect(r({ underflow: "stretch" }).success).toBe(false);
      expect(r({ overflow: "stretch" }).success).toBe(false);
      expect(r({ underflow: "loop" }).success).toBe(true);
      expect(r({ underflow: "extend-end" }).success).toBe(true);
      expect(r({ overflow: "trim-end" }).success).toBe(true);
      expect(r({ overflow: "stretch", underflow: "loop" }).success).toBe(true);
      // Either one alone stays fine.
      expect(validate({ type: "composition", children: [{ ...node, speed: 2 }] }).success).toBe(true);
      expect(validate({ type: "composition", children: [{ ...node, duration: 10 }] }).success).toBe(true);
      expect(
        validate({ type: "composition", children: [{ ...node, duration: 10, underflow: "loop" }] }).success
      ).toBe(true);
    }
  });

  it("a validated document resolves with the documented placement", () => {
    const r = validate({
      type: "composition",
      children: [
        { type: "clip", source: "a.mp4", in: 0, out: 5, id: "a" },
        { type: "clip", source: "b.mp4", in: 0, out: 5, offset: -1 },
        { type: "rect", duration: 2, start: "a@50%" },
        { type: "audio", source: "bed.wav", in: 0, out: 2, start: 0, duration: 9, underflow: "loop" },
      ],
    });
    expect(r.success, r.success ? "" : r.errors.join("\n")).toBe(true);
    if (r.success) {
      const t = resolveComposition(r.data);
      expect(spans(t.children)).toEqual([[0, 5], [4, 9], [2.5, 4.5], [0, 9]]);
      expect(t.duration).toBe(9);
    }
  });
});

describe("anchor helpers", () => {
  it("parseStart reads every form", () => {
    expect(parseStart(3)).toEqual({ kind: "absolute", time: 3 });
    expect(parseStart(-1.5)).toEqual({ kind: "absolute", time: -1.5 });
    expect(parseStart("intro")).toEqual({ kind: "node", id: "intro" });
    expect(parseStart("intro@50%")).toEqual({
      kind: "node",
      id: "intro",
      point: { kind: "percent", value: 0.5 },
    });
    expect(parseStart("intro@100%")).toEqual({
      kind: "node",
      id: "intro",
      point: { kind: "percent", value: 1 },
    });
    expect(parseStart("intro@12.5%")).toEqual({
      kind: "node",
      id: "intro",
      point: { kind: "percent", value: 0.125 },
    });
    expect(parseStart("intro@-20%")).toEqual({
      kind: "node",
      id: "intro",
      point: { kind: "percent", value: -0.2 },
    });
    expect(parseStart("intro@10")).toEqual({
      kind: "node",
      id: "intro",
      point: { kind: "source", value: 10 },
    });
    expect(parseStart("intro@0")).toEqual({
      kind: "node",
      id: "intro",
      point: { kind: "source", value: 0 },
    });
    expect(parseStart("intro@-2.25")).toEqual({
      kind: "node",
      id: "intro",
      point: { kind: "source", value: -2.25 },
    });
    // Ids keep their punctuation — only '@' splits.
    expect(parseStart("clip-1.take 2@50%")).toMatchObject({ id: "clip-1.take 2" });
    expect(parseStart("50%")).toEqual({ kind: "node", id: "50%" });
  });

  it("parseStart throws on a malformed anchor", () => {
    for (const s of ["", "a@", "@5", "a@b", "a@1@2", "a@50%%"]) {
      expect(() => parseStart(s), s).toThrow(/invalid start anchor/);
    }
  });

  it("formatStart is the inverse of parseStart", () => {
    for (const s of [0, 3, -1.5, "intro", "intro@50%", "intro@0%", "intro@100%", "intro@12.5%", "intro@-20%", "intro@10", "intro@0", "intro@2.75"]) {
      expect(formatStart(parseStart(s))).toBe(s);
    }
    expect(formatStart({ kind: "absolute", time: 2 })).toBe(2);
    expect(formatStart({ kind: "node", id: "x" })).toBe("x");
    expect(formatStart({ kind: "node", id: "x", point: { kind: "percent", value: 0.25 } })).toBe("x@25%");
    expect(formatStart({ kind: "node", id: "x", point: { kind: "source", value: 4 } })).toBe("x@4");
  });

  it("formatStart trims float noise to 6 decimals", () => {
    expect(formatStart({ kind: "node", id: "x", point: { kind: "percent", value: 0.1 + 0.2 } })).toBe("x@30%");
    expect(formatStart({ kind: "node", id: "x", point: { kind: "percent", value: 1 / 3 } })).toBe("x@33.333333%");
    expect(formatStart({ kind: "node", id: "x", point: { kind: "source", value: 0.1 + 0.2 } })).toBe("x@0.3");
    expect(formatStart({ kind: "node", id: "x", point: { kind: "source", value: 1.23456789 } })).toBe("x@1.234568");
    // What it writes always validates and parses back.
    expect(parseStart(formatStart({ kind: "node", id: "x", point: { kind: "source", value: 1e-9 } }))).toEqual({
      kind: "node",
      id: "x",
      point: { kind: "source", value: 0 },
    });
  });

  it("startAnchorId returns the referenced id, if any", () => {
    expect(startAnchorId(undefined)).toBeUndefined();
    expect(startAnchorId(4)).toBeUndefined();
    expect(startAnchorId("a")).toBe("a");
    expect(startAnchorId("a@50%")).toBe("a");
    expect(startAnchorId("a@10")).toBe("a");
  });

  const kids = [
    {}, // 0  run A head (implicit first)
    {}, // 1
    { start: "x@50%" }, // 2  run B head
    {}, // 3
    {}, // 4
    { start: 0 }, // 5  run C head (absolute 0 still counts)
    { start: "y" }, // 6  run D head
  ];

  it("runsOf splits the array at every node with a `start`", () => {
    expect(runsOf(kids)).toEqual([[0, 2], [2, 5], [5, 6], [6, 7]]);
    expect(runsOf([])).toEqual([]);
    expect(runsOf([{}])).toEqual([[0, 1]]);
    expect(runsOf([{ start: 3 }, {}])).toEqual([[0, 2]]);
    expect(runsOf([{}, {}, {}])).toEqual([[0, 3]]);
    expect(runsOf([{ start: 1 }, { start: 2 }])).toEqual([[0, 1], [1, 2]]);
  });

  it("runHeadIndex walks back to the node that heads the run", () => {
    expect(kids.map((_, i) => runHeadIndex(kids, i))).toEqual([0, 0, 2, 2, 2, 5, 6]);
    expect(runHeadIndex([{ start: 3 }, {}], 1)).toBe(0);
  });

  it("isRunMember is true for a non-first node without `start`", () => {
    expect(kids.map((_, i) => isRunMember(kids, i))).toEqual([false, true, false, true, true, false, false]);
    expect(isRunMember([{ start: 3 }, {}], 0)).toBe(false);
    expect(isRunMember([{ start: 3 }, {}], 1)).toBe(true);
  });

  it("offset doesn't affect run membership", () => {
    const withOffsets: { start?: number; offset?: number }[] = [
      { offset: 1 },
      { offset: -1 },
      { start: 0, offset: -1 },
    ];
    expect(runsOf(withOffsets)).toEqual([[0, 2], [2, 3]]);
  });

  it("the helpers agree with the resolver: only run members cross-fade", () => {
    const children: Child[] = [
      clip("a.mp4", 4, { id: "a" }),
      clip("b.mp4", 4, { offset: -1 }),
      clip("c.mp4", 4, { start: "a", offset: -1 }),
      clip("d.mp4", 4, { offset: -1 }),
      clip("e.mp4", 4, { start: 20, offset: -1 }),
    ];
    const r = resolve(children);
    // c lands at −1 and is cropped, but stays in the array.
    expect(r.children).toHaveLength(children.length);
    r.children.forEach((c, i) => {
      expect((c as Fades).transition != null, `child ${i}`).toBe(isRunMember(children, i));
    });
  });
});

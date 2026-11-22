import { describe, expect, it } from "vitest";
import { createSeam } from "@seam/core";
import type { Child, Composition, SeamFile } from "@seam/core";
import {
  insertIntoRuns,
  moveRun,
  removeFromRuns,
  removeWithDependents,
  shiftOffsets,
} from "../runEdit.js";
import { moveNodesTracked, parsePath, pathKey, removeNodesAtPaths } from "../nodePath.js";
import { applyAttach } from "../attachTool.js";
import { dragAnchorPoint, toggleAnchorPoint, type AnchorEditCtx } from "../anchorEdit.js";
import { layoutTree } from "../timelineTree.js";
import { dropTargetAt, flattenDropRegions, runZIndexAt } from "../dropRegions.js";
import { ROW_GAP, ROW_HEIGHT, RULER_HEIGHT } from "../timelineLayout.js";
import { timeAfterLift } from "../dropTime.js";

const seam = createSeam();
const { resolveComposition } = seam;

const clip = (name: string, extra: Record<string, unknown> = {}): Child =>
  ({ type: "clip", source: `${name}.mp4`, in: 0, out: 5, ...extra }) as Child;
const names = (children: Child[]) =>
  children.map((c) => (c as { source: string }).source.replace(".mp4", ""));
const placement = (c: Child) => {
  const p = c as { start?: unknown; offset?: number };
  return { ...(p.start != null ? { start: p.start } : {}), ...(p.offset != null ? { offset: p.offset } : {}) };
};
const doc = (children: Child[]): SeamFile => ({ type: "composition", children });
const starts = (d: Composition) =>
  resolveComposition(d, { uncropped: true }).children.map((c) => c.timelineStart);

describe("removeFromRuns — anchor transfer", () => {
  it("a removed head hands start + offset to its successor (which drops its own offset)", () => {
    const out = removeFromRuns(
      [clip("a"), clip("h", { start: "a@2", offset: 1 }), clip("m", { offset: -1 }), clip("n")],
      new Set([1]),
    );
    expect(names(out)).toEqual(["a", "m", "n"]);
    expect(placement(out[1])).toEqual({ start: "a@2", offset: 1 });
    expect(placement(out[2])).toEqual({});
  });

  it("removing a member leaves the run alone; removing a whole run leaves nothing behind", () => {
    const kids = [clip("a"), clip("b", { offset: 2 }), clip("h", { start: 7 }), clip("c")];
    expect(removeFromRuns(kids, new Set([1])).map(placement)).toEqual([{}, { start: 7 }, {}]);
    const gone = removeFromRuns(kids, new Set([2, 3]));
    expect(names(gone)).toEqual(["a", "b"]);
    expect(placement(gone[1])).toEqual({ offset: 2 });
  });

  it("removing the implicit head puts its successor at 0", () => {
    const out = removeFromRuns([clip("a"), clip("b", { offset: 3 })], new Set([0]));
    expect(placement(out[0])).toEqual({});
  });
});

describe("removeWithDependents — delete cascade", () => {
  it("takes every run anchored (transitively) to a removed id, whole", () => {
    const kids = [
      clip("a", { id: "a" }),
      clip("b"),
      clip("o1", { start: "a@1", id: "o1" }),
      clip("o1b"),
      clip("o2", { start: "o1" }),
      clip("keep", { start: 3 }),
    ];
    expect(names(removeWithDependents(kids, new Set([0])))).toEqual(["b", "keep"]);
  });
});

describe("insertIntoRuns", () => {
  const base = () => [clip("a"), clip("b"), clip("h", { start: 9, offset: 1 }), clip("c")];

  it("plain insert extends the run of the node before the index", () => {
    const out = insertIntoRuns(base(), 2, [clip("x", { start: 4 })]);
    expect(names(out)).toEqual(["a", "b", "x", "h", "c"]);
    expect(placement(out[2])).toEqual({});
    expect(placement(out[3])).toEqual({ start: 9, offset: 1 });
  });

  it("`before` a head takes over its anchor", () => {
    const out = insertIntoRuns(base(), 2, [clip("x", { offset: -1 }), clip("y", { offset: 2 })], {
      before: true,
    });
    expect(names(out)).toEqual(["a", "b", "x", "y", "h", "c"]);
    expect(placement(out[2])).toEqual({ start: 9, offset: 1 });
    expect(placement(out[3])).toEqual({ offset: 2 });
    expect(placement(out[4])).toEqual({});
  });

  it("a new run slides to the run boundary and never splits a run", () => {
    const out = insertIntoRuns(base(), 1, [clip("x")], { start: 2.5 });
    expect(names(out)).toEqual(["a", "b", "x", "h", "c"]);
    expect(placement(out[2])).toEqual({ start: 2.5 });
  });

  it("a new run at the front pins the old implicit head at 0", () => {
    const out = insertIntoRuns([clip("a"), clip("b")], 0, [clip("x")], { start: 3 });
    expect(names(out)).toEqual(["x", "a", "b"]);
    expect(out.map(placement)).toEqual([{ start: 3 }, { start: 0 }, {}]);
    expect(starts(doc(out))).toEqual([3, 0, 5]);
  });
});

describe("moveRun / shiftOffsets", () => {
  it("re-stacks a whole run and pins a departing implicit head", () => {
    const kids = [clip("a"), clip("b"), clip("h", { start: 1 }), clip("k", { start: 2 })];
    const out = moveRun(kids, 0, 2, 4);
    expect(names(out)).toEqual(["h", "k", "a", "b"]);
    expect(out.map(placement)).toEqual([{ start: 1 }, { start: 2 }, { start: 0 }, {}]);
    expect(moveRun(kids, 2, 3, 2)).toBe(kids);
  });

  it("pins the implicit head when another run is moved in front of it", () => {
    const kids = [clip("a"), clip("b"), clip("h", { start: 1 })];
    const out = moveRun(kids, 2, 3, 0);
    expect(names(out)).toEqual(["h", "a", "b"]);
    expect(out.map(placement)).toEqual([{ start: 1 }, { start: 0 }, {}]);
    expect(starts(doc(out))).toEqual([1, 0, 5]);
  });

  it("adds the delta to every selected node (dumb: adjacent members compound)", () => {
    const out = shiftOffsets([clip("a"), clip("b"), clip("c", { offset: -1 })], new Set([1, 2]), 1);
    expect(out.map(placement)).toEqual([{}, { offset: 1 }, {}]);
    expect(starts(doc(out))).toEqual([0, 6, 11]);
  });
});

describe("shiftOffsets — clamped (Shift-drag)", () => {
  const kids = [clip("a"), clip("pos", { offset: 2 }), clip("neg", { offset: -2 }), clip("zero")];
  const all = new Set([1, 2, 3]);
  const offsets = (out: Child[]) => out.slice(1).map((c) => (c as { offset?: number }).offset ?? 0);

  it("an offset never crosses zero within the operation", () => {
    expect(offsets(shiftOffsets(kids, all, -5, { direction: -1 }))).toEqual([0, -7, -5]);
    expect(offsets(shiftOffsets(kids, all, 5, { direction: 1 }))).toEqual([7, 0, 5]);
  });

  it("a zero offset only moves in the drag's first direction", () => {
    expect(offsets(shiftOffsets(kids, all, 1, { direction: -1 }))).toEqual([3, -1, 0]);
    expect(offsets(shiftOffsets(kids, all, -1, { direction: 1 }))).toEqual([1, -3, 0]);
  });
});

describe("shiftOffsets — end clamp (Shift-drag)", () => {
  // One 5s node at index 1; its end sits on the reference point at offset −5.
  const at = (offset: number) => [clip("a"), clip("n", offset ? { offset } : {})];
  const durations = new Map([[1, 5]]);
  const go = (offset: number, delta: number, direction: 1 | -1) =>
    (shiftOffsets(at(offset), new Set([1]), delta, { direction, durations })[1] as { offset?: number })
      .offset ?? 0;

  it("between the two boundaries: stops at 0 and at −duration", () => {
    expect(go(-2, 10, 1)).toBe(0);
    expect(go(-2, -10, -1)).toBe(-5);
  });
  it("past the end boundary: cannot come back through it", () => {
    expect(go(-7, 10, 1)).toBe(-5);
    expect(go(-7, -1, -1)).toBe(-8);
  });
  it("on a boundary: the drag's first direction picks the side", () => {
    expect(go(0, -10, -1)).toBe(-5);
    expect(go(0, 3, 1)).toBe(3);
    expect(go(-5, -3, -1)).toBe(-8);
    expect(go(-5, 10, 1)).toBe(0);
  });
});

describe("moveNodesTracked", () => {
  it("moves a multi-selection contiguous in the given order and reports new paths", () => {
    const d = doc([clip("a"), clip("b"), clip("c"), clip("d")]);
    const moved = moveNodesTracked(d, [parsePath("children.3"), parsePath("children.0")], [], 2)!;
    expect(names(moved.doc.children!)).toEqual(["b", "d", "a", "c"]);
    expect(moved.paths.map(pathKey)).toEqual(["children.1", "children.2"]);
  });

  it("moves into a nested composition and out again", () => {
    const d = doc([
      clip("a"),
      { type: "composition", children: [clip("x"), clip("y")] } as Child,
      clip("b"),
    ]);
    const into = moveNodesTracked(d, [parsePath("children.0")], parsePath("children.1"), 1)!;
    expect(into.paths.map(pathKey)).toEqual(["children.0.children.1"]);
    const inner = (into.doc.children![0] as Composition).children!;
    expect(names(inner)).toEqual(["x", "a", "y"]);
    const out = moveNodesTracked(into.doc, [parsePath("children.0.children.0")], [], 2, { start: 4 })!;
    expect(names([out.doc.children![1], out.doc.children![2]])).toEqual(["b", "x"]);
    expect(placement(out.doc.children![2])).toEqual({ start: 4 });
  });

  it("delete cascades to anchored runs", () => {
    const d = doc([clip("a", { id: "a" }), clip("b"), clip("o", { start: "a@1" })]);
    expect(names(removeNodesAtPaths(d, [parsePath("children.0")]).children!)).toEqual(["b"]);
  });
});

describe("applyAttach — anchors without moving", () => {
  const at = (d: SeamFile, t: number, primary: string, secondaries: string[]) =>
    applyAttach(seam, d, resolveComposition(d, { uncropped: true }), t, primary, secondaries)!;

  it("point at the playhead, offset back to where the secondary already is", () => {
    // a plays source [10,20] at 0..10; o sits at 2..7; playhead at 4.
    const d = doc([clip("a", { in: 10, out: 20 }), clip("o", { start: 2 })]);
    const r = at(d, 4, "children.0", ["children.1"]);
    expect((r.doc.children![0] as { id?: string }).id).toBe("anchor");
    expect(placement(r.doc.children![1])).toEqual({ start: "anchor@14", offset: -2 });
    expect(starts(r.doc)).toEqual(starts(d));
  });

  it("pulls the point inside the secondary when the playhead is before or past it", () => {
    const d = doc([clip("a", { in: 10, out: 30 }), clip("o", { start: 6 })]);
    // Playhead before o (o spans 6..11) → point at o's start, no offset.
    expect(placement(at(d, 1, "children.0", ["children.1"]).doc.children![1])).toEqual({
      start: "anchor@16",
    });
    // Playhead past o → point at o's end.
    const past = at(d, 15, "children.0", ["children.1"]);
    expect(placement(past.doc.children![1])).toEqual({ start: "anchor@21", offset: -5 });
    expect(starts(past.doc)).toEqual(starts(d));
  });

  it("keeps the point on what the primary plays", () => {
    // a spans 0..5; o sits at 8..13 entirely after it → point at a's out.
    const d = doc([clip("a", { in: 10, out: 15 }), clip("o", { start: 8 })]);
    const r = at(d, 9, "children.0", ["children.1"]);
    expect(placement(r.doc.children![1])).toEqual({ start: "anchor@15", offset: 3 });
    expect(starts(r.doc)).toEqual(starts(d));
  });

  it("each secondary keeps its own place; run members become their own heads", () => {
    const d = doc([clip("a", { in: 10, out: 30 }), clip("b"), clip("c")]);
    const r = at(d, 3, "children.0", ["children.1", "children.2"]);
    expect(names(r.doc.children!)).toEqual(["a", "b", "c"]);
    expect(starts(r.doc)).toEqual([0, 20, 25]);
    expect(r.secondaryKeys).toEqual(["children.1", "children.2"]);
  });

  it("uses the bare id + offset for a primary with no source axis", () => {
    const d = doc([{ type: "rect", duration: 4, id: "t" } as Child, clip("b", { start: 1.5 })]);
    const r = at(d, 3, "children.0", ["children.1"]);
    expect(placement(r.doc.children![1])).toEqual({ start: "t", offset: 1.5 });
  });

  it("a secondary lifted from before the primary shifts the primary's key", () => {
    const d = doc([clip("b", { start: 2 }), clip("a", { start: 0 })]);
    const r = at(d, 3, "children.1", ["children.0"]);
    expect(r.primaryKey).toBe("children.0");
    expect(names(r.doc.children!)).toEqual(["a", "b"]);
    expect(starts(r.doc)).toEqual([0, 2]);
  });
});

describe("anchorEdit", () => {
  const ctx: AnchorEditCtx = {
    index: 1,
    pointTime: 2,
    anchorStart: 0,
    anchorEnd: 10,
    anchorBase: 100,
    anchorSpeed: 2,
  };
  it("drags percent and source points, clamped to the target", () => {
    expect(dragAnchorPoint("a", 2.5, ctx)).toBe("a@25%");
    expect(dragAnchorPoint("a@25%", -5, ctx)).toBe("a");
    expect(dragAnchorPoint("a@104", 1, ctx)).toBe("a@106");
    expect(dragAnchorPoint("a@104", 100, ctx)).toBe("a@120");
  });
  it("drags an absolute start along the time axis, not before 0", () => {
    expect(dragAnchorPoint(4, 1.5, ctx)).toBe(5.5);
    expect(dragAnchorPoint(4, -10, ctx)).toBe(0);
  });
  it("toggles units without moving the point", () => {
    expect(toggleAnchorPoint("a@104", ctx)).toBe("a@20%");
    expect(toggleAnchorPoint("a@20%", ctx)).toBe("a@104");
  });
});

describe("layout + drop targets", () => {
  const body = {
    children: [
      clip("a", { id: "a" }),
      clip("b"),
      clip("over", { start: "a@1", out: 2 }),
      clip("later", { start: 20 }),
      clip("over2", { start: 1, out: 2 }),
    ],
  };
  const resolved = resolveComposition({ type: "composition", ...body }, { uncropped: true }).children;
  const group = layoutTree(seam, resolved, body, new Set(), []);

  it("packs runs: overlapping later runs go below, non-overlapping share a row", () => {
    expect(group.runs.map((r) => [r.head, r.end, r.row])).toEqual([
      [0, 2, 0],
      [2, 3, 1],
      [3, 4, 0],
      [4, 5, 2],
    ]);
  });

  const px = 10;
  const regions = flattenDropRegions(group, px, { width: 1000, height: 400 });
  const row0 = RULER_HEIGHT + ROW_GAP;

  it("row drop: before a head takes its slot, between members extends the run", () => {
    expect(dropTargetAt(regions, 5, row0 + 5, px)).toMatchObject({ kind: "insert", index: 0, before: true });
    expect(dropTargetAt(regions, 40, row0 + 5, px)).toMatchObject({ kind: "insert", index: 1, before: false });
    expect(dropTargetAt(regions, 99, row0 + 5, px)).toMatchObject({ kind: "insert", index: 2, before: false });
    expect(dropTargetAt(regions, 201, row0 + 5, px)).toMatchObject({ kind: "insert", index: 3, before: true });
  });

  it("strip drop: a new run at the cursor time, after that row's runs", () => {
    expect(dropTargetAt(regions, 123, row0 + ROW_HEIGHT + 2, px)).toMatchObject({
      kind: "newRun",
      index: 4,
      time: 12.3,
    });
  });

  it("snapped new run: lands exactly on the nearest node edge, else stays free", () => {
    const strip = row0 + ROW_HEIGHT + 2;
    // b ends at 10s (x=100); `later` starts at 20s (x=200).
    expect(dropTargetAt(regions, 104, strip, px, { thresholdPx: 10 })).toMatchObject({
      kind: "newRun",
      time: 10,
      x: 100,
      snapped: true,
    });
    expect(dropTargetAt(regions, 150, strip, px, { thresholdPx: 10 })).toMatchObject({
      time: 15,
      snapped: false,
    });
    // The dragged node's own edges are ignored.
    expect(
      dropTargetAt(regions, 196, strip, px, { thresholdPx: 10, exclude: new Set(["children.3"]) }),
    ).toMatchObject({ time: 19.6, snapped: false });
  });

  it("snaps to the playhead, but a node edge in reach wins", () => {
    const strip = row0 + ROW_HEIGHT + 2;
    // Playhead at 15s (x=150), nothing else near.
    expect(dropTargetAt(regions, 146, strip, px, { thresholdPx: 10, playheadX: 150 })).toMatchObject({
      time: 15,
      x: 150,
      snapped: true,
    });
    // Playhead at 10.3s, b's end at 10s: the cursor is nearer the playhead, the edge still wins.
    expect(dropTargetAt(regions, 104, strip, px, { thresholdPx: 10, playheadX: 103 })).toMatchObject({
      time: 10,
      x: 100,
    });
  });

  it("ruler drop: a new run at the front", () => {
    expect(dropTargetAt(regions, 30, 4, px)).toMatchObject({ kind: "newRun", index: 0, time: 3 });
  });

  it("z-drag: lands before the first other run below the cursor", () => {
    expect(runZIndexAt(regions[0], 4, 0)).toBe(0);
    expect(runZIndexAt(regions[0], 0, 9999)).toBe(5);
  });
});

describe("timeAfterLift — a new-run drop follows what the cursor pointed at", () => {
  const abc = doc([clip("a"), clip("b"), clip("c")]);
  const A = [parsePath("children.0")];

  it("dragging A onto C's start lands where C ends up", () => {
    expect(timeAfterLift(seam, abc, A, [], 10)).toBe(5);
    const moved = moveNodesTracked(abc, A, [], 3, { start: timeAfterLift(seam, abc, A, [], 10) })!;
    expect(names(moved.doc.children!)).toEqual(["b", "c", "a"]);
    expect(starts(moved.doc)).toEqual([0, 5, 5]);
  });

  it("a free drop keeps its distance from the edge before it", () => {
    expect(timeAfterLift(seam, abc, A, [], 12)).toBe(7);
    // Before every surviving edge: nothing to follow.
    expect(timeAfterLift(seam, abc, A, [], 1)).toBe(1);
  });

  it("nothing moves when the lifted node rippled nothing", () => {
    const d = doc([clip("a"), clip("b"), clip("o", { start: 2 })]);
    expect(timeAfterLift(seam, d, [parsePath("children.2")], [], 5)).toBe(5);
    // Lifting the last member of a run leaves earlier edges alone.
    expect(timeAfterLift(seam, abc, [parsePath("children.2")], [], 5)).toBe(5);
  });

  it("follows a nested composition that shrinks when a node is dragged out of it", () => {
    const d = doc([
      { type: "composition", children: [clip("x"), clip("y")] } as Child,
      clip("b"),
    ]);
    // b starts at 10; pulling x out of the comp leaves it 5s long → b at 5.
    expect(timeAfterLift(seam, d, [parsePath("children.0.children.0")], [], 10)).toBe(5);
  });
});

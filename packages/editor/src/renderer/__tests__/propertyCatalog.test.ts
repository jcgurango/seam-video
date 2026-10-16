import { describe, expect, it } from "vitest";
import type { Child, SeamFile } from "@seam/core";
import {
  ROOT_PROPS,
  addKeyframe,
  applyPropertyEdit,
  catalogFor,
  joinLength,
  patchKeyframe,
  pointAxis,
  propState,
  removeKeyframe,
  selectedNodes,
  sharedProps,
  splitLength,
  summarizeSelection,
  toAnimated,
  toStatic,
  withPointAxis,
} from "../propertyCatalog.js";
import { parsePath } from "../nodePath.js";

const doc: SeamFile = {
  type: "composition",
  contentWidth: 1080,
  contentHeight: 1920,
  children: [
    { type: "clip", source: "a.mp4", in: 0, out: 5, opacity: 0.5, translation: "25%" },
    { type: "clip", source: "b.mp4", in: 1, out: 6, opacity: 0.5, translation: { x: "25%", y: 10 } },
    { type: "text", text: "hi", duration: 2, opacity: [[0, 0], [2, 1]] },
    { type: "rect", duration: 1, fill: "red", size: 100 },
  ],
};
const nodesAt = (...keys: string[]): Child[] => selectedNodes(doc, keys).map((s) => s.node);

describe("catalog + multi-selection", () => {
  it("every type has a catalog; shared props are the intersection in first-node order", () => {
    for (const t of ["clip", "audio", "static", "empty", "data", "text", "rect", "circle", "map", "composition"] as const) {
      expect(catalogFor(t).length).toBeGreaterThan(0);
    }
    const keys = sharedProps(nodesAt("children.0", "children.2")).map((d) => d.key);
    expect(keys).toContain("opacity");
    expect(keys).toContain("translation");
    expect(keys).not.toContain("source"); // text has none
    expect(keys).not.toContain("text"); // clip has none
    expect(keys.indexOf("in")).toBe(-1); // text has no in/out
    // Catalog order of the first node (clip): timing before layout.
    expect(keys.indexOf("id")).toBeLessThan(keys.indexOf("opacity"));
  });

  it("summarizes the selection by type", () => {
    expect(summarizeSelection(nodesAt("children.0", "children.1", "children.2"))).toEqual({
      count: 3,
      types: [
        { type: "clip", count: 2 },
        { type: "text", count: 1 },
      ],
    });
  });

  it("propState: same / mixed / all-omitted", () => {
    expect(propState(nodesAt("children.0", "children.1"), "opacity")).toEqual({ kind: "same", value: 0.5 });
    expect(propState(nodesAt("children.0", "children.1"), "source")).toEqual({ kind: "mixed" });
    expect(propState(nodesAt("children.0", "children.1"), "rotation")).toEqual({ kind: "same", value: undefined });
    expect(propState(nodesAt("children.0", "children.2"), "opacity")).toEqual({ kind: "mixed" });
    // Keyframe arrays compare structurally.
    expect(propState(nodesAt("children.2", "children.2"), "opacity")).toEqual({
      kind: "same",
      value: [[0, 0], [2, 1]],
    });
  });

  it("an empty selection targets the root composition", () => {
    const sel = selectedNodes(doc, []);
    expect(sel).toHaveLength(1);
    expect(sel[0].path).toEqual([]);
    expect(sel[0].node).toBe(doc);
    // Editing through path [] rewrites the root itself.
    const r = applyPropertyEdit(doc, [[]], "backgroundColor", () => "#112233");
    expect(r.errors).toBeNull();
    expect(r.doc.backgroundColor).toBe("#112233");
    expect(r.doc.children).toBe(doc.children);
    // The schema allows a percent root canvas but the spatial pass throws on
    // it, so the root catalog exposes the canvas dims as plain numbers only.
    expect(ROOT_PROPS.find((d) => d.key === "contentWidth")?.kind).toBe("number");
    expect(ROOT_PROPS.find((d) => d.key === "contentHeight")?.kind).toBe("number");
    expect(ROOT_PROPS.some((d) => d.key === "translation" || d.key === "duration")).toBe(false);
  });

  it("drops stale selection keys", () => {
    expect(selectedNodes(doc, ["children.0", "children.9", "attachments.0"]).map((s) => s.key)).toEqual([
      "children.0",
    ]);
  });
});

describe("length parts", () => {
  it("splits every authored form and round-trips", () => {
    expect(splitLength(undefined)).toEqual({ percent: null, px: null });
    expect(splitLength(25)).toEqual({ percent: null, px: 25 });
    expect(splitLength("50%")).toEqual({ percent: 50, px: null });
    expect(splitLength("50% + 10")).toEqual({ percent: 50, px: 10 });
    expect(splitLength("50% - 10")).toEqual({ percent: 50, px: -10 });
    for (const v of [25, -3.5, "50%", "50% + 10", "50% - 10", "0% + 4"] as const) {
      expect(joinLength(splitLength(v))).toBe(v);
    }
  });

  it("joins: both empty → unset; percent-only; px-only number; combined", () => {
    expect(joinLength({ percent: null, px: null })).toBeUndefined();
    expect(joinLength({ percent: 50, px: null })).toBe("50%");
    expect(joinLength({ percent: 50, px: 0 })).toBe("50%");
    expect(joinLength({ percent: null, px: 12 })).toBe(12);
    expect(joinLength({ percent: 0, px: 12 })).toBe("0% + 12");
    expect(joinLength({ percent: 33.33333, px: -2 })).toBe("33.3333% - 2");
  });

  it("point axes: scalar applies to both; editing one keeps the other; collapses when equal", () => {
    expect(pointAxis("25%", "y")).toBe("25%");
    expect(pointAxis({ x: "25%", y: 10 }, "y")).toBe(10);
    expect(pointAxis({ x: "25%" }, "y")).toBeUndefined();
    expect(withPointAxis("25%", "y", 10)).toEqual({ y: 10, x: "25%" });
    expect(withPointAxis({ x: "25%", y: 10 }, "y", "25%")).toBe("25%");
    expect(withPointAxis({ x: "25%", y: 10 }, "x", undefined)).toEqual({ y: 10 });
    expect(withPointAxis({ y: 10 }, "y", undefined)).toBeUndefined();
  });
});

describe("keyframes", () => {
  it("static ↔ animated conversions", () => {
    expect(toAnimated(0.5, 1)).toEqual([[0, 0.5]]);
    expect(toAnimated(undefined, 1)).toEqual([[0, 1]]); // omitted key animates from its default
    expect(toAnimated([[0, 0], [1, 1]], 1)).toEqual([[0, 0], [1, 1]]);
    expect(toStatic([[0, 0.25], [1, 1]])).toBe(0.25);
    expect(toStatic(0.7)).toBe(0.7);
  });

  it("patch / add / remove keep the [time, value, easing?] shape", () => {
    let kfs = toAnimated(0, 0);
    kfs = addKeyframe(kfs);
    expect(kfs).toEqual([[0, 0], [1, 0]]);
    kfs = patchKeyframe(kfs, 1, { value: 1, easing: "ease-in" });
    expect(kfs[1]).toEqual([1, 1, "ease-in"]);
    kfs = patchKeyframe(kfs, 1, { easing: null });
    expect(kfs[1]).toEqual([1, 1]);
    kfs = patchKeyframe(kfs, 1, { time: "50% + 1" });
    expect(kfs[1]).toEqual(["50% + 1", 1]);
    expect(addKeyframe(kfs)[2][0]).toBe("100%"); // after a percent time, next is 100%
    expect(removeKeyframe(kfs, 0)).toEqual([["50% + 1", 1]]);
  });
});

describe("applyPropertyEdit", () => {
  const paths = ["children.0", "children.1"].map(parsePath);

  it("writes to every selected node, deletes on undefined, validates", () => {
    const r = applyPropertyEdit(doc, paths, "rotation", () => 45);
    expect(r.errors).toBeNull();
    const kids = r.doc.children!;
    expect((kids[0] as { rotation?: number }).rotation).toBe(45);
    expect((kids[1] as { rotation?: number }).rotation).toBe(45);
    expect(kids[2]).toBe(doc.children![2]); // untouched nodes keep identity

    const cleared = applyPropertyEdit(r.doc, paths, "rotation", () => undefined);
    expect("rotation" in cleared.doc.children![0]).toBe(false);
  });

  it("per-node updater sees each node's own value", () => {
    const r = applyPropertyEdit(doc, paths, "in", (cur) => (cur as number) + 1);
    expect((r.doc.children![0] as { in: number }).in).toBe(1);
    expect((r.doc.children![1] as { in: number }).in).toBe(2);
  });

  it("rejects an invalid result and returns the original doc", () => {
    const r = applyPropertyEdit(doc, paths, "speed", () => -1);
    expect(r.errors).not.toBeNull();
    expect(r.doc).toBe(doc);
  });

  it("is a no-op (same doc identity) when nothing changes", () => {
    const r = applyPropertyEdit(doc, paths, "opacity", () => 0.5);
    expect(r.doc).toBe(doc);
  });
});

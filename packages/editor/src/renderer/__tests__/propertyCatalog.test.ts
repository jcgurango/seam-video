import { describe, expect, it } from "vitest";
import type { Child, SeamFile } from "@seam/core";
import {
  ROOT_PROPS,
  addKeyframe,
  applyPropertyEdit,
  catalogFor,
  extensionProps,
  joinLength,
  patchKeyframe,
  pointAxis,
  propState,
  removeKeyframe,
  rootProps,
  selectedNodes,
  sharedProps,
  splitLength,
  summarizeSelection,
  toAnimated,
  toStatic,
  withPointAxis,
} from "../propertyCatalog.js";
import { parsePath } from "../nodePath.js";
import { createSeam } from "@seam/core";
import { adjustments } from "@seam/extension-adjustments";
import { map } from "@seam/extension-map";
import { captions } from "@seam/extension-captions";
import { text } from "@seam/extension-text";

// Core plus the Map extension (a contributed node type with its own catalog).
const seam = createSeam([map, text]);

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
    for (const t of ["clip", "audio", "static", "data", "text", "rect", "circle", "map", "composition"] as const) {
      expect(catalogFor(seam, t).length).toBeGreaterThan(0);
    }
    const keys = sharedProps(seam, nodesAt("children.0", "children.2")).map((d) => d.key);
    expect(keys).toContain("opacity");
    expect(keys).toContain("translation");
    expect(keys).not.toContain("source"); // text has none
    expect(keys).not.toContain("text"); // clip has none
    expect(keys.indexOf("in")).toBe(-1); // text has no in/out
    // Catalog order of the first node (clip): timing before layout.
    expect(keys.indexOf("id")).toBeLessThan(keys.indexOf("opacity"));
  });

  it("every child type exposes start + offset (no transition); the root does not", () => {
    for (const t of ["clip", "audio", "static", "data", "text", "rect", "circle", "map", "composition"] as const) {
      const defs = catalogFor(seam, t);
      expect(defs.find((d) => d.key === "start")).toMatchObject({ group: "Timing", kind: "scalar" });
      const offset = defs.find((d) => d.key === "offset");
      expect(offset).toMatchObject({ group: "Timing", kind: "number", placeholder: "0" });
      expect(offset?.animatable).toBeFalsy();
      expect(defs.some((d) => d.key === "transition")).toBe(false);
    }
    expect(ROOT_PROPS.some((d) => d.key === "start" || d.key === "offset")).toBe(false);
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
    const r = applyPropertyEdit(seam, doc, [[]], "backgroundColor", () => "#112233");
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
    expect(selectedNodes(doc, ["children.0", "children.9", "children.2.children.0"]).map((s) => s.key)).toEqual([
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
  it("start: a number or a valid anchor is written; a malformed anchor is rejected", () => {
    const withId = applyPropertyEdit(seam, doc, [parsePath("children.0")], "id", () => "a").doc;
    const paths = [parsePath("children.2")];
    expect(applyPropertyEdit(seam, withId, paths, "start", () => 1.5).doc.children?.[2]).toMatchObject({ start: 1.5 });
    expect(applyPropertyEdit(seam, withId, paths, "start", () => "a@50%").doc.children?.[2]).toMatchObject({
      start: "a@50%",
    });
    const bad = applyPropertyEdit(seam, withId, paths, "start", () => "a@x");
    expect(bad.errors?.length).toBeGreaterThan(0);
    expect(bad.doc).toBe(withId);
  });

  const paths = ["children.0", "children.1"].map(parsePath);

  it("writes to every selected node, deletes on undefined, validates", () => {
    const r = applyPropertyEdit(seam, doc, paths, "rotation", () => 45);
    expect(r.errors).toBeNull();
    const kids = r.doc.children!;
    expect((kids[0] as { rotation?: number }).rotation).toBe(45);
    expect((kids[1] as { rotation?: number }).rotation).toBe(45);
    expect(kids[2]).toBe(doc.children![2]); // untouched nodes keep identity

    const cleared = applyPropertyEdit(seam, r.doc, paths, "rotation", () => undefined);
    expect("rotation" in cleared.doc.children![0]).toBe(false);
  });

  it("per-node updater sees each node's own value", () => {
    const r = applyPropertyEdit(seam, doc, paths, "in", (cur) => (cur as number) + 1);
    expect((r.doc.children![0] as { in: number }).in).toBe(1);
    expect((r.doc.children![1] as { in: number }).in).toBe(2);
  });

  it("rejects an invalid result and returns the original doc", () => {
    const r = applyPropertyEdit(seam, doc, paths, "speed", () => -1);
    expect(r.errors).not.toBeNull();
    expect(r.doc).toBe(doc);
  });

  it("is a no-op (same doc identity) when nothing changes", () => {
    const r = applyPropertyEdit(seam, doc, paths, "opacity", () => 0.5);
    expect(r.doc).toBe(doc);
  });
});

describe("extension-contributed fields", () => {
  const withAdj = createSeam([adjustments, map, text]);
  const KEYS = ["brightness", "contrast", "saturation", "gamma", "temperature", "tint"];

  it("appear on every visual node type, after core's rows, and not on audio/data", () => {
    for (const t of ["clip", "static", "text", "rect", "circle", "map", "composition"] as const) {
      const keys = catalogFor(withAdj, t).map((d) => d.key);
      expect(keys.slice(-KEYS.length), t).toEqual(KEYS);
    }
    for (const t of ["audio", "data"] as const) {
      expect(catalogFor(withAdj, t).some((d) => KEYS.includes(d.key)), t).toBe(false);
    }
  });

  it("are absent on an instance without the extension", () => {
    expect(catalogFor(seam, "clip").some((d) => KEYS.includes(d.key))).toBe(false);
    expect(rootProps(seam)).toBe(ROOT_PROPS);
  });

  it("derive the row from the field spec: group, default, slider span, unit", () => {
    const by = new Map(extensionProps(withAdj).map((d) => [d.key, d]));
    const sat = by.get("saturation")!;
    expect(sat).toMatchObject({
      label: "Saturation",
      group: "Adjustments",
      kind: "number",
      animatable: true,
      placeholder: "1",
      default: 1,
      range: { min: 0, max: 2, step: 0.01 },
    });
    // The slider spans the soft range, not the (much wider) valid range.
    expect(by.get("contrast")!.range).toEqual({ min: 0, max: 2, step: 0.01 });
    expect(by.get("temperature")).toMatchObject({
      unit: "K",
      default: 6500,
      range: { min: 2000, max: 12000, step: 50 },
    });
  });

  it("are shared across a mixed visual selection and offered on the root", () => {
    const nodes = [
      { type: "clip", source: "a.mp4", in: 0, out: 1 },
      { type: "rect", duration: 1 },
    ] as Child[];
    const keys = sharedProps(withAdj, nodes).map((d) => d.key);
    for (const k of KEYS) expect(keys).toContain(k);
    expect(rootProps(withAdj).map((d) => d.key).slice(-KEYS.length)).toEqual(KEYS);
  });

  it("applyPropertyEdit writes, validates the range and unsets", () => {
    const d: SeamFile = {
      type: "composition",
      children: [{ type: "rect", duration: 1 }],
    };
    const path = [parsePath("children.0")];
    const set = applyPropertyEdit(withAdj, d, path, "saturation", () => 0);
    expect(set.errors).toBeFalsy();
    expect((set.doc.children![0] as unknown as Record<string, unknown>).saturation).toBe(0);

    const bad = applyPropertyEdit(withAdj, d, path, "saturation", () => 9);
    expect(bad.errors?.length).toBeGreaterThan(0);
    expect(bad.doc).toBe(d);

    const unset = applyPropertyEdit(withAdj, set.doc, path, "saturation", () => undefined);
    expect("saturation" in (unset.doc.children![0] as object)).toBe(false);

    // The same edit on an instance without the extension is rejected.
    expect(applyPropertyEdit(seam, d, path, "saturation", () => 0).errors?.length).toBeGreaterThan(0);
  });
});

describe("extension node types", () => {
  it("get a catalog from their definition: source, duration, placement, own fields, spatial, inner canvas", () => {
    const keys = catalogFor(seam, "map").map((d) => d.key);
    expect(keys.slice(0, 5)).toEqual(["source", "duration", "start", "offset", "id"]);
    expect(keys.slice(5, 10)).toEqual(["latitude", "longitude", "zoom", "mapOpacity", "theme"]);
    for (const k of ["translation", "size", "rotation", "opacity", "contentWidth", "contentHeight"]) {
      expect(keys).toContain(k);
    }
    // Structured fields have no row (JSON panel).
    expect(keys).not.toContain("paths");
    expect(keys).not.toContain("pin");
  });

  it("derive each row from its field declaration", () => {
    const by = new Map(catalogFor(seam, "map").map((d) => [d.key, d]));
    expect(by.get("source")).toMatchObject({ kind: "string", group: "Media", label: "Source" });
    expect(by.get("theme")).toMatchObject({ kind: "enum", options: ["light", "dark"], placeholder: "light", group: "Map" });
    expect(by.get("latitude")).toMatchObject({ kind: "number", animatable: true, placeholder: "0", group: "Map" });
    // No slider without an asked-for control span.
    expect(by.get("latitude")!.range).toBeUndefined();
    // Zoom brings its own (scale-space) interpolation.
    const zoom = by.get("zoom")!;
    expect(zoom.sample!([[0, 10], [1, 12]], 0.5, 1)).toBeCloseTo(10 - Math.log2(0.625), 9);
  });

  it("are unknown on an instance without the extension", () => {
    expect(catalogFor(createSeam(), "map" as never)).toEqual([]);
  });
});

describe("non-visual node types and composition-only fields", () => {
  const withCaptions = createSeam([adjustments, map, text, captions]);

  it("a non-visual type's catalog has timing and its own fields only", () => {
    const keys = catalogFor(withCaptions, "caption").map((d) => d.key);
    expect(keys).toEqual(["duration", "start", "offset", "id", "text", "speaker"]);
    // Its length defaults to its words' extent.
    expect(catalogFor(withCaptions, "caption")[0]).toMatchObject({ key: "duration", placeholder: "children" });
    expect(catalogFor(withCaptions, "word").map((d) => d.key)).toEqual(["duration", "start", "offset", "id", "text"]);
  });

  it("composition-only fields appear on compositions and the root, not on other nodes", () => {
    const comp = catalogFor(withCaptions, "composition").map((d) => d.key);
    expect(comp).toContain("captions");
    expect(comp).toContain("saturation");
    expect(rootProps(withCaptions).map((d) => d.key)).toContain("captions");
    expect(catalogFor(withCaptions, "clip").map((d) => d.key)).not.toContain("captions");
    expect(catalogFor(withCaptions, "map").map((d) => d.key)).not.toContain("captions");
    const row = catalogFor(withCaptions, "composition").find((d) => d.key === "captions")!;
    expect(row).toMatchObject({ kind: "enum", options: ["pass", "off", "show"], placeholder: "pass", group: "Captions" });
    // The structured style has no row.
    expect(comp).not.toContain("captionStyle");
  });

  it("writes and validates the routing field through applyPropertyEdit", () => {
    const d: SeamFile = { type: "composition", children: [{ type: "composition", children: [] }] };
    const set = applyPropertyEdit(withCaptions, d, [parsePath("children.0")], "captions", () => "off");
    expect(set.errors).toBeFalsy();
    expect((set.doc.children![0] as { captions?: string }).captions).toBe("off");
    // The root (no selection) takes it too.
    const root = applyPropertyEdit(withCaptions, d, [[]], "captions", () => "show");
    expect((root.doc as { captions?: string }).captions).toBe("show");
    expect(applyPropertyEdit(withCaptions, d, [[]], "captions", () => "loud").errors?.length).toBeGreaterThan(0);
  });
});

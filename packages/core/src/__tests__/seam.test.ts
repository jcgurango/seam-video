import { describe, it, expect } from "vitest";
import { createSeam } from "../seam.js";
import type { ColorStage, SeamExtension } from "../registry.js";
import type { Composition } from "../types.js";
import { resolveSpatial } from "../layout/resolve-spatial.js";
import { flattenResolved } from "../flatten.js";
import { asExtensionNode, type ResolvedExtensionNode } from "../resolved-types.js";
import { stage as stageExt } from "./stageExtension.js";

describe("createSeam", () => {
  it("creates an instance with no extensions by default", () => {
    const seam = createSeam();
    expect(seam.extensions).toEqual([]);
    const r = seam.validate({ type: "composition", children: [] });
    expect(r.success).toBe(true);
  });

  it("keeps the extensions in registration order", () => {
    const seam = createSeam([{ name: "a" }, { name: "b" }]);
    expect(seam.extensions.map((e) => e.name)).toEqual(["a", "b"]);
  });

  it("rejects a duplicate extension name", () => {
    expect(() => createSeam([{ name: "a" }, { name: "a" }])).toThrow(/registered twice/);
  });

  it("rejects an extension without a name", () => {
    expect(() => createSeam([{ name: "" }])).toThrow(/non-empty 'name'/);
  });

  it("validates, compiles and resolves through one instance", () => {
    const seam = createSeam();
    const parsed = seam.parseSeamFile(
      JSON.stringify({
        type: "composition",
        children: [{ type: "rect", duration: 2 }],
      }),
    );
    if (!parsed.success) throw new Error(parsed.errors.join(", "));
    const { doc, errors } = seam.compileSeamFile(parsed.data);
    expect(errors).toEqual([]);
    expect(seam.resolveComposition(doc).duration).toBe(2);
  });
});

// A stand-in extension: two fields on visual nodes and a one-slot stage.
const stage: ColorStage = {
  slots: 1,
  wgsl: "fn t_stage(rgb: vec3f, p: vec4f) -> vec3f { return rgb * p.x; }",
  entry: "t_stage",
  prepare(values, out) {
    out[0] = values.gain ?? 1;
  },
};
const gainExt: SeamExtension = {
  name: "gain",
  fields: [
    { key: "gain", nodes: "visual", type: "number", min: 0, max: 2, default: 1, animatable: true },
    { key: "bias", nodes: "visual", type: "number", default: 0 },
  ],
  colorStage: stage,
};

describe("extension fields", () => {
  const seam = createSeam([gainExt, stageExt]);
  const doc = (child: Record<string, unknown>) => ({ type: "composition", children: [child] });

  it("exposes the registered fields and stages", () => {
    expect(seam.fields.map((f) => [f.key, f.extension])).toEqual([
      ["gain", "gain"],
      ["bias", "gain"],
      ["mood", "stage"],
    ]);
    expect(seam.colorSlots).toBe(1);
    expect(seam.colorStages.map((s) => [s.entry, s.offset])).toEqual([["t_stage", 0]]);
    expect([...seam.nodeTypes.keys()]).toEqual(["cue", "tick", "stage"]);
  });

  it("accepts a contributed field on every visual node type", () => {
    const nodes: Record<string, unknown>[] = [
      { type: "clip", source: "a.mp4", in: 0, out: 1 },
      { type: "static", source: "a.png", duration: 1 },
      { type: "text", text: "hi", duration: 1 },
      { type: "rect", duration: 1 },
      { type: "circle", duration: 1 },
      { type: "stage", source: "a.bin", duration: 1 },
      { type: "composition", children: [{ type: "rect", duration: 1 }] },
    ];
    for (const node of nodes) {
      const r = seam.validate(doc({ ...node, gain: 0.5 }));
      expect(r.success, String(node.type)).toBe(true);
    }
  });

  it("rejects it on non-visual nodes", () => {
    expect(seam.validate(doc({ type: "audio", source: "a.wav", in: 0, out: 1, gain: 1 })).success).toBe(false);
    expect(seam.validate(doc({ type: "data", data: 1, gain: 1 })).success).toBe(false);
  });

  it("enforces the range, and keyframes only where animatable", () => {
    expect(seam.validate(doc({ type: "rect", duration: 1, gain: 3 })).success).toBe(false);
    expect(seam.validate(doc({ type: "rect", duration: 1, gain: [[0, 0], [1, 2]] })).success).toBe(true);
    expect(seam.validate(doc({ type: "rect", duration: 1, gain: [[0, 0], [1, 3]] })).success).toBe(false);
    expect(seam.validate(doc({ type: "rect", duration: 1, bias: [[0, 0], [1, 1]] })).success).toBe(false);
    expect(seam.validate(doc({ type: "rect", duration: 1, bias: 0.25 })).success).toBe(true);
  });

  it("is a validation error on an instance without the extension", () => {
    const r = createSeam().validate(doc({ type: "rect", duration: 1, gain: 0.5 }));
    expect(r.success).toBe(false);
    if (!r.success) expect(r.errors.join(" ")).toMatch(/gain/);
  });

  it("rides through resolution as `ext`, authored values verbatim", () => {
    const kf = [[0, 0], [1, 2]];
    const t = seam.resolveComposition({
      type: "composition",
      children: [
        { type: "rect", duration: 1, gain: kf, bias: 0.25 },
        { type: "rect", duration: 1 },
        { type: "composition", gain: 0.5, children: [{ type: "rect", duration: 1 }] },
      ],
    } as unknown as Composition);
    expect((t.children[0] as { ext?: unknown }).ext).toEqual({ gain: kf, bias: 0.25 });
    expect((t.children[1] as { ext?: unknown }).ext).toBeUndefined();
    expect((t.children[2] as { ext?: unknown }).ext).toEqual({ gain: 0.5 });
  });

  it("rejects two extensions contributing the same field", () => {
    expect(() =>
      createSeam([gainExt, { name: "other", fields: [{ key: "gain", nodes: "visual", type: "number", default: 0 }] }]),
    ).toThrow(/already contributed by "gain"/);
  });

  it("rejects a field that collides with a core key", () => {
    expect(() =>
      createSeam([{ name: "bad", fields: [{ key: "opacity", nodes: "visual", type: "number", default: 1 }] }]),
    ).toThrow(/collides with a core field/);
  });

  it("rejects two stages sharing a WGSL entry name", () => {
    expect(() => createSeam([gainExt, { name: "other", colorStage: stage }])).toThrow(/already used by "gain"/);
  });

  it("gives each stage its own run of uniform slots", () => {
    const two = createSeam([
      gainExt,
      { name: "other", colorStage: { ...stage, entry: "o_stage", slots: 3 } },
    ]);
    expect(two.colorStages.map((s) => s.offset)).toEqual([0, 1]);
    expect(two.colorSlots).toBe(4);
  });
});

describe("extension node types", () => {
  const seam = createSeam([stageExt]);
  const doc = (child: Record<string, unknown>) => ({ type: "composition", children: [child] });
  const node = { type: "stage", source: "a.bin", duration: 4 };

  it("validates the node's own fields from their declarations", () => {
    expect(seam.validate(doc(node)).success).toBe(true);
    expect(seam.validate(doc({ ...node, level: [[0, 0], [4, 10]], mode: "b", tint: "red", gap: "50% + 4" })).success).toBe(true);
    // required, range, enum, strictness
    expect(seam.validate(doc({ type: "stage", duration: 4 })).success).toBe(false);
    expect(seam.validate(doc({ ...node, level: 11 })).success).toBe(false);
    expect(seam.validate(doc({ ...node, mode: "c" })).success).toBe(false);
    expect(seam.validate(doc({ ...node, mode: [[0, "a"]] })).success).toBe(false);
    expect(seam.validate(doc({ ...node, nope: 1 })).success).toBe(false);
    // structured field via the schema escape hatch
    expect(seam.validate(doc({ ...node, points: [[0, 0], [1, 1]] })).success).toBe(true);
    expect(seam.validate(doc({ ...node, points: [[0, 0]] })).success).toBe(false);
  });

  it("gets duration, the inner canvas, spatial / placement fields and children from core", () => {
    const full = {
      ...node,
      id: "s",
      start: 1,
      offset: 0.5,
      opacity: 0.5,
      rotation: 10,
      cornerRadius: "50%",
      contentWidth: 400,
      contentHeight: "50%",
      metadata: { a: 1 },
      children: [{ type: "rect", duration: 1 }],
    };
    const r = seam.validate(doc(full));
    expect(r.success, r.success ? "" : r.errors.join("\n")).toBe(true);
    expect(seam.validate(doc({ type: "stage", source: "a.bin" })).success).toBe(false);
  });

  it("is unknown without the extension", () => {
    const r = createSeam().validate(doc(node));
    expect(r.success).toBe(false);
  });

  it("resolves as a leaf for timing, with its fields verbatim and children in node-local time", () => {
    const level = [[0, 0], [4, 10]];
    const t = resolveSpatial(
      seam.resolveComposition({
        type: "composition",
        contentWidth: 1000,
        contentHeight: 500,
        children: [
          { type: "rect", duration: 2 },
          {
            ...node,
            level,
            contentWidth: 400,
            children: [
              { type: "rect", duration: 1, size: 10 },
              { type: "rect", duration: 9 },
            ],
          },
        ],
      } as unknown as Composition),
      1000,
      500,
    );
    const s = t.children[1] as unknown as ResolvedExtensionNode & { source: string; level: unknown };
    expect(asExtensionNode(t.children[0])).toBeNull();
    expect(asExtensionNode(t.children[1])).toBe(s);
    expect(s).toMatchObject({ type: "stage", extension: true, source: "a.bin", timelineStart: 2, timelineEnd: 6 });
    expect(s.level).toBe(level);
    // Children: node-local time, never extending the node.
    expect(s.children!.map((c) => [c.timelineStart, c.timelineEnd])).toEqual([[0, 1], [1, 10]]);
    expect(t.duration).toBe(6);
    // Inner canvas: authored width, default (100% of parent) height; children
    // lay out against it.
    expect(s.intrinsicWidth).toBe(400);
    expect(s.intrinsicHeight).toBe(500);
    expect((s.children![0] as { spatial?: unknown }).spatial).toEqual({ x: 195, y: 245, width: 10, height: 10 });
  });

  it("flattens to the node itself plus its children offset by its start", () => {
    const t = seam.resolveComposition({
      type: "composition",
      children: [
        { type: "rect", duration: 2 },
        { ...node, children: [{ type: "clip", source: "v.mp4", in: 0, out: 1, start: 1 }] },
      ],
    } as unknown as Composition);
    const flat = flattenResolved(t.children);
    expect(flat.map((l) => [l.type, l.timelineStart, l.timelineEnd])).toEqual([
      ["rect", 0, 2],
      ["stage", 2, 6],
      ["clip", 3, 4],
    ]);
  });

  it("rejects a core type name, a duplicate type and a field core already gives every node", () => {
    expect(() => createSeam([{ name: "x", nodes: [{ type: "clip" }] }])).toThrow(/is a core type/);
    expect(() => createSeam([stageExt, { name: "y", nodes: [{ type: "stage" }] }])).toThrow(/already contributed by "stage"/);
    expect(() =>
      createSeam([{ name: "z", nodes: [{ type: "thing", fields: [{ key: "opacity", type: "number" }] }] }]),
    ).toThrow(/collides with a field every node already has/);
    expect(() =>
      createSeam([{ name: "w", nodes: [{ type: "thing", createAnchors: () => null }] }]),
    ).toThrow(/createAnchors but no children/);
  });

  it("a visual field flagged `anchor` marks the node for per-frame layout", () => {
    const withPin = createSeam([
      stageExt,
      {
        name: "pinny",
        fields: [
          { key: "spot", nodes: "visual", type: "custom", anchor: true, schema: (z) => z.number() },
        ],
      },
    ]);
    const t = resolveSpatial(
      withPin.resolveComposition({
        type: "composition",
        children: [
          { ...node, children: [{ type: "rect", duration: 1, size: 10, spot: 3 }, { type: "rect", duration: 1, size: 10 }] },
        ],
      } as unknown as Composition),
      100,
      100,
    );
    const kids = (t.children[0] as unknown as ResolvedExtensionNode).children!;
    expect(kids[0]).toMatchObject({ anchored: true, ext: { spot: 3 } });
    // The authored spatial input survives on the anchored node (and is baked
    // away on the plain one), so the anchor can replace `translation` per frame.
    expect((kids[0] as { spatialInput?: unknown }).spatialInput).toBeDefined();
    expect((kids[1] as { spatialInput?: unknown }).spatialInput).toBeUndefined();
    expect((kids[1] as { anchored?: unknown }).anchored).toBeUndefined();
  });
});

describe("non-visual node types, span from children, composition-only fields", () => {
  const seam = createSeam([stageExt]);
  const doc = (child: Record<string, unknown>, root: Record<string, unknown> = {}) => ({
    type: "composition",
    ...root,
    children: [child],
  });
  const tick = (label: string, duration: number, extra: object = {}) => ({ type: "tick", label, duration, ...extra });

  it("a non-visual node takes placement and its own fields, but no spatial or visual-extension fields", () => {
    expect(seam.validate(doc(tick("a", 1, { id: "t", start: 2, offset: 0.5, metadata: {} }))).success).toBe(true);
    for (const bad of [{ opacity: 0.5 }, { size: 10 }, { contentWidth: 100 }, { rotation: 1 }]) {
      expect(seam.validate(doc(tick("a", 1, bad))).success, JSON.stringify(bad)).toBe(false);
    }
    // …including fields other extensions add to every VISUAL node.
    const withGain = createSeam([gainExt, stageExt]);
    expect(withGain.validate(doc({ type: "rect", duration: 1, gain: 1 })).success).toBe(true);
    expect(withGain.validate(doc(tick("a", 1, { gain: 1 }))).success).toBe(false);
  });

  it("a container may restrict the types of its children", () => {
    expect(seam.validate(doc({ type: "cue", children: [tick("a", 1), tick("b", 2)] })).success).toBe(true);
    expect(seam.validate(doc({ type: "cue", children: [{ type: "rect", duration: 1 }] })).success).toBe(false);
    expect(() =>
      createSeam([{ name: "x", nodes: [{ type: "box", children: ["nope"] }] }]),
    ).toThrow(/unknown type "nope"/);
  });

  it("span from children: duration is optional, defaults to the children's extent, and wins when authored", () => {
    expect(seam.validate(doc({ type: "cue" })).success).toBe(false);
    expect(seam.validate(doc({ type: "cue", duration: 3 })).success).toBe(true);
    const t = seam.resolveComposition({
      type: "composition",
      children: [
        { type: "rect", duration: 1 },
        { type: "cue", who: "jc", children: [tick("a", 1), tick("b", 2, { offset: 0.5 })] },
        { type: "cue", duration: 2, children: [tick("c", 5)] },
        { type: "rect", duration: 1 },
      ],
    } as unknown as Composition);
    const [, first, second, after] = t.children as unknown as ResolvedExtensionNode[];
    expect(first).toMatchObject({ type: "cue", extension: true, nonVisual: true, who: "jc", timelineStart: 1, timelineEnd: 4.5 });
    expect(first.children!.map((c) => [c.timelineStart, c.timelineEnd])).toEqual([[0, 1], [1.5, 3.5]]);
    // Authored duration is authoritative; children keep their own times.
    expect(second).toMatchObject({ timelineStart: 4.5, timelineEnd: 6.5 });
    expect(second.children![0]).toMatchObject({ timelineStart: 0, timelineEnd: 5 });
    expect(after).toMatchObject({ timelineStart: 6.5 });
    expect(() => createSeam([{ name: "x", nodes: [{ type: "box", span: "children" }] }])).toThrow(/has none/);
  });

  it("resolves with no spatial data, and the spatial pass leaves it alone", () => {
    const t = resolveSpatial(
      seam.resolveComposition(doc({ type: "cue", children: [tick("a", 1)] }) as unknown as Composition),
      100,
      100,
    );
    const cue = t.children[0] as unknown as ResolvedExtensionNode;
    for (const key of ["spatial", "spatialInput", "intrinsicWidth", "naturalWidth", "objectFit", "ext"]) {
      expect(key in cue, key).toBe(false);
      expect(key in cue.children![0], key).toBe(false);
    }
  });

  it("a non-visual type cannot draw, rasterize or anchor children", () => {
    expect(() => createSeam([{ name: "x", nodes: [{ type: "box", visual: false, draws: true }] }])).toThrow(/not visual/);
  });

  it("a composition-only field validates on compositions and the root, nowhere else", () => {
    expect(seam.validate(doc({ type: "composition", mood: "calm", children: [] }, { mood: "loud" })).success).toBe(true);
    expect(seam.validate(doc({ type: "rect", duration: 1, mood: "calm" })).success).toBe(false);
    expect(seam.validate(doc({ type: "stage", source: "a.bin", duration: 1, mood: "calm" })).success).toBe(false);
    expect(seam.validate(doc({ type: "composition", mood: "angry", children: [] })).success).toBe(false);
  });

  it("composition-only fields ride in `ext` on the resolved composition and on the root", () => {
    const t = seam.resolveComposition(
      doc({ type: "composition", mood: "calm", children: [{ type: "rect", duration: 1 }] }, { mood: "loud" }) as unknown as Composition,
    );
    expect(t.ext).toEqual({ mood: "loud" });
    expect((t.children[0] as { ext?: unknown }).ext).toEqual({ mood: "calm" });
  });

  it("a composition-only field may not collide with a composition key or a visual field", () => {
    expect(() =>
      createSeam([{ name: "x", fields: [{ key: "volume", nodes: "composition", type: "number" }] }]),
    ).toThrow(/collides with a field of "composition"/);
  });
});

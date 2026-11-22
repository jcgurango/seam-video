import { describe, it, expect } from "vitest";
import { createSeam } from "../seam.js";
import type { ColorStage, SeamExtension } from "../registry.js";
import type { Composition } from "../types.js";

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
  const seam = createSeam([gainExt]);
  const doc = (child: Record<string, unknown>) => ({ type: "composition", children: [child] });

  it("exposes the registered fields and stages", () => {
    expect(seam.fields.map((f) => [f.key, f.extension])).toEqual([
      ["gain", "gain"],
      ["bias", "gain"],
    ]);
    expect(seam.colorSlots).toBe(1);
    expect(seam.colorStages.map((s) => [s.entry, s.offset])).toEqual([["t_stage", 0]]);
  });

  it("accepts a contributed field on every visual node type", () => {
    const nodes: Record<string, unknown>[] = [
      { type: "clip", source: "a.mp4", in: 0, out: 1 },
      { type: "static", source: "a.png", duration: 1 },
      { type: "text", text: "hi", duration: 1 },
      { type: "rect", duration: 1 },
      { type: "circle", duration: 1 },
      { type: "map", source: "a.pmtiles", duration: 1 },
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

import { describe, it, expect } from "vitest";
import { createSeam } from "@seam/core";
import { adjustments, temperatureScale, tintScale } from "../index.js";

const seam = createSeam([adjustments]);

function prepare(values: Record<string, number>): number[] {
  const out = new Float32Array(8);
  seam.colorStages[0].prepare(values, out);
  return Array.from(out);
}

describe("adjustments extension", () => {
  it("registers six fields on visual nodes and one two-slot colour stage", () => {
    expect(seam.fields.map((f) => f.key)).toEqual([
      "brightness", "contrast", "saturation", "gamma", "temperature", "tint",
    ]);
    expect(seam.fields.every((f) => f.nodes === "visual" && f.animatable)).toBe(true);
    expect(seam.colorSlots).toBe(2);
    expect(seam.colorStages[0].entry).toBe("adj_stage");
  });

  it("no authored field = identity uniforms", () => {
    expect(prepare({})).toEqual([0, 1, 1, 1, 1, 1, 1, 0]);
  });

  it("6500 K and tint 0 are exactly neutral", () => {
    expect(temperatureScale(6500)).toEqual([1, 1, 1]);
    expect(tintScale(0)).toEqual([1, 1, 1]);
    expect(prepare({ temperature: 6500, tint: 0 }).slice(4, 7)).toEqual([1, 1, 1]);
  });

  it("warm pulls blue down, cool pulls red down", () => {
    const warm = temperatureScale(3000);
    expect(warm[0]).toBe(1);
    expect(warm[2]).toBeLessThan(warm[1]);
    const cool = temperatureScale(10000);
    expect(cool[0]).toBeLessThan(1);
    expect(cool[2]).toBeGreaterThan(cool[1]);
  });

  it("tint: + attenuates green, − attenuates red and blue", () => {
    expect(tintScale(1)).toEqual([1, 0.5, 1]);
    expect(tintScale(-1)).toEqual([0.5, 1, 0.5]);
    expect(tintScale(0.5)).toEqual([1, 0.75, 1]);
  });

  it("temperature and tint multiply into one scale", () => {
    const [r, g, b] = temperatureScale(3000);
    const got = prepare({ temperature: 3000, tint: 0.5 }).slice(4, 7);
    expect(got[0]).toBeCloseTo(r, 6);
    expect(got[1]).toBeCloseTo(g * 0.75, 6);
    expect(got[2]).toBeCloseTo(b, 6);
  });

  it("validates the fields on visual nodes, plain or keyframed", () => {
    const ok = seam.validate({
      type: "composition",
      saturation: 0,
      children: [
        { type: "clip", source: "a.mp4", in: 0, out: 1, brightness: 0.2, tint: -0.3 },
        { type: "rect", duration: 1, temperature: [[0, 3000], ["100%", 9000]] },
      ],
    });
    expect(ok.success).toBe(true);
  });

  it("rejects out-of-range values and the fields on non-visual nodes", () => {
    const range = seam.validate({
      type: "composition",
      children: [{ type: "rect", duration: 1, brightness: 5 }],
    });
    expect(range.success).toBe(false);
    const audio = seam.validate({
      type: "composition",
      children: [{ type: "audio", source: "a.wav", in: 0, out: 1, brightness: 0.1 }],
    });
    expect(audio.success).toBe(false);
  });

  it("without the extension the same document does not validate", () => {
    const bare = createSeam();
    const r = bare.validate({
      type: "composition",
      children: [{ type: "rect", duration: 1, saturation: 0 }],
    });
    expect(r.success).toBe(false);
    if (!r.success) expect(r.errors.join(" ")).toMatch(/saturation/);
  });
});

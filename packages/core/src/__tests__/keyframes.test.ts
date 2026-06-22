import { describe, it, expect } from "vitest";
import {
  isKeyframed,
  sampleNumber,
  sampleColor,
  samplePadding,
  sampleLength,
  sampleVolume,
  resolveVolume,
  dbToGain,
} from "../animation/keyframes.js";

describe("isKeyframed", () => {
  it("rejects scalars", () => {
    expect(isKeyframed(5)).toBe(false);
    expect(isKeyframed("red")).toBe(false);
    expect(isKeyframed(undefined as never)).toBe(false);
  });

  it("rejects static padding tuples", () => {
    expect(isKeyframed([10, 5])).toBe(false);
    expect(isKeyframed([10, 5, 10, 5])).toBe(false);
  });

  it("accepts keyframe arrays", () => {
    expect(isKeyframed([[0, 5]])).toBe(true);
    expect(isKeyframed([[0, 5], ["50%", 10]])).toBe(true);
    expect(isKeyframed([[0, [10, 5]]])).toBe(true);
  });
});

describe("sampleNumber", () => {
  it("returns static value unchanged", () => {
    expect(sampleNumber(0.5, 0, 10)).toBe(0.5);
    expect(sampleNumber(0.5, 5, 10)).toBe(0.5);
  });

  it("clamps before first keyframe", () => {
    expect(sampleNumber([[1, 10], [2, 20]], 0, 10)).toBe(10);
  });

  it("clamps after last keyframe", () => {
    expect(sampleNumber([[1, 10], [2, 20]], 5, 10)).toBe(20);
  });

  it("interpolates linearly between keyframes by default", () => {
    expect(sampleNumber([[0, 0], [10, 10]], 5, 10)).toBe(5);
    expect(sampleNumber([[0, 0], [10, 10]], 2.5, 10)).toBe(2.5);
  });

  it("resolves percentage time expressions against duration", () => {
    expect(sampleNumber([["0%", 0], ["100%", 100]], 5, 10)).toBe(50);
  });

  it("resolves percentage + offset", () => {
    expect(sampleNumber([["0%", 0], ["50% + 1", 100]], 6, 10)).toBe(100);
  });

  it("applies easing on the segment leading into a keyframe", () => {
    // Linear vs ease-in: at midpoint, ease-in produces less than 0.5
    const linear = sampleNumber([[0, 0], [1, 1]], 0.5, 1);
    const easeIn = sampleNumber([[0, 0], [1, 1, "ease-in"]], 0.5, 1);
    expect(linear).toBe(0.5);
    expect(easeIn).toBeLessThan(0.5);
  });

  it("sorts unsorted keyframes by resolved time", () => {
    expect(sampleNumber([[10, 100], [0, 0]], 5, 10)).toBe(50);
  });

  it("holds the previous value across the span with discrete easing", () => {
    const kf = [[0, 0], [1, 10, "discrete"]] as const;
    // No tween anywhere in [0, 1): stays at the prev value.
    expect(sampleNumber(kf as never, 0.01, 1)).toBe(0);
    expect(sampleNumber(kf as never, 0.5, 1)).toBe(0);
    expect(sampleNumber(kf as never, 0.999, 1)).toBe(0);
    // At/after the next keyframe it snaps to the next value.
    expect(sampleNumber(kf as never, 1, 1)).toBe(10);
  });

  it("step-end is an alias for discrete", () => {
    expect(sampleNumber([[0, 0], [1, 10, "step-end"]] as never, 0.5, 1)).toBe(0);
  });

  it("step-start jumps to the next value immediately", () => {
    const kf = [[0, 0], [1, 10, "step-start"]] as const;
    expect(sampleNumber(kf as never, 0.01, 1)).toBe(10);
    expect(sampleNumber(kf as never, 0.5, 1)).toBe(10);
  });

});

describe("sampleVolume (linear + dB)", () => {
  it("passes through a static linear value", () => {
    expect(sampleVolume(2, 0, 10)).toBe(2);
    expect(sampleVolume(0, 5, 10)).toBe(0);
  });

  it("converts dB strings to linear gain (uncapped)", () => {
    expect(resolveVolume("0dB")).toBeCloseTo(1, 6);
    expect(resolveVolume("6dB")).toBeCloseTo(dbToGain(6), 6); // ~1.995
    expect(resolveVolume("-6dB")).toBeCloseTo(dbToGain(-6), 6); // ~0.501
    // Exceeds the linear 0..4 cap — allowed for dB.
    expect(resolveVolume("25dB")).toBeGreaterThan(4);
    expect(sampleVolume("-25.5dB", 0, 10)).toBeCloseTo(dbToGain(-25.5), 6);
  });

  it("accepts case/spacing variants", () => {
    expect(resolveVolume("3 db")).toBeCloseTo(dbToGain(3), 6);
    expect(resolveVolume("+3dB")).toBeCloseTo(dbToGain(3), 6);
  });

  it("interpolates in linear gain across mixed linear/dB keyframes", () => {
    // 0dB (gain 1) → "6dB" (gain ~1.995): midpoint is the linear average.
    const mid = sampleVolume([[0, "0dB"], [10, "6dB"]] as never, 5, 10);
    expect(mid).toBeCloseTo((1 + dbToGain(6)) / 2, 6);
  });

  it("falls back to unity for an unparseable string", () => {
    expect(resolveVolume("loud")).toBe(1);
  });
});

describe("sampleColor", () => {
  it("returns static colour unchanged", () => {
    expect(sampleColor("red", 0, 10)).toBe("red");
  });

  it("interpolates between colours", () => {
    const mid = sampleColor([[0, "rgb(0,0,0)"], [10, "rgb(255,255,255)"]], 5, 10);
    // d3-interpolate returns CSS rgb strings
    expect(mid).toMatch(/rgb\(12[78],\s*12[78],\s*12[78]\)/);
  });
});

describe("samplePadding", () => {
  it("returns static padding unchanged", () => {
    expect(samplePadding(10, 0, 10)).toBe(10);
    expect(samplePadding([10, 5], 0, 10)).toEqual([10, 5]);
  });

  it("upgrades number to 4-tuple before interpolating", () => {
    const result = samplePadding([[0, 0], [10, 20]], 5, 10);
    expect(result).toEqual([10, 10, 10, 10]);
  });

  it("upgrades [v, h] to 4-tuple before interpolating", () => {
    const result = samplePadding([[0, [0, 0]], [10, [20, 10]]], 5, 10) as number[];
    expect(result).toEqual([10, 5, 10, 5]);
  });
});

describe("sampleLength", () => {
  it("resolves static numeric pixels (percentDefault 0 = literal pixels)", () => {
    expect(sampleLength(100, 0, 10, 1920, 0)).toBe(100);
  });

  it("resolves static percentage against reference size", () => {
    expect(sampleLength("50%", 0, 10, 1920, 0)).toBe(960);
  });

  it("uses percentDefault for bare numbers", () => {
    // percentDefault 50 → bare `0` = 50% of 1000 = 500.
    expect(sampleLength(0, 0, 10, 1000, 50)).toBe(500);
  });

  it("interpolates between pixel keyframes", () => {
    expect(sampleLength([[0, 0], [10, 100]], 5, 10, 1920, 0)).toBe(50);
  });

  it("collapses percent + pixel keyframes before interpolating", () => {
    // 0 → "50%" of 1000 = 500; midpoint = 250
    expect(sampleLength([[0, 0], [10, "50%"]], 5, 10, 1000, 0)).toBe(250);
  });

  it("supports combined '<n>% +/- <n>' keyframe values", () => {
    // 0 → "100% - 50" of 1000 = 950; midpoint = 475
    expect(sampleLength([[0, 0], [10, "100% - 50"]], 5, 10, 1000, 0)).toBe(475);
  });
});

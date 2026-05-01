import { describe, it, expect } from "vitest";
import {
  bakePwl,
  bakePwlDimension,
  isConstant,
  pwlToMltKeyframes,
} from "../animation/expr.js";

describe("bakePwl", () => {
  it("returns a single sample for static values", () => {
    const p = bakePwl(0.5, 2, 30);
    expect(isConstant(p)).toBe(true);
    expect(p.samples).toEqual([{ t: 0, v: 0.5 }]);
  });

  it("samples animated values at fps with a final t=duration sample", () => {
    const p = bakePwl([[0, 0], [1, 1]], 1, 4); // 4 fps, 1s
    expect(p.samples.length).toBe(5);
    expect(p.samples[0]).toEqual({ t: 0, v: 0 });
    expect(p.samples[p.samples.length - 1]).toEqual({ t: 1, v: 1 });
    expect(p.samples[2].v).toBeCloseTo(0.5, 5);
  });

  it("collapses to a constant when all keyframes match", () => {
    const p = bakePwl([[0, 0.5], [10, 0.5]], 10, 30);
    expect(isConstant(p)).toBe(true);
  });
});

describe("bakePwlDimension", () => {
  it("collapses static percent against parent", () => {
    const p = bakePwlDimension("50%", 2, 30, 1000);
    expect(p.samples).toEqual([{ t: 0, v: 500 }]);
  });

  it("samples mixed pixel + percent keyframes against parent", () => {
    const p = bakePwlDimension([[0, 0], [1, "50%"]], 1, 4, 1000);
    expect(p.samples[0].v).toBe(0);
    expect(p.samples[p.samples.length - 1].v).toBe(500);
  });
});

describe("pwlToMltKeyframes", () => {
  it("returns a constant for static PWL", () => {
    const p = bakePwl(0.5, 1, 30);
    expect(pwlToMltKeyframes(p, 30)).toBe("0.5");
  });

  it("emits frame=value pairs separated by semicolons", () => {
    // 2 fps → samples at 0, 0.5, 1
    const p = bakePwl([[0, 0], [1, 1]], 1, 2);
    const k = pwlToMltKeyframes(p, 2);
    const parts = k.split(";");
    expect(parts.length).toBe(3);
    expect(parts[0]).toBe("0=0");
    expect(parts[parts.length - 1]).toBe("2=1");
  });

  it("collapses run-length-encoded equal values", () => {
    // Constant for 0..0.5, jump to 1 at 1.0
    const p: { duration: number; samples: { t: number; v: number }[] } = {
      duration: 1,
      samples: [
        { t: 0, v: 0 },
        { t: 0.25, v: 0 },
        { t: 0.5, v: 0 },
        { t: 1, v: 1 },
      ],
    };
    const k = pwlToMltKeyframes(p, 4);
    // Middle equal-value samples should be skipped, but the last one is kept.
    const parts = k.split(";");
    expect(parts.length).toBe(2);
    expect(parts[0]).toBe("0=0");
    expect(parts[1]).toBe("4=1");
  });

  it("applies a frame offset to each keyframe", () => {
    const p = bakePwl([[0, 0], [1, 1]], 1, 2);
    const k = pwlToMltKeyframes(p, 2, 100);
    expect(k.split(";")[0]).toBe("100=0");
    expect(k.split(";")[2]).toBe("102=1");
  });
});

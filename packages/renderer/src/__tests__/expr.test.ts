import { describe, it, expect } from "vitest";
import {
  bakePwl,
  bakePwlDimension,
  isConstant,
  pwlToExpression,
  pwlToSendcmdCommands,
} from "../animation/expr.js";

describe("bakePwl", () => {
  it("returns a single sample for static values", () => {
    const p = bakePwl(0.5, 2, 30);
    expect(isConstant(p)).toBe(true);
    expect(p.samples).toEqual([{ t: 0, v: 0.5 }]);
  });

  it("samples animated values at fps with a final t=duration sample", () => {
    const p = bakePwl([[0, 0], [1, 1]], 1, 4); // 4 fps, 1s
    // Should hit t=0, 0.25, 0.5, 0.75, 1.0
    expect(p.samples.length).toBe(5);
    expect(p.samples[0]).toEqual({ t: 0, v: 0 });
    expect(p.samples[p.samples.length - 1]).toEqual({ t: 1, v: 1 });
    // Linear-ish in between
    expect(p.samples[2].v).toBeCloseTo(0.5, 5);
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

describe("pwlToExpression", () => {
  it("returns a constant for static PWL", () => {
    const p = bakePwl(0.5, 1, 30);
    expect(pwlToExpression(p)).toBe("0.5");
  });

  it("emits a nested if tree with lerp segments", () => {
    const p = bakePwl([[0, 0], [1, 1]], 1, 2); // 2 fps → samples at 0, 0.5, 1
    const expr = pwlToExpression(p);
    // Should reference t and lt() at sample boundaries
    expect(expr).toMatch(/^if\(lt\(t,/);
    expect(expr).toContain("0.5");
    expect(expr).toContain("1");
  });

  it("supports a time shift for delayed children", () => {
    const p = bakePwl([[0, 0], [1, 1]], 1, 2);
    const expr = pwlToExpression(p, 5);
    // Variable should be (t-5) wherever t appeared
    expect(expr).toContain("(t-5)");
    // The shifted form is the only place `t` appears.
    const stripped = expr.replace(/\(t-5\)/g, "X");
    expect(stripped).not.toMatch(/\bt\b/);
  });

  it("collapses to a constant when all samples agree", () => {
    // 30s of a static "animation" — bakePwl through sampleSeries should
    // collapse, even though the keyframe array is shaped like an animation.
    const p = bakePwl([[0, 1080], [30, 1080]], 30, 30);
    expect(p.samples).toHaveLength(1);
    expect(pwlToExpression(p)).toBe("1080");
  });

  it("uses balanced-tree depth O(log N) for long PWLs", () => {
    // 900-sample series (30s * 30fps). The balanced tree should keep
    // the maximum nesting depth well under the right-leaning chain's,
    // which is what tripped ffmpeg's expression parser.
    const p = bakePwl([[0, 0], [30, 100]], 30, 30);
    const expr = pwlToExpression(p);
    let depth = 0, maxDepth = 0;
    for (const ch of expr) {
      if (ch === "(") { depth++; if (depth > maxDepth) maxDepth = depth; }
      else if (ch === ")") depth--;
    }
    // 900 samples → ⌈log2(899)⌉ ≈ 10 if-levels, plus a constant overhead.
    // Allow generous slack; the right-leaning version was ~900 deep.
    expect(maxDepth).toBeLessThan(40);
  });

  it("clamps to the first/last value outside the keyframed range", () => {
    // The runtime sampler holds endpoints; the compiled expression must too.
    const p = bakePwl([[0, 10], [1, 20]], 1, 4);
    const expr = pwlToExpression(p);
    // Wrapper should test t < first then t < last, with first/last
    // values outside the inner tree.
    expect(expr).toMatch(/^if\(lt\(t,/);
    // First-value clamp before the keyframed range
    expect(expr).toContain(",10,");
    // Last-value clamp after the keyframed range
    expect(expr).toMatch(/,20\)\)$/);
  });
});

describe("pwlToSendcmdCommands", () => {
  it("returns empty string for static value", () => {
    const p = bakePwl(0.5, 1, 30);
    // Single sample => only one command emitted
    const cmd = pwlToSendcmdCommands(p, "eq", "brightness");
    expect(cmd).toBe("0 eq brightness 0.5");
  });

  it("emits one stepwise command per sample for animated values", () => {
    const p = bakePwl([[0, 0], [1, 1]], 1, 2);
    const cmd = pwlToSendcmdCommands(p, "eq", "brightness");
    // 3 samples, all distinct values, semicolon-separated
    const parts = cmd.split(";");
    expect(parts.length).toBe(3);
    expect(parts[0]).toBe("0 eq brightness 0");
    expect(parts[parts.length - 1]).toBe("1 eq brightness 1");
  });

  it("drops back-to-back equal values to keep the graph small", () => {
    const p = bakePwl([[0, 0.5], [1, 0.5]], 1, 4); // constant via keyframes
    const cmd = pwlToSendcmdCommands(p, "eq", "brightness");
    expect(cmd.split(";").length).toBe(1);
  });

  it("shifts command times for delayed children", () => {
    const p = bakePwl([[0, 0], [1, 1]], 1, 2);
    const cmd = pwlToSendcmdCommands(p, "eq", "brightness", 10);
    expect(cmd.split(";")[0]).toBe("10 eq brightness 0");
  });
});

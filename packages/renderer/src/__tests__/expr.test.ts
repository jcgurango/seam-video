import { describe, it, expect } from "vitest";
import {
  bakePwl,
  bakePwlDimension,
  isConstant,
  isStaticOrConstant,
  keyframedToExpression,
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
    // 2 fps over 1s → samples at 0, 0.5, 1; the midpoint is colinear
    // with its neighbours under linear interpolation so RLE drops it.
    const p = bakePwl([[0, 0], [1, 1]], 1, 2);
    const expr = pwlToExpression(p);
    expect(expr).toMatch(/^if\(lt\(t,/);
    // Surviving segment endpoints are the keyframe values (0 and 1).
    expect(expr).toContain("(0+(1)*(t-0)/1)");
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

describe("isStaticOrConstant", () => {
  it("returns true for static scalars", () => {
    expect(isStaticOrConstant(0.5)).toBe(true);
  });

  it("returns true when all keyframe values are equal", () => {
    expect(isStaticOrConstant([[0, 5], [10, 5], [20, 5]])).toBe(true);
  });

  it("returns false when keyframes differ", () => {
    expect(isStaticOrConstant([[0, 0], [1, 1]])).toBe(false);
  });
});

describe("keyframedToExpression — native easings", () => {
  it("returns a literal for static values", () => {
    expect(keyframedToExpression(0.5, 1, 30)).toBe("0.5");
  });

  it("returns a literal for effectively-constant keyframes", () => {
    expect(keyframedToExpression([[0, 5], [10, 5]], 10, 30)).toBe("5");
  });

  it("emits one analytical segment per keyframe pair (no sampling)", () => {
    // Linear over 30s should be ONE expression, not 900 if-segments.
    const expr = keyframedToExpression([[0, 0], [30, 100]], 30, 30);
    // Count `if(` occurrences — only the 2-level outer clamp wrapper
    // should appear (not the inner segments).
    const ifs = (expr.match(/if\(/g) || []).length;
    expect(ifs).toBe(2);
    // Should reference t directly (no sampling, no sample-time literals
    // like 0.033333 in the body).
    expect(expr).not.toContain("0.033333");
  });

  it("uses the cubic ease-in formula", () => {
    const expr = keyframedToExpression(
      [[0, 0], [1, 100, "ease-in"]],
      1,
      30,
    );
    expect(expr).toContain("pow(");
    // ease-in is t^3 → no `1-pow(...)` shape (that's ease-out)
    expect(expr).toMatch(/pow\([^,]+,3\)/);
  });

  it("uses the cubic ease-in-out piecewise formula", () => {
    const expr = keyframedToExpression(
      [[0, 0], [1, 100, "ease-in-out"]],
      1,
      30,
    );
    // Piecewise: lt(f, 0.5) gate plus 4*pow(...) on the easy half.
    expect(expr).toContain("0.5");
    expect(expr).toContain("4*pow(");
  });

  it("falls back to sampled PWL for cubic-bezier custom curves", () => {
    const expr = keyframedToExpression(
      [[0, 0], [1, 100, "cubic-bezier(0.42, 0, 0.58, 1)"]],
      1,
      4,
    );
    // Sampled segments → multiple sample-time literals appear in the body
    expect(expr).toMatch(/0\.25|0\.5|0\.75/);
  });

  it("clamps to first/last value outside the keyframe range", () => {
    const expr = keyframedToExpression([[1, 10], [3, 30]], 5, 30);
    // Wrapped in: if(lt(t, 1), 10, if(lt(t, 3), …, 30))
    expect(expr).toMatch(/^if\(lt\(t,1\),10,/);
    expect(expr).toMatch(/,30\)\)$/);
  });
});

describe("pwlToExpression — RLE collapses flat / linear regions", () => {
  it("collapses a 30s mostly-flat animation to a tiny tree", () => {
    // 30s timeline with a 1s ease at the end — 870 of 900 samples are
    // identical to their neighbours and should drop out.
    const p = bakePwl(
      [["0%", 800], ["100% - 1", 800], ["100%", 0, "ease-in-out"]],
      30,
      30,
    );
    const expr = pwlToExpression(p);
    // Compare to the dense form (no RLE would be ~900 segments). Even
    // accounting for the cubic region keeping its samples, the kept
    // count should be a small fraction.
    const ifs = (expr.match(/if\(/g) || []).length;
    expect(ifs).toBeLessThan(50);
  });
});

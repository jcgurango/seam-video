import { describe, it, expect } from "vitest";
import { parseLength, resolveLength, hasPercent } from "../layout/units.js";

describe("parseLength", () => {
  it("parses bare numbers as pixel-only (percent omitted)", () => {
    expect(parseLength(10)).toEqual({ percent: null, pixels: 10 });
    expect(parseLength(0)).toEqual({ percent: null, pixels: 0 });
    expect(parseLength(-25)).toEqual({ percent: null, pixels: -25 });
    expect(parseLength(12.5)).toEqual({ percent: null, pixels: 12.5 });
  });

  it("parses percentage-only strings", () => {
    expect(parseLength("50%")).toEqual({ percent: 50, pixels: 0 });
    expect(parseLength("-25%")).toEqual({ percent: -25, pixels: 0 });
    expect(parseLength("33.3%")).toEqual({ percent: 33.3, pixels: 0 });
  });

  it("parses combined '<n>% +/- <n>' form", () => {
    expect(parseLength("100% - 50")).toEqual({ percent: 100, pixels: -50 });
    expect(parseLength("50% + 10")).toEqual({ percent: 50, pixels: 10 });
    expect(parseLength("0% - 100")).toEqual({ percent: 0, pixels: -100 });
  });

  it("rejects pixel-suffixed and ambiguous strings", () => {
    expect(() => parseLength("10px")).toThrow("Invalid length");
    expect(() => parseLength("100")).toThrow("Invalid length");
    expect(() => parseLength("abc")).toThrow("Invalid length");
    expect(() => parseLength("%")).toThrow("Invalid length");
    expect(() => parseLength(NaN)).toThrow("Invalid length");
  });
});

describe("resolveLength", () => {
  it("treats bare numbers as percent-default + pixels", () => {
    // percentDefault: 50 → bare `0` is at the center (50% of 1000 = 500).
    expect(resolveLength(0, 1000, 50)).toBe(500);
    expect(resolveLength(20, 1000, 50)).toBe(520);
    // percentDefault: 0 → bare `100` is literal pixels.
    expect(resolveLength(100, 1000, 0)).toBe(100);
    expect(resolveLength(0, 1000, 0)).toBe(0);
  });

  it("resolves explicit percentages against reference size", () => {
    expect(resolveLength("50%", 1000, 0)).toBe(500);
    expect(resolveLength("100%", 1000, 0)).toBe(1000);
    // Property percent default is overridden by explicit "0%".
    expect(resolveLength("0%", 1000, 50)).toBe(0);
  });

  it("resolves combined form", () => {
    expect(resolveLength("100% - 50", 1000, 0)).toBe(950);
    expect(resolveLength("50% + 25", 200, 0)).toBe(125);
  });
});

describe("hasPercent", () => {
  it("returns true for percentage forms", () => {
    expect(hasPercent("50%")).toBe(true);
    expect(hasPercent("100% - 50")).toBe(true);
    expect(hasPercent("0%")).toBe(true);
  });
  it("returns false for pixel numbers", () => {
    expect(hasPercent(100)).toBe(false);
    expect(hasPercent(0)).toBe(false);
  });
});

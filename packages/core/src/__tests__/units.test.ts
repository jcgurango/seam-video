import { describe, it, expect } from "vitest";
import { parseDimension, resolveDimension } from "../layout/units.js";

describe("parseDimension", () => {
  it("parses numbers as px", () => {
    expect(parseDimension(10)).toEqual({ value: 10, unit: "px" });
    expect(parseDimension(0)).toEqual({ value: 0, unit: "px" });
    expect(parseDimension(12.5)).toEqual({ value: 12.5, unit: "px" });
    expect(parseDimension(-10)).toEqual({ value: -10, unit: "px" });
  });

  it("parses percentage strings", () => {
    expect(parseDimension("50%")).toEqual({ value: 50, unit: "%" });
    expect(parseDimension("33.3%")).toEqual({ value: 33.3, unit: "%" });
    expect(parseDimension("-25%")).toEqual({ value: -25, unit: "%" });
  });

  it("rejects px-suffixed strings (numbers must be bare)", () => {
    expect(() => parseDimension("10px")).toThrow("Invalid dimension");
    expect(() => parseDimension("100")).toThrow("Invalid dimension");
  });

  it("throws on invalid input", () => {
    expect(() => parseDimension("abc")).toThrow("Invalid dimension");
    expect(() => parseDimension("%")).toThrow("Invalid dimension");
    expect(() => parseDimension("10em")).toThrow("Invalid dimension");
    expect(() => parseDimension(NaN)).toThrow("Invalid dimension");
    expect(() => parseDimension(Infinity)).toThrow("Invalid dimension");
  });
});

describe("resolveDimension", () => {
  it("resolves px values", () => {
    expect(resolveDimension(100, 1920)).toBe(100);
    expect(resolveDimension(0, 1920)).toBe(0);
  });

  it("resolves percentage values against parent", () => {
    expect(resolveDimension("50%", 1920)).toBe(960);
    expect(resolveDimension("25%", 1080)).toBe(270);
  });

  it("resolves negative values", () => {
    expect(resolveDimension(-10, 1920)).toBe(-10);
    expect(resolveDimension("-50%", 200)).toBe(-100);
  });
});

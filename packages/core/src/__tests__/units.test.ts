import { describe, it, expect } from "vitest";
import { parseDimension, resolveDimension } from "../layout/units.js";

describe("parseDimension", () => {
  it("parses px values", () => {
    expect(parseDimension("10px")).toEqual({ value: 10, unit: "px" });
  });

  it("parses percentage values", () => {
    expect(parseDimension("50%")).toEqual({ value: 50, unit: "%" });
  });

  it("parses bare numbers as px", () => {
    expect(parseDimension("100")).toEqual({ value: 100, unit: "px" });
  });

  it("parses decimal values", () => {
    expect(parseDimension("12.5px")).toEqual({ value: 12.5, unit: "px" });
    expect(parseDimension("33.3%")).toEqual({ value: 33.3, unit: "%" });
  });

  it("parses negative values", () => {
    expect(parseDimension("-10px")).toEqual({ value: -10, unit: "px" });
    expect(parseDimension("-25%")).toEqual({ value: -25, unit: "%" });
  });

  it("throws on invalid input", () => {
    expect(() => parseDimension("abc")).toThrow("Invalid dimension");
    expect(() => parseDimension("px")).toThrow("Invalid dimension");
    expect(() => parseDimension("10em")).toThrow("Invalid dimension");
  });
});

describe("resolveDimension", () => {
  it("resolves px values", () => {
    expect(resolveDimension("100px", 1920)).toBe(100);
  });

  it("resolves percentage values against parent", () => {
    expect(resolveDimension("50%", 1920)).toBe(960);
    expect(resolveDimension("25%", 1080)).toBe(270);
  });

  it("resolves bare numbers as px", () => {
    expect(resolveDimension("200", 1920)).toBe(200);
  });

  it("resolves negative values", () => {
    expect(resolveDimension("-10px", 1920)).toBe(-10);
    expect(resolveDimension("-50%", 200)).toBe(-100);
  });
});

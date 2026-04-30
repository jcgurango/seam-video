import { describe, it, expect } from "vitest";
import { parseTimeExpr, resolveTimeExpr } from "../animation/time.js";

describe("parseTimeExpr", () => {
  it("parses bare seconds", () => {
    expect(parseTimeExpr(0)).toEqual({ percent: 0, offset: 0 });
    expect(parseTimeExpr(1.5)).toEqual({ percent: 0, offset: 1.5 });
    expect(parseTimeExpr(-0.25)).toEqual({ percent: 0, offset: -0.25 });
  });

  it("parses percentages", () => {
    expect(parseTimeExpr("0%")).toEqual({ percent: 0, offset: 0 });
    expect(parseTimeExpr("50%")).toEqual({ percent: 0.5, offset: 0 });
    expect(parseTimeExpr("100%")).toEqual({ percent: 1, offset: 0 });
    expect(parseTimeExpr("-25%")).toEqual({ percent: -0.25, offset: 0 });
  });

  it("parses percentage + offset", () => {
    expect(parseTimeExpr("50% + 10")).toEqual({ percent: 0.5, offset: 10 });
    expect(parseTimeExpr("100% - 1.5")).toEqual({ percent: 1, offset: -1.5 });
    expect(parseTimeExpr("0% + 0")).toEqual({ percent: 0, offset: 0 });
  });

  it("requires spaces around the operator", () => {
    expect(() => parseTimeExpr("50%+10")).toThrow("Invalid time expression");
    expect(() => parseTimeExpr("50%-10")).toThrow("Invalid time expression");
  });

  it("rejects garbage", () => {
    expect(() => parseTimeExpr("abc")).toThrow("Invalid time expression");
    expect(() => parseTimeExpr("10s")).toThrow("Invalid time expression");
    expect(() => parseTimeExpr("10 + 50%")).toThrow("Invalid time expression");
    expect(() => parseTimeExpr(NaN)).toThrow("Invalid time expression");
  });
});

describe("resolveTimeExpr", () => {
  it("resolves bare seconds", () => {
    expect(resolveTimeExpr(2, 10)).toBe(2);
  });

  it("resolves percentages against duration", () => {
    expect(resolveTimeExpr("50%", 10)).toBe(5);
    expect(resolveTimeExpr("100%", 7)).toBe(7);
  });

  it("resolves percentage + offset", () => {
    expect(resolveTimeExpr("50% + 1", 10)).toBe(6);
    expect(resolveTimeExpr("100% - 2", 8)).toBe(6);
  });
});

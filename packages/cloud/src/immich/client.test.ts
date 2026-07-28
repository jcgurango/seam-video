import { describe, expect, it } from "vitest";
import { parseImmichDuration } from "./client.js";

describe("parseImmichDuration", () => {
  it("parses Immich's H:MM:SS.mmmmm format", () => {
    expect(parseImmichDuration("0:00:30.00000")).toBe(30);
    expect(parseImmichDuration("0:01:05.50000")).toBe(65.5);
    expect(parseImmichDuration("1:02:03.00000")).toBe(3723);
  });

  it("parses without fractional seconds", () => {
    expect(parseImmichDuration("0:00:07")).toBe(7);
  });

  it("returns null for zero (images), absent, or malformed values", () => {
    expect(parseImmichDuration("0:00:00.00000")).toBeNull();
    expect(parseImmichDuration(null)).toBeNull();
    expect(parseImmichDuration(undefined)).toBeNull();
    expect(parseImmichDuration("")).toBeNull();
    expect(parseImmichDuration("30")).toBeNull();
    expect(parseImmichDuration("not a duration")).toBeNull();
  });
});

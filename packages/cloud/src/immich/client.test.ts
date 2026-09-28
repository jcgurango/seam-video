import { describe, expect, it } from "vitest";
import { immichAssetDimensions, parseImmichDuration } from "./client.js";

describe("parseImmichDuration", () => {
  it("parses Immich's H:MM:SS.mmmmm format", () => {
    expect(parseImmichDuration("0:00:30.00000")).toBe(30);
    expect(parseImmichDuration("0:01:05.50000")).toBe(65.5);
    expect(parseImmichDuration("1:02:03.00000")).toBe(3723);
  });

  it("parses without fractional seconds", () => {
    expect(parseImmichDuration("0:00:07")).toBe(7);
  });

  it("treats a number (Immich ≥3) as milliseconds", () => {
    expect(parseImmichDuration(2612)).toBe(2.612);
    expect(parseImmichDuration(7535)).toBe(7.535);
    expect(parseImmichDuration(0)).toBeNull();
    expect(parseImmichDuration(NaN)).toBeNull();
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

describe("immichAssetDimensions", () => {
  it("prefers v3's orientation-corrected top-level width/height", () => {
    expect(
      immichAssetDimensions({
        width: 1080,
        height: 1920,
        exifInfo: { exifImageWidth: 1920, exifImageHeight: 1080 },
      })
    ).toEqual({ width: 1080, height: 1920 });
  });

  it("falls back to exifInfo on older payloads", () => {
    expect(
      immichAssetDimensions({ exifInfo: { exifImageWidth: 640, exifImageHeight: 480 } })
    ).toEqual({ width: 640, height: 480 });
  });

  it("returns nulls when nothing usable is present", () => {
    expect(immichAssetDimensions({})).toEqual({ width: null, height: null });
    expect(immichAssetDimensions({ width: 0, height: 0, exifInfo: null })).toEqual({
      width: null,
      height: null,
    });
  });
});

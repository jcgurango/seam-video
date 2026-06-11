import { describe, it, expect } from "vitest";
import { withFallbackFamilies } from "../text/fallbackFonts.js";

describe("withFallbackFamilies", () => {
  it("appends CJK + emoji fallbacks after the primary family", () => {
    // Multi-word families are quoted; single-word ones (OpenMoji) are not.
    expect(withFallbackFamilies('"Liberation Sans"')).toBe(
      '"Liberation Sans", "Noto Sans CJK JP", OpenMoji',
    );
  });

  it("does not duplicate a fallback already present in the primary", () => {
    expect(withFallbackFamilies("OpenMoji")).toBe('OpenMoji, "Noto Sans CJK JP"');
    expect(withFallbackFamilies('"Noto Sans CJK JP"')).toBe(
      '"Noto Sans CJK JP", OpenMoji',
    );
  });

  it("handles an existing comma list as the primary", () => {
    expect(withFallbackFamilies('"Arial", monospace')).toBe(
      '"Arial", monospace, "Noto Sans CJK JP", OpenMoji',
    );
  });
});

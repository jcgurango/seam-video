import { describe, it, expect } from "vitest";
import { resolveSpatial, type ResolvedTimeline } from "@seam/core";
import { buildMltDocument } from "../mlt-builder.js";
import type { IntrinsicSizeMap } from "../media-probe.js";

// Extract every qtblend `rect` value from the emitted MLT XML, in order.
function rects(xml: string): string[] {
  return [...xml.matchAll(/<property name="rect">([^<]+)<\/property>/g)].map(
    (m) => m[1],
  );
}

/** Resolve a minimal portrait timeline holding one 1920×1080-source clip
 *  whose fit is inherited from the root composition's objectFit. */
function coverTimeline(objectFit: "fit" | "cover" | "center"): ResolvedTimeline {
  const raw = {
    duration: 1,
    width: 1080,
    height: 1920,
    contentWidth: 1080,
    contentHeight: 1920,
    objectFit,
    children: [
      {
        type: "clip" as const,
        source: "land.mp4",
        timelineStart: 0,
        timelineEnd: 1,
        duration: 1,
        speed: 1,
        sourceIn: 0,
        sourceOut: 1,
      },
    ],
  };
  // resolveSpatial bakes objectFit inheritance + the (stale) parent-size
  // natural rect, mirroring the real CLI pipeline.
  return resolveSpatial(raw as unknown as ResolvedTimeline, 1080, 1920);
}

const PROBED: IntrinsicSizeMap = new Map([
  ["land.mp4", { width: 1920, height: 1080 }],
]);

describe("objectFit cover/center via probed dims", () => {
  it("cover emits an oversized centered rect that frame-clips to fill", () => {
    const { xml } = buildMltDocument(coverTimeline("cover"), {
      width: 1080,
      height: 1920,
      fps: 30,
      intrinsicSizes: PROBED,
    });
    // cover scale = max(1080/1920, 1920/1080) = 1.7778 → 3413×1920,
    // centered → x = round((1080-3413.3)/2) = -1167.
    expect(rects(xml)).toContain("-1167 0 3413 1920 1");
  });

  it("center emits the intrinsic-size rect centered (no scaling)", () => {
    const { xml } = buildMltDocument(coverTimeline("center"), {
      width: 1080,
      height: 1920,
      fps: 30,
      intrinsicSizes: PROBED,
    });
    // center scale = 1 → 1920×1080, centered → x=-420, y=420.
    expect(rects(xml)).toContain("-420 420 1920 1080 1");
  });

  it("fit emits the contained rect (letterboxed)", () => {
    const { xml } = buildMltDocument(coverTimeline("fit"), {
      width: 1080,
      height: 1920,
      fps: 30,
      intrinsicSizes: PROBED,
    });
    // fit scale = min(1080/1920, 1920/1080) = 0.5625 → 1080×608,
    // centered → y = (1920-608)/2 = 656.
    expect(rects(xml)).toContain("0 656 1080 608 1");
  });

  it("without probed dims, falls back to parent-size stretch + warns", () => {
    const result = buildMltDocument(coverTimeline("cover"), {
      width: 1080,
      height: 1920,
      fps: 30,
    });
    expect(rects(result.xml)).toContain("0 0 1080 1920 1");
    expect(
      result.limitations.some(
        (l) => l.node === "clip" && l.field === "objectFit",
      ),
    ).toBe(true);
  });
});

import { describe, it, expect } from "vitest";
import type { ResolvedComposition, ResolvedTimeline } from "@seam/core";
import { buildMltDocument, isComplexComposition } from "../mlt-builder.js";

// These tests construct already-resolved nodes directly (the shape
// `resolveSpatial` produces), since the builder consumes the resolved
// tree — `spatial` / `objectFit` / `filters` / `naturalWidth` etc.

function innerClip() {
  return {
    type: "clip" as const,
    source: "inner.mp4",
    timelineStart: 0,
    timelineEnd: 1,
    duration: 1,
    speed: 1,
    sourceIn: 0,
    sourceOut: 1,
  };
}

function nestedComp(extra: Partial<ResolvedComposition>): ResolvedComposition {
  return {
    type: "composition",
    timelineStart: 0,
    timelineEnd: 1,
    duration: 1,
    speed: 1,
    objectFit: "fit",
    contentWidth: 1080,
    contentHeight: 1920,
    naturalWidth: 1080,
    naturalHeight: 1920,
    children: [innerClip()],
    ...extra,
  } as ResolvedComposition;
}

function timelineWith(comp: ResolvedComposition): ResolvedTimeline {
  return {
    duration: 1,
    width: 1080,
    height: 1920,
    contentWidth: 1080,
    contentHeight: 1920,
    children: [comp],
  };
}

describe("isComplexComposition", () => {
  it("is true for filters / spatial / non-fit objectFit", () => {
    expect(isComplexComposition(nestedComp({ filters: [{ type: "adjust", brightness: 0.2 }] }))).toBe(true);
    expect(isComplexComposition(nestedComp({ spatial: { x: 270, y: 480, width: 540, height: 960 } }))).toBe(true);
    expect(isComplexComposition(nestedComp({ objectFit: "cover" }))).toBe(true);
  });

  it("is false for a plain pass-through composition", () => {
    expect(isComplexComposition(nestedComp({}))).toBe(false);
  });
});

describe("nested composition as external .mlt producer", () => {
  it("references the sub-mlt producer, places it, and applies wrapper filters", () => {
    const comp = nestedComp({
      spatial: { x: 270, y: 480, width: 540, height: 960 },
      filters: [{ type: "adjust", brightness: 0.3 }],
    });
    const compositionMlts = new Map([[comp, "/tmp/sidecar/comp-0.mlt"]]);
    const { xml } = buildMltDocument(timelineWith(comp), {
      width: 1080,
      height: 1920,
      fps: 30,
      compositionMlts,
    });
    expect(xml).toContain('resource="/tmp/sidecar/comp-0.mlt"');
    expect(xml).toMatch(/<playlist id="comp_v1">/);
    // wrapper filter → avfilter chain
    expect(xml).toContain("avfilter.eq");
    // placed at its display rect (270 480 540 960)
    expect(xml).toContain("270 480 540 960 1");
    // inner clip is NOT flattened into the parent
    expect(xml).not.toContain("inner.mp4");
  });

  it("flattens a trivial composition (children inline, no comp track)", () => {
    const comp = nestedComp({});
    const { xml } = buildMltDocument(timelineWith(comp), {
      width: 1080,
      height: 1920,
      fps: 30,
      compositionMlts: new Map(),
    });
    expect(xml).toContain("inner.mp4");
    expect(xml).not.toMatch(/<playlist id="comp_v1">/);
  });

  it("warns when a complex composition has no pre-rendered sub-mlt", () => {
    const comp = nestedComp({ spatial: { x: 270, y: 480, width: 540, height: 960 } });
    const { limitations } = buildMltDocument(timelineWith(comp), {
      width: 1080,
      height: 1920,
      fps: 30,
    });
    expect(limitations.some((l) => l.node === "composition" && l.field === "wrapper")).toBe(true);
  });
});

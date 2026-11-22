import { describe, it, expect } from "vitest";
import {
  resolveSpatial,
  samplePin,
  sampleZoom,
  type Composition,
  type ResolvedMap,
  type ResolvedRect,
} from "../index.js";
import { createSeam } from "../seam.js";

const { parseSeamFile, resolveComposition } = createSeam();

function parse(doc: unknown) {
  return parseSeamFile(JSON.stringify(doc));
}

describe("rect / circle schema", () => {
  it("accepts a rect with keyframed fill, stroke and cornerRadius", () => {
    const r = parse({
      type: "composition",
      children: [
        {
          type: "rect",
          duration: 2,
          fill: [[0, "red"], [1, "blue", "ease-in-out"]],
          stroke: "black",
          strokeWidth: [[0, 0], ["100%", 8]],
          cornerRadius: "50%",
          size: { x: 300, y: 40 },
          origin: "0%",
          translation: "0%",
        },
      ],
    });
    expect(r.success, r.success ? "" : r.errors.join("\n")).toBe(true);
  });

  it("accepts an anchored circle, but always requires a duration", () => {
    const doc = (circle: object) => ({
      type: "composition",
      children: [
        { type: "clip", id: "c", source: "a.mp4", in: 0, out: 5 },
        { type: "circle", fill: "white", size: 120, start: "c", ...circle },
      ],
    });
    const r = parse(doc({ duration: 5 }));
    expect(r.success, r.success ? "" : r.errors.join("\n")).toBe(true);
    expect(parse(doc({})).success).toBe(false);
  });

  it("rejects a rect without duration, and unknown fields", () => {
    expect(parse({ type: "composition", children: [{ type: "rect" }] }).success).toBe(false);
    expect(
      parse({ type: "composition", children: [{ type: "rect", start: 0, offset: 1 }] }).success,
    ).toBe(false);
    expect(
      parse({ type: "composition", children: [{ type: "rect", duration: 1, radius: 4 }] }).success,
    ).toBe(false);
  });

  it("rejects the removed graphic type", () => {
    const r = parse({
      type: "composition",
      children: [{ type: "graphic", duration: 1, frames: [[0, []]] }],
    });
    expect(r.success).toBe(false);
  });
});

describe("map schema", () => {
  const map = {
    type: "map",
    source: "area.pmtiles",
    duration: 6,
    latitude: [[0, 34.05], [6, 34.22]],
    longitude: 133,
    zoom: [[0, 14], [6, 11]],
    mapOpacity: 0.8,
    theme: "dark",
    paths: [
      { id: "route", color: "red", points: [[132.9, 34.0], [133.1, 34.2]], progress: [[0, 0], [6, 1]] },
    ],
    children: [
      {
        type: "static",
        source: "avatar.jpg",
        duration: 6,
        size: 90,
        cornerRadius: "50%",
        pin: { path: "route" },
      },
      {
        type: "text",
        text: "Start",
        duration: 6,
        start: 0,
        pin: [[0, { latitude: 34.0, longitude: 132.9 }], [6, { latitude: 34.2, longitude: 133.1 }]],
      },
    ],
  };

  it("accepts a map with camera keyframes, paths and pinned children", () => {
    const r = parse({ type: "composition", children: [map] });
    expect(r.success, r.success ? "" : r.errors.join("\n")).toBe(true);
  });

  it("rejects a path with fewer than two points and a pin of the wrong shape", () => {
    expect(
      parse({
        type: "composition",
        children: [{ ...map, paths: [{ color: "red", points: [[0, 0]] }] }],
      }).success,
    ).toBe(false);
    expect(
      parse({
        type: "composition",
        children: [{ type: "rect", duration: 1, pin: { latitude: 1 } }],
      }).success,
    ).toBe(false);
  });

  it("rejects the legacy `attachments` array on a map", () => {
    const { children, ...rest } = map;
    expect(
      parse({ type: "composition", children: [{ ...rest, attachments: children }] }).success,
    ).toBe(false);
  });

  it("resolves children in map-local time and keeps pins + content dims", () => {
    const doc: Composition = {
      type: "composition",
      contentWidth: 1080,
      contentHeight: 1920,
      children: [
        {
          ...(map as unknown as Composition["children"] extends (infer C)[] | undefined ? C : never),
          offset: 2,
        },
      ],
    };
    const timeline = resolveSpatial(resolveComposition(doc), 1080, 1920);
    const m = timeline.children[0] as ResolvedMap;
    expect(m.type).toBe("map");
    expect(m.timelineStart).toBe(2);
    expect(m.timelineEnd).toBe(8);
    expect(m.children).toHaveLength(2);
    expect(m.children[0].timelineStart).toBe(0);
    expect(m.children[0].timelineEnd).toBe(6);
    // `start: 0` heads a second run alongside the first, in array (z) order.
    expect(m.children[1]).toMatchObject({ type: "text", timelineStart: 0, timelineEnd: 6 });
    expect((m.children[0] as { pin?: unknown }).pin).toEqual({ path: "route" });
    expect((m.children[0] as { cornerRadius?: unknown }).cornerRadius).toBe("50%");
    // Default inner canvas = 100% of the parent; children lay out against it.
    expect(m.intrinsicWidth).toBe(1080);
    expect(m.intrinsicHeight).toBe(1920);
    expect((m.children[0] as ResolvedRect).spatial).toEqual({ x: 495, y: 915, width: 90, height: 90 });
    expect(m.paths?.[0].id).toBe("route");
    expect(m.zoom).toEqual([[0, 14], [6, 11]]);
  });

  it("lets a map child anchor to a sibling's id", () => {
    const doc = {
      type: "composition",
      children: [
        {
          ...map,
          children: [
            { type: "rect", duration: 1, fill: "blue", start: "a@100%" },
            { type: "rect", id: "a", duration: 2, fill: "red", start: 0 },
          ],
        },
      ],
    } as unknown as Composition;
    const timeline = resolveComposition(doc);
    const m = timeline.children[0] as ResolvedMap;
    expect(m.children[0]).toMatchObject({ fill: "blue", timelineStart: 2, timelineEnd: 3 });
    expect(m.children[1]).toMatchObject({ fill: "red", timelineStart: 0, timelineEnd: 2 });
    // Children never extend (or shrink) the map.
    expect(m.timelineEnd - m.timelineStart).toBe(6);
    expect(timeline.duration).toBe(6);
  });
});

describe("shape resolution", () => {
  it("places a rect by size/origin/translation with no intrinsic dims", () => {
    const doc: Composition = {
      type: "composition",
      contentWidth: 1000,
      contentHeight: 500,
      children: [
        {
          type: "rect",
          duration: 1,
          fill: "red",
          size: { x: 200, y: 50 },
          origin: "0%",
          translation: { x: "0% + 10", y: "0% + 20" },
          cornerRadius: 8,
        },
      ],
    };
    const timeline = resolveSpatial(resolveComposition(doc), 1000, 500);
    const r = timeline.children[0] as ResolvedRect;
    expect(r.type).toBe("rect");
    expect(r.intrinsicWidth).toBeUndefined();
    expect(r.naturalWidth).toBe(1000);
    expect(r.spatial).toEqual({ x: 10, y: 20, width: 200, height: 50 });
    expect(r.fill).toBe("red");
    expect(r.cornerRadius).toBe(8);
    // Static spatial → no spatialInput retained.
    expect(r.spatialInput).toBeUndefined();
  });

  it("a rect with no size fills the parent", () => {
    const doc: Composition = {
      type: "composition",
      contentWidth: 640,
      contentHeight: 480,
      children: [{ type: "circle", duration: 1 }],
    };
    const timeline = resolveSpatial(resolveComposition(doc), 640, 480);
    const c = timeline.children[0];
    expect(c.type).toBe("circle");
    // No authored spatial → no baked rect; the renderer centers the natural box.
    expect((c as ResolvedRect).naturalWidth).toBe(640);
    expect((c as ResolvedRect).naturalHeight).toBe(480);
  });
});

describe("samplers", () => {
  it("sampleZoom is linear in scale (2^-zoom), not in zoom", () => {
    const kf: [number, number][] = [[0, 10], [1, 12]];
    expect(sampleZoom(kf, 0, 1)).toBe(10);
    expect(sampleZoom(kf, 1, 1)).toBe(12);
    // Halfway in scale: (2^-10 + 2^-12)/2 = 2^-10 · 0.625 → zoom = 10 - log2(0.625)
    expect(sampleZoom(kf, 0.5, 1)).toBeCloseTo(10 - Math.log2(0.625), 9);
    expect(sampleZoom(13, 0.5, 1)).toBe(13);
  });

  it("samplePin lerps geo→geo and position on the same path, snaps otherwise", () => {
    const geo = samplePin(
      [[0, { latitude: 0, longitude: 10 }], [2, { latitude: 10, longitude: 20 }]],
      1,
      2,
    );
    expect(geo).toEqual({ latitude: 5, longitude: 15 });
    const path = samplePin(
      [[0, { path: "r", position: 0 }], [2, { path: "r", position: 1 }]],
      0.5,
      2,
    );
    expect(path).toEqual({ path: "r", position: 0.25 });
    const mixed = samplePin(
      [[0, { path: "r", position: 0 }], [2, { latitude: 1, longitude: 1 }]],
      1,
      2,
    );
    expect(mixed).toEqual({ path: "r", position: 0 });
    expect(samplePin({ path: 0 }, 5, 2)).toEqual({ path: 0 });
  });
});

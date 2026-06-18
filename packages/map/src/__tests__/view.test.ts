import { describe, it, expect } from "vitest";
import { MapView, type DataBounds, type MapCamera } from "../view.js";

// area.pmtiles-like archive: regional (Shimanami, Japan), zooms 9–13.
const BOUNDS: DataBounds = {
  minLon: 132.03,
  minLat: 33.72,
  maxLon: 134.02,
  maxLat: 34.72,
};
const MIN_ZOOM = 9;
const MAX_ZOOM = 13;

function tileCount(view: MapView): number {
  const r = view.tileRange();
  return Math.max(0, r.x1 - r.x0 + 1) * Math.max(0, r.y1 - r.y0 + 1);
}

const cam = (over: Partial<MapCamera>): MapCamera => ({
  latitude: 0,
  longitude: 0,
  zoom: 1,
  width: 1080,
  height: 1920,
  ...over,
});

describe("MapView.tileRange clamping", () => {
  it("does not explode when zoomed far below the archive minZoom (the tab-killer)", () => {
    // z1 against a minZoom-9 archive used to span the whole z9 world (~277k tiles).
    const view = new MapView(cam({ zoom: 1 }), MIN_ZOOM, MAX_ZOOM, BOUNDS);
    expect(view.tileZoom).toBe(9);
    expect(tileCount(view)).toBeLessThan(100);
  });

  it("yields an empty range when the viewport is entirely outside the data", () => {
    // Tight viewport at 0,0 — nowhere near the data extent.
    const view = new MapView(cam({ zoom: 12, longitude: 0, latitude: 0 }), MIN_ZOOM, MAX_ZOOM, BOUNDS);
    expect(tileCount(view)).toBe(0);
  });

  it("covers the data center at native zoom with a sane tile count", () => {
    const view = new MapView(
      cam({ zoom: 13, longitude: 133.14757, latitude: 34.302281, width: 800, height: 800 }),
      MIN_ZOOM,
      MAX_ZOOM,
      BOUNDS,
    );
    const n = tileCount(view);
    expect(n).toBeGreaterThan(0);
    expect(n).toBeLessThan(36);
  });

  it("enforces the hard per-axis backstop even without data bounds", () => {
    // Same pathological camera, no bounds to clamp to — the MAX_TILES_PER_AXIS
    // backstop must still bound each axis.
    const view = new MapView(cam({ zoom: 1 }), MIN_ZOOM, MAX_ZOOM);
    const r = view.tileRange();
    expect(r.x1 - r.x0 + 1).toBeLessThanOrEqual(64);
    expect(r.y1 - r.y0 + 1).toBeLessThanOrEqual(64);
  });
});

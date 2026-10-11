import { describe, it, expect } from "vitest";
import {
  squareToQuad,
  applyHomography,
  quadWeights,
  type Quad,
} from "../layout/distort.js";
import { sampleDistort, isIdentityDistort } from "../animation/keyframes.js";

const unit: Quad = [
  { x: 0, y: 0 },
  { x: 1, y: 0 },
  { x: 1, y: 1 },
  { x: 0, y: 1 },
];

describe("squareToQuad / applyHomography", () => {
  it("is the identity for the unit square", () => {
    const m = squareToQuad(unit);
    expect(m.g).toBe(0);
    expect(m.h).toBe(0);
    expect(applyHomography(m, 0.3, 0.7)).toEqual({ x: 0.3, y: 0.7 });
  });

  it("hits every corner exactly for a general (projective) quad", () => {
    const quad: Quad = [
      { x: 10, y: 20 },
      { x: 90, y: 5 },
      { x: 120, y: 110 },
      { x: 30, y: 80 },
    ];
    const m = squareToQuad(quad);
    const corners = [
      applyHomography(m, 0, 0),
      applyHomography(m, 1, 0),
      applyHomography(m, 1, 1),
      applyHomography(m, 0, 1),
    ];
    corners.forEach((c, i) => {
      expect(c.x).toBeCloseTo(quad[i].x, 9);
      expect(c.y).toBeCloseTo(quad[i].y, 9);
    });
  });

  it("keeps straight lines straight (projective, not bilinear)", () => {
    // A keystone: bottom edge shrunk to the middle half. Under the homography
    // the image of the vertical mid-line u=0.5 is a straight line, so three
    // points on it must be collinear.
    const quad: Quad = [
      { x: 0, y: 0 },
      { x: 100, y: 0 },
      { x: 75, y: 100 },
      { x: 25, y: 100 },
    ];
    const m = squareToQuad(quad);
    const a = applyHomography(m, 0.5, 0);
    const b = applyHomography(m, 0.5, 0.5);
    const c = applyHomography(m, 0.5, 1);
    const cross = (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
    expect(cross).toBeCloseTo(0, 9);
    // And a bilinear blend would NOT put the midpoint where the homography
    // does: perspective foreshortening pushes the texture's half-way point
    // toward the narrow ("far") edge, past the corner average (50, 50).
    expect(b.x).toBeCloseTo(50, 9);
    expect(b.y).toBeGreaterThan(50);
  });

  it("stays affine (g = h = 0) for a parallelogram", () => {
    const m = squareToQuad([
      { x: 0, y: 0 },
      { x: 100, y: 0 },
      { x: 130, y: 50 },
      { x: 30, y: 50 },
    ]);
    expect(m.g).toBeCloseTo(0, 12);
    expect(m.h).toBeCloseTo(0, 12);
  });
});

describe("quadWeights", () => {
  it("is all ones for an affine quad", () => {
    expect(quadWeights(unit)).toEqual([1, 1, 1, 1]);
  });

  it("is positive and non-trivial for a convex keystone", () => {
    const w = quadWeights([
      { x: 0, y: 0 },
      { x: 100, y: 0 },
      { x: 75, y: 100 },
      { x: 25, y: 100 },
    ]);
    for (const x of w) expect(x).toBeGreaterThan(0);
    expect(w.some((x) => Math.abs(x - 1) > 1e-6)).toBe(true);
  });

  it("falls back to unit weights for a bow-tie (non-convex) quad", () => {
    // TR and BR swapped → self-intersecting; the homography would need a
    // negative w, which the GPU would clip. Fallback to plain triangles.
    const w = quadWeights([
      { x: 0, y: 0 },
      { x: 100, y: 100 },
      { x: 100, y: 0 },
      { x: 0, y: 100 },
    ]);
    expect(w).toEqual([1, 1, 1, 1]);
  });
});

describe("sampleDistort", () => {
  it("defaults every absent corner to its natural position", () => {
    const c = sampleDistort({}, 0, 1, 200, 100);
    expect(c).toEqual({ x0: 0, y0: 0, x1: 200, y1: 0, x2: 200, y2: 100, x3: 0, y3: 100 });
    expect(isIdentityDistort(c, 200, 100)).toBe(true);
  });

  it("resolves % against contentWidth (x) / contentHeight (y)", () => {
    const c = sampleDistort({ x1: "50%", y3: "25%" }, 0, 1, 200, 100);
    expect(c.x1).toBe(100);
    expect(c.y3).toBe(25);
    expect(isIdentityDistort(c, 200, 100)).toBe(false);
  });

  it("treats a bare number as a pixel offset from the corner's natural spot", () => {
    const c = sampleDistort({ x0: 10, x1: -20, y2: -5, y3: 7 }, 0, 1, 200, 100);
    expect(c.x0).toBe(10); // 0% + 10
    expect(c.x1).toBe(180); // 100% - 20
    expect(c.y2).toBe(95); // 100% - 5
    expect(c.y3).toBe(107); // 100% + 7
  });

  it("supports the combined '% ± px' form", () => {
    const c = sampleDistort({ x2: "100% - 30", y0: "0% + 12" }, 0, 1, 200, 100);
    expect(c.x2).toBe(170);
    expect(c.y0).toBe(12);
  });

  it("animates the whole set as one value (per-coordinate pixel tween)", () => {
    const kf = [
      [0, {}],
      [1, { x1: "50%", y1: 20 }],
    ] as const;
    const mid = sampleDistort(kf as never, 0.5, 1, 200, 100);
    expect(mid.x1).toBeCloseTo(150); // 200 → 100
    expect(mid.y1).toBeCloseTo(10); // 0 → 20
    expect(mid.x0).toBe(0); // untouched corner stays put
    const end = sampleDistort(kf as never, 1, 1, 200, 100);
    expect(end.x1).toBe(100);
    expect(end.y1).toBe(20);
  });
});

// ── Projective (homography) math for corner-pin distortion ─────────
//
// A `distort` pins the four corners of a composition's content canvas to
// arbitrary points. Drawing that as two bilinear triangles would crease along
// the diagonal; the correct warp is the unique projective map (homography)
// taking the unit square to the quad. Both renderers share this module via the
// compositor: it maps points through the homography (so an `inset` window's
// corners land where the full-canvas warp puts them) and derives the
// per-corner homogeneous weights the vertex shader needs for perspective-
// correct texture interpolation (`clip.w`).
//
// Reference: Heckbert, "Fundamentals of Texture Mapping and Image Warping"
// (1989), §2.2 "square-to-quadrilateral".

export interface Point {
  x: number;
  y: number;
}

/** Four corners, clockwise from top-left: TL, TR, BR, BL — the images of the
 *  unit-square corners (0,0), (1,0), (1,1), (0,1). */
export type Quad = [Point, Point, Point, Point];

/** Homography `(u,v) ↦ ((a·u + b·v + c) / w, (d·u + e·v + f) / w)` with
 *  `w = g·u + h·v + 1`. Identity-affine when `g = h = 0`. */
export interface Homography {
  a: number; b: number; c: number;
  d: number; e: number; f: number;
  g: number; h: number;
}

const EPS = 1e-9;

/** Homography taking the unit square (0,0)-(1,1) to `quad`. Degenerate quads
 *  (collinear corners) fall back to the affine map through TL/TR/BL. */
export function squareToQuad(quad: Quad): Homography {
  const [p0, p1, p2, p3] = quad;
  const sx = p0.x - p1.x + p2.x - p3.x;
  const sy = p0.y - p1.y + p2.y - p3.y;
  let g = 0;
  let h = 0;
  if (Math.abs(sx) > EPS || Math.abs(sy) > EPS) {
    const dx1 = p1.x - p2.x;
    const dx2 = p3.x - p2.x;
    const dy1 = p1.y - p2.y;
    const dy2 = p3.y - p2.y;
    const det = dx1 * dy2 - dx2 * dy1;
    if (Math.abs(det) > EPS) {
      g = (sx * dy2 - dx2 * sy) / det;
      h = (dx1 * sy - sx * dy1) / det;
    }
  }
  return {
    a: p1.x - p0.x + g * p1.x,
    b: p3.x - p0.x + h * p3.x,
    c: p0.x,
    d: p1.y - p0.y + g * p1.y,
    e: p3.y - p0.y + h * p3.y,
    f: p0.y,
    g,
    h,
  };
}

/** Map a unit-square point through the homography. */
export function applyHomography(m: Homography, u: number, v: number): Point {
  const w = m.g * u + m.h * v + 1;
  const iw = Math.abs(w) > EPS ? 1 / w : 0;
  return {
    x: (m.a * u + m.b * v + m.c) * iw,
    y: (m.d * u + m.e * v + m.f) * iw,
  };
}

/** Homogeneous weight (`clip.w`) for each corner of `quad`, in the same
 *  clockwise-from-TL order, so a rasterizer interpolating with these as the
 *  vertex `w` reproduces the projective map exactly. Returns all-ones (plain
 *  bilinear across two triangles) when the quad is not convex in the right
 *  orientation sense — some weight would be ≤ 0 and the GPU would clip it. */
export function quadWeights(quad: Quad): [number, number, number, number] {
  const { g, h } = squareToQuad(quad);
  const w: [number, number, number, number] = [1, 1 + g, 1 + g + h, 1 + h];
  for (const x of w) {
    if (!(x > EPS) || !Number.isFinite(x)) return [1, 1, 1, 1];
  }
  return w;
}

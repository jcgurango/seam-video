// Projection + viewport math for the DIY map rasterizer.
//
// Everything is reduced to "world pixels at the camera zoom" using the
// MapLibre/512-tile web-mercator convention, so seam `zoom` values mean the
// same thing here as in the old OpenLayers path. A tile's features live in
// tile-local [0..extent]; MapView maps them — and any lon/lat — to screen
// pixels (top-left origin). Paths and embedded-object anchors project through
// the same MapView, so overlays line up with the basemap by construction.

export const TILE_SIZE = 512;

/** lon/lat → world pixels at `zoom` (512-tile mercator, top-left origin). */
export function lngLatToWorld(
  lng: number,
  lat: number,
  zoom: number,
): [number, number] {
  const worldSize = TILE_SIZE * Math.pow(2, zoom);
  const x = ((lng + 180) / 360) * worldSize;
  const sin = Math.sin((lat * Math.PI) / 180);
  const y = (0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI)) * worldSize;
  return [x, y];
}

export interface MapCamera {
  latitude: number;
  longitude: number;
  zoom: number;
  width: number;
  height: number;
}

export interface TileRange {
  x0: number;
  x1: number;
  y0: number;
  y1: number;
  /** Number of tiles per axis at this tile zoom (for x-wrapping/clamping). */
  count: number;
}

export class MapView {
  readonly zoom: number;
  readonly width: number;
  readonly height: number;
  /** Integer source-tile zoom (clamped to the archive's min/max). */
  readonly tileZoom: number;
  /** camera-world-px per tile-zoom-px = 2^(zoom − tileZoom). */
  private readonly scaleTC: number;
  private readonly topLeftX: number;
  private readonly topLeftY: number;

  constructor(camera: MapCamera, minZoom: number, maxZoom: number) {
    this.zoom = camera.zoom;
    this.width = camera.width;
    this.height = camera.height;
    this.tileZoom = Math.min(maxZoom, Math.max(minZoom, Math.round(camera.zoom)));
    this.scaleTC = Math.pow(2, camera.zoom - this.tileZoom);
    const [cx, cy] = lngLatToWorld(camera.longitude, camera.latitude, camera.zoom);
    this.topLeftX = cx - camera.width / 2;
    this.topLeftY = cy - camera.height / 2;
  }

  /** lon/lat → screen pixel (top-left origin). */
  project(lng: number, lat: number): [number, number] {
    const [x, y] = lngLatToWorld(lng, lat, this.zoom);
    return [x - this.topLeftX, y - this.topLeftY];
  }

  /** Tile-local extent coordinate → screen pixel. */
  tilePoint(
    tx: number,
    ty: number,
    extent: number,
    ex: number,
    ey: number,
  ): [number, number] {
    const k = (TILE_SIZE / extent) * this.scaleTC;
    return [
      (tx * TILE_SIZE) * this.scaleTC + ex * k - this.topLeftX,
      (ty * TILE_SIZE) * this.scaleTC + ey * k - this.topLeftY,
    ];
  }

  /** Integer-snapped screen rect of a whole tile (for per-tile clipping). */
  tileScreenRect(tx: number, ty: number): { x: number; y: number; w: number; h: number } {
    const x = Math.round(tx * TILE_SIZE * this.scaleTC - this.topLeftX);
    const y = Math.round(ty * TILE_SIZE * this.scaleTC - this.topLeftY);
    const r = Math.round((tx + 1) * TILE_SIZE * this.scaleTC - this.topLeftX);
    const b = Math.round((ty + 1) * TILE_SIZE * this.scaleTC - this.topLeftY);
    return { x, y, w: r - x, h: b - y };
  }

  /** Tiles covering the viewport, as tile-zoom indices. */
  tileRange(): TileRange {
    const left = this.topLeftX / this.scaleTC;
    const top = this.topLeftY / this.scaleTC;
    const right = (this.topLeftX + this.width) / this.scaleTC;
    const bottom = (this.topLeftY + this.height) / this.scaleTC;
    return {
      x0: Math.floor(left / TILE_SIZE),
      x1: Math.floor(right / TILE_SIZE),
      y0: Math.floor(top / TILE_SIZE),
      y1: Math.floor(bottom / TILE_SIZE),
      count: Math.pow(2, this.tileZoom),
    };
  }

  /** Project a polyline (lon/lat pairs) to screen, then return the point at
   *  `fraction` (0..1) of its length — distance-normalized, camera-independent
   *  (translation/scale preserve fractions). Null for degenerate input. */
  projectPathFraction(
    points: Array<[number, number]>,
    fraction: number,
  ): [number, number] | null {
    if (!Array.isArray(points) || points.length < 2) return null;
    const screen = points.map(([lng, lat]) => this.project(lng, lat));
    const frac = Math.max(0, Math.min(1, fraction));
    if (frac >= 1) return screen[screen.length - 1];
    return truncateToFraction(screen, frac).at(-1) ?? null;
  }
}

/** Polyline truncated to `fraction` (0..1) of its total length, splitting the
 *  final segment so the reveal is smooth. */
export function truncateToFraction(
  pts: Array<[number, number]>,
  fraction: number,
): Array<[number, number]> {
  let total = 0;
  for (let i = 1; i < pts.length; i++) {
    total += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
  }
  const target = total * fraction;
  if (target <= 0) return [pts[0]];
  const out: Array<[number, number]> = [pts[0]];
  let acc = 0;
  for (let i = 1; i < pts.length; i++) {
    const seg = Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
    if (acc + seg >= target) {
      const t = seg === 0 ? 0 : (target - acc) / seg;
      out.push([
        pts[i - 1][0] + (pts[i][0] - pts[i - 1][0]) * t,
        pts[i - 1][1] + (pts[i][1] - pts[i - 1][1]) * t,
      ]);
      return out;
    }
    out.push(pts[i]);
    acc += seg;
  }
  return out;
}

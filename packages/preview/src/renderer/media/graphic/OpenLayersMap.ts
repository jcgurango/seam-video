// Browser-side OpenLayers integration for graphic Map elements.
//
// This replaces the maplibre-gl path. Instead of embedding a live WebGL
// map and blitting its canvas every frame (which fought fabric's
// re-materialize-every-tick churn — pool refcounts, pre-enliven, a 16ms
// mutation flush, glyph/sprite synthesis), we run OpenLayers purely as an
// OFF-SCREEN, ON-DEMAND rasterizer:
//
//   set view → renderSync() → blit the layer canvas → composite.
//
// OL's Canvas2D renderer draws vector tiles into a plain <canvas>; we
// sample that canvas (no WebGL, no DOM-to-image). The container <div> and
// per-layer wrapper divs are OL's internal scaffolding only — hidden,
// never in the visible scene. pmtiles are read through the same
// host-registered byte-range resolver as before.
//
// Labels render via ol-mapbox-style's canvas text (not glyph PBFs): each
// symbol layer's text-font is rewritten to our bundled families
// (Liberation Sans + Noto CJK + OpenMoji, preloaded into document.fonts),
// so there's no glyph-synthesis subsystem and no font CDN fetch. POI icons
// (sprite) are not wired yet. Geometry-only (no labels) is one edit away —
// filter out symbol layers in basemapStyle.

import { PMTiles, type Source } from "pmtiles";
import { classRegistry, FabricObject, type FabricObjectProps } from "fabric";
import OLMap from "ol/Map.js";
import View from "ol/View.js";
import VectorTileLayer from "ol/layer/VectorTile.js";
import { fromLonLat } from "ol/proj.js";
import { PMTilesVectorSource } from "ol-pmtiles";
import { applyStyle } from "ol-mapbox-style";
// Bundled OSM Bright style — same JSON the renderer reads from disk. Vite
// inlines it so the editor needs no host-served style file.
import osmBrightStyle from "./osm-bright/style.json";
import { mapLabelFontStack, loadMapLabelFonts } from "../../fonts.js";

// ── pmtiles resolver (host-registered) ─────────────────────────────

/** Async resolver from a host-provided pmtiles filename (the value of
 *  `Map.source` in the seam graphic) to a byte-range-capable `Source`.
 *  Web: OPFS file handle → FileSource. Electron: file:// FetchSource.
 *  Returns null when the source isn't resolvable (file missing, etc.). */
export type PmtilesResolver = (filename: string) => Promise<Source | null>;

let pmtilesResolver: PmtilesResolver | null = null;

/** Host registration. Each shell's main.tsx calls this at boot with the
 *  active platform's pmtiles opener. */
export function setPmtilesResolver(fn: PmtilesResolver | null): void {
  pmtilesResolver = fn;
}

const DEFAULT_LINE_WIDTH = 4;
const BACKGROUND_COLOR = "#f8f4f0"; // OSM Bright background layer fill.
// Bump label text up from the OSM Bright defaults — they read small at our
// graphic sizes. Scales numeric sizes, legacy {stops} functions, and the
// implicit 16px default alike.
const TEXT_SIZE_SCALE = 1.3;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function scaleTextSize(size: any): any {
  if (size == null) return 16 * TEXT_SIZE_SCALE;
  if (typeof size === "number") return size * TEXT_SIZE_SCALE;
  // Legacy mapbox "function" form: { base?, stops: [[zoom, size], …] }.
  if (Array.isArray(size.stops)) {
    return {
      ...size,
      stops: size.stops.map((s: [number, number]) => [
        s[0],
        s[1] * TEXT_SIZE_SCALE,
      ]),
    };
  }
  return size;
}

// Web-mercator resolution (m/px at the equator) for a MapLibre/512-tile
// zoom level. MapLibre GL — which the seam `zoom` values were authored
// against — uses 512px tiles, so zoom z ⇒ 78271.517 / 2^z. (OL's own XYZ
// default is 256-based, i.e. half the resolution at the same zoom number,
// so we set the view resolution explicitly rather than view.setZoom.)
const RES_ZOOM_0 = 78271.51696402048;
function zoomToResolution(zoom: number): number {
  return RES_ZOOM_0 / Math.pow(2, zoom);
}

export interface MapPath {
  color: string;
  points: number[][];
  progress?: number;
  lineWidth?: number;
}

export interface MapOptions extends Partial<FabricObjectProps> {
  source?: string;
  latitude?: number;
  longitude?: number;
  zoom?: number;
  paths?: MapPath[];
}

/** Where an overlay's (0,0) anchors on the map. `geo` projects a coordinate;
 *  `path` projects the point at `position` (0..1) along a polyline. */
export type MapAnchor =
  | { kind: "geo"; longitude: number; latitude: number }
  | { kind: "path"; points: number[][]; position: number };

/** A live fabric object drawn over the map at a projected anchor. The host
 *  (GraphicStore) materializes `live` — so Clips/Groups go through the normal
 *  graphic pipeline with clip context — and hands it here with its anchor;
 *  this object owns only the projection + draw. The object's own left/top is
 *  the offset from the anchor pixel. */
export interface MapOverlay {
  live: FabricObject;
  anchor: MapAnchor;
}

/** Deep-clone the bundled style and prepare it for OL:
 *   - rewrite each symbol layer's `text-font` to our bundled families via
 *     mapLabelFontStack (Liberation Sans for Latin + Noto CJK + OpenMoji),
 *     all preloaded into document.fonts by loadMapLabelFonts — so
 *     ol-mapbox-style finds them already loaded and never reaches for its
 *     Fontsource CDN fallback;
 *   - drop `glyphs` (canvas fonts render labels, no glyph PBFs) and
 *     `sprite` (no POI icons yet — text labels still render). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function basemapStyle(): any {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const style = JSON.parse(JSON.stringify(osmBrightStyle)) as any;
  for (const layer of style.layers) {
    if (layer.type !== "symbol") continue;
    const layout = layer.layout;
    const textFont = layout?.["text-font"];
    if (textFont) layout["text-font"] = mapLabelFontStack(textFont);
    if (layout) layout["text-size"] = scaleTextSize(layout["text-size"]);
  }
  delete style.glyphs;
  delete style.sprite;
  return style;
}

// ── Pool ────────────────────────────────────────────────────────────
// One OL rasterizer per (path-id, source). Keeps the style + tile cache
// warm across an animation's frames instead of rebuilding per tick.

type SharedOLMap = {
  map: OLMap | null;
  layer: VectorTileLayer | null;
  container: HTMLDivElement;
  ready: boolean;
  refCount: number;
  source: string;
  pendingReady: Array<() => void>;
  onRender: Set<() => void>;
};

const pool = new Map<string, SharedOLMap>();

function poolKey(path: string, source: string): string {
  return `${path}|${source}`;
}

function acquireShared(
  path: string,
  source: string,
  width: number,
  height: number,
  initialCamera: { latitude: number; longitude: number; zoom: number },
): SharedOLMap {
  const key = poolKey(path, source);
  const existing = pool.get(key);
  if (existing) {
    existing.refCount++;
    return existing;
  }

  // Off-screen, hidden scaffolding for OL. visibility:hidden (not
  // display:none) so the element keeps layout box metrics OL reads.
  const container = document.createElement("div");
  container.style.cssText = `
    position: fixed;
    left: 0;
    top: 0;
    width: ${width}px;
    height: ${height}px;
    pointer-events: none;
    visibility: hidden;
    z-index: -1;
  `;
  document.body.appendChild(container);

  const entry: SharedOLMap = {
    map: null,
    layer: null,
    container,
    ready: false,
    refCount: 1,
    source,
    pendingReady: [],
    onRender: new Set(),
  };
  pool.set(key, entry);

  (async () => {
    if (!pmtilesResolver) {
      console.error(
        "[Map] no pmtilesResolver registered — call setPmtilesResolver()",
      );
      return;
    }
    const pmSource = await pmtilesResolver(source);
    if (!pmSource) {
      console.error(`[Map] pmtiles source unresolved: ${source}`);
      return;
    }
    if (!pool.has(key)) return;

    // Header read up front: only MVT (vector) is wired here. Raster
    // pmtiles would need a separate Canvas2D tile layer — a follow-up.
    let header;
    try {
      header = await new PMTiles(pmSource).getHeader();
    } catch (err) {
      console.error("[Map] pmtiles header read failed:", err);
      return;
    }
    if (!pool.has(key)) return;
    // TileType.Mvt === 1 (avoid importing the enum just for this).
    if (header.tileType !== 1) {
      console.error(
        "[Map] only vector (MVT) pmtiles are supported for now; got tileType",
        header.tileType,
      );
      return;
    }

    const layer = new VectorTileLayer({
      source: new PMTilesVectorSource({ url: pmSource }),
      declutter: true,
    });
    const map = new OLMap({
      target: container,
      layers: [layer],
      view: new View({
        center: fromLonLat([initialCamera.longitude, initialCamera.latitude]),
        resolution: zoomToResolution(initialCamera.zoom),
        constrainResolution: false,
      }),
      controls: [],
      interactions: [],
      pixelRatio: 1,
    });
    entry.map = map;
    entry.layer = layer;

    // Tiles load async (pmtiles getZxy is a Promise); rendercomplete fires
    // once the currently-loadable tiles are drawn. Wake the host so its
    // throttled draw loop re-blits the now-fuller canvas.
    map.on("rendercomplete", () => {
      for (const cb of entry.onRender) cb();
    });

    // Labels render via canvas fonts, so the bundled families must be in
    // document.fonts before ol-mapbox-style resolves text-font (otherwise
    // it falls back to fetching from the Fontsource CDN). Mains warm this
    // at boot; await here so it's settled before applyStyle.
    await loadMapLabelFonts();
    if (!pool.has(key)) return;

    // updateSource:false — keep our pmtiles-backed source; only paint the
    // GL layers onto it. Otherwise ol-mapbox-style tries to resolve the
    // style's remote tilejson URL.
    try {
      await applyStyle(layer, basemapStyle(), "openmaptiles", {
        updateSource: false,
      });
    } catch (err) {
      console.error("[Map] applyStyle failed:", err);
      return;
    }
    if (!pool.has(key)) return;

    entry.ready = true;
    for (const cb of entry.pendingReady) cb();
    entry.pendingReady = [];
    for (const cb of entry.onRender) cb();
  })();

  return entry;
}

function releaseShared(path: string, source: string): void {
  const key = poolKey(path, source);
  const entry = pool.get(key);
  if (!entry) return;
  entry.refCount--;
  if (entry.refCount <= 0) {
    if (entry.map) {
      try {
        entry.map.setTarget(undefined);
      } catch {
        // ignore
      }
    }
    if (entry.container.parentNode) {
      entry.container.parentNode.removeChild(entry.container);
    }
    pool.delete(key);
  }
}

// ── FabricObject subclass ──────────────────────────────────────────

export class OpenLayersMap extends FabricObject {
  static type = "Map";

  source = "";
  latitude = 0;
  longitude = 0;
  zoom = 1;
  paths: MapPath[] = [];

  /** Overlays drawn over the map at projected anchors. Set each tick by the
   *  host (GraphicStore) — not a serialized fabric prop, since `live` is a
   *  materialized fabric object. */
  private _overlays: MapOverlay[] = [];

  private _path = "";
  private _shared: SharedOLMap | null = null;
  private _ready = false;
  private _renderListener: (() => void) | null = null;
  isPreEnliven = false;

  constructor(options: MapOptions = {}) {
    const {
      type: _ignoredType,
      source,
      latitude,
      longitude,
      zoom,
      paths,
      ...rest
    } = options as MapOptions & { type?: string };
    super(rest as Partial<FabricObjectProps>);

    if (typeof source === "string") this.source = source;
    if (typeof latitude === "number") this.latitude = latitude;
    if (typeof longitude === "number") this.longitude = longitude;
    if (typeof zoom === "number") this.zoom = zoom;
    if (Array.isArray(paths)) this.paths = paths as MapPath[];
    if (typeof rest.width !== "number") this.width = 400;
    if (typeof rest.height !== "number") this.height = 400;
    this.objectCaching = false;

    this.on("removed", () => {
      if (!this.isPreEnliven) this.dispose();
    });
  }

  attachToPath(path: string): void {
    if (this._shared) return;
    if (!this.source || !path) return;

    this._path = path;
    this._shared = acquireShared(path, this.source, this.width, this.height, {
      latitude: this.latitude,
      longitude: this.longitude,
      zoom: this.zoom,
    });

    if (this._shared.ready) {
      this._ready = true;
    } else {
      this._shared.pendingReady.push(() => {
        this._ready = true;
      });
    }
  }

  /** External hook for when the OL map repaints (a tile arriving, the
   *  style applying). GraphicStore uses this to wake its rAF loop so the
   *  next throttled draw re-blits the fuller canvas. Returns an
   *  unsubscriber. */
  addRenderListener(fn: () => void): () => void {
    if (!this._shared) {
      console.warn(
        "[OpenLayersMap] addRenderListener before attachToPath — no-op",
      );
      return () => {};
    }
    const shared = this._shared;
    shared.onRender.add(fn);
    return () => shared.onRender.delete(fn);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  set(key: any, value?: any): this {
    const ret = super.set(key, value);
    const keys =
      typeof key === "object" && key !== null
        ? Object.keys(key as Record<string, unknown>)
        : [key as string];
    this._applyToView(keys);
    return ret;
  }

  /** Push prop changes into the OL view/container. Unlike the maplibre
   *  path there's no flush buffer — GraphicStore already throttles set()
   *  to ≤60 Hz, and the actual render happens lazily in _render. */
  private _applyToView(keys: string[]): void {
    const map = this._shared?.map;
    if (!map) return;
    let camera = false;
    let size = false;
    for (const k of keys) {
      if (k === "latitude" || k === "longitude" || k === "zoom") camera = true;
      else if (k === "width" || k === "height") size = true;
    }
    if (camera) {
      const view = map.getView();
      view.setCenter(fromLonLat([this.longitude, this.latitude]));
      view.setResolution(zoomToResolution(this.zoom));
    }
    if (size) {
      this._shared!.container.style.width = `${this.width}px`;
      this._shared!.container.style.height = `${this.height}px`;
      map.updateSize();
    }
  }

  _render(ctx: CanvasRenderingContext2D): void {
    const w = this.width;
    const h = this.height;
    const map = this._shared?.map;
    if (!map || !this._ready) {
      ctx.fillStyle = "#2a2a2a";
      ctx.fillRect(-w / 2, -h / 2, w, h);
      ctx.fillStyle = "#666";
      ctx.font = "16px monospace";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText("loading map…", 0, 0);
      return;
    }

    // Synchronously render whatever tiles are currently loaded into the
    // layer canvas, then blit. Tiles still loading wake us via
    // rendercomplete → the next draw fills them in.
    map.renderSync();

    // OSM Bright's background layer (a full-extent cream fill) isn't part
    // of the vector layer's style function, so the layer canvas is
    // transparent over un-filled land — flatten onto the cream base.
    ctx.fillStyle = BACKGROUND_COLOR;
    ctx.fillRect(-w / 2, -h / 2, w, h);

    // Blit every canvas OL rendered for this map (one per layer; just the
    // vector layer today). Container is sized w×h at pixelRatio 1, so the
    // canvas maps 1:1 into the object's rect.
    const canvases = this._shared!.container.querySelectorAll("canvas");
    for (const canvas of canvases) {
      if (canvas.width === 0 || canvas.height === 0) continue;
      ctx.drawImage(canvas, -w / 2, -h / 2, w, h);
    }

    this._drawPaths(ctx, map, w, h);
    this._drawOverlays(ctx, map, w, h);
  }

  /** Replace the overlay objects drawn over the map. Called by the host each
   *  tick after materializing the embedded objects (so Clips get their
   *  context). Anchors are projected lazily in `_render` against the current
   *  view, so a panning camera moves the overlays for free. */
  setOverlayObjects(overlays: MapOverlay[]): void {
    this._overlays = overlays;
  }

  /** Project an anchor to a viewport pixel (top-left origin) against the
   *  current view. Returns null when the point isn't projectable. */
  private _projectAnchor(map: OLMap, anchor: MapAnchor): [number, number] | null {
    let coord: number[] | undefined;
    if (anchor.kind === "geo") {
      coord = fromLonLat([anchor.longitude, anchor.latitude]);
    } else {
      if (!Array.isArray(anchor.points) || anchor.points.length < 2) return null;
      const coords = anchor.points.map(([lon, lat]) => fromLonLat([lon, lat]));
      const frac = Math.max(0, Math.min(1, anchor.position));
      // Truncate in projected (web-mercator) space so the fraction is
      // distance-normalized and camera-independent — same convention as the
      // path reveal. The truncation's last point is the point at `frac`.
      coord =
        frac >= 1
          ? coords[coords.length - 1]
          : truncateToFraction(
              coords as Array<[number, number]>,
              frac,
            ).at(-1);
    }
    if (!coord) return null;
    const px = map.getPixelFromCoordinate(coord);
    return px ? [px[0], px[1]] : null;
  }

  /** Draw each overlay at its projected anchor. The object's own transform
   *  (left/top/origin/scale/angle) offsets it from the anchor — so we just
   *  translate the context to the anchor (in fabric's center-origin local
   *  space) and let the object render itself. */
  private _drawOverlays(
    ctx: CanvasRenderingContext2D,
    map: OLMap,
    w: number,
    h: number,
  ): void {
    if (!this._overlays.length) return;
    for (const ov of this._overlays) {
      const px = this._projectAnchor(map, ov.anchor);
      if (!px) continue;
      ctx.save();
      ctx.translate(px[0] - w / 2, px[1] - h / 2);
      ov.live.render(ctx);
      ctx.restore();
    }
  }

  /** Draw path overlays directly in 2D, projecting each lon/lat through
   *  the OL view. Keeps a single base canvas (no extra OL layer) and gives
   *  us full control over the progress reveal + width. */
  private _drawPaths(
    ctx: CanvasRenderingContext2D,
    map: OLMap,
    w: number,
    h: number,
  ): void {
    if (!this.paths.length) return;
    ctx.save();
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    for (const p of this.paths) {
      if (!Array.isArray(p.points) || p.points.length < 2) continue;

      // Truncate in projected (web-mercator) space so the progress reveal is
      // normalized by true map distance and stays camera-independent —
      // matching maplibre's line-progress. (Truncating in pixel space would
      // drift with zoom and skew along a path that spans latitudes.)
      const coords = p.points.map(([lon, lat]) => fromLonLat([lon, lat]));
      const progress =
        typeof p.progress === "number"
          ? Math.max(0, Math.min(1, p.progress))
          : 1;
      const revealed =
        progress >= 1 ? coords : truncateToFraction(coords, progress);

      // Now project the (possibly truncated) line to viewport pixels:
      // top-left origin → fabric center origin.
      const pts: Array<[number, number]> = [];
      for (const c of revealed) {
        const px = map.getPixelFromCoordinate(c);
        if (px) pts.push([px[0] - w / 2, px[1] - h / 2]);
      }
      if (pts.length < 2) continue;

      ctx.beginPath();
      ctx.moveTo(pts[0][0], pts[0][1]);
      for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
      ctx.strokeStyle = p.color;
      ctx.lineWidth =
        typeof p.lineWidth === "number" ? p.lineWidth : DEFAULT_LINE_WIDTH;
      ctx.stroke();
    }
    ctx.restore();
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  static async fromObject(obj: any): Promise<OpenLayersMap> {
    return new OpenLayersMap(obj);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  toObject(propertiesToInclude: any = []): any {
    const extra = [
      ...(propertiesToInclude as string[]),
      "source",
      "latitude",
      "longitude",
      "zoom",
      "paths",
    ];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (super.toObject as any).call(this, extra) as Record<string, unknown>;
  }

  dispose(): void {
    if (this._shared && this._renderListener) {
      this._shared.onRender.delete(this._renderListener);
    }
    if (this._shared && this._path) {
      releaseShared(this._path, this.source);
    }
    this._shared = null;
    this._renderListener = null;
    this._path = "";
    this._ready = false;
  }
}

/** Return the polyline truncated to `fraction` (0..1) of its total length,
 *  splitting the final segment so the reveal is smooth. */
function truncateToFraction(
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
    const seg = Math.hypot(
      pts[i][0] - pts[i - 1][0],
      pts[i][1] - pts[i - 1][1],
    );
    if (acc + seg >= target) {
      const t = (target - acc) / seg;
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

classRegistry.setClass(OpenLayersMap, "Map");

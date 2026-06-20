// Browser-side Map element for graphic nodes — a STATELESS fabric object over
// the shared @seam/map rasterizer (the same code the headless renderer runs).
// No OpenLayers, no WebGL.
//
// Mental model: like an Image, the element only ever renders what's already in
// memory. All state lives in a pooled TileSource (decoded MVT tiles, never
// rasters) owned by Seam here. The fabric object is throwaway — rebuilt every
// frame like Group/Clip — and just does a synchronous draw in _render from
// whatever tiles are loaded now, requesting any missing ones. Tile loads bubble
// up through the pool to wake the host's redraw loop (subscribeMapWake), the
// same way an Image's load event does.
//
// Registered into fabric's classRegistry as "Map".

import { type Source } from "pmtiles";
import { classRegistry, FabricObject, type FabricObjectProps } from "fabric";
import {
  TileSource,
  TileSourcePool,
  MapView,
  drawBasemap,
  drawPaths,
  applyTheme,
  type MapPathInput,
  type MapTheme,
} from "@seam/map";
// Bundled OSM Bright style — same JSON the renderer reads from disk. Vite
// inlines it. @seam/map reads text-font/paint directly and never fetches the
// style's glyphs/sprite/source URLs, so we pass it through as-is.
import osmBrightStyle from "./osm-bright/style.json";

// Themed styles, derived from the base once per theme (light = base verbatim).
const themedStyles = new Map<MapTheme, unknown>();
function styleFor(theme: MapTheme): unknown {
  let s = themedStyles.get(theme);
  if (!s) {
    s = applyTheme(osmBrightStyle, theme);
    themedStyles.set(theme, s);
  }
  return s;
}

// ── Seam-owned TileSource pool ──────────────────────────────────────

/** Async resolver from a `Map.source` filename to a byte-range `Source`.
 *  Web: OPFS FileSource. Electron: file:// FetchSource. Null when missing. */
export type PmtilesResolver = (filename: string) => Promise<Source | null>;

let resolver: PmtilesResolver | null = null;

/** Host registration (each shell's main.tsx, at boot). */
export function setPmtilesResolver(fn: PmtilesResolver | null): void {
  resolver = fn;
}

// Stable pool (resolver is swapped in at boot, before any map renders).
const pool = new TileSourcePool((filename) =>
  resolver ? resolver(filename) : Promise.resolve(null),
);

const wakeListeners = new Set<() => void>();
pool.onChange(() => {
  for (const cb of wakeListeners) cb();
});

/** Subscribe to "a map tile (or header) finished loading anywhere" — the
 *  bubble-up that drives a redraw. The host (GraphicStore) calls this once.
 *  Returns an unsubscriber. */
export function subscribeMapWake(cb: () => void): () => void {
  wakeListeners.add(cb);
  return () => wakeListeners.delete(cb);
}

export interface MapPath extends MapPathInput {}

export interface MapOptions extends Partial<FabricObjectProps> {
  source?: string;
  latitude?: number;
  longitude?: number;
  zoom?: number;
  /** Basemap-only opacity (0..1); excludes paths/overlays. */
  mapOpacity?: number;
  theme?: MapTheme;
  paths?: MapPath[];
  /** Embedded objects (anchor-wrapped specs). Opaque to TileMap — the host
   *  reads them from the snapshot to build overlays; we only carry them so
   *  serialization round-trips don't drop them. */
  objects?: unknown[];
}

/** Where an overlay's (0,0) anchors on the map. `geo` projects a coordinate;
 *  `path` projects the point at `position` (0..1) along a polyline. */
export type MapAnchor =
  | { kind: "geo"; longitude: number; latitude: number }
  | { kind: "path"; points: number[][]; position: number };

/** A live fabric object drawn over the map at a projected anchor. The host
 *  materializes `live` (so Clips/Groups get their context) and hands it here;
 *  this object owns only the projection + draw. */
export interface MapOverlay {
  live: FabricObject;
  anchor: MapAnchor;
}

// ── FabricObject subclass ──────────────────────────────────────────

export class TileMap extends FabricObject {
  static type = "Map";

  source = "";
  latitude = 0;
  longitude = 0;
  zoom = 1;
  mapOpacity = 1;
  theme: MapTheme = "light";
  paths: MapPath[] = [];
  /** Embedded objects, carried verbatim so serialization round-trips (the
   *  frame editor, Group rebuilds) don't drop them. Not rendered from here —
   *  the host reads them off the snapshot and pushes overlays via
   *  setOverlayObjects. Held off the `objects` key fabric's Group reserves. */
  embeddedObjects: unknown[] = [];

  private _overlays: MapOverlay[] = [];
  private _tiles: TileSource | null = null;

  constructor(options: MapOptions = {}) {
    const {
      type: _ignoredType,
      source,
      latitude,
      longitude,
      zoom,
      mapOpacity,
      theme,
      paths,
      objects,
      ...rest
    } = options as MapOptions & { type?: string };
    super(rest as Partial<FabricObjectProps>);

    if (typeof source === "string") this.source = source;
    if (typeof latitude === "number") this.latitude = latitude;
    if (typeof longitude === "number") this.longitude = longitude;
    if (typeof zoom === "number") this.zoom = zoom;
    if (typeof mapOpacity === "number") this.mapOpacity = mapOpacity;
    if (theme === "dark" || theme === "light") this.theme = theme;
    if (Array.isArray(paths)) this.paths = paths as MapPath[];
    if (Array.isArray(objects)) this.embeddedObjects = objects;
    if (typeof rest.width !== "number") this.width = 400;
    if (typeof rest.height !== "number") this.height = 400;
    this.objectCaching = false;
  }

  /** Overlay objects drawn over the map (host sets each tick). */
  setOverlayObjects(overlays: MapOverlay[]): void {
    this._overlays = overlays;
  }

  private tiles(): TileSource | null {
    if (!this._tiles && this.source) this._tiles = pool.acquire(this.source);
    return this._tiles;
  }

  _render(ctx: CanvasRenderingContext2D): void {
    const w = this.width;
    const h = this.height;
    const tiles = this.tiles();
    const header = tiles?.headerNow() ?? null;

    // Not ready (no source, header still loading, or non-vector archive):
    // draw a placeholder. Header loads bubble up via the pool → redraw.
    if (!tiles || !header || header.tileType !== 1) {
      ctx.fillStyle = "#2a2a2a";
      ctx.fillRect(-w / 2, -h / 2, w, h);
      ctx.fillStyle = "#666";
      ctx.font = "16px sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText("loading map…", 0, 0);
      return;
    }

    const view = new MapView(
      {
        latitude: this.latitude,
        longitude: this.longitude,
        zoom: this.zoom,
        width: w,
        height: h,
      },
      header.minZoom,
      header.maxZoom,
      header,
    );

    // Shift to top-left origin so @seam/map's screen coords line up.
    ctx.save();
    ctx.translate(-w / 2, -h / 2);
    // mapOpacity dims the basemap only. drawBasemap hardcodes per-feature
    // globalAlpha, so we can't just lower the ctx alpha around it — rasterize
    // the basemap onto its own layer canvas and composite that whole layer at
    // mapOpacity (folded with the object's own opacity already on ctx). Paths
    // and overlays draw at full alpha afterward.
    const baseAlpha = ctx.globalAlpha;
    if (this.mapOpacity < 1) {
      const lw = Math.max(1, Math.ceil(w));
      const lh = Math.max(1, Math.ceil(h));
      const layer = document.createElement("canvas");
      layer.width = lw;
      layer.height = lh;
      const lctx = layer.getContext("2d")!;
      drawBasemap(lctx, view, styleFor(this.theme), tiles); // requests missing tiles → bubble up
      ctx.globalAlpha = baseAlpha * this.mapOpacity;
      ctx.drawImage(layer, 0, 0);
      ctx.globalAlpha = baseAlpha;
    } else {
      drawBasemap(ctx, view, styleFor(this.theme), tiles); // requests missing tiles → bubble up
    }
    drawPaths(ctx, view, this.paths);
    this._drawOverlays(ctx, view);
    ctx.restore();
  }

  private _projectAnchor(view: MapView, anchor: MapAnchor): [number, number] | null {
    if (anchor.kind === "geo") {
      return view.project(anchor.longitude, anchor.latitude);
    }
    return view.projectPathFraction(
      anchor.points as Array<[number, number]>,
      anchor.position,
    );
  }

  private _drawOverlays(ctx: CanvasRenderingContext2D, view: MapView): void {
    if (!this._overlays.length) return;
    for (const ov of this._overlays) {
      const px = this._projectAnchor(view, ov.anchor);
      if (!px) continue;
      ctx.save();
      ctx.translate(px[0], px[1]);
      ov.live.render(ctx);
      ctx.restore();
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  static async fromObject(obj: any): Promise<TileMap> {
    return new TileMap(obj);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  toObject(propertiesToInclude: any = []): any {
    const extra = [
      ...(propertiesToInclude as string[]),
      "source",
      "latitude",
      "longitude",
      "zoom",
      "mapOpacity",
      "theme",
      "paths",
    ];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const obj = (super.toObject as any).call(this, extra) as Record<string, unknown>;
    // Re-emit embedded objects under their authored `objects` key (held off
    // the instance's `objects` to avoid fabric's Group reservation), so the
    // map round-trips through the editor / Group rebuilds without losing them.
    if (this.embeddedObjects.length) obj.objects = this.embeddedObjects;
    return obj;
  }
}

classRegistry.setClass(TileMap, "Map");

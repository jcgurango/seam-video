// Browser-side maplibre-gl integration for graphic Map elements.
// Ported from motion-editor-test/src/maplibre-map.ts — same FabricObject
// subclass + path-id-keyed pool architecture, but the pmtiles source
// resolution is async and goes through a host-registered resolver so
// the web platform can hand back an OPFS-backed FileSource (byte-range
// reads only — multi-GB pmtiles files don't land in memory).
//
// The class is registered into fabric's classRegistry at import time so
// `enlivenObjects({ type: "Map", ... })` produces a MapLibreMap, not
// the placeholder we used in phase 1.

import maplibregl from "maplibre-gl";
import { PMTiles, Protocol, TileType, type Source } from "pmtiles";
import {
  classRegistry,
  FabricObject,
  type FabricObjectProps,
} from "fabric";
// Bundled OSM Bright style — same JSON the renderer side reads from
// filesystem candidates. Importing the JSON directly lets vite inline
// it into the bundle so the editor doesn't depend on the host serving
// /osm-bright-gl-style/style.json.
import osmBrightStyle from "./osm-bright/style.json";

// One protocol per page — maplibre's `addProtocol` is global state.
const protocol = new Protocol();
maplibregl.addProtocol("pmtiles", protocol.tile);

/** Async resolver from a host-provided pmtiles filename (the value of
 *  `Map.source` in the seam graphic) to a byte-range-capable `Source`.
 *  Web: OPFS file handle → FileSource. Electron: future fs-backed source.
 *  Returns null when the source isn't resolvable (file missing, etc.). */
export type PmtilesResolver = (
  filename: string,
) => Promise<Source | null>;

let pmtilesResolver: PmtilesResolver | null = null;

/** Host registration. The editor's App.tsx calls this at boot with the
 *  active platform's pmtiles opener. */
export function setPmtilesResolver(fn: PmtilesResolver | null): void {
  pmtilesResolver = fn;
}

const RASTER_TYPES = new Set<TileType>([
  TileType.Png,
  TileType.Jpeg,
  TileType.Webp,
  TileType.Avif,
]);

const GLYPHS_URL =
  "https://demotiles.maplibre.org/font/{fontstack}/{range}.pbf";

const DEFAULT_LINE_WIDTH = 4;

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

// ── Style dispatch ────────────────────────────────────────────────

// Deep-clone the bundled style so per-Map source/glyph overrides don't
// mutate the shared module-level reference.
function loadOsmBrightTemplate(): maplibregl.StyleSpecification {
  return JSON.parse(
    JSON.stringify(osmBrightStyle),
  ) as maplibregl.StyleSpecification;
}

async function buildStyleForPMTiles(
  pmKey: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  header: any,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  metadata: any,
): Promise<maplibregl.StyleSpecification | null> {
  if (RASTER_TYPES.has(header.tileType)) {
    return {
      version: 8,
      sources: {
        "pmtiles-source": {
          type: "raster",
          url: `pmtiles://${pmKey}`,
          tileSize: 256,
        },
      },
      layers: [
        {
          id: "pmtiles-layer",
          type: "raster",
          source: "pmtiles-source",
        },
      ],
    };
  }
  if (header.tileType === TileType.Mvt) {
    const template = loadOsmBrightTemplate();
    template.sources = {
      openmaptiles: {
        type: "vector",
        url: `pmtiles://${pmKey}`,
      },
    };
    // Override the upstream maptiler glyphs URL (which requires an
    // API key) with maplibre's public demo endpoint. Same swap the
    // renderer does server-side.
    template.glyphs = GLYPHS_URL;
    return template;
  }
  return null;
}

function buildAutoVectorStyle(
  pmKey: string,
  metadata: unknown,
): maplibregl.StyleSpecification {
  const layers: maplibregl.LayerSpecification[] = [
    {
      id: "pmtiles-bg",
      type: "background",
      paint: { "background-color": "#1a1a1a" },
    },
  ];
  const vectorLayers = (metadata as { vector_layers?: Array<{ id: string }> })
    ?.vector_layers;
  if (Array.isArray(vectorLayers) && vectorLayers.length > 0) {
    const palette = ["#7fb069", "#5b8c5a", "#dec25b", "#d99873", "#85bcd6"];
    vectorLayers.forEach((vl, i) => {
      const color = palette[i % palette.length];
      layers.push(
        {
          id: `pm-${vl.id}-fill`,
          type: "fill",
          source: "pmtiles-source",
          "source-layer": vl.id,
          paint: { "fill-color": color, "fill-opacity": 0.5 },
          filter: ["==", ["geometry-type"], "Polygon"],
        },
        {
          id: `pm-${vl.id}-line`,
          type: "line",
          source: "pmtiles-source",
          "source-layer": vl.id,
          paint: { "line-color": color, "line-width": 1 },
          filter: ["==", ["geometry-type"], "LineString"],
        },
      );
    });
  }
  return {
    version: 8,
    sources: {
      "pmtiles-source": {
        type: "vector",
        url: `pmtiles://${pmKey}`,
      },
    },
    layers,
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function pathGradient(p: MapPath): any {
  const raw = typeof p.progress === "number" ? p.progress : 1;
  const progress = Math.max(0, Math.min(1, raw));
  return ["step", ["line-progress"], p.color, progress, "rgba(0,0,0,0)"];
}

// ── Pool ──────────────────────────────────────────────────────────

/** Pending mutations buffered between flush ticks. Animation can write
 *  here at any rate; the 16ms interval drains the *latest* value for
 *  each field exactly once. Last write wins — no event queue. */
type PendingUpdate = {
  center?: [number, number];
  zoom?: number;
  size?: { width: number; height: number };
  /** Paths layer ownership snapshot. The instance pointer is the
   *  current owner; reading `paths` off it at flush time picks up any
   *  further mutation that arrived after this entry was set. */
  pathsOwner?: MapLibreMap;
};

type SharedMaplibre = {
  map: maplibregl.Map | null;
  container: HTMLDivElement;
  ready: boolean;
  refCount: number;
  source: string;
  pendingReady: Array<() => void>;
  onRender: Set<() => void>;
  pathOwner: unknown;
  pathSignatures: string[];
  /** Pending mutations applied by the 16ms interval. Null when no
   *  updates have arrived since the last flush. */
  pending: PendingUpdate | null;
  /** Interval id created in acquireShared, cleared on dispose. */
  flushTimer: ReturnType<typeof setInterval> | null;
};

const FLUSH_INTERVAL_MS = 16;

const pool = new Map<string, SharedMaplibre>();

function poolKey(path: string, source: string): string {
  return `${path}|${source}`;
}

function acquireShared(
  path: string,
  source: string,
  width: number,
  height: number,
  initialCamera: { latitude: number; longitude: number; zoom: number },
): SharedMaplibre {
  const key = poolKey(path, source);
  const existing = pool.get(key);
  if (existing) {
    existing.refCount++;
    return existing;
  }

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

  const entry: SharedMaplibre = {
    map: null,
    container,
    ready: false,
    refCount: 1,
    source,
    pendingReady: [],
    onRender: new Set(),
    pathOwner: null,
    pathSignatures: [],
    pending: null,
    flushTimer: null,
  };
  pool.set(key, entry);
  entry.flushTimer = setInterval(() => flushPending(entry), FLUSH_INTERVAL_MS);

  (async () => {
    if (!pmtilesResolver) {
      console.warn("[Map] no pmtilesResolver registered — call setPmtilesResolver()");
      return;
    }
    const pmSource = await pmtilesResolver(source);
    if (!pmSource) {
      console.warn(`[Map] pmtiles source unresolved: ${source}`);
      return;
    }
    if (!pool.has(key)) return;

    const pm = new PMTiles(pmSource);
    protocol.add(pm);
    let header;
    let metadata;
    try {
      header = await pm.getHeader();
      metadata = await pm.getMetadata();
    } catch (err) {
      console.error("[Map pool] header read failed:", err);
      return;
    }
    if (!pool.has(key)) return;
    const style = await buildStyleForPMTiles(pmSource.getKey(), header, metadata);
    if (!pool.has(key)) return;
    if (!style) {
      console.error(
        "[Map pool] unsupported pmtiles tileType:",
        header.tileType,
        TileType[header.tileType],
      );
      return;
    }

    const map = new maplibregl.Map({
      container,
      style,
      center: [initialCamera.longitude, initialCamera.latitude],
      zoom: initialCamera.zoom,
      interactive: false,
      attributionControl: false,
      canvasContextAttributes: { preserveDrawingBuffer: true },
    });
    entry.map = map;

    const markReady = () => {
      if (entry.ready) return;
      entry.ready = true;
      for (const cb of entry.pendingReady) cb();
      entry.pendingReady = [];
    };
    map.on("styledata", markReady);
    map.on("load", markReady);
    map.on("render", () => {
      for (const cb of entry.onRender) cb();
    });
    map.on("error", (e) => {
      console.warn(
        "[Map pool] maplibre error:",
        e?.error?.message ?? "(no message)",
      );
    });
  })();

  return entry;
}

function releaseShared(path: string, source: string): void {
  const key = poolKey(path, source);
  const entry = pool.get(key);
  if (!entry) return;
  entry.refCount--;
  if (entry.refCount <= 0) {
    if (entry.flushTimer != null) {
      clearInterval(entry.flushTimer);
      entry.flushTimer = null;
    }
    if (entry.map) {
      try {
        entry.map.remove();
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

var lastFlush = 0;

/** Apply the latest buffered mutations to the live maplibre. Runs on
 *  the 16ms interval. No-op until the map is initialised + nothing is
 *  pending. Last-write-wins per field. */
function flushPending(entry: SharedMaplibre): void {
  if (!entry.map || !entry.pending) return;
  const p = entry.pending;
  entry.pending = null;
  if (p.size) {
    entry.container.style.width = `${p.size.width}px`;
    entry.container.style.height = `${p.size.height}px`;
    try {
      entry.map.resize();
    } catch {
      // ignore — maplibre throws if mid-style change
    }
  }
  if (p.center) {
    try {
      entry.map.setCenter(p.center);
    } catch {
      // ignore
    }
  }
  if (typeof p.zoom === "number") {
    try {
      entry.map.setZoom(p.zoom);
    } catch {
      // ignore
    }
  }
  if (p.pathsOwner) {
    // Read paths off the owner at flush time so any further writes
    // since this entry was queued are also picked up.
    p.pathsOwner._applyPaths();
  }
}

// ── FabricObject subclass ──────────────────────────────────────────

export class MapLibreMap extends FabricObject {
  static type = "Map";

  source = "";
  latitude = 0;
  longitude = 0;
  zoom = 1;
  paths: MapPath[] = [];

  private _path = "";
  private _shared: SharedMaplibre | null = null;
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

    this.on("added", () => this._onAdded());
    this.on("removed", () => {
      if (!this.isPreEnliven) this.dispose();
    });
  }

  attachToPath(path: string): void {
    if (this._shared) return;
    if (!this.source || !path) return;

    this._path = path;
    this._shared = acquireShared(
      path,
      this.source,
      this.width,
      this.height,
      { latitude: this.latitude, longitude: this.longitude, zoom: this.zoom },
    );

    this._renderListener = () => this._requestRenderAll();
    this._shared.onRender.add(this._renderListener);

    if (this._shared.ready) {
      this._becomeReady();
    } else {
      this._shared.pendingReady.push(() => this._becomeReady());
    }
  }

  private _becomeReady(): void {
    this._ready = true;
    if (this.canvas && this._shared) {
      this._queuePending({ camera: true, paths: true });
    }
    this._requestRenderAll();
  }

  private _onAdded(): void {
    if (this._shared?.map) {
      this._queuePending({ camera: true, paths: true });
      this._requestRenderAll();
    }
  }

  /** Stash the latest values onto the shared pending update. The 16ms
   *  flushPending will drain it. Repeated calls between flushes
   *  overwrite — that's the throttle. */
  private _queuePending(flags: {
    camera?: boolean;
    size?: boolean;
    paths?: boolean;
  }): void {
    const shared = this._shared;
    if (!shared) return;
    const p = (shared.pending ??= {});
    if (flags.camera) {
      p.center = [this.longitude, this.latitude];
      p.zoom = this.zoom;
    }
    if (flags.size) {
      p.size = { width: this.width, height: this.height };
    }
    if (flags.paths) {
      p.pathsOwner = this;
    }
  }

  /** Called by flushPending (module-internal) on the 16ms interval —
   *  reads `this.paths` and diffs against the shared pool's installed
   *  path signatures. Not `private` so the module-level flusher can
   *  reach it; treat as internal. */
  _applyPaths(): void {
    const shared = this._shared;
    const map = shared?.map;
    if (!map || !shared) return;

    const newSigs = this.paths.map((p) => JSON.stringify(p.points));
    const sameOwner = shared.pathOwner === this;
    const sameStructure =
      sameOwner &&
      newSigs.length === shared.pathSignatures.length &&
      newSigs.every((s, i) => s === shared.pathSignatures[i]);

    if (sameStructure) {
      this.paths.forEach((p, i) => {
        const id = `seam-path-${i}`;
        if (map.getLayer(id)) {
          map.setPaintProperty(id, "line-gradient", pathGradient(p));
          map.setPaintProperty(
            id,
            "line-width",
            typeof p.lineWidth === "number" ? p.lineWidth : DEFAULT_LINE_WIDTH,
          );
        }
      });
      return;
    }

    for (let i = 0; i < shared.pathSignatures.length; i++) {
      const id = `seam-path-${i}`;
      if (map.getLayer(id)) map.removeLayer(id);
      if (map.getSource(id)) map.removeSource(id);
    }
    shared.pathSignatures = [];
    shared.pathOwner = this;

    this.paths.forEach((p, i) => {
      const id = `seam-path-${i}`;
      map.addSource(id, {
        type: "geojson",
        lineMetrics: true,
        data: {
          type: "Feature",
          properties: {},
          geometry: { type: "LineString", coordinates: p.points },
        },
      });
      map.addLayer({
        id,
        type: "line",
        source: id,
        layout: { "line-cap": "round", "line-join": "round" },
        paint: {
          "line-width":
            typeof p.lineWidth === "number" ? p.lineWidth : DEFAULT_LINE_WIDTH,
          "line-gradient": pathGradient(p),
        },
      });
      shared.pathSignatures.push(newSigs[i]);
    });
  }

  private _requestRenderAll(): void {
    // Deliberate no-op. All fabric renders are driven by
    // GraphicStore.update, which wall-clock-throttles to 60 Hz.
    // If we called fabric's requestRenderAll here, maplibre's tile-load
    // cadence (or display refresh on 120 Hz screens) would defeat the
    // throttle. Paused-state tile loads still propagate through the
    // render-listener hook below, which wakes the rAF loop so the
    // throttled update sees them on the next tick.
  }

  /** External hook for when the live maplibre repaints — typically a
   *  tile arriving or a flushPending firing. GraphicStore uses this to
   *  call onFrameAvailable so the rAF loop wakes (or stays awake);
   *  the next throttled update picks up the new map content via the
   *  fabric drawImage in _render. Returns an unsubscriber. */
  addRenderListener(fn: () => void): () => void {
    if (!this._shared) {
      // attachToPath populates _shared synchronously, so this only
      // fires if a caller forgot to attach first.
      console.warn(
        "[MapLibreMap] addRenderListener before attachToPath — no-op",
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
    if (this._shared?.map) {
      const keys =
        typeof key === "object" && key !== null
          ? Object.keys(key as Record<string, unknown>)
          : [key as string];
      this._forwardToShared(keys);
    }
    return ret;
  }

  private _forwardToShared(keys: string[]): void {
    const shared = this._shared;
    if (!shared?.map) return;
    let cameraChanged = false;
    let sizeChanged = false;
    let pathsChanged = false;
    for (const k of keys) {
      if (k === "latitude" || k === "longitude" || k === "zoom") {
        cameraChanged = true;
      } else if (k === "width" || k === "height") {
        sizeChanged = true;
      } else if (k === "paths") {
        pathsChanged = true;
      }
    }
    if (cameraChanged || sizeChanged || pathsChanged) {
      this._queuePending({
        camera: cameraChanged,
        size: sizeChanged,
        paths: pathsChanged,
      });
    }
  }

  _render(ctx: CanvasRenderingContext2D): void {
    const w = this.width;
    const h = this.height;
    if (!this._shared?.map || !this._ready) {
      ctx.fillStyle = "#2a2a2a";
      ctx.fillRect(-w / 2, -h / 2, w, h);
      ctx.fillStyle = "#666";
      ctx.font = "16px monospace";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText("loading map…", 0, 0);
      return;
    }
    ctx.drawImage(this._shared.map.getCanvas(), -w / 2, -h / 2, w, h);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  static async fromObject(obj: any): Promise<MapLibreMap> {
    return new MapLibreMap(obj);
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
    const out = (super.toObject as any).call(this, extra) as Record<
      string,
      unknown
    >;
    return out;
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

classRegistry.setClass(MapLibreMap, "Map");

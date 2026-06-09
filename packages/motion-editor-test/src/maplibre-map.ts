import maplibregl from "maplibre-gl";
import { PMTiles, Protocol, TileType } from "pmtiles";
import {
  classRegistry,
  FabricObject,
  type FabricObjectProps,
} from "fabric";
import { resolveSrc } from "./src-registry.js";

// Register the pmtiles protocol once at module load.
const protocol = new Protocol();
maplibregl.addProtocol("pmtiles", protocol.tile);

type PMHeader = Awaited<ReturnType<PMTiles["getHeader"]>>;

const RASTER_TYPES = new Set<TileType>([
  TileType.Png,
  TileType.Jpeg,
  TileType.Webp,
  TileType.Avif,
]);

// Public glyphs endpoint — maplibre's own demo tile server. Free for dev
// use; swap to a self-hosted set for production.
const GLYPHS_URL =
  "https://demotiles.maplibre.org/font/{fontstack}/{range}.pbf";

// OSM Bright (OpenMapTiles) style served from public/. Loaded once and
// cached so multiple Map instances share the parsed object. The original
// style references api.maptiler.com for sources + glyphs; we strip those
// and re-point the source to our pmtiles URL. The source's NAME stays
// "openmaptiles" so the layer references resolve correctly.
let osmBrightCache: maplibregl.StyleSpecification | null = null;

async function loadOsmBrightTemplate(): Promise<maplibregl.StyleSpecification | null> {
  if (osmBrightCache) {
    // Deep clone so per-Map overrides don't mutate the shared cache.
    return JSON.parse(JSON.stringify(osmBrightCache));
  }
  try {
    const res = await fetch("/osm-bright-gl-style/style.json");
    if (!res.ok) {
      console.warn(`[Map] osm-bright fetch failed: ${res.status}`);
      return null;
    }
    osmBrightCache = (await res.json()) as maplibregl.StyleSpecification;
    return JSON.parse(JSON.stringify(osmBrightCache));
  } catch (err) {
    console.warn("[Map] osm-bright fetch error:", err);
    return null;
  }
}

async function buildStyleForPMTiles(
  realUrl: string,
  header: PMHeader,
  metadata: unknown,
): Promise<maplibregl.StyleSpecification | null> {
  if (RASTER_TYPES.has(header.tileType)) {
    return {
      version: 8,
      sources: {
        "pmtiles-source": {
          type: "raster",
          url: `pmtiles://${realUrl}`,
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
    // Try the proper OSM Bright style first. It expects a vector source
    // named "openmaptiles", which we'll satisfy by pointing at our pmtiles.
    const template = await loadOsmBrightTemplate();
    if (template) {
      template.sources = {
        openmaptiles: {
          type: "vector",
          url: `pmtiles://${realUrl}`,
        },
      };
      template.glyphs = GLYPHS_URL;
      // Sprite stays as the upstream github.io URL; the browser fetches at
      // runtime. Authors wanting offline can self-host under public/.
      return template;
    }
    // Fallback: auto-generated style enumerating layers from metadata.
    return buildAutoVectorStyle(realUrl, metadata);
  }
  return null;
}

function buildAutoVectorStyle(
  realUrl: string,
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
        url: `pmtiles://${realUrl}`,
      },
    },
    layers,
  };
}

// ───────────────────────────────────────────────────────────────────────────
// Pool: shared maplibre instances keyed by path-id (the same hierarchical
// id-or-positional-index key the animation system uses). Multiple fabric
// Maps with the same path — e.g. the same animating element across frames
// — all reference one maplibregl.Map and one container. Refcount drives
// teardown so frame transitions don't burn the GL context.
// ───────────────────────────────────────────────────────────────────────────

type SharedMaplibre = {
  map: maplibregl.Map | null;
  container: HTMLDivElement;
  ready: boolean;
  refCount: number;
  pmtilesSrc: string;
  pendingReady: Array<() => void>;
  onRender: Set<() => void>;
  // Path layers tracking: which Map currently owns the installed paths,
  // and which point-signatures are installed so per-tick paint-only updates
  // can fast-path past the rebuild.
  pathOwner: unknown;
  pathSignatures: string[];
};

const pool = new Map<string, SharedMaplibre>();

function poolKey(path: string, pmtilesSrc: string): string {
  return `${path}|${pmtilesSrc}`;
}

function acquireShared(
  path: string,
  pmtilesSrc: string,
  realUrl: string,
  width: number,
  height: number,
  initialCamera: { latitude: number; longitude: number; zoom: number },
): SharedMaplibre {
  const key = poolKey(path, pmtilesSrc);
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
    pmtilesSrc,
    pendingReady: [],
    onRender: new Set(),
    pathOwner: null,
    pathSignatures: [],
  };
  pool.set(key, entry);

  // Async init kicked off; consumers wait via pendingReady.
  (async () => {
    let header: PMHeader;
    let metadata: unknown;
    try {
      const pm = new PMTiles(realUrl);
      header = await pm.getHeader();
      metadata = await pm.getMetadata();
    } catch (err) {
      console.error("[Map pool] failed to read pmtiles header:", err);
      return;
    }
    if (!pool.has(key)) return; // disposed before init finished
    const style = await buildStyleForPMTiles(realUrl, header, metadata);
    if (!pool.has(key)) return; // disposed during style fetch
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
    map.on("error", e => {
      console.warn(
        "[Map pool] maplibre error:",
        e?.error?.message ?? "(no message)",
      );
    });
  })();

  return entry;
}

function releaseShared(path: string, pmtilesSrc: string): void {
  const key = poolKey(path, pmtilesSrc);
  const entry = pool.get(key);
  if (!entry) return;
  entry.refCount--;
  if (entry.refCount <= 0) {
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

// Build a line-gradient paint value for the given path. maplibre's
// `line-gradient` always requires an expression involving `line-progress`,
// so we use the same step form whether progress is partial or full.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function pathGradient(p: MapPath): any {
  const raw = typeof p.progress === "number" ? p.progress : 1;
  const progress = Math.max(0, Math.min(1, raw));
  return [
    "step",
    ["line-progress"],
    p.color,
    progress,
    "rgba(0,0,0,0)",
  ];
}

// ───────────────────────────────────────────────────────────────────────────
// Map class
// ───────────────────────────────────────────────────────────────────────────

export interface MapPath {
  color: string;
  points: number[][]; // [[lng, lat], ...]
  progress?: number;  // 0..1, defaults to 1 (full line)
  lineWidth?: number; // defaults to 4
}

const DEFAULT_LINE_WIDTH = 4;

export interface MapOptions extends Partial<FabricObjectProps> {
  pmtilesSrc?: string;
  latitude?: number;
  longitude?: number;
  zoom?: number;
  paths?: MapPath[];
}

export class MapLibreMap extends FabricObject {
  static type = "Map";

  pmtilesSrc = "";
  latitude = 0;
  longitude = 0;
  zoom = 1;
  paths: MapPath[] = [];

  private _path = "";
  private _shared: SharedMaplibre | null = null;
  private _ready = false;
  private _renderListener: (() => void) | null = null;
  // Pre-enliven Maps survive add/remove cycles (loop playback re-adds them).
  // Single-frame Maps dispose on remove. Host sets this flag explicitly.
  isPreEnliven = false;

  constructor(options: MapOptions = {}) {
    const {
      type: _ignoredType,
      pmtilesSrc,
      latitude,
      longitude,
      zoom,
      paths,
      ...rest
    } = options as MapOptions & { type?: string };
    super(rest as Partial<FabricObjectProps>);

    if (typeof pmtilesSrc === "string") this.pmtilesSrc = pmtilesSrc;
    if (typeof latitude === "number") this.latitude = latitude;
    if (typeof longitude === "number") this.longitude = longitude;
    if (typeof zoom === "number") this.zoom = zoom;
    if (Array.isArray(paths)) this.paths = paths as MapPath[];
    if (typeof rest.width !== "number") this.width = 400;
    if (typeof rest.height !== "number") this.height = 400;
    this.objectCaching = false;

    // 'added' on canvas means this instance becomes the active camera driver
    // for its path. Throwaway fillObject instances never see this event.
    this.on("added", () => this._onAdded());
    this.on("removed", () => {
      // Pre-enliven Maps re-enter the canvas on loop wrap; don't dispose.
      if (!this.isPreEnliven) this.dispose();
    });
  }

  // Called externally once the host (App.tsx) knows this Map's hierarchical
  // path. Idempotent — re-attach is ignored. Throwaway instances that don't
  // get attached never acquire a maplibre.
  attachToPath(path: string): void {
    if (this._shared) return;
    if (!this.pmtilesSrc || !path) return;
    const real = resolveSrc(this.pmtilesSrc);
    if (!real) return;

    this._path = path;
    this._shared = acquireShared(
      path,
      this.pmtilesSrc,
      real,
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
    // Only the on-canvas Map drives camera + paths. Pre-enlivened off-canvas
    // Maps that complete attach via pendingReady don't fight over ownership.
    if (this.canvas && this._shared?.map) {
      this._shared.map.jumpTo({
        center: [this.longitude, this.latitude],
        zoom: this.zoom,
      });
      this._applyPaths();
    }
    this._requestRenderAll();
  }

  private _onAdded(): void {
    if (this._shared?.map) {
      this._shared.map.jumpTo({
        center: [this.longitude, this.latitude],
        zoom: this.zoom,
      });
      this._applyPaths();
      this._requestRenderAll();
    }
  }

  // Install / update this Map's path layers on the shared maplibre. Fast
  // path: when the previously installed paths have the same point arrays,
  // only the line-gradient paint property is updated (per-tick colors and
  // progress during animation flow through here cheaply).
  private _applyPaths(): void {
    const shared = this._shared;
    const map = shared?.map;
    if (!map || !shared) {
      console.log("[Map] _applyPaths: no map yet, deferring", {
        hasShared: !!shared,
        sharedReady: shared?.ready,
        pathCount: this.paths.length,
      });
      return;
    }

    const newSigs = this.paths.map(p => JSON.stringify(p.points));
    const sameOwner = shared.pathOwner === this;
    const sameStructure =
      sameOwner &&
      newSigs.length === shared.pathSignatures.length &&
      newSigs.every((s, i) => s === shared.pathSignatures[i]);
    console.log("[Map] _applyPaths", {
      newCount: this.paths.length,
      installedCount: shared.pathSignatures.length,
      sameOwner,
      sameStructure,
    });

    if (sameStructure) {
      // Cheap path: only update paint on existing layers.
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

    // Tear down whatever the previous owner installed.
    for (let i = 0; i < shared.pathSignatures.length; i++) {
      const id = `seam-path-${i}`;
      if (map.getLayer(id)) map.removeLayer(id);
      if (map.getSource(id)) map.removeSource(id);
    }
    shared.pathSignatures = [];
    shared.pathOwner = this;

    // Install fresh.
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
    const c = (this as unknown as { canvas?: { requestRenderAll(): void } })
      .canvas;
    if (c) c.requestRenderAll();
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
    if (cameraChanged) {
      shared.map.setCenter([this.longitude, this.latitude]);
      shared.map.setZoom(this.zoom);
    }
    if (sizeChanged) {
      shared.container.style.width = `${this.width}px`;
      shared.container.style.height = `${this.height}px`;
      shared.map.resize();
    }
    if (pathsChanged) {
      this._applyPaths();
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
      "pmtilesSrc",
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
      releaseShared(this._path, this.pmtilesSrc);
    }
    this._shared = null;
    this._renderListener = null;
    this._path = "";
    this._ready = false;
  }
}

classRegistry.setClass(MapLibreMap, "Map");

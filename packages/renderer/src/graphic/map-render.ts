// Server-side maplibre rendering for graphic Map elements. Loads
// @maplibre/maplibre-gl-native (which ships prebuilt binaries for the
// Node 22 and 24 LTS lines — ABI 127/137; Node 23 and 25 have no
// prebuilt — see the package engines field), wires a custom
// request callback into pmtiles + an http fetcher for glyphs/sprites,
// and renders the requested view into an RGBA buffer.
//
// PMTiles uses a custom node Source so byte-range reads hit the file
// directly — no full-file load. Style dispatch (raster vs vector +
// osm-bright) mirrors the same logic we settled on in motion-editor-test.
//
// `MapPool` reuses a mbgl.Map across frames for the same path-id:
// per-tick mutations are confined to setSize / setCenter / setZoom and
// the small set of geojson path layers, so a 4-second animated map
// pays the style/load cost once instead of per output frame.

import { createRequire } from "node:module";
import { readFile, open, type FileHandle } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, isAbsolute, join } from "node:path";
import { PMTiles, TileType, type Source } from "pmtiles";
import { createCanvas, type Canvas as NodeCanvas } from "canvas";
import { generateGlyphRangePBF } from "./glyphs.js";

const require = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mbgl: any = require("@maplibre/maplibre-gl-native");

// The OSM Bright style + sprite atlas are bundled in this package (copied
// from the openmaptiles osm-bright-gl-style), so the renderer doesn't
// depend on a sibling package's files or any external CDN. From either
// src/graphic or dist/graphic, the dir sits two levels up at the package
// root, alongside fonts/.
const OSM_BRIGHT_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "osm-bright",
);

// Glyphs are synthesized locally from the bundled Liberation Sans (see
// glyphs.ts) instead of fetched from an external server — the custom
// `seamglyphs://` scheme is intercepted in handleRequest. No production
// CDN dependency, and metrically consistent with the browser preview's
// own local-font rendering.
const GLYPHS_URL = "seamglyphs://{fontstack}/{range}.pbf";

// Sprite atlas served from the bundled osm-bright dir via the custom
// `seamsprite://` scheme (intercepted in handleRequest). maplibre appends
// `@2x`/`.json`/`.png` to this base, which `new URL()` parsing handles.
const SPRITE_URL = "seamsprite://osm-bright/sprite";

const RASTER_TYPES = new Set<TileType>([
  TileType.Png,
  TileType.Jpeg,
  TileType.Webp,
  TileType.Avif,
]);

/** PMTiles Source backed by a node file handle. byte-range reads only,
 *  so a multi-GB pmtiles file never lands fully in memory. */
class NodeFileSource implements Source {
  private handle: FileHandle | null = null;

  constructor(private readonly filepath: string) {}

  getKey(): string {
    return this.filepath;
  }

  async getBytes(
    offset: number,
    length: number,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    signal?: AbortSignal,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    etag?: string,
  ): Promise<{ data: ArrayBuffer; etag?: string; cacheControl?: string; expires?: string }> {
    if (!this.handle) {
      this.handle = await open(this.filepath, "r");
    }
    const buffer = Buffer.alloc(length);
    await this.handle.read(buffer, 0, length, offset);
    const ab = buffer.buffer.slice(
      buffer.byteOffset,
      buffer.byteOffset + buffer.byteLength,
    ) as ArrayBuffer;
    return { data: ab };
  }

  async close(): Promise<void> {
    if (this.handle) {
      await this.handle.close();
      this.handle = null;
    }
  }
}

export interface MapInstanceOptions {
  /** Path to the pmtiles file. Relative paths resolve against `basePath`. */
  source: string;
  basePath?: string;
}

export interface MapCamera {
  latitude: number;
  longitude: number;
  zoom: number;
}

export interface MapRenderInput extends MapCamera {
  width: number;
  height: number;
  paths?: Array<{
    color: string;
    points: Array<[number, number]>;
    progress?: number;
    lineWidth?: number;
  }>;
}

export interface MapRenderResult {
  /** RGBA8 buffer, width * height * 4 bytes. */
  rgba: Buffer;
  width: number;
  height: number;
}

/** A live maplibre instance + its pmtiles handle. Style is loaded once;
 *  subsequent renders mutate the camera and the (small) set of path
 *  overlay layers. Held by the MapPool across animation frames. */
export class MapInstance {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private constructor(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    private readonly map: any,
    private readonly fileSource: NodeFileSource,
    /** IDs of geojson path layers currently installed (so we can diff
     *  them out before installing this frame's). */
    private installedPathIds: string[],
  ) {}

  static async create(opts: MapInstanceOptions): Promise<MapInstance> {
    const absPath = isAbsolute(opts.source)
      ? opts.source
      : join(opts.basePath ?? process.cwd(), opts.source);
    const fileSource = new NodeFileSource(absPath);
    const pm = new PMTiles(fileSource);
    const header = await pm.getHeader();
    const metadata = await pm.getMetadata();
    const style = await buildMapStyle(absPath, header, metadata);
    if (!style) {
      await fileSource.close();
      throw new Error(
        `[Map] unsupported pmtiles tileType: ${header.tileType} (${TileType[header.tileType]})`,
      );
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const map: any = new mbgl.Map({
      request: (
        req: { url: string; kind: number },
        callback: (err?: Error, response?: { data: Uint8Array }) => void,
      ) => {
        handleRequest(req, pm, absPath, callback).catch((err) => {
          callback(err instanceof Error ? err : new Error(String(err)));
        });
      },
      ratio: 1,
    });
    map.load(style);
    return new MapInstance(map, fileSource, []);
  }

  async render(input: MapRenderInput): Promise<MapRenderResult> {
    // Remove the previous frame's path overlays before installing the
    // current set. We always start from a clean slate because path
    // sets can shrink, and a stale source would block the next addSource
    // call with the same id.
    for (const id of this.installedPathIds) {
      try {
        this.map.removeLayer(id);
      } catch {
        // already gone — ignore
      }
      try {
        this.map.removeSource(id);
      } catch {
        // already gone — ignore
      }
    }
    this.installedPathIds = [];

    if (input.paths?.length) {
      input.paths.forEach((p, i) => {
        const id = `seam-path-${i}`;
        this.map.addSource(id, {
          type: "geojson",
          lineMetrics: true,
          data: {
            type: "Feature",
            properties: {},
            geometry: {
              type: "LineString",
              coordinates: p.points,
            },
          },
        });
        const progress = Math.max(0, Math.min(1, p.progress ?? 1));
        this.map.addLayer({
          id,
          type: "line",
          source: id,
          layout: { "line-cap": "round", "line-join": "round" },
          paint: {
            "line-width": p.lineWidth ?? 4,
            "line-gradient": [
              "step",
              ["line-progress"],
              p.color,
              progress,
              "rgba(0,0,0,0)",
            ],
          },
        });
        this.installedPathIds.push(id);
      });
    }

    const buffer: Uint8Array = await new Promise((resolve, reject) => {
      this.map.render(
        {
          zoom: input.zoom,
          width: input.width,
          height: input.height,
          center: [input.longitude, input.latitude],
        },
        (err?: Error, buf?: Uint8Array) => {
          if (err || !buf) reject(err ?? new Error("empty render buffer"));
          else resolve(buf);
        },
      );
    });

    return {
      rgba: Buffer.from(buffer),
      width: input.width,
      height: input.height,
    };
  }

  async release(): Promise<void> {
    try {
      this.map.release();
    } catch {
      // ignore
    }
    await this.fileSource.close();
  }
}

/** Path-id keyed pool of MapInstances. Owned by the rasterizer for the
 *  duration of one ResolvedGraphic — `releaseAll` at the end drains
 *  every instance. Pool key includes pmtilesSrc so a Map whose source
 *  changed across frames (rare, would also break the structural patch)
 *  doesn't accidentally share state. */
export class MapPool {
  private instances = new Map<string, MapInstance>();

  async acquire(
    path: string,
    source: string,
    basePath: string | undefined,
  ): Promise<MapInstance> {
    const key = `${path}|${source}`;
    const existing = this.instances.get(key);
    if (existing) return existing;
    const inst = await MapInstance.create({ source, basePath });
    this.instances.set(key, inst);
    return inst;
  }

  async releaseAll(): Promise<void> {
    for (const inst of this.instances.values()) {
      await inst.release();
    }
    this.instances.clear();
  }
}

/** Convenience: render a single map view (no pooling). Used by tests and
 *  any caller that just wants one frame. */
export async function renderMapToRgba(
  opts: MapInstanceOptions & MapRenderInput,
): Promise<MapRenderResult> {
  const inst = await MapInstance.create(opts);
  try {
    return await inst.render(opts);
  } finally {
    await inst.release();
  }
}

/** Wrap an RGBA buffer in a node-canvas. Fabric/node consumes it as an
 *  Image source directly. */
export function rgbaToCanvas(result: MapRenderResult): NodeCanvas {
  const canvas = createCanvas(result.width, result.height);
  const ctx = canvas.getContext("2d");
  const imageData = ctx.createImageData(result.width, result.height);
  imageData.data.set(result.rgba);
  ctx.putImageData(imageData, 0, 0);
  return canvas;
}

// ── Request dispatch ────────────────────────────────────────────────

async function handleRequest(
  req: { url: string; kind: number },
  pm: PMTiles,
  pmtilesPath: string,
  callback: (err?: Error, response?: { data: Uint8Array }) => void,
): Promise<void> {
  const url = req.url;
  const glyphMatch = url.match(/^seamglyphs:\/\/(.+)\/(\d+)-(\d+)\.pbf$/);
  if (glyphMatch) {
    const fontstack = decodeURIComponent(glyphMatch[1]);
    const start = parseInt(glyphMatch[2], 10);
    const end = parseInt(glyphMatch[3], 10);
    callback(undefined, { data: generateGlyphRangePBF(fontstack, start, end) });
    return;
  }
  const spriteMatch = url.match(/^seamsprite:\/\/.*\/(sprite(?:@2x)?\.(?:json|png))$/);
  if (spriteMatch) {
    // maplibre uses `@2x` in the URL; the bundled file is named `-2x`.
    const file = spriteMatch[1].replace("@2x", "-2x");
    const data = await readFile(join(OSM_BRIGHT_DIR, file));
    callback(undefined, { data: new Uint8Array(data) });
    return;
  }
  const tileMatch = url.match(/^pmtiles:\/\/(.+?)\/(\d+)\/(\d+)\/(\d+)$/);
  if (tileMatch) {
    const z = parseInt(tileMatch[2], 10);
    const x = parseInt(tileMatch[3], 10);
    const y = parseInt(tileMatch[4], 10);
    const tile = await pm.getZxy(z, x, y);
    if (!tile) {
      callback(undefined, { data: new Uint8Array(0) });
      return;
    }
    callback(undefined, { data: new Uint8Array(tile.data) });
    return;
  }
  if (url === `pmtiles://${pmtilesPath}` || url.startsWith("pmtiles://")) {
    const header = await pm.getHeader();
    const metadata = await pm.getMetadata();
    const tilejson = buildTileJson(pmtilesPath, header, metadata);
    callback(undefined, {
      data: new TextEncoder().encode(JSON.stringify(tilejson)),
    });
    return;
  }
  if (url.startsWith("http://") || url.startsWith("https://")) {
    const res = await fetch(url);
    if (!res.ok) {
      callback(new Error(`HTTP ${res.status} for ${url}`));
      return;
    }
    const buf = new Uint8Array(await res.arrayBuffer());
    callback(undefined, { data: buf });
    return;
  }
  if (url.startsWith("file://")) {
    const localPath = url.replace(/^file:\/\//, "");
    const data = await readFile(localPath);
    callback(undefined, { data: new Uint8Array(data) });
    return;
  }
  callback(new Error(`[Map] unsupported request scheme: ${url}`));
}

function buildTileJson(
  pmtilesPath: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  header: any,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  metadata: any,
): Record<string, unknown> {
  return {
    tilejson: "3.0.0",
    tiles: [`pmtiles://${pmtilesPath}/{z}/{x}/{y}`],
    minzoom: header.minZoom,
    maxzoom: header.maxZoom,
    bounds: [header.minLon, header.minLat, header.maxLon, header.maxLat],
    center: [header.centerLon, header.centerLat, header.centerZoom],
    vector_layers: metadata?.vector_layers,
  };
}

// ── Style ──────────────────────────────────────────────────────────

async function buildMapStyle(
  pmtilesPath: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  header: any,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  metadata: any,
): Promise<Record<string, unknown> | null> {
  if (RASTER_TYPES.has(header.tileType)) {
    return {
      version: 8,
      sources: {
        "pmtiles-source": {
          type: "raster",
          tiles: [`pmtiles://${pmtilesPath}/{z}/{x}/{y}`],
          tileSize: 256,
          minzoom: header.minZoom,
          maxzoom: header.maxZoom,
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
    const template = await tryLoadOsmBrightStyle();
    if (template) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const style = template as any;
      style.sources = {
        openmaptiles: {
          type: "vector",
          tiles: [`pmtiles://${pmtilesPath}/{z}/{x}/{y}`],
          minzoom: header.minZoom,
          maxzoom: header.maxZoom,
        },
      };
      style.glyphs = GLYPHS_URL;
      style.sprite = SPRITE_URL;
      return style;
    }
    return buildAutoVectorStyle(pmtilesPath, header, metadata);
  }
  return null;
}

async function tryLoadOsmBrightStyle(): Promise<Record<string, unknown> | null> {
  try {
    const data = await readFile(join(OSM_BRIGHT_DIR, "style.json"), "utf8");
    return JSON.parse(data) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function buildAutoVectorStyle(
  pmtilesPath: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  header: any,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  metadata: any,
): Record<string, unknown> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const layers: any[] = [
    {
      id: "pmtiles-bg",
      type: "background",
      paint: { "background-color": "#1a1a1a" },
    },
  ];
  const vectorLayers = metadata?.vector_layers as
    | Array<{ id: string }>
    | undefined;
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
        tiles: [`pmtiles://${pmtilesPath}/{z}/{x}/{y}`],
        minzoom: header.minZoom,
        maxzoom: header.maxZoom,
      },
    },
    glyphs: GLYPHS_URL,
    layers,
  };
}

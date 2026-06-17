// Server-side OpenLayers rendering for graphic Map elements.
//
// Mirrors the browser preview's OpenLayersMap, but headless: OpenLayers is
// a browser library, so we fake a DOM with jsdom (backed by node-canvas)
// and run OL's Canvas2D renderer to rasterize vector tiles — no maplibre,
// no WebGL, no glyph-PBF synthesis. The flow per frame:
//
//   set view → renderSync() → wait for `rendercomplete` (tiles loaded) →
//   composite the layer canvas over the OSM Bright cream base → draw paths.
//
// pmtiles are read through a byte-range node file Source (no full-file
// load). Labels render via ol-mapbox-style's canvas text using the bundled
// fonts registered with node-canvas (registerNodeCanvasFonts) — the symbol
// layers' `text-font` is rewritten to those families so there's no font CDN
// fetch. POI icons (sprite) are not wired yet; text labels still render.
//
// jsdom globals are installed lazily (first render), AFTER all static
// imports — notably fabric/node, which reads window.devicePixelRatio at
// module load and otherwise builds its own private jsdom env. So OL's
// globals and fabric coexist: fabric uses getEnv(), never the globals.

import { readFile, open, type FileHandle } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, isAbsolute, join } from "node:path";
import { PMTiles, TileType, type Source } from "pmtiles";
import { createCanvas, type Canvas as NodeCanvas } from "canvas";
// eslint-disable-next-line @typescript-eslint/no-explicit-any
import { JSDOM } from "jsdom";
import { CJK_FALLBACK_FAMILY, EMOJI_FALLBACK_FAMILY } from "@seam/core";
import { LIBERATION_SANS_FAMILY, registerNodeCanvasFonts } from "../text/fonts.js";

// The OSM Bright style + sprite atlas are bundled in this package. From
// either src/graphic or dist/graphic, the dir sits two levels up at the
// package root, alongside fonts/.
const OSM_BRIGHT_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "osm-bright",
);

const DEFAULT_LINE_WIDTH = 4;
const BACKGROUND_COLOR: [number, number, number] = [0xf8, 0xf4, 0xf0]; // OSM Bright base.

// Bump label text up from the OSM Bright defaults — they read small at our
// graphic sizes. Must match the preview (OpenLayersMap.TEXT_SIZE_SCALE).
const TEXT_SIZE_SCALE = 1.3;

// Web-mercator resolution (m/px at the equator) for a MapLibre/512-tile zoom
// level — the convention seam `zoom` values were authored against. Set the
// view resolution explicitly rather than view.setZoom (OL's XYZ default is
// 256-based, half the resolution at the same zoom number).
const RES_ZOOM_0 = 78271.51696402048;
function zoomToResolution(zoom: number): number {
  return RES_ZOOM_0 / Math.pow(2, zoom);
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

/** Where an embedded object's (0,0) anchors. Mirrors the preview's MapAnchor:
 *  `geo` projects a coordinate; `path` projects the point at `position`
 *  (0..1) along a polyline. */
export type MapAnchorQuery =
  | { kind: "geo"; longitude: number; latitude: number }
  | { kind: "path"; points: Array<[number, number]>; position: number };

export interface MapRenderInput extends MapCamera {
  width: number;
  height: number;
  paths?: Array<{
    color: string;
    points: Array<[number, number]>;
    progress?: number;
    lineWidth?: number;
  }>;
  /** Anchors to project to viewport pixels (for embedded objects). The
   *  result's `anchorPixels` lines up index-for-index. */
  anchors?: MapAnchorQuery[];
}

export interface MapRenderResult {
  /** RGBA8 buffer, width * height * 4 bytes. */
  rgba: Buffer;
  width: number;
  height: number;
  /** Viewport pixels (top-left origin) for each requested anchor; null when
   *  unprojectable. Aligned with `input.anchors`. */
  anchorPixels?: Array<[number, number] | null>;
}

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

// ── jsdom + OpenLayers environment (lazy, process-global) ───────────

interface OLEnv {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  OLMap: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  View: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  VectorTileLayer: any;
  fromLonLat: (coord: number[]) => number[];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  PMTilesVectorSource: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  applyStyle: any;
}

let jsdomInstalled = false;

/** Fake the browser globals OpenLayers' canvas renderer reads. jsdom uses
 *  node-canvas for <canvas> (so OL draws into a real raster backend) and
 *  must be installed before `ol` modules load — they capture globals at
 *  import time. Runs once; safe because fabric/node already initialised. */
function installJsdomGlobals(): void {
  if (jsdomInstalled) return;
  jsdomInstalled = true;
  const { window } = new JSDOM(
    "<!DOCTYPE html><html><head></head><body></body></html>",
    { pretendToBeVisual: true }, // gives requestAnimationFrame
  );
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const g = globalThis as any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const w = window as any;
  g.window = window;
  g.document = window.document;
  // jsdom has no FontFaceSet. ol-mapbox-style's getFonts awaits
  // document.fonts.ready and probes document.fonts.load(...) to decide
  // whether to fetch a web font from its CDN. Stub it so every probe
  // "matches" — the real glyphs come from the node-canvas-registered
  // families (registerNodeCanvasFonts), and no CDN fetch ever happens.
  const fontsStub = {
    ready: Promise.resolve(),
    status: "loaded",
    check: () => true,
    add: () => {},
    delete: () => {},
    forEach: () => {},
    // Echo the requested face back so getFonts' family/weight/style match
    // passes. Probe string is `${style} ${weight} 16px "${family}"`.
    load: (font: string) => {
      const m = /^(\S+)\s+(\S+)\s+[\d.]+px\s+"(.+)"$/.exec(font);
      const [, style = "normal", weight = "normal", family = ""] = m ?? [];
      return Promise.resolve([{ family, weight, style, status: "loaded" }]);
    },
    [Symbol.iterator]: () => [][Symbol.iterator](),
  };
  Object.defineProperty(window.document, "fonts", {
    value: fontsStub,
    configurable: true,
  });
  // Node 24 ships read-only `navigator`/`location` globals; override them.
  Object.defineProperty(globalThis, "navigator", {
    value: window.navigator,
    configurable: true,
    writable: true,
  });
  Object.defineProperty(globalThis, "location", {
    value: window.location,
    configurable: true,
    writable: true,
  });
  for (const name of [
    "HTMLElement",
    "HTMLCanvasElement",
    "HTMLImageElement",
    "Image",
    "Node",
    "Element",
    "ShadowRoot",
    "Event",
    "EventTarget",
    "DOMParser",
    "XMLSerializer",
    "CSSStyleDeclaration",
    "WheelEvent",
    "PointerEvent",
    "MouseEvent",
    "KeyboardEvent",
  ]) {
    if (w[name] !== undefined) g[name] = w[name];
  }
  g.getComputedStyle = window.getComputedStyle.bind(window);
  g.requestAnimationFrame = window.requestAnimationFrame.bind(window);
  g.cancelAnimationFrame = window.cancelAnimationFrame.bind(window);
  w.devicePixelRatio = 1;
  g.devicePixelRatio = 1;
  g.OffscreenCanvas = w.OffscreenCanvas;
  g.ResizeObserver =
    w.ResizeObserver ??
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
  w.ResizeObserver = g.ResizeObserver;
}

let olEnvPromise: Promise<OLEnv> | null = null;

function initOL(): Promise<OLEnv> {
  if (olEnvPromise) return olEnvPromise;
  olEnvPromise = (async () => {
    installJsdomGlobals();
    // Map labels render through node-canvas (fabric/Cairo) text — register
    // the bundled families it'll resolve to. Idempotent.
    registerNodeCanvasFonts();
    const [olMap, olView, olVTL, olProj, olPmtiles, olms] = await Promise.all([
      import("ol/Map.js"),
      import("ol/View.js"),
      import("ol/layer/VectorTile.js"),
      import("ol/proj.js"),
      import("ol-pmtiles"),
      import("ol-mapbox-style"),
    ]);
    return {
      OLMap: olMap.default,
      View: olView.default,
      VectorTileLayer: olVTL.default,
      fromLonLat: olProj.fromLonLat,
      PMTilesVectorSource: olPmtiles.PMTilesVectorSource,
      applyStyle: olms.applyStyle,
    };
  })();
  return olEnvPromise;
}

// ── Style ──────────────────────────────────────────────────────────

/** The `text-font` stack to substitute for a style layer's original stack:
 *  the matching Liberation Sans variant name (ol-mapbox-style re-derives the
 *  weight/style from it) plus the CJK + emoji fallbacks. Mirrors the
 *  preview's mapLabelFontStack. */
function mapLabelFontStack(stack: string[] | string): string[] {
  const s = (Array.isArray(stack) ? stack.join(" ") : stack).toLowerCase();
  const bold = /bold|semibold|black|heavy/.test(s);
  const italic = /italic|oblique/.test(s);
  let family = LIBERATION_SANS_FAMILY;
  if (bold) family += " Bold";
  if (italic) family += " Italic";
  return [family, CJK_FALLBACK_FAMILY, EMOJI_FALLBACK_FAMILY];
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function scaleTextSize(size: any): any {
  if (size == null) return 16 * TEXT_SIZE_SCALE;
  if (typeof size === "number") return size * TEXT_SIZE_SCALE;
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

/** Read + prepare the bundled OSM Bright style for OL: rewrite symbol
 *  text-font to our bundled families, scale label text, drop glyphs/sprite
 *  refs (canvas fonts, no icons yet). Mirrors the preview's basemapStyle. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function basemapStyle(): Promise<any> {
  const data = await readFile(join(OSM_BRIGHT_DIR, "style.json"), "utf8");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const style = JSON.parse(data) as any;
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

// ── MapInstance ─────────────────────────────────────────────────────

/** A headless OL map + its pmtiles handle. Style is loaded once; subsequent
 *  renders mutate the view + redraw. Held by the MapPool across frames so
 *  the tile cache stays warm. */
export class MapInstance {
  private constructor(
    private readonly env: OLEnv,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    private readonly map: any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    private readonly container: any,
    private readonly fileSource: NodeFileSource,
    private width: number,
    private height: number,
  ) {}

  static async create(opts: MapInstanceOptions): Promise<MapInstance> {
    const env = await initOL();
    const absPath = isAbsolute(opts.source)
      ? opts.source
      : join(opts.basePath ?? process.cwd(), opts.source);
    const fileSource = new NodeFileSource(absPath);

    const header = await new PMTiles(fileSource).getHeader();
    if (header.tileType !== TileType.Mvt) {
      await fileSource.close();
      throw new Error(
        `[Map] only vector (MVT) pmtiles are supported; got ${header.tileType} (${TileType[header.tileType]})`,
      );
    }

    // Nominal initial size; render() sets the real one per frame.
    const W = 256;
    const H = 256;
    const container = createContainer(W, H);

    const layer = new env.VectorTileLayer({
      source: new env.PMTilesVectorSource({ url: fileSource }),
      declutter: true,
    });
    const map = new env.OLMap({
      target: container,
      layers: [layer],
      view: new env.View({
        center: [0, 0],
        resolution: zoomToResolution(1),
        constrainResolution: false,
      }),
      controls: [],
      interactions: [],
      pixelRatio: 1,
    });
    map.setSize([W, H]);

    // updateSource:false — keep our pmtiles-backed source; only paint the GL
    // layers onto it (else ol-mapbox-style resolves the style's remote URL).
    await env.applyStyle(layer, await basemapStyle(), "openmaptiles", {
      updateSource: false,
    });

    return new MapInstance(env, map, container, fileSource, W, H);
  }

  async render(input: MapRenderInput): Promise<MapRenderResult> {
    const w = input.width;
    const h = input.height;
    if (w !== this.width || h !== this.height) {
      this.width = w;
      this.height = h;
      this.container.style.width = `${w}px`;
      this.container.style.height = `${h}px`;
      this.map.setSize([w, h]);
    }

    const view = this.map.getView();
    view.setCenter(this.env.fromLonLat([input.longitude, input.latitude]));
    view.setResolution(zoomToResolution(input.zoom));
    await this.renderComplete();

    // Composite the OL layer canvas(es) over the cream base. We blend the
    // straight-alpha pixels manually rather than drawImage the jsdom canvas
    // (node-canvas only accepts its own Canvas/Image in drawImage).
    const acc = new Uint8ClampedArray(w * h * 4);
    for (let i = 0; i < acc.length; i += 4) {
      acc[i] = BACKGROUND_COLOR[0];
      acc[i + 1] = BACKGROUND_COLOR[1];
      acc[i + 2] = BACKGROUND_COLOR[2];
      acc[i + 3] = 255;
    }
    const canvases = this.container.querySelectorAll("canvas");
    for (const c of canvases) {
      if (c.width !== w || c.height !== h) continue;
      const src = c.getContext("2d").getImageData(0, 0, w, h).data;
      for (let i = 0; i < acc.length; i += 4) {
        const a = src[i + 3] / 255;
        if (a === 0) continue;
        acc[i] = src[i] * a + acc[i] * (1 - a);
        acc[i + 1] = src[i + 1] * a + acc[i + 1] * (1 - a);
        acc[i + 2] = src[i + 2] * a + acc[i + 2] * (1 - a);
      }
    }

    // Seed a node-canvas with the composite, draw paths on top, read back.
    const out = createCanvas(w, h);
    const ctx = out.getContext("2d");
    const seed = ctx.createImageData(w, h);
    seed.data.set(acc);
    ctx.putImageData(seed, 0, 0);
    this.drawPaths(ctx, w, h, input.paths);
    const rgba = Buffer.from(ctx.getImageData(0, 0, w, h).data);
    const anchorPixels = input.anchors?.map((a) => this.projectAnchor(a));
    return { rgba, width: w, height: h, anchorPixels };
  }

  /** Project an anchor to a viewport pixel (top-left origin) against the
   *  current view. Mirrors the preview's _projectAnchor. */
  private projectAnchor(a: MapAnchorQuery): [number, number] | null {
    let coord: number[] | undefined;
    if (a.kind === "geo") {
      coord = this.env.fromLonLat([a.longitude, a.latitude]);
    } else {
      if (!Array.isArray(a.points) || a.points.length < 2) return null;
      const coords = a.points.map(([lon, lat]) => this.env.fromLonLat([lon, lat]));
      const frac = Math.max(0, Math.min(1, a.position));
      // Truncate in projected (web-mercator) space — distance-normalized,
      // camera-independent — then the last point is the point at `frac`.
      coord =
        frac >= 1
          ? coords[coords.length - 1]
          : truncateToFraction(coords, frac).at(-1);
    }
    if (!coord) return null;
    const px = this.map.getPixelFromCoordinate(coord);
    return px ? [px[0], px[1]] : null;
  }

  /** Resolve once the current viewport's tiles are loaded and drawn. OL's
   *  `rendercomplete` fires when all sources/tiles have finished loading for
   *  the viewport; warm tiles resolve immediately. The timeout is a backstop
   *  so a stuck source can't hang the whole render. */
  private renderComplete(): Promise<void> {
    return new Promise((resolve) => {
      let settled = false;
      // eslint-disable-next-line prefer-const
      let timer: ReturnType<typeof setTimeout>;
      const finish = () => {
        if (settled) return;
        settled = true;
        this.map.un("rendercomplete", finish);
        clearTimeout(timer);
        resolve();
      };
      this.map.on("rendercomplete", finish);
      this.map.renderSync();
      timer = setTimeout(finish, 10000);
    });
  }

  /** Draw path overlays in 2D, truncating the progress reveal in projected
   *  (web-mercator) space so it's distance-normalized and camera-independent,
   *  then projecting to viewport pixels. Mirrors the preview. */
  private drawPaths(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ctx: any,
    w: number,
    h: number,
    paths: MapRenderInput["paths"],
  ): void {
    if (!paths?.length) return;
    ctx.save();
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    for (const p of paths) {
      if (!Array.isArray(p.points) || p.points.length < 2) continue;
      const coords = p.points.map(([lon, lat]) => this.env.fromLonLat([lon, lat]));
      const progress =
        typeof p.progress === "number"
          ? Math.max(0, Math.min(1, p.progress))
          : 1;
      const revealed =
        progress >= 1 ? coords : truncateToFraction(coords, progress);
      const pts: number[][] = [];
      for (const c of revealed) {
        const px = this.map.getPixelFromCoordinate(c);
        if (px) pts.push([px[0], px[1]]);
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

  async release(): Promise<void> {
    try {
      this.map.setTarget(undefined);
    } catch {
      // ignore
    }
    try {
      if (this.container.parentNode) {
        this.container.parentNode.removeChild(this.container);
      }
    } catch {
      // ignore
    }
    await this.fileSource.close();
  }
}

/** Off-screen, hidden jsdom container OL renders into. visibility:hidden (not
 *  display:none) keeps layout box metrics; setSize overrides them anyway. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function createContainer(width: number, height: number): any {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const doc = (globalThis as any).document;
  const container = doc.createElement("div");
  container.style.cssText = `position:fixed;left:0;top:0;width:${width}px;height:${height}px;visibility:hidden;`;
  doc.body.appendChild(container);
  return container;
}

/** Path-id keyed pool of MapInstances. Owned by the rasterizer for the
 *  duration of one ResolvedGraphic — `releaseAll` at the end drains every
 *  instance. Pool key includes source so a Map whose source changed across
 *  frames doesn't share state. */
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

/** Convenience: render a single map view (no pooling). Used by tests and any
 *  caller that just wants one frame. */
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

/** Wrap an RGBA buffer in a node-canvas. Fabric/node consumes it as an Image
 *  source directly. */
export function rgbaToCanvas(result: MapRenderResult): NodeCanvas {
  const canvas = createCanvas(result.width, result.height);
  const ctx = canvas.getContext("2d");
  const imageData = ctx.createImageData(result.width, result.height);
  imageData.data.set(result.rgba);
  ctx.putImageData(imageData, 0, 0);
  return canvas;
}

/** Return the polyline truncated to `fraction` (0..1) of its total length,
 *  splitting the final segment so the reveal is smooth. */
function truncateToFraction(
  pts: number[][],
  fraction: number,
): number[][] {
  let total = 0;
  for (let i = 1; i < pts.length; i++) {
    total += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
  }
  const target = total * fraction;
  if (target <= 0) return [pts[0]];
  const out: number[][] = [pts[0]];
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

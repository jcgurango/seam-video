// Node adapter for the shared @seam/map rasterizer — the renderer's headless
// map path. Supplies the platform bits (byte-range pmtiles Source over fs, a
// node-canvas 2D context, node-canvas font registration, the bundled style)
// and delegates all drawing to @seam/map, the same code the preview runs.
//
// Headless flow: await every covering tile into the pooled TileSource, then
// draw synchronously (no bubble-up — offline we just block until ready).

import { open, readFile, type FileHandle } from "node:fs/promises";
import { isAbsolute, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { type Source } from "pmtiles";
import { createCanvas, type Canvas as NodeCanvas } from "canvas";
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
import { registerNodeCanvasFonts } from "../text/fonts.js";

// The bundled OSM Bright style lives at the package root (../../osm-bright from
// src/graphic or dist/graphic). @seam/map reads text-font/paint directly and
// never fetches glyphs/sprite/source URLs, so the raw JSON is passed as-is.
const OSM_BRIGHT_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "osm-bright",
);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let baseStylePromise: Promise<any> | null = null;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const themedStyles = new Map<MapTheme, any>();
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function loadStyle(theme: MapTheme): Promise<any> {
  if (!baseStylePromise) {
    baseStylePromise = readFile(join(OSM_BRIGHT_DIR, "style.json"), "utf8").then(
      (s) => JSON.parse(s),
    );
  }
  const cached = themedStyles.get(theme);
  if (cached) return cached;
  const styled = applyTheme(await baseStylePromise, theme);
  themedStyles.set(theme, styled);
  return styled;
}

/** Where an embedded object's (0,0) anchors. `geo` projects a coordinate;
 *  `path` projects the point at `position` (0..1) along a polyline. */
export type MapAnchorQuery =
  | { kind: "geo"; longitude: number; latitude: number }
  | { kind: "path"; points: Array<[number, number]>; position: number };

export interface MapViewInput {
  latitude: number;
  longitude: number;
  zoom: number;
  width: number;
  height: number;
  theme?: MapTheme;
  /** Basemap-only opacity (0..1, default 1); excludes paths/overlays. */
  mapOpacity?: number;
  paths?: MapPathInput[];
  /** Anchors to project to viewport pixels (embedded objects). The result's
   *  `anchorPixels` lines up index-for-index. */
  anchors?: MapAnchorQuery[];
}

export interface RenderedMap {
  canvas: NodeCanvas;
  width: number;
  height: number;
  /** Viewport pixels (top-left origin) for each requested anchor; null when
   *  unprojectable. Aligned with `input.anchors`. */
  anchorPixels?: Array<[number, number] | null>;
}

/** PMTiles Source backed by a node file handle — byte-range reads only. */
class NodeFileSource implements Source {
  private handle: FileHandle | null = null;
  constructor(private readonly filepath: string) {}
  getKey(): string {
    return this.filepath;
  }
  async getBytes(offset: number, length: number) {
    if (!this.handle) this.handle = await open(this.filepath, "r");
    const buffer = Buffer.alloc(length);
    await this.handle.read(buffer, 0, length, offset);
    const ab = buffer.buffer.slice(
      buffer.byteOffset,
      buffer.byteOffset + buffer.byteLength,
    ) as ArrayBuffer;
    return { data: ab };
  }
  async close() {
    if (this.handle) {
      await this.handle.close();
      this.handle = null;
    }
  }
}

/** A pool of decoded-tile sources keyed by source filename, warm across a
 *  graphic's frames. Held by `createGraphicFrameRenderer`; disposed at the
 *  end (closing the underlying file handles). */
export function createTileSourcePool(basePath?: string): TileSourcePool {
  return new TileSourcePool((filename) => {
    const abs = isAbsolute(filename)
      ? filename
      : join(basePath ?? process.cwd(), filename);
    return Promise.resolve(new NodeFileSource(abs));
  });
}

/** Rasterize one map view to a node-canvas + project the requested anchors.
 *  Awaits the covering tiles into `tiles`, then draws synchronously. */
export async function renderMapView(
  tiles: TileSource,
  input: MapViewInput,
): Promise<RenderedMap> {
  registerNodeCanvasFonts(); // labels resolve to node-canvas-registered families
  const style = await loadStyle(input.theme === "dark" ? "dark" : "light");
  const header = await tiles.header();
  const view = new MapView(
    input,
    header?.minZoom ?? 0,
    header?.maxZoom ?? 22,
    header ?? undefined,
  );
  await tiles.ensure(view.tileZoom, view.tileRange());

  const canvas = createCanvas(input.width, input.height);
  const ctx = canvas.getContext("2d") as unknown as CanvasRenderingContext2D;
  // mapOpacity dims the basemap only. drawBasemap hardcodes per-feature
  // globalAlpha, so a single globalAlpha on the shared ctx wouldn't stick —
  // instead rasterize the basemap onto its own layer and composite that whole
  // layer at mapOpacity. Paths draw at full alpha afterward; embedded objects
  // are composited separately by render.ts.
  const mapOpacity = input.mapOpacity ?? 1;
  if (mapOpacity < 1) {
    const layer = createCanvas(input.width, input.height);
    const lctx = layer.getContext("2d") as unknown as CanvasRenderingContext2D;
    drawBasemap(lctx, view, style, tiles);
    ctx.globalAlpha = mapOpacity;
    ctx.drawImage(layer as unknown as CanvasImageSource, 0, 0);
    ctx.globalAlpha = 1;
  } else {
    drawBasemap(ctx, view, style, tiles);
  }
  drawPaths(ctx, view, input.paths);

  const anchorPixels = input.anchors?.map((a) =>
    a.kind === "geo"
      ? view.project(a.longitude, a.latitude)
      : view.projectPathFraction(a.points, a.position),
  );
  return { canvas, width: input.width, height: input.height, anchorPixels };
}

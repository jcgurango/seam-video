// Headless map rasterizer for `map` nodes — the Node adapter over the shared
// @seam/map drawing code (the same code the browser preview runs), on
// @napi-rs/canvas (Skia). Supplies the platform bits: a byte-range pmtiles
// Source over fs, a Skia 2D context, the bundled OSM Bright style, and the
// bundled fonts for labels.
//
// Flow per frame: sample the map's camera/paths at `drawTime` (core's
// `sampleMapState`, shared with the compositor's pin projection so overlays
// land exactly on the basemap), await every covering tile into the pooled
// TileSource, then draw synchronously and read the RGBA back.

import { open, readFile, type FileHandle } from "node:fs/promises";
import { isAbsolute, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { FetchSource, type Source } from "pmtiles";
import { createCanvas, type SKRSContext2D } from "@napi-rs/canvas";
import {
  TileSourcePool,
  MapView,
  drawBasemap,
  drawPaths,
  applyTheme,
  type MapTheme,
} from "@seam/map";
import { sampleMapState, type ResolvedMap } from "@seam/core";
import { installFonts } from "./text/fonts.js";
import type { NodeFrame } from "./NodeBackend.js";

// The bundled OSM Bright style lives at the package root (../osm-bright from
// src or dist). @seam/map reads text-font/paint directly and never fetches
// glyphs/sprite/source URLs, so the raw JSON is passed as-is.
// `SEAM_RENDERER_ASSETS` overrides the base dir when the renderer is bundled
// into another package (e.g. the published CLI), where the source-relative
// walk no longer lands on the assets. Resolved lazily so the host can set the
// env var before the first map render.
function osmBrightDir(): string {
  const base = process.env.SEAM_RENDERER_ASSETS;
  if (base) return join(base, "osm-bright");
  return join(dirname(fileURLToPath(import.meta.url)), "..", "osm-bright");
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let baseStylePromise: Promise<any> | null = null;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const themedStyles = new Map<MapTheme, any>();
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function loadStyle(theme: MapTheme): Promise<any> {
  if (!baseStylePromise) {
    baseStylePromise = readFile(join(osmBrightDir(), "style.json"), "utf8").then(
      (s) => JSON.parse(s),
    );
  }
  const cached = themedStyles.get(theme);
  if (cached) return cached;
  const styled = applyTheme(await baseStylePromise, theme);
  themedStyles.set(theme, styled);
  return styled;
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

/** Rasterizes `map` nodes to RGBA frames. One per render run: the pooled
 *  TileSources (decoded tiles, keyed by source filename) stay warm across
 *  frames and nodes; `dispose()` closes the underlying file handles. */
export class MapRasterizer {
  private readonly pool: TileSourcePool;

  constructor(basePath: string) {
    this.pool = new TileSourcePool((filename) => {
      // Remote pmtiles (e.g. a cloud streaming URL from a remote .seam) — let
      // pmtiles' own byte-range fetcher handle it, like the preview does.
      if (/^https?:\/\//i.test(filename)) {
        return Promise.resolve(new FetchSource(filename));
      }
      const abs = isAbsolute(filename) ? filename : join(basePath, filename);
      return Promise.resolve(new NodeFileSource(abs));
    });
  }

  /** Rasterize `node` at map-local `drawTime` into a `width`×`height` frame
   *  (the compositor's per-frame inner-canvas size). */
  async render(
    node: ResolvedMap,
    drawTime: number,
    width: number,
    height: number,
  ): Promise<NodeFrame> {
    installFonts(); // labels resolve to the bundled Skia-registered families
    const W = Math.max(1, Math.round(width));
    const H = Math.max(1, Math.round(height));
    const duration = node.timelineEnd - node.timelineStart;
    const state = sampleMapState(node, Math.max(0, drawTime), duration);

    const tiles = this.pool.acquire(node.source);
    const style = await loadStyle(state.theme);
    const header = await tiles.header();
    const view = new MapView(
      { latitude: state.latitude, longitude: state.longitude, zoom: state.zoom, width: W, height: H },
      header?.minZoom ?? 0,
      header?.maxZoom ?? 22,
      header ?? undefined,
    );
    await tiles.ensure(view.tileZoom, view.tileRange());

    const canvas = createCanvas(W, H);
    const ctx = canvas.getContext("2d") as SKRSContext2D;
    const c2d = ctx as unknown as CanvasRenderingContext2D;
    // mapOpacity dims the basemap only. drawBasemap sets per-feature
    // globalAlpha itself, so a single alpha on the shared ctx wouldn't stick —
    // rasterize the basemap onto its own layer and composite that layer at
    // mapOpacity. Paths draw at full alpha afterward; children are separate
    // nodes composited by the GPU.
    if (state.mapOpacity < 1) {
      const layer = createCanvas(W, H);
      const lctx = layer.getContext("2d") as unknown as CanvasRenderingContext2D;
      drawBasemap(lctx, view, style, tiles);
      ctx.globalAlpha = state.mapOpacity;
      ctx.drawImage(layer, 0, 0);
      ctx.globalAlpha = 1;
    } else {
      drawBasemap(c2d, view, style, tiles);
    }
    drawPaths(c2d, view, state.paths);

    const id = ctx.getImageData(0, 0, W, H);
    return { data: id.data, width: W, height: H };
  }

  /** Close every pooled archive's file handle. */
  async dispose(): Promise<void> {
    await this.pool.dispose();
  }
}

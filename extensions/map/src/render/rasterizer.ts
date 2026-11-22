// The `map` node's rasterizer — one implementation for both hosts.
//
// Mirrors how an image works: a pooled `TileSource` per archive owns the async
// fetch + decode and an in-memory cache of UNPACKED tiles (never rasters);
// `draw` is fully synchronous over whatever is decoded right now.
//
//  - The live preview calls `draw` every frame. Missing tiles are requested
//    and land later; the pool's change event marks every canvas stale and
//    asks the host to repaint, so the frame fills in like a half-loaded image.
//  - The offline renderer awaits `ensure` first (header + the covering
//    tiles), so its `draw` always has everything.
//
// The camera / paths are sampled with `sampleMapState` at the map-local
// `drawTime` the render list computed — the same sampler the pin projection
// uses, so pinned children land exactly on the basemap.

import type { Source } from "pmtiles";
import type { CanvasLike, ExtensionNodeView, NodeRasterizer, RasterHost } from "@seam/core";
import { MapView } from "../view.js";
import { sampleMapState, type MapTheme, type ResolvedMap } from "../index.js";
import { TileSourcePool } from "./tile-source.js";
import { drawBasemap, drawPaths } from "./rasterize.js";
import { applyTheme } from "./theme.js";
import { OSM_BRIGHT_STYLE } from "./osmBrightStyle.js";

interface Entry {
  canvas: CanvasLike;
  ctx: CanvasRenderingContext2D;
  /** Last (drawTime, w, h) rasterized — skip identical redraws. */
  lastT: number;
  lastW: number;
  lastH: number;
  /** A tile/header landed since the last draw → redraw even at the same time. */
  wake: boolean;
}

export function createMapRasterizer(host: RasterHost): NodeRasterizer {
  // Decoded tiles stay cached per archive across every map node and every
  // frame, for as long as the host keeps this rasterizer.
  const pool = new TileSourcePool((source) => host.openSource(source) as Promise<Source | null>);
  const entries = new Map<ExtensionNodeView, Entry>();
  /** Sources whose header + tiles an `ensure` has finished loading. `draw`
   *  never shows the loading placeholder for these. */
  const settled = new Set<string>();

  pool.onChange(() => {
    for (const e of entries.values()) e.wake = true;
    host.requestRepaint();
  });

  // Themed styles, derived from the base once per theme (light = base verbatim).
  const themedStyles = new Map<MapTheme, unknown>();
  const styleFor = (theme: MapTheme): unknown => {
    let s = themedStyles.get(theme);
    if (!s) {
      s = applyTheme(OSM_BRIGHT_STYLE, theme);
      themedStyles.set(theme, s);
    }
    return s;
  };

  const sizeOf = (w: number, h: number): [number, number] => [
    Math.max(1, Math.round(w)),
    Math.max(1, Math.round(h)),
  ];

  return {
    draw(view: ExtensionNodeView, drawTime: number, w: number, h: number): CanvasLike | null {
      const node = view as unknown as ResolvedMap;
      const [W, H] = sizeOf(w, h);
      let entry = entries.get(view);
      if (!entry) {
        const canvas = host.createCanvas(W, H);
        const ctx = canvas.getContext("2d") as CanvasRenderingContext2D | null;
        if (!ctx) return null;
        entry = { canvas, ctx, lastT: NaN, lastW: W, lastH: H, wake: true };
        entries.set(view, entry);
      }
      const t = Math.max(0, drawTime);
      if (
        !entry.wake &&
        Math.abs(t - entry.lastT) < 0.001 &&
        entry.lastW === W &&
        entry.lastH === H
      ) {
        return entry.canvas;
      }
      if (entry.lastW !== W || entry.lastH !== H) {
        entry.canvas.width = W;
        entry.canvas.height = H;
        entry.lastW = W;
        entry.lastH = H;
      }
      entry.lastT = t;
      entry.wake = false;

      const { ctx } = entry;
      ctx.clearRect(0, 0, W, H);
      const tiles = pool.acquire(node.source);
      const header = tiles.headerNow();
      const ready = settled.has(node.source);
      // Not ready (header still loading, or a non-vector archive): placeholder.
      // The header load bubbles up via the pool → redraw. A host that awaited
      // `ensure` never sees it — whatever loaded is what there is.
      if (!ready && (!header || header.tileType !== 1)) {
        // save/restore: this canvas is reused for the real draw, which must
        // not inherit the placeholder's text alignment / font.
        ctx.save();
        ctx.fillStyle = "#2a2a2a";
        ctx.fillRect(0, 0, W, H);
        ctx.fillStyle = "#666";
        ctx.font = "16px sans-serif";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText("loading map…", W / 2, H / 2);
        ctx.restore();
        return entry.canvas;
      }
      const duration = node.timelineEnd - node.timelineStart;
      const state = sampleMapState(node, t, duration);
      const mapView = new MapView(
        { latitude: state.latitude, longitude: state.longitude, zoom: state.zoom, width: W, height: H },
        header?.minZoom ?? 0,
        header?.maxZoom ?? 22,
        header ?? undefined,
      );
      const style = styleFor(state.theme);
      // mapOpacity dims the basemap only. drawBasemap sets per-feature
      // globalAlpha itself, so a single alpha on the shared ctx wouldn't stick
      // — rasterize the basemap onto its own layer and composite that layer
      // at mapOpacity. Paths draw at full alpha afterward (children are their
      // own nodes, composited by the GPU).
      if (state.mapOpacity < 1) {
        const layer = host.createCanvas(W, H);
        const lctx = layer.getContext("2d") as CanvasRenderingContext2D | null;
        if (lctx) {
          drawBasemap(lctx, mapView, style, tiles);
          ctx.globalAlpha = state.mapOpacity;
          ctx.drawImage(layer as unknown as CanvasImageSource, 0, 0);
          ctx.globalAlpha = 1;
        }
      } else {
        drawBasemap(ctx, mapView, style, tiles);
      }
      drawPaths(ctx, mapView, state.paths);
      return entry.canvas;
    },

    async ensure(view: ExtensionNodeView, drawTime: number, w: number, h: number): Promise<void> {
      const node = view as unknown as ResolvedMap;
      const [W, H] = sizeOf(w, h);
      const duration = node.timelineEnd - node.timelineStart;
      const state = sampleMapState(node, Math.max(0, drawTime), duration);
      const tiles = pool.acquire(node.source);
      const header = await tiles.header();
      const mapView = new MapView(
        { latitude: state.latitude, longitude: state.longitude, zoom: state.zoom, width: W, height: H },
        header?.minZoom ?? 0,
        header?.maxZoom ?? 22,
        header ?? undefined,
      );
      await tiles.ensure(mapView.tileZoom, mapView.tileRange());
      settled.add(node.source);
    },

    /** Drop per-timeline canvases (the tile pool stays warm). */
    clear(): void {
      entries.clear();
    },

    /** Close every pooled archive. */
    async dispose(): Promise<void> {
      entries.clear();
      await pool.dispose();
    },
  };
}

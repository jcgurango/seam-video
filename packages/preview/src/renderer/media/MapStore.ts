// Browser-side rasterizer for `map` nodes — mirrors TextStore's shape: one
// canvas per ResolvedMap that the compositor uploads as the node's texture.
//
// The basemap is drawn synchronously by @seam/map from whatever tiles the
// pooled TileSource has decoded right now (missing ones are requested and
// bubble up via `subscribeMapWake` → `onFrameAvailable`, so the frame fills in
// like a half-loaded image). The camera/paths are sampled with core's
// `sampleMapState` at the map-local `drawTime` the render list computed — the
// same sampler the compositor uses to project pinned attachments, so overlays
// land exactly on the basemap. Driven per frame by `FrameCoordinator.
// applyContentSizes` (which hands over each map draw's time + inner size), so
// nested-composition time mapping never has to be duplicated here.

import type { ResolvedMap } from "@seam/core";
import { sampleMapState } from "@seam/core";
import { MapView, drawBasemap, drawPaths } from "@seam/map";
import { mapTilePool, mapStyleFor, subscribeMapWake } from "./mapPool.js";

interface MapEntry {
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  /** Last (drawTime, w, h) rasterized — skip identical redraws. */
  lastT: number;
  lastW: number;
  lastH: number;
  /** A tile/header landed since the last draw → redraw even at the same time. */
  wake: boolean;
}

export class MapStore {
  private entries = new Map<ResolvedMap, MapEntry>();
  private unsub: (() => void) | null = null;
  /** Fires when a map canvas has been (re-)drawn so the outer render loop can
   *  repaint while paused (tile loads). */
  onFrameAvailable: (() => void) | null = null;

  constructor() {
    this.unsub = subscribeMapWake(() => {
      for (const e of this.entries.values()) e.wake = true;
      this.onFrameAvailable?.();
    });
  }

  /** Rasterize `node` for map-local `drawTime` at `w`×`h` (the compositor's
   *  per-frame inner-canvas size). Synchronous; no-op when nothing changed. */
  draw(node: ResolvedMap, drawTime: number, w: number, h: number): void {
    const W = Math.max(1, Math.round(w));
    const H = Math.max(1, Math.round(h));
    let entry = this.entries.get(node);
    if (!entry) {
      const canvas = document.createElement("canvas");
      canvas.width = W;
      canvas.height = H;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      entry = { canvas, ctx, lastT: NaN, lastW: W, lastH: H, wake: true };
      this.entries.set(node, entry);
    }
    const t = Math.max(0, drawTime);
    if (
      !entry.wake &&
      Math.abs(t - entry.lastT) < 0.001 &&
      entry.lastW === W &&
      entry.lastH === H
    ) {
      return;
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
    const tiles = mapTilePool.acquire(node.source);
    const header = tiles.headerNow();
    // Not ready (header still loading, or non-vector archive): placeholder.
    // The header load bubbles up via the pool → redraw.
    if (!header || header.tileType !== 1) {
      ctx.fillStyle = "#2a2a2a";
      ctx.fillRect(0, 0, W, H);
      ctx.fillStyle = "#666";
      ctx.font = "16px sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText("loading map…", W / 2, H / 2);
      return;
    }
    const duration = node.timelineEnd - node.timelineStart;
    const state = sampleMapState(node, t, duration);
    const view = new MapView(
      { latitude: state.latitude, longitude: state.longitude, zoom: state.zoom, width: W, height: H },
      header.minZoom,
      header.maxZoom,
      header,
    );
    const style = mapStyleFor(state.theme);
    // mapOpacity dims the basemap only. drawBasemap sets per-feature
    // globalAlpha itself, so composite a separate basemap layer at mapOpacity;
    // paths draw at full alpha afterward (attachments are their own nodes).
    if (state.mapOpacity < 1) {
      const layer = document.createElement("canvas");
      layer.width = W;
      layer.height = H;
      const lctx = layer.getContext("2d");
      if (lctx) {
        drawBasemap(lctx, view, style, tiles);
        ctx.globalAlpha = state.mapOpacity;
        ctx.drawImage(layer, 0, 0);
        ctx.globalAlpha = 1;
      }
    } else {
      drawBasemap(ctx, view, style, tiles);
    }
    drawPaths(ctx, view, state.paths);
  }

  getFrame(node: ResolvedMap): HTMLCanvasElement | null {
    return this.entries.get(node)?.canvas ?? null;
  }

  /** Drop per-timeline canvases (the tile pool is page-global and stays warm). */
  clear(): void {
    this.entries.clear();
  }

  dispose(): void {
    this.clear();
    this.unsub?.();
    this.unsub = null;
  }
}

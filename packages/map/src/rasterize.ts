// Platform-neutral basemap rasterizer: pmtiles byte-range reads → MVT decode
// → Mapbox-GL style evaluation → Canvas2D fills/lines/labels. Draws into any
// CanvasRenderingContext2D — the renderer hands it a node-canvas context, the
// preview hands it an HTMLCanvasElement context. No WebGL, no DOM, no OL.

import { MapView, truncateToFraction } from "./view.js";
import type { DecodedTile, TileProvider } from "./tile-source.js";
import {
  type AnyLayer,
  type Evaluator,
  featureFilter,
  makeEvaluator,
  paintEvaluator,
  colorToCss,
  resolveTextField,
  buildLabelFont,
  clamp01,
  clampNum,
} from "./style.js";

const BACKGROUND_FALLBACK = "#f8f4f0"; // OSM Bright base.

export interface MapPathInput {
  color: string;
  /** lon/lat pairs. */
  points: Array<[number, number]>;
  progress?: number;
  lineWidth?: number;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Ctx = CanvasRenderingContext2D;

const DEFAULT_LINE_WIDTH = 4;

/** Synchronously draw the basemap (geometry + labels) into `ctx` for the
 *  given view, from whatever decoded tiles the provider has in memory now.
 *  Missing tiles are requested fire-and-forget (they bubble up via the
 *  provider's onChange and get drawn on the next pass — like a half-loaded
 *  image filling in). Never blocks on I/O. */
export function drawBasemap(
  ctx: Ctx,
  view: MapView,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  style: any,
  tiles: TileProvider,
): void {
  // Clip to the viewport rect. Per-tile clips use the FULL tile rect (a tile
  // can be far larger than the viewport when overzoomed), so without this the
  // tile geometry spills outside (0,0,w,h) — invisible in the renderer (its
  // canvas IS w×h) but it bled across the shared fabric canvas in the preview.
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, 0, view.width, view.height);
  ctx.clip();

  paintBackground(ctx, style, view);

  // Collect the decoded tiles covering the viewport (requesting any missing),
  // keyed by their unwrapped slot `tx/ty` so screen placement stays correct
  // across the antimeridian.
  const range = view.tileRange();
  const present = new Map<string, DecodedTile>();
  for (let tx = range.x0; tx <= range.x1; tx++) {
    for (let ty = range.y0; ty <= range.y1; ty++) {
      if (ty < 0 || ty >= range.count) continue;
      const wx = ((tx % range.count) + range.count) % range.count;
      if (!tiles.has(view.tileZoom, wx, ty)) {
        tiles.request(view.tileZoom, wx, ty);
        continue;
      }
      const vt = tiles.getTile(view.tileZoom, wx, ty);
      if (vt) present.set(`${tx}/${ty}`, vt);
    }
  }

  drawGeometry(ctx, style, view, present, view.zoom);
  drawLabels(ctx, style, view, present, view.zoom);
  ctx.restore();
}

/** Draw animated path overlays (the app's route lines) on top of a basemap.
 *  Separate from rasterizeBasemap so it can run synchronously each frame (no
 *  tile fetch) over an already-rasterized basemap. */
export function drawPaths(
  ctx: Ctx,
  view: MapView,
  paths: MapPathInput[] | undefined,
): void {
  if (!paths?.length) return;
  ctx.save();
  // Clip to the viewport (same reason as drawBasemap) so a path with points
  // outside the map rect doesn't bleed across the host canvas.
  ctx.beginPath();
  ctx.rect(0, 0, view.width, view.height);
  ctx.clip();
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  for (const p of paths) {
    if (!Array.isArray(p.points) || p.points.length < 2) continue;
    const screen = p.points.map(([lng, lat]) => view.project(lng, lat));
    const progress =
      typeof p.progress === "number" ? Math.max(0, Math.min(1, p.progress)) : 1;
    const revealed =
      progress >= 1 ? screen : truncateToFraction(screen, progress);
    if (revealed.length < 2) continue;
    ctx.beginPath();
    ctx.moveTo(revealed[0][0], revealed[0][1]);
    for (let i = 1; i < revealed.length; i++) {
      ctx.lineTo(revealed[i][0], revealed[i][1]);
    }
    ctx.strokeStyle = p.color;
    ctx.lineWidth = typeof p.lineWidth === "number" ? p.lineWidth : DEFAULT_LINE_WIDTH;
    ctx.stroke();
  }
  ctx.restore();
}

// ── internals ───────────────────────────────────────────────────────

function paintBackground(ctx: Ctx, style: AnyLayer, view: MapView): void {
  const bg = style.layers.find((l: AnyLayer) => l.type === "background");
  const color = bg
    ? colorToCss(
        paintEvaluator(
          "background",
          "background-color",
          bg.paint?.["background-color"],
          BACKGROUND_FALLBACK,
        )({ zoom: view.zoom }, {}),
      )
    : BACKGROUND_FALLBACK;
  ctx.fillStyle = color;
  ctx.fillRect(0, 0, view.width, view.height);
}

function drawGeometry(
  ctx: Ctx,
  style: AnyLayer,
  view: MapView,
  tiles: Map<string, DecodedTile>,
  zoom: number,
): void {
  for (const layer of style.layers as AnyLayer[]) {
    if (layer.type !== "fill" && layer.type !== "line") continue;
    if (layer.layout?.visibility === "none") continue;
    // Pattern fills/lines (sprite-based) aren't supported — skip rather than
    // fall back to a solid color (which would paint over the real fill).
    if (layer.paint?.["fill-pattern"] || layer.paint?.["line-pattern"]) continue;
    if (typeof layer.minzoom === "number" && zoom < layer.minzoom) continue;
    if (typeof layer.maxzoom === "number" && zoom >= layer.maxzoom) continue;

    const srcLayer = layer["source-layer"];
    if (!srcLayer) continue;
    const filter = featureFilter(layer.filter);
    const lineCap = (layer.layout?.["line-cap"] as CanvasLineCap) ?? "butt";
    const lineJoin = (layer.layout?.["line-join"] as CanvasLineJoin) ?? "miter";

    const ev =
      layer.type === "fill"
        ? {
            color: paintEvaluator("fill", "fill-color", layer.paint?.["fill-color"], "#000"),
            opacity: paintEvaluator("fill", "fill-opacity", layer.paint?.["fill-opacity"], 1),
            outline: paintEvaluator("fill", "fill-outline-color", layer.paint?.["fill-outline-color"], undefined),
          }
        : {
            color: paintEvaluator("line", "line-color", layer.paint?.["line-color"], "#000"),
            opacity: paintEvaluator("line", "line-opacity", layer.paint?.["line-opacity"], 1),
            width: paintEvaluator("line", "line-width", layer.paint?.["line-width"], 1),
            dash: paintEvaluator("line", "line-dasharray", layer.paint?.["line-dasharray"], undefined),
          };

    for (const [key, vt] of tiles) {
      const [txStr, tyStr] = key.split("/");
      const tx = Number(txStr);
      const ty = Number(tyStr);
      const vtLayer = vt.layers[srcLayer];
      if (!vtLayer) continue;
      const extent = vtLayer.extent || 4096;

      // Clip to the tile's exact square so the MVT buffer (geometry beyond the
      // extent) doesn't double-draw semi-transparent fills into a seam.
      const rect = view.tileScreenRect(tx, ty);
      ctx.save();
      ctx.beginPath();
      ctx.rect(rect.x, rect.y, rect.w, rect.h);
      ctx.clip();
      ctx.lineCap = lineCap;
      ctx.lineJoin = lineJoin;

      for (let i = 0; i < vtLayer.length; i++) {
        const feature = vtLayer.feature(i);
        if (!filter.filter({ zoom }, feature)) continue;
        const geom = feature.loadGeometry();
        const globals = { zoom };

        if (layer.type === "fill" && feature.type === 3) {
          ctx.beginPath();
          for (const ring of geom) {
            for (let p = 0; p < ring.length; p++) {
              const [X, Y] = view.tilePoint(tx, ty, extent, ring[p].x, ring[p].y);
              if (p === 0) ctx.moveTo(X, Y);
              else ctx.lineTo(X, Y);
            }
            ctx.closePath();
          }
          ctx.globalAlpha = clamp01((ev as { opacity: Evaluator }).opacity(globals, feature));
          ctx.fillStyle = colorToCss(ev.color(globals, feature));
          ctx.fill("nonzero");
          const outline = (ev as { outline: Evaluator }).outline(globals, feature);
          if (outline !== undefined) {
            ctx.globalAlpha = 1;
            ctx.lineWidth = 1;
            ctx.strokeStyle = colorToCss(outline);
            ctx.stroke();
          }
          ctx.globalAlpha = 1;
        } else if (layer.type === "line" && (feature.type === 2 || feature.type === 3)) {
          const lw = (ev as { width: Evaluator }).width(globals, feature);
          if (!(lw > 0)) continue;
          const dash = (ev as { dash: Evaluator }).dash(globals, feature);
          ctx.setLineDash(Array.isArray(dash) ? dash.map((d: number) => d * lw) : []);
          ctx.beginPath();
          for (const ring of geom) {
            for (let p = 0; p < ring.length; p++) {
              const [X, Y] = view.tilePoint(tx, ty, extent, ring[p].x, ring[p].y);
              if (p === 0) ctx.moveTo(X, Y);
              else ctx.lineTo(X, Y);
            }
          }
          ctx.globalAlpha = clamp01((ev as { opacity: Evaluator }).opacity(globals, feature));
          ctx.lineWidth = lw;
          ctx.strokeStyle = colorToCss(ev.color(globals, feature));
          ctx.stroke();
          ctx.globalAlpha = 1;
          ctx.setLineDash([]);
        }
      }
      ctx.restore();
    }
  }
}

interface Box {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

function drawLabels(
  ctx: Ctx,
  style: AnyLayer,
  view: MapView,
  tiles: Map<string, DecodedTile>,
  zoom: number,
): void {
  const placed: Box[] = [];
  const globals = { zoom };
  ctx.textBaseline = "top";
  ctx.lineJoin = "round";

  for (const layer of style.layers as AnyLayer[]) {
    if (layer.type !== "symbol") continue;
    if (layer.layout?.visibility === "none") continue;
    if (typeof layer.minzoom === "number" && zoom < layer.minzoom) continue;
    if (typeof layer.maxzoom === "number" && zoom >= layer.maxzoom) continue;
    const field = layer.layout?.["text-field"];
    if (!field) continue;
    const srcLayer = layer["source-layer"];
    if (!srcLayer) continue;

    const filter = featureFilter(layer.filter);
    const sizeEv = makeEvaluator("layout_symbol", "text-size", layer.layout?.["text-size"], 16);
    const placementEv = makeEvaluator("layout_symbol", "symbol-placement", layer.layout?.["symbol-placement"], "point");
    const colorEv = paintEvaluator("symbol", "text-color", layer.paint?.["text-color"], "#000");
    const haloColorEv = paintEvaluator("symbol", "text-halo-color", layer.paint?.["text-halo-color"], undefined);
    const haloWidthEv = paintEvaluator("symbol", "text-halo-width", layer.paint?.["text-halo-width"], 0);
    const anchor = (layer.layout?.["text-anchor"] as string) ?? "center";
    const offset = (layer.layout?.["text-offset"] as [number, number]) ?? [0, 0];
    const textFont = layer.layout?.["text-font"];

    for (const [key, vt] of tiles) {
      const [txStr, tyStr] = key.split("/");
      const tx = Number(txStr);
      const ty = Number(tyStr);
      const vtLayer = vt.layers[srcLayer];
      if (!vtLayer) continue;
      const extent = vtLayer.extent || 4096;

      for (let i = 0; i < vtLayer.length; i++) {
        const feature = vtLayer.feature(i);
        if (!filter.filter(globals, feature)) continue;
        const lines = resolveTextField(field, feature.properties);
        if (!lines.length) continue;

        const size = clampNum(sizeEv(globals, feature), 16);
        const placement = placementEv(globals, feature);
        ctx.font = buildLabelFont(textFont, size);

        const geom = feature.loadGeometry();
        let px: number;
        let py: number;
        let angle = 0;
        if (placement === "line" && (feature.type === 2 || feature.type === 3)) {
          const pts = geom[0].map((p: { x: number; y: number }) =>
            view.tilePoint(tx, ty, extent, p.x, p.y),
          ) as Array<[number, number]>;
          if (pts.length < 2) continue;
          const mid = lineMidpoint(pts);
          px = mid.x;
          py = mid.y;
          angle = mid.angle;
        } else {
          const p = geom[0][0];
          [px, py] = view.tilePoint(tx, ty, extent, p.x, p.y);
        }

        const lineHeight = size * 1.2;
        const widths = lines.map((l) => ctx.measureText(l).width);
        const blockW = Math.max(...widths);
        const blockH = lineHeight * lines.length;

        let ax = px + offset[0] * size;
        let ay = py + offset[1] * size;
        if (anchor.includes("left")) ax += 0;
        else if (anchor.includes("right")) ax -= blockW;
        else ax -= blockW / 2;
        if (anchor.includes("top")) ay += 0;
        else if (anchor.includes("bottom")) ay -= blockH;
        else ay -= blockH / 2;

        // Greedy declutter (also dedupes cross-tile buffer duplicates).
        const box: Box = { x0: ax - 1, y0: ay - 1, x1: ax + blockW + 1, y1: ay + blockH + 1 };
        if (placed.some((b) => box.x0 < b.x1 && box.x1 > b.x0 && box.y0 < b.y1 && box.y1 > b.y0)) {
          continue;
        }
        placed.push(box);

        const haloColor = haloColorEv(globals, feature);
        const haloWidth = clampNum(haloWidthEv(globals, feature), 0);
        const fillColor = colorToCss(colorEv(globals, feature));

        ctx.save();
        if (angle !== 0) {
          const cxp = px + offset[0] * size;
          const cyp = py + offset[1] * size;
          ctx.translate(cxp, cyp);
          ctx.rotate(angle);
          ctx.translate(-cxp, -cyp);
        }
        for (let li = 0; li < lines.length; li++) {
          const lineX = ax + (blockW - widths[li]) / 2; // center-justify
          const lineY = ay + li * lineHeight;
          if (haloColor !== undefined && haloWidth > 0) {
            ctx.strokeStyle = colorToCss(haloColor);
            ctx.lineWidth = haloWidth * 2;
            ctx.strokeText(lines[li], lineX, lineY);
          }
          ctx.fillStyle = fillColor;
          ctx.fillText(lines[li], lineX, lineY);
        }
        ctx.restore();
      }
    }
  }
}

/** Midpoint (by length) of a projected polyline + the local tangent angle,
 *  clamped near-horizontal so labels stay upright. */
function lineMidpoint(
  pts: Array<[number, number]>,
): { x: number; y: number; angle: number } {
  let total = 0;
  for (let i = 1; i < pts.length; i++) {
    total += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
  }
  const target = total / 2;
  let acc = 0;
  for (let i = 1; i < pts.length; i++) {
    const seg = Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
    if (acc + seg >= target) {
      const t = seg === 0 ? 0 : (target - acc) / seg;
      const x = pts[i - 1][0] + (pts[i][0] - pts[i - 1][0]) * t;
      const y = pts[i - 1][1] + (pts[i][1] - pts[i - 1][1]) * t;
      let angle = Math.atan2(pts[i][1] - pts[i - 1][1], pts[i][0] - pts[i - 1][0]);
      if (angle > Math.PI / 2) angle -= Math.PI;
      if (angle < -Math.PI / 2) angle += Math.PI;
      return { x, y, angle };
    }
    acc += seg;
  }
  return { x: pts[0][0], y: pts[0][1], angle: 0 };
}

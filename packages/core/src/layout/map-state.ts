// Per-frame state of a `map` node: the camera, basemap opacity and paths with
// every keyframed field sampled at a map-local time. Defined once so the
// compositor (pin projection), the headless renderer and the browser preview
// all rasterize/project against the same camera for the same instant.

import type { ResolvedMap } from "../resolved-types.js";
import { sampleColor, sampleNumber, sampleZoom } from "../animation/keyframes.js";

export interface MapPathState {
  id?: string;
  color: string;
  /** [[lng, lat], ...] */
  points: [number, number][];
  /** 0..1 fraction drawn (1 when unset). */
  progress: number;
  /** Display px (undefined → the rasterizer's default). */
  lineWidth?: number;
}

export interface MapState {
  latitude: number;
  longitude: number;
  /** maplibre-512 zoom. */
  zoom: number;
  /** Basemap-only opacity, 0..1. */
  mapOpacity: number;
  theme: "light" | "dark";
  paths: MapPathState[];
}

export const DEFAULT_MAP_ZOOM = 1;

/** Sample a map's animatable fields at map-local time `t` over `duration`. */
export function sampleMapState(map: ResolvedMap, t: number, duration: number): MapState {
  return {
    latitude: map.latitude != null ? sampleNumber(map.latitude, t, duration) : 0,
    longitude: map.longitude != null ? sampleNumber(map.longitude, t, duration) : 0,
    zoom: map.zoom != null ? sampleZoom(map.zoom, t, duration) : DEFAULT_MAP_ZOOM,
    mapOpacity: map.mapOpacity != null ? sampleNumber(map.mapOpacity, t, duration) : 1,
    theme: map.theme === "dark" ? "dark" : "light",
    paths: (map.paths ?? []).map((p) => ({
      ...(p.id != null ? { id: p.id } : {}),
      color: sampleColor(p.color, t, duration),
      points: p.points,
      progress: p.progress != null ? sampleNumber(p.progress, t, duration) : 1,
      ...(p.lineWidth != null ? { lineWidth: sampleNumber(p.lineWidth, t, duration) } : {}),
    })),
  };
}

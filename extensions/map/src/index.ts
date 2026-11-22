// Map — a Seam extension.
//
// The `map` node: a basemap rasterized from a pmtiles archive, used like a
// `static` with a camera. `latitude` / `longitude` / `zoom` / `mapOpacity` are
// animatable, `paths` draw geo polylines over it, and `children` are ordinary
// nodes of any type composited over the map. A child carrying a **`pin`** has
// its `origin` placed at the pin's projected point (its `translation` then
// acts as a pixel offset from there).
//
// This entry is PURE: the node definition, the `pin` field, their types and
// the samplers / projection both hosts share. It has no rasterizer and pulls
// in none of its dependencies — hosts that render import
// `@seam/extension-map/render`, which exports the same extension with the
// rasterizer attached.
//
// The extension imports only the public extension API (`@seam/core`).

import {
  sampleColor,
  sampleKeyframes,
  sampleNumber,
  type ChildAnchor,
  type ExtensionNodeBase,
  type ExtensionNodeView,
  type FieldSpec,
  type Keyframed,
  type NodeTypeDef,
  type ResolvedChild,
  type ResolvedExtensionNode,
  type SeamExtension,
} from "@seam/core";
import { lngLatToWorld, truncateToFraction } from "./view.js";

export {
  MapView,
  lngLatToWorld,
  truncateToFraction,
  TILE_SIZE,
  type MapCamera,
  type TileRange,
  type DataBounds,
} from "./view.js";

// ── Types ───────────────────────────────────────────────────────────

/**
 * Where a map child is anchored: a geographic coordinate, or a fraction
 * along one of the map's `paths` (by index or path `id`). `position` defaults
 * to that path's current `progress`, so the node rides the head of the
 * reveal. Keyframes interpolate lat/lng (geo→geo) or `position` (same path →
 * same path); a change of kind or path snaps at the keyframe.
 */
export type Pin =
  | { latitude: number; longitude: number }
  | { path: number | string; position?: number };

/** Geo polyline drawn over a map. */
export interface MapPath {
  /** Referenced by `pin: { path: "<id>" }`; else pins address by index. */
  id?: string;
  color: Keyframed<string>;
  /** [[lng, lat], ...] — at least two points. Not animatable. */
  points: [number, number][];
  /** 0..1 fraction of the line drawn. Default 1. Animatable. */
  progress?: Keyframed<number>;
  /** Stroke width in display pixels. Default 4. Animatable. */
  lineWidth?: Keyframed<number>;
}

export type MapTheme = "light" | "dark";

/** The map's own fields (authored and resolved alike). */
interface MapFields {
  /** pmtiles archive — host-resolved like clip/static `source`. */
  source: string;
  latitude?: Keyframed<number>;
  longitude?: Keyframed<number>;
  /** maplibre-512 convention; interpolates in scale space (linear in 2^-zoom). */
  zoom?: Keyframed<number>;
  /** Basemap-only opacity (tiles); paths/children unaffected. */
  mapOpacity?: Keyframed<number>;
  theme?: MapTheme;
  paths?: MapPath[];
}

/**
 * A basemap rasterized from a pmtiles archive with an animatable camera, geo
 * `paths`, and ordinary nodes composited over it as `children` (placed
 * geographically via `pin`). The inner canvas (`contentWidth` /
 * `contentHeight`, default 100% of the parent) is both the raster size and
 * the layout space the children resolve against.
 */
export interface MapNode extends ExtensionNodeBase<"map">, MapFields {}

/** A map after resolution. Its `children` are in map-local time (0 = the
 *  map's start, speed 1), laid out against the map's inner canvas. */
export interface ResolvedMap extends ResolvedExtensionNode<"map">, MapFields {
  children: ResolvedChild[];
}

declare module "@seam/core" {
  interface ExtensionNodeTypes {
    map: MapNode;
  }
  interface ResolvedExtensionNodeTypes {
    map: ResolvedMap;
  }
  interface VisualExtensionFields {
    /** Geo / path anchor — only meaningful on a `map`'s children: the node's
     *  `origin` lands at the pin's projected point and `translation` becomes
     *  a pixel offset from there. Ignored elsewhere. Animatable. */
    pin?: Keyframed<Pin>;
  }
}

// ── Samplers ────────────────────────────────────────────────────────

/** Map zoom (maplibre-512 convention). Interpolates in SCALE space — linear in
 *  2^-zoom (metres per pixel) — so a zoom tween reads as a constant-rate
 *  dolly rather than an exponential rush at the end. */
export function sampleZoom(value: Keyframed<number>, t: number, duration: number): number {
  if (!Array.isArray(value)) return value;
  const scale = sampleKeyframes<number, number>(
    value,
    t,
    duration,
    (z) => Math.pow(2, -z),
    (a, b, f) => a + (b - a) * f,
  );
  if (scale > 0) return -Math.log2(scale);
  // Degenerate (non-positive scale): hold the last keyframe by time.
  return sampleNumber(value, Number.POSITIVE_INFINITY, duration);
}

/** Map child anchor. Geo→geo tweens lat/lng; same-path→same-path tweens
 *  `position` (a missing position holds the "ride the head" default, which is
 *  resolved against the path's live `progress`, so it stays discrete); any
 *  change of kind or path snaps at the keyframe. */
export function samplePin(value: Keyframed<Pin>, t: number, duration: number): Pin {
  return sampleKeyframes<Pin, Pin>(
    value,
    t,
    duration,
    (p) => p,
    (a, b, f) => {
      if ("latitude" in a && "latitude" in b) {
        return {
          latitude: a.latitude + (b.latitude - a.latitude) * f,
          longitude: a.longitude + (b.longitude - a.longitude) * f,
        };
      }
      if (
        "path" in a &&
        "path" in b &&
        a.path === b.path &&
        typeof a.position === "number" &&
        typeof b.position === "number"
      ) {
        return { path: a.path, position: a.position + (b.position - a.position) * f };
      }
      return f < 1 ? a : b;
    },
  );
}

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

/** Per-frame state of a `map` node: the camera, basemap opacity and paths
 *  with every keyframed field sampled at a map-local time. */
export interface MapState {
  latitude: number;
  longitude: number;
  /** maplibre-512 zoom. */
  zoom: number;
  /** Basemap-only opacity, 0..1. */
  mapOpacity: number;
  theme: MapTheme;
  paths: MapPathState[];
}

export const DEFAULT_MAP_ZOOM = 1;

/** Sample a map's animatable fields at map-local time `t` over `duration`.
 *  The ONE sampler the pin projection and the rasterizer both use, so
 *  overlays land exactly on the basemap for the same instant. */
export function sampleMapState(
  map: Pick<ResolvedMap, "latitude" | "longitude" | "zoom" | "mapOpacity" | "theme" | "paths">,
  t: number,
  duration: number,
): MapState {
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

// ── Pin projection ──────────────────────────────────────────────────

/** A map's camera + paths at one instant, with its inner canvas size. */
interface MapContext {
  latitude: number;
  longitude: number;
  zoom: number;
  width: number;
  height: number;
  paths: MapPathState[];
}

/** lon/lat → map content px (top-left origin) for the camera in `ctx`.
 *  Same math as `MapView.project`, so overlays land exactly where the
 *  basemap rasterizer puts the geometry. */
function projectLngLat(ctx: MapContext, lng: number, lat: number): [number, number] {
  const [x, y] = lngLatToWorld(lng, lat, ctx.zoom);
  const [cx, cy] = lngLatToWorld(ctx.longitude, ctx.latitude, ctx.zoom);
  return [x - (cx - ctx.width / 2), y - (cy - ctx.height / 2)];
}

/** Project a pinned child's anchor into the map's content space (px). Null
 *  when the pin can't be resolved (unknown path) — the child then lays out
 *  as if unpinned. */
function projectPin(
  pin: Keyframed<Pin>,
  t: number,
  duration: number,
  ctx: MapContext,
): { x: number; y: number } | null {
  const p = samplePin(pin, t, duration);
  if ("latitude" in p) {
    const [x, y] = projectLngLat(ctx, p.longitude, p.latitude);
    return { x, y };
  }
  const paths = ctx.paths ?? [];
  const path =
    typeof p.path === "number" ? paths[p.path] : paths.find((pp) => pp.id === p.path);
  if (!path || path.points.length < 2) return null;
  const position = p.position ?? path.progress;
  const screen = path.points.map(([lng, lat]) => projectLngLat(ctx, lng, lat));
  const frac = Math.max(0, Math.min(1, position));
  const pt = frac >= 1 ? screen[screen.length - 1] : truncateToFraction(screen, frac).at(-1);
  return pt ? { x: pt[0], y: pt[1] } : null;
}

/** This frame's anchor function for a map's children: the camera is sampled
 *  ONCE at the map-local time the basemap rasterizes for, then each pinned
 *  child is projected against it at the child's own local time. */
function createAnchors(
  node: ExtensionNodeView,
  t: number,
  duration: number,
  inner: { width: number; height: number },
): ChildAnchor {
  const st = sampleMapState(node as unknown as ResolvedMap, t, duration);
  const ctx: MapContext = {
    latitude: st.latitude,
    longitude: st.longitude,
    zoom: st.zoom,
    width: inner.width,
    height: inner.height,
    paths: st.paths,
  };
  return (child, childT, childDuration) => {
    const pin = child.ext?.pin as Keyframed<Pin> | undefined;
    return pin != null ? projectPin(pin, childT, childDuration, ctx) : null;
  };
}

// ── The definition ──────────────────────────────────────────────────

const GROUP = "Map";

const mapFields: FieldSpec[] = [
  {
    key: "source", type: "string", required: true, source: true,
    label: "Source", group: "Media",
  },
  {
    key: "latitude", type: "number", animatable: true, min: -90, max: 90, default: 0,
    label: "Latitude", group: GROUP,
  },
  {
    key: "longitude", type: "number", animatable: true, min: -180, max: 180, default: 0,
    label: "Longitude", group: GROUP,
  },
  {
    key: "zoom", type: "number", animatable: true, min: 0, default: DEFAULT_MAP_ZOOM,
    label: "Zoom", group: GROUP, hint: "maplibre-512 zoom; tweens in scale space.",
    sample: (value, t, duration) => sampleZoom(value as Keyframed<number>, t, duration),
  },
  {
    key: "mapOpacity", type: "number", animatable: true, min: 0, max: 1, default: 1,
    label: "Basemap opacity", group: GROUP,
  },
  {
    key: "theme", type: "enum", options: ["light", "dark"], default: "light",
    label: "Theme", group: GROUP,
  },
  {
    // Geo polylines. Structured → JSON panel.
    key: "paths", type: "custom",
    schema: (z, h) =>
      z.array(
        z.object({
          // Referenced by a `pin: { path: "<id>" }`; else pins address paths by index.
          id: z.string().min(1).optional(),
          color: h.keyframed(z.string()),
          // [[lng, lat], ...] — at least two points. Not animatable.
          points: z.array(z.tuple([z.number(), z.number()])).min(2),
          // 0..1 fraction of the line drawn (the rest is hidden). Default 1.
          progress: h.keyframed(z.number().min(0).max(1)).optional(),
          // Stroke width in display pixels. Default 4.
          lineWidth: h.keyframed(z.number().positive()).optional(),
        }).strict(),
      ),
  },
];

/** Where a node's `origin` lands when it is a child of a `map`: either a
 *  geographic coordinate or a fraction along one of the map's `paths`. */
const pinField: FieldSpec = {
  key: "pin", nodes: "visual", type: "custom", anchor: true, animatable: true,
  schema: (z, h) =>
    h.keyframed(
      z.union([
        z.object({
          latitude: z.number().min(-90).max(90),
          longitude: z.number().min(-180).max(180),
        }).strict(),
        z.object({
          path: z.union([z.number().int().nonnegative(), z.string().min(1)]),
          position: z.number().min(0).max(1).optional(),
        }).strict(),
      ]),
    ),
};

/** The `map` node type, without a rasterizer. */
export const mapNode: NodeTypeDef = {
  type: "map",
  fields: mapFields,
  children: true,
  draws: true,
  createAnchors,
  editor: { color: "#2f7a5a", border: "#4bb886" },
  import: {
    extensions: ["pmtiles"],
    byteRange: true,
    // A whole-world view; the author frames it from there.
    create: (source, { duration }) => ({
      type: "map",
      source,
      duration,
      latitude: 0,
      longitude: 0,
      zoom: 1,
    }),
  },
};

/** The Map extension, pure (validate / compile / resolve / lay out). Hosts
 *  that render register `map` from `@seam/extension-map/render` instead. */
export const map: SeamExtension = {
  name: "map",
  fields: [pinField],
  nodes: [mapNode],
};

export default map;

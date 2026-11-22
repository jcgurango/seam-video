// Browser-side home of the rasterizers for extension node types that draw
// themselves (`NodeTypeDef.rasterizer` — e.g. the Map extension's `map`).
//
// Rasterizers are PAGE-LIFETIME: one per (Seam instance, node type), created
// on first use and never disposed, so whatever they cache (a map's decoded
// tiles) stays warm across timelines and <Timeline> remounts — like a decoded
// image. Per-timeline state is dropped with `clear()`.
//
// The host shell injects how to open a media `source` for byte-range reads
// (OPFS File on web, file:// on Electron) via `setByteSourceResolver` at boot.
// Async loads bubble up through `subscribeRasterWake` so the redraw loop can
// repaint while paused (the same way an image's load event does).

import type {
  ByteSource,
  CanvasLike,
  NodeRasterizer,
  RasterHost,
  RegisteredNodeType,
} from "@seam/core";

/** Async resolver from a node's `source` to a byte-range source. Null when
 *  missing. */
export type ByteSourceResolver = (source: string) => Promise<ByteSource | null>;

let resolver: ByteSourceResolver | null = null;

/** Host registration (each shell's main.tsx, at boot — before the first
 *  frame, since a rasterizer may cache each source permanently). */
export function setByteSourceResolver(fn: ByteSourceResolver | null): void {
  resolver = fn;
}

const wakeListeners = new Set<() => void>();

/** Subscribe to "a rasterizer finished loading something". Returns an
 *  unsubscriber. */
export function subscribeRasterWake(cb: () => void): () => void {
  wakeListeners.add(cb);
  return () => wakeListeners.delete(cb);
}

const host: RasterHost = {
  createCanvas(width, height) {
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    return canvas as unknown as CanvasLike;
  },
  openSource: (source) => (resolver ? resolver(source) : Promise.resolve(null)),
  requestRepaint() {
    for (const cb of wakeListeners) cb();
  },
};

type NodeTypes = ReadonlyMap<string, RegisteredNodeType>;
const rasterizers = new WeakMap<NodeTypes, Map<string, NodeRasterizer | null>>();

/** The page's rasterizer for `type` under this Seam instance's node types
 *  (`seam.nodeTypes`), or null when the type has none — its extension was
 *  registered from the pure entry instead of its `./render` entry. */
export function rasterizerFor(nodeTypes: NodeTypes, type: string): NodeRasterizer | null {
  let byType = rasterizers.get(nodeTypes);
  if (!byType) {
    byType = new Map();
    rasterizers.set(nodeTypes, byType);
  }
  let r = byType.get(type);
  if (r === undefined) {
    const create = nodeTypes.get(type)?.rasterizer;
    r = create ? create(host) : null;
    byType.set(type, r);
  }
  return r;
}

/** Drop every rasterizer's per-timeline state (their media caches stay). */
export function clearRasterizers(nodeTypes: NodeTypes): void {
  for (const r of rasterizers.get(nodeTypes)?.values() ?? []) r?.clear?.();
}

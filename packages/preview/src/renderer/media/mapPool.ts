// Browser-side home of the @seam/map TileSourcePool for `map` nodes. Seam
// owns the pool; the host shell injects how to open a pmtiles byte-range
// Source for a filename (OPFS File on web, file:// FetchSource on Electron)
// via `setPmtilesResolver` at boot. Decoded tiles stay cached per archive
// across every map node and every frame, like an Image's decoded bitmap.
//
// Tile loads bubble up through `subscribeMapWake` so the host's redraw loop
// can repaint while paused (the same way an Image's load event does).

import { type Source } from "pmtiles";
import { TileSourcePool, applyTheme, type MapTheme } from "@seam/map";
// Bundled OSM Bright style — same JSON the renderer reads from disk. Vite
// inlines it. @seam/map reads text-font/paint directly and never fetches the
// style's glyphs/sprite/source URLs, so we pass it through as-is.
import osmBrightStyle from "./osm-bright/style.json";

/** Async resolver from a `map.source` filename to a byte-range `Source`.
 *  Null when missing. */
export type PmtilesResolver = (filename: string) => Promise<Source | null>;

let resolver: PmtilesResolver | null = null;

/** Host registration (each shell's main.tsx, at boot — before the first map
 *  renders, since the pool caches each source permanently). */
export function setPmtilesResolver(fn: PmtilesResolver | null): void {
  resolver = fn;
}

/** The one pool. Stable for the page's lifetime. */
export const mapTilePool = new TileSourcePool((filename) =>
  resolver ? resolver(filename) : Promise.resolve(null),
);

const wakeListeners = new Set<() => void>();
mapTilePool.onChange(() => {
  for (const cb of wakeListeners) cb();
});

/** Subscribe to "a map tile (or header) finished loading anywhere". Returns
 *  an unsubscriber. */
export function subscribeMapWake(cb: () => void): () => void {
  wakeListeners.add(cb);
  return () => wakeListeners.delete(cb);
}

// Themed styles, derived from the base once per theme (light = base verbatim).
const themedStyles = new Map<MapTheme, unknown>();
export function mapStyleFor(theme: MapTheme): unknown {
  let s = themedStyles.get(theme);
  if (!s) {
    s = applyTheme(osmBrightStyle, theme);
    themedStyles.set(theme, s);
  }
  return s;
}

// TileSource — the stateful half of the map. Mirrors how an Image's bytes are
// fetched+decoded off to the side so the element only ever renders something
// already in memory. A TileSource owns a pmtiles archive and an in-memory
// cache of UNPACKED (decoded MVT) tiles — never rasters. Rasterization happens
// synchronously at draw time from these decoded tiles.
//
// Sync surface (TileProvider) is what the synchronous draw path consumes:
//   has()      — is this tile resolved (loaded, possibly empty)?
//   getTile()  — the decoded tile if present + non-empty, else null
//   request()  — fire-and-forget fetch+decode; bubbles up via onChange when done
//
// Async surface:
//   header()   — min/max zoom + tile type
//   ensure()   — await a whole tile range (the headless renderer's path)

import { PMTiles, type Source } from "pmtiles";
import { VectorTile } from "@mapbox/vector-tile";
import Pbf from "pbf";
import type { TileRange } from "./view.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type DecodedTile = any; // a @mapbox/vector-tile VectorTile

/** A resolved-but-empty tile (the archive has no data here). Distinct from
 *  "not loaded yet" so we don't re-request a known-empty tile forever. */
const EMPTY = Symbol("empty-tile");

export interface HeaderInfo {
  minZoom: number;
  maxZoom: number;
  tileType: number;
  /** Data extent (degrees), used to clamp the covering-tile range. */
  minLon: number;
  minLat: number;
  maxLon: number;
  maxLat: number;
}

/** The synchronous tile lookup the draw path needs. */
export interface TileProvider {
  has(z: number, x: number, y: number): boolean;
  getTile(z: number, x: number, y: number): DecodedTile | null;
  request(z: number, x: number, y: number): void;
}

type TileOpener = () => Promise<Source | null>;

export class TileSource implements TileProvider {
  private sourceP: Promise<Source | null>;
  private pmtilesP: Promise<PMTiles | null>;
  private headerP: Promise<HeaderInfo | null> | null = null;
  private headerValue: HeaderInfo | null = null;
  private readonly cache = new Map<string, VectorTile | typeof EMPTY>();
  private readonly inflight = new Map<string, Promise<void>>();
  private readonly listeners = new Set<() => void>();

  constructor(open: TileOpener) {
    this.sourceP = open();
    this.pmtilesP = this.sourceP.then((src) => (src ? new PMTiles(src) : null));
  }

  /** Subscribe to "a tile finished loading" — the bubble-up that drives a
   *  redraw, the same way an Image's load event does. Returns an unsubscriber. */
  onChange(cb: () => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  header(): Promise<HeaderInfo | null> {
    if (!this.headerP) {
      this.headerP = (async () => {
        const pm = await this.pmtilesP;
        if (!pm) return null;
        const h = await pm.getHeader();
        const info: HeaderInfo = {
          minZoom: h.minZoom,
          maxZoom: h.maxZoom,
          tileType: h.tileType,
          minLon: h.minLon,
          minLat: h.minLat,
          maxLon: h.maxLon,
          maxLat: h.maxLat,
        };
        this.headerValue = info;
        return info;
      })();
    }
    return this.headerP;
  }

  /** Synchronous header for the sync draw path: returns it if already resolved,
   *  else kicks the async load (bubbling up via onChange when ready) and
   *  returns null for now — like an Image before its bytes arrive. */
  headerNow(): HeaderInfo | null {
    if (!this.headerP) void this.header().then(() => this.notify());
    return this.headerValue;
  }

  has(z: number, x: number, y: number): boolean {
    return this.cache.has(key(z, x, y));
  }

  getTile(z: number, x: number, y: number): DecodedTile | null {
    const v = this.cache.get(key(z, x, y));
    return v && v !== EMPTY ? v : null;
  }

  /** Fire-and-forget: ensure this tile is fetched + decoded, then notify. No-op
   *  if already resolved or in flight. */
  request(z: number, x: number, y: number): void {
    const k = key(z, x, y);
    if (this.cache.has(k) || this.inflight.has(k)) return;
    void this.fetch(z, x, y).then(() => this.notify());
  }

  /** Await every tile in `range` at `tileZoom` (headless renderer path — draw
   *  once everything's in memory, no bubble-up). */
  async ensure(tileZoom: number, range: TileRange): Promise<void> {
    const ps: Array<Promise<void>> = [];
    for (let tx = range.x0; tx <= range.x1; tx++) {
      for (let ty = range.y0; ty <= range.y1; ty++) {
        if (ty < 0 || ty >= range.count) continue;
        const wx = ((tx % range.count) + range.count) % range.count;
        ps.push(this.fetch(tileZoom, wx, ty));
      }
    }
    await Promise.all(ps);
  }

  private fetch(z: number, x: number, y: number): Promise<void> {
    const k = key(z, x, y);
    if (this.cache.has(k)) return Promise.resolve();
    const existing = this.inflight.get(k);
    if (existing) return existing;
    const p = (async () => {
      const pm = await this.pmtilesP;
      if (!pm) return;
      const res = await pm.getZxy(z, x, y);
      this.cache.set(
        k,
        res ? new VectorTile(new Pbf(new Uint8Array(res.data))) : EMPTY,
      );
    })()
      .catch((err) => {
        // eslint-disable-next-line no-console
        console.error(`[map] tile ${k} fetch failed`, err);
      })
      .finally(() => this.inflight.delete(k));
    this.inflight.set(k, p);
    return p;
  }

  private notify(): void {
    for (const cb of this.listeners) cb();
  }

  /** Release the underlying byte Source if it exposes a `close()` (e.g. a node
   *  file handle). No-op for sources without one (browser FileSource/Fetch). */
  async dispose(): Promise<void> {
    const src = (await this.sourceP.catch(() => null)) as
      | (Source & { close?: () => unknown })
      | null;
    try {
      await src?.close?.();
    } catch {
      // ignore
    }
  }
}

function key(z: number, x: number, y: number): string {
  return `${z}/${x}/${y}`;
}

/** Pool of TileSources keyed by source filename, so the decoded-tile cache is
 *  shared across every Map that references the same archive (and stays warm
 *  across frames). Seam owns this: the host injects how to open a byte Source
 *  for a filename (OPFS / fs / fetch); the pool hands back reusable sources. */
export class TileSourcePool {
  private readonly sources = new Map<string, TileSource>();
  private readonly listeners = new Set<() => void>();

  constructor(private readonly opener: (filename: string) => Promise<Source | null>) {}

  acquire(filename: string): TileSource {
    let src = this.sources.get(filename);
    if (!src) {
      src = new TileSource(() => this.opener(filename));
      // Re-broadcast every source's loads so a single host subscription wakes
      // the redraw loop no matter which archive a tile came from.
      src.onChange(() => {
        for (const cb of this.listeners) cb();
      });
      this.sources.set(filename, src);
    }
    return src;
  }

  /** Notified whenever any pooled source loads a tile (or its header). */
  onChange(cb: () => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  /** Dispose every pooled source (closing file handles) and drop them. */
  async dispose(): Promise<void> {
    await Promise.all([...this.sources.values()].map((s) => s.dispose()));
    this.sources.clear();
  }

  clear(): void {
    this.sources.clear();
  }
}

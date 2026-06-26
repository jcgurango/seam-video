// Module-level base directory for resolving a Map element's `.pmtiles` `source`
// (which is stored relative to the .seam file's directory). The renderer learns
// it from the main process on every timeline update; the boot-registered
// pmtiles resolver (see main.tsx) reads it at acquire time.
//
// It lives module-global because the pmtiles resolver only receives the bare
// `source` filename — not the surrounding basePath — and the TileSource pool
// caches each source permanently (its opener runs once), so the resolver must
// be registered at boot while still seeing the latest basePath here.
let mapBasePath = "";

export function setMapBasePath(path: string): void {
  mapBasePath = path;
}

export function getMapBasePath(): string {
  return mapBasePath;
}

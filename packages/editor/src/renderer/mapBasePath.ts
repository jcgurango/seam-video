// Base directory for resolving a `map` node's `.pmtiles` `source` on Electron
// (stored relative to the .seam file). Module-global because the pmtiles
// resolver registered at boot (main.tsx) only receives the bare filename;
// App keeps it current. Mirrors @seam/preview's shell. Unused on web (OPFS).
let mapBasePath = "";

export function setMapBasePath(path: string): void {
  mapBasePath = path;
}

export function getMapBasePath(): string {
  return mapBasePath;
}

// @seam/map — platform-neutral DIY map rasterizer. Shared by the renderer
// (node-canvas, headless) and the preview (browser canvas inside fabric).
// pmtiles + MVT + Mapbox-GL style → Canvas2D. No OpenLayers, no WebGL, no DOM.
//
// Split of concerns mirrors how Images work: TileSource owns the async
// fetch+decode + an in-memory cache of UNPACKED tiles (never rasters); the
// draw path is fully synchronous over whatever's in memory now.

export {
  TileSource,
  TileSourcePool,
  type TileProvider,
  type DecodedTile,
  type HeaderInfo,
} from "./tile-source.js";
export {
  drawBasemap,
  drawPaths,
  type MapPathInput,
} from "./rasterize.js";
export {
  MapView,
  lngLatToWorld,
  truncateToFraction,
  TILE_SIZE,
  type MapCamera,
  type TileRange,
} from "./view.js";

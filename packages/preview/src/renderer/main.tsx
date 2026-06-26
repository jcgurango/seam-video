import React from "react";
import { createRoot } from "react-dom/client";
import App from "./App.js";
import {
  loadLiberationSans,
  loadFallbackFonts,
  loadMapLabelFonts,
} from "./fonts.js";
import { FetchSource } from "pmtiles";
import { setPmtilesResolver } from "./media/graphic/TileMap.js";
import { defaultResolveSource } from "./components/resolveSource.js";
import { getMapBasePath } from "./mapBasePath.js";

// Kick off font loading immediately so it's typically ready by the
// time the first text node renders. We don't await — first-paint
// shouldn't be blocked on a font, and any text drawn before the font
// is ready will reflow once it resolves (same as web fonts on the web).
loadLiberationSans();
// CJK + emoji fallbacks for text/graphic nodes and map labels.
loadFallbackFonts();
// Warm the map-label alias families too, so the first map's local glyph
// rasterization finds Liberation Sans already registered.
loadMapLabelFonts();

// Resolve a Map element's `.pmtiles` source to a byte-range Source. The preview
// always runs in Electron, so a file:// FetchSource is enough — the main
// process's custom file:// handler honors Range requests. basePath is the .seam
// file's directory, learned per timeline update (App keeps getMapBasePath()
// current). Registered at boot because the TileSource pool caches each source
// permanently — the resolver must already exist before the first map renders.
setPmtilesResolver(async (filename) => {
  const url = defaultResolveSource(filename, getMapBasePath());
  if (!url.startsWith("file://") && !url.startsWith("http")) return null;
  return new FetchSource(url);
});

const root = createRoot(document.getElementById("root")!);
root.render(<App />);

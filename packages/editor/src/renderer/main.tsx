import React from "react";
import { createRoot } from "react-dom/client";
import {
  loadLiberationSans,
  loadFallbackFonts,
  loadMapLabelFonts,
  setSourceResolver,
  setPmtilesResolver,
} from "@seam/preview";
import App from "./App.js";
import { detectPlatform, WebPlatform } from "./platform/index.js";
import type { Source } from "pmtiles";

const platform = detectPlatform();

// Seam Cloud is web-editor-only. When this entry runs as a web build (not
// Electron), wire the optional cloud connection from VITE_SEAM_CLOUD_URL —
// same as @seam/web's main.tsx.
if (platform instanceof WebPlatform) {
  const cloudUrl = (import.meta as { env?: Record<string, string | undefined> })
    .env?.VITE_SEAM_CLOUD_URL;
  const cloud = platform.configureCloud(cloudUrl);
  if (cloud) void cloud.restore();
}

// Bundle Liberation Sans as the default font so editor and final
// render agree on glyph metrics. Fire-and-forget — text drawn before
// the font resolves will reflow when it does, same as web fonts.
loadLiberationSans();
// CJK + emoji fallbacks for text/graphic nodes and map labels.
loadFallbackFonts();
// Warm the map-label alias families so the first map's local glyph
// rasterization finds Liberation Sans already registered.
loadMapLabelFonts();

// Let the media layer resolve clip sources via the selected platform
setSourceResolver((source, basePath) =>
  platform.resolveSource(source, basePath)
);

// pmtiles → byte-range Source — same shape on web (OPFS) + electron
// (file:// FetchSource). OpenLayersMap uses it when opening pmtiles.
setPmtilesResolver(async (filename: string) => {
  const src = await platform.openPmtilesSource(filename, "");
  return (src as Source | null) ?? null;
});

const root = createRoot(document.getElementById("root")!);
root.render(<App platform={platform} />);

import React from "react";
import { createRoot } from "react-dom/client";
import {
  loadLiberationSans,
  loadFallbackFonts,
  loadMapLabelFonts,
  setSourceResolver,
  setByteSourceResolver,
} from "@seam/preview";
import App from "./App.js";
import { detectPlatform, WebPlatform } from "./platform/index.js";
import { getMapBasePath } from "./mapBasePath.js";
import type { Source } from "pmtiles";
import { createSeam } from "@seam/core";
import { adjustments } from "@seam/extension-adjustments";
// The render entry: Captions WITH its overlay renderer.
import { captions } from "@seam/extension-captions/render";
import { captionsEditor } from "@seam/extension-captions/editor";
// The render entry: the Map extension WITH its rasterizer (this shell draws).
import { map } from "@seam/extension-map/render";

// One Seam instance per host: core plus the extensions this shell installs.
const seam = createSeam([adjustments, map, captions]);
const platform = detectPlatform(seam);

// Seam Cloud is web-editor-only. When this entry runs as a web build (not
// Electron), wire the optional cloud connection from VITE_SEAM_CLOUD_URL —
// same as @seam/web's main.tsx.
if (platform instanceof WebPlatform) {
  const runtimeCloudUrl = (window as unknown as { __SEAM_CLOUD_URL__?: string })
    .__SEAM_CLOUD_URL__;
  const buildCloudUrl = (
    import.meta as { env?: Record<string, string | undefined> }
  ).env?.VITE_SEAM_CLOUD_URL;
  const cloud = platform.configureCloud(runtimeCloudUrl || buildCloudUrl);
  if (cloud) void cloud.restore();
}

// Bundle Liberation Sans as the default font so editor and final
// render agree on glyph metrics. Fire-and-forget — text drawn before
// the font resolves will reflow when it does, same as web fonts.
loadLiberationSans();
// CJK + emoji fallbacks for text nodes and map labels.
loadFallbackFonts();
// Warm the map-label alias families so the first map's local glyph
// rasterization finds Liberation Sans already registered.
loadMapLabelFonts();

// Let the media layer resolve clip sources via the selected platform
setSourceResolver((source, basePath) =>
  platform.resolveSource(source, basePath)
);

// pmtiles → byte-range Source — same shape on web (OPFS) + electron
// (file:// FetchSource). `map` nodes use it when opening pmtiles.
setByteSourceResolver(async (filename: string) => {
  const src = await platform.openByteSource(filename, getMapBasePath());
  return (src as Source | null) ?? null;
});

const root = createRoot(document.getElementById("root")!);
// What the extensions add to the editor itself (toolbar commands, …).
const editorExtensions = [captionsEditor];
root.render(<App platform={platform} seam={seam} editorExtensions={editorExtensions} />);

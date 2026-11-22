import React from "react";
import { createRoot } from "react-dom/client";
import {
  setSourceResolver,
  setByteSourceResolver,
  loadLiberationSans,
  loadFallbackFonts,
  loadMapLabelFonts,
} from "@seam/preview";
import App from "@seam/editor/App";
import { WebPlatform } from "@seam/editor/platform";
import type { Source } from "pmtiles";
import { createSeam } from "@seam/core";
import { adjustments } from "@seam/extension-adjustments";
import { captions } from "@seam/extension-captions";
// The render entry: the Map extension WITH its rasterizer (this shell draws).
import { map } from "@seam/extension-map/render";

// One Seam instance per host: core plus the extensions this shell installs.
const seam = createSeam([adjustments, map, captions]);
const platform = new WebPlatform(seam);

// Bundle the same fonts the renderer uses (body + CJK/emoji fallbacks) so
// web text/map output matches the final render. Fire-and-forget.
loadLiberationSans();
loadFallbackFonts();
loadMapLabelFonts();

setSourceResolver((source, basePath) =>
  platform.resolveSource(source, basePath)
);

// `map` nodes need byte-range pmtiles access — the
// platform opens an OPFS-backed File and wraps it as a pmtiles Source.
// basePath is "" on web (OPFS clips/ is the resolution root).
setByteSourceResolver(async (filename: string) => {
  const src = await platform.openByteSource(filename, "");
  return (src as Source | null) ?? null;
});

// Optional Seam Cloud connection — web-editor-only. The base URL comes from a
// runtime-injected global (window.__SEAM_CLOUD_URL__, written by the container
// entrypoint from $SEAM_CLOUD_URL) and falls back to the build-time
// VITE_SEAM_CLOUD_URL for local dev. When set, the platform creates a
// CloudClient and we restore any prior session before mounting.
const runtimeCloudUrl = (window as unknown as { __SEAM_CLOUD_URL__?: string })
  .__SEAM_CLOUD_URL__;
const buildCloudUrl = (
  import.meta as { env?: Record<string, string | undefined> }
).env?.VITE_SEAM_CLOUD_URL;
const cloud = platform.configureCloud(runtimeCloudUrl || buildCloudUrl);
if (cloud) void cloud.restore();

const root = createRoot(document.getElementById("root")!);
root.render(<App platform={platform} seam={seam} />);

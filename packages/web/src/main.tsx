import React from "react";
import { createRoot } from "react-dom/client";
import {
  setSourceResolver,
  setPmtilesResolver,
  loadLiberationSans,
  loadFallbackFonts,
  loadMapLabelFonts,
} from "@seam/preview";
import App from "@seam/editor/App";
import { WebPlatform } from "@seam/editor/platform";
import type { Source } from "pmtiles";

const platform = new WebPlatform();

// Bundle the same fonts the renderer uses (body + CJK/emoji fallbacks) so
// web text/graphic/map output matches the final render. Fire-and-forget.
loadLiberationSans();
loadFallbackFonts();
loadMapLabelFonts();

setSourceResolver((source, basePath) =>
  platform.resolveSource(source, basePath)
);

// Map elements in graphics need byte-range pmtiles access — the
// platform opens an OPFS-backed File and wraps it as a pmtiles Source.
// basePath is "" on web (OPFS clips/ is the resolution root).
setPmtilesResolver(async (filename: string) => {
  const src = await platform.openPmtilesSource(filename, "");
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
root.render(<App platform={platform} />);

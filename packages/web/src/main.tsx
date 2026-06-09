import React from "react";
import { createRoot } from "react-dom/client";
import { setSourceResolver, setPmtilesResolver } from "@seam/preview";
import App from "@seam/editor/App";
import { WebPlatform } from "@seam/editor/platform";
import type { Source } from "pmtiles";

const platform = new WebPlatform();

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

const root = createRoot(document.getElementById("root")!);
root.render(<App platform={platform} />);

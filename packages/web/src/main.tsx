import React from "react";
import { createRoot } from "react-dom/client";
import { setSourceResolver } from "@seam/preview";
import App from "@seam/editor/App";
import { WebPlatform } from "@seam/editor/platform";

const platform = new WebPlatform();

setSourceResolver((source, basePath) =>
  platform.resolveSource(source, basePath)
);

const root = createRoot(document.getElementById("root")!);
root.render(<App platform={platform} />);

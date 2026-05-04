import React from "react";
import { createRoot } from "react-dom/client";
import { loadLiberationSans, setSourceResolver } from "@seam/preview";
import App from "./App.js";
import { detectPlatform } from "./platform/index.js";

const platform = detectPlatform();

// Bundle Liberation Sans as the default font so editor and final
// render agree on glyph metrics. Fire-and-forget — text drawn before
// the font resolves will reflow when it does, same as web fonts.
loadLiberationSans();

// Let the media layer resolve clip sources via the selected platform
setSourceResolver((source, basePath) =>
  platform.resolveSource(source, basePath)
);

const root = createRoot(document.getElementById("root")!);
root.render(<App platform={platform} />);

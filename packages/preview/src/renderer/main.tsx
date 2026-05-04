import React from "react";
import { createRoot } from "react-dom/client";
import App from "./App.js";
import { loadLiberationSans } from "./fonts.js";

// Kick off font loading immediately so it's typically ready by the
// time the first text node renders. We don't await — first-paint
// shouldn't be blocked on a font, and any text drawn before the font
// is ready will reflow once it resolves (same as web fonts on the web).
loadLiberationSans();

const root = createRoot(document.getElementById("root")!);
root.render(<App />);

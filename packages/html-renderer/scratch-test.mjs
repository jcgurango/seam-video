// One-off: render the html node from the prompt to SVG and dump it.
// Run from the package dir: `node scratch-test.mjs`.

import { htmlToSvg } from "./dist/index.js";
import { loadDefaultFonts } from "./dist/node-fonts.js";
import { writeFile } from "node:fs/promises";

const source =
  "<div style='position: absolute; top: 0; left: 0; right: 0; bottom: 0; align-items: flex-end; justify-content: center; display: flex;'><div style='color: white; font-size: 50px; padding: 200px 220px 500px 220px; font-weight: bold; text-align: center; -webkit-text-stroke: 20px black; display: flex;'>asdf  asdfasdf asdf afawf wa fwawe atweat awt awet <mark style='color: white;'>dasdf</mark> asdf</div></div>";

const fonts = await loadDefaultFonts();
const svg = await htmlToSvg(source, 1080, 1920, { fonts });
await writeFile("scratch-output.svg", svg);

console.log(`SVG: ${svg.length} chars, written to packages/html-renderer/scratch-output.svg`);
console.log();
console.log(svg);

import { readFileSync } from "fs";
import { parseSeamFile, resolveComposition } from "./packages/core/dist/index.js";

const json = readFileSync("test.seam", "utf-8");
const result = parseSeamFile(json);
if (result.success) {
  const timeline = resolveComposition(result.data);
  console.log(JSON.stringify(timeline, null, 2));
}

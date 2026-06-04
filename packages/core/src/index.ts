export * from "./schema.js";
export * from "./types.js";
export * from "./resolved-types.js";
export * from "./validate.js";
export { compileSeamFile, runScript } from "./compile.js";
export type { CompileError, CompileOptions, CompileResult } from "./compile.js";
export { resolveComposition } from "./layout/resolve.js";
export {
  resolveSpatial,
  resolveBoxProps,
  hasAnimatedSpatialInput,
  DEFAULT_CANVAS_WIDTH,
  DEFAULT_CANVAS_HEIGHT,
} from "./layout/resolve-spatial.js";
export { parseDimension, resolveDimension } from "./layout/units.js";
export { flattenResolved } from "./flatten.js";
export * from "./animation/index.js";
export {
  layoutText,
  textHasAnimatedStyle,
  type TextLayoutResult,
  type TextRect,
  type TextGlyph,
} from "./text/textLayout.js";
export { drawTextLayout } from "./text/textCanvas.js";

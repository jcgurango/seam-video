export * from "./schema.js";
export * from "./types.js";
export * from "./resolved-types.js";
export * from "./validate.js";
export { formatZodError, type FormattedIssue } from "./format-error.js";
export { compileSeamFile, runScript } from "./compile.js";
export type { CompileError, CompileOptions, CompileResult } from "./compile.js";
export { expandMacros, findUnresolvedMacros } from "./macros.js";
export type { MacroExpandResult } from "./macros.js";
export { resolveComposition } from "./layout/resolve.js";
export {
  resolveSpatial,
  resolveBoxProps,
  computeNaturalSize,
  sampleContentDim,
  hasAnimatedSpatialInput,
  DEFAULT_CANVAS_WIDTH,
  DEFAULT_CANVAS_HEIGHT,
} from "./layout/resolve-spatial.js";
export {
  parseLength,
  resolveLength,
  hasPercent,
  type Length,
  type ParsedLength,
} from "./layout/units.js";
export { flattenResolved } from "./flatten.js";
export type { FlatLeaf } from "./flatten.js";
export * from "./animation/index.js";
export {
  layoutText,
  textHasAnimatedStyle,
  type TextLayoutResult,
  type TextRect,
  type TextGlyph,
} from "./text/textLayout.js";
export { drawTextLayout } from "./text/textCanvas.js";
export {
  CJK_FALLBACK_FAMILY,
  EMOJI_FALLBACK_FAMILY,
  FALLBACK_FONT_FAMILIES,
  withFallbackFamilies,
} from "./text/fallbackFonts.js";

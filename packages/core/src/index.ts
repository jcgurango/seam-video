export * from "./schema.js";
export * from "./types.js";
export * from "./resolved-types.js";
export type { ValidationResult } from "./validate.js";
export { createSeam, type Seam } from "./seam.js";
export type {
  EditorExtension,
  EditorCommand,
  EditorCommandContext,
  EditorTools,
  EditorServices,
  EditorView,
  EditorViewProps,
  EditorPlayer,
  EditorStorage,
  EditorPropertyProps,
  EditorPropertyEditor,
  Transcript,
  TranscriptSegment,
} from "./editor-api.js";
export {
  VISUAL_NODE_TYPES,
  CORE_NODE_TYPES,
  type SeamExtension,
  type FieldSpec,
  type NumberFieldSpec,
  type StringFieldSpec,
  type EnumFieldSpec,
  type ColorFieldSpec,
  type LengthFieldSpec,
  type CustomFieldSpec,
  type SchemaHelpers,
  type FieldTarget,
  type ColorStage,
  type NodeTypeDef,
  type ExtensionNodeView,
  type ChildAnchor,
  type NodeRasterizer,
  type OverlayDef,
  type OverlayRasterizer,
  type SurfaceView,
  type RegisteredOverlay,
  type RasterHost,
  type CanvasLike,
  type ByteSource,
  type RegisteredField,
  type RegisteredColorStage,
  type RegisteredNodeType,
} from "./registry.js";
export { formatZodError, type FormattedIssue } from "./format-error.js";
export { runScript } from "./compile.js";
export type { CompileError, CompileOptions, CompileResult } from "./compile.js";
export { expandMacros, findUnresolvedMacros } from "./macros.js";
export type { MacroExpandResult } from "./macros.js";
export { unrollLoops, type ResolveOptions } from "./layout/resolve.js";
export {
  clipOut,
  clipIsReversed,
  clipPlayRange,
  clipNaturalDuration,
  resolvedPlayStart,
  resolvedSignedRate,
  clipSourceTime,
} from "./layout/clip-span.js";
export {
  parseStart,
  formatStart,
  startAnchorId,
  isRunMember,
  runHeadIndex,
  runsOf,
  type ParsedStart,
  type AnchorPoint,
} from "./layout/anchor.js";
export { loopLocalTime, loopIterations, type LoopIteration } from "./layout/loop.js";
export {
  resolveSpatial,
  resolveBoxProps,
  computeNaturalSize,
  sampleContentDim,
  hasAnimatedSpatialInput,
  DEFAULT_CANVAS_WIDTH,
  DEFAULT_CANVAS_HEIGHT,
  type InnerMeasurer,
  type ResolveSpatialOptions,
} from "./layout/resolve-spatial.js";
export {
  squareToQuad,
  applyHomography,
  quadWeights,
  type Point as QuadPoint,
  type Quad,
  type Homography,
} from "./layout/distort.js";
export {
  parseLength,
  resolveLength,
  hasPercent,
  type Length,
  type ParsedLength,
} from "./layout/units.js";
export { flattenResolved, walkResolved } from "./flatten.js";
export type { FlatLeaf, WalkedSpan } from "./flatten.js";
export * from "./animation/index.js";
export { createPitchShifter, type PitchShifter } from "./audio/pitchShifter.js";
export {
  CJK_FALLBACK_FAMILY,
  EMOJI_FALLBACK_FAMILY,
  FALLBACK_FONT_FAMILIES,
  withFallbackFamilies,
} from "./text/fallbackFonts.js";

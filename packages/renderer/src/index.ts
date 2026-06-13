export { buildMltDocument, isComplexComposition } from "./mlt-builder.js";
export type {
  MltOptions,
  MltLimitation,
  MltBuildResult,
} from "./mlt-builder.js";
export { prerenderCompositionMlts } from "./composition-prerender.js";
export type {
  CompositionPrerenderOptions,
  CompositionPrerenderResult,
} from "./composition-prerender.js";
export {
  renderWithMelt,
  checkMelt,
  buildMeltArgs,
  buildMeltProfile,
  meltProfilePath,
  writeMeltProfile,
} from "./mlt-runner.js";
export type { RenderResult, MeltRenderOptions } from "./mlt-runner.js";
export {
  buildFfmpegAudioCommand,
  runFfmpegAudio,
  checkFfmpeg,
} from "./ffmpeg-audio.js";
export type {
  AudioGraphOptions,
  FfmpegAudioCommand,
} from "./ffmpeg-audio.js";
export { rasterizeAllText } from "./text/textRaster.js";
export type { TextRasterEntry, TextRasterMap } from "./text/textRaster.js";
export { rasterizeAllGraphics } from "./graphic/raster.js";
export type {
  GraphicRasterEntry,
  GraphicRasterMap,
  RasterProgress,
  OnRasterProgress,
} from "./graphic/raster.js";
export {
  precomputeGraphicPlayback,
  snapshotAt,
  isStatic,
} from "./graphic/playback.js";
export type { GraphicPlayback } from "./graphic/playback.js";
export {
  renderSnapshotToPng,
  renderFilledFrameToPng,
} from "./graphic/render.js";
export { fillObject, fillFrame, CUSTOM_PROPS } from "./graphic/fill.js";
export {
  probeIntrinsicSize,
  probeIntrinsicSizes,
  checkFfprobe,
} from "./media-probe.js";
export type { IntrinsicSize, IntrinsicSizeMap } from "./media-probe.js";

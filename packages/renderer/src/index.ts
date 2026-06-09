export { buildMltDocument } from "./mlt-builder.js";
export type {
  MltOptions,
  MltLimitation,
  MltBuildResult,
} from "./mlt-builder.js";
export {
  renderWithMelt,
  checkMelt,
  buildMeltArgs,
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

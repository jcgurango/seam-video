/**
 * @seam/renderer — headless video renderer. Renders a .seam file to mp4 fully
 * in-process: mediabunny decode → @seam/compositor on Dawn WebGPU → readback →
 * mediabunny encode/mux, with an OfflineAudioContext audio mixer. Graphics/text
 * rasterize via fabric/node + OpenLayers + Skia (see ./graphic, ./text).
 */
export { renderSeamToFile, QUALITY_PRESETS, DEFAULT_QUALITY } from "./render.js";
export type { RenderOptions, RenderResult, QualityPreset } from "./render.js";
export { createGpuDevice } from "./gpu.js";
export { NodeBackend, parseColor } from "./NodeBackend.js";
export type { NodeFrame } from "./NodeBackend.js";
export { FrameSource, collectDrawables } from "./frameSource.js";

/**
 * @seam/compositor — the platform-neutral WebGPU compositing core, shared by
 * the live preview (browser canvas backend) and the headless Node renderer
 * (Dawn offscreen backend). Both produce identical pixels because they run the
 * same {@link Compositor}, {@link buildRenderList}, and WGSL shader; only the
 * {@link RenderBackend} (device, frame upload, target) differs.
 */
export { Compositor } from "./Compositor.js";
export type { RenderBackend } from "./backend.js";
export { buildRenderList } from "./RenderList.js";
export type {
  RenderCommand,
  DrawCommand,
  GroupCommand,
  FillCommand,
} from "./RenderList.js";

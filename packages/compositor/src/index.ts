/**
 * @seam/compositor — the platform-neutral WebGPU compositing core, shared by
 * the live preview (browser canvas backend) and the headless Node renderer
 * (Dawn offscreen backend). Both produce identical pixels because they run the
 * same {@link Compositor}, {@link buildRenderList}, and WGSL shader; only the
 * {@link RenderBackend} (device, frame upload, target) differs.
 */
export { Compositor, type CompositorExtensions } from "./Compositor.js";
export type { RenderBackend } from "./backend.js";
export { buildRenderList, NO_FIELDS } from "./RenderList.js";
export type { RenderListExtensions, Drawable, OverlayDrawable } from "./RenderList.js";
export type {
  RenderCommand,
  DrawCommand,
  GroupCommand,
  FillCommand,
  ShapeGeometry,
  FieldValues,
} from "./RenderList.js";

/**
 * Platform seam for the compositor.
 *
 * The {@link Compositor} owns all platform-neutral GPU work — pipelines,
 * uniform buffers, the FBO pool, bind-group caching, the encode loop. The
 * four things that genuinely differ between a browser canvas and a headless
 * Dawn process are delegated to a {@link RenderBackend}:
 *
 *   1. where the `GPUDevice` and the output texture format come from,
 *   2. how a host frame (a canvas in the browser, a raw RGBA buffer in Node)
 *      lands in a GPU texture (`copyExternalImageToTexture` vs `writeTexture`),
 *   3. how a solid-color fill tile is produced,
 *   4. what the root render pass draws into (a swapchain texture vs an
 *      offscreen texture that gets read back), and what happens after submit.
 *
 * `F` is the host frame type the backend knows how to upload. The compositor
 * is generic over it and never inspects it — it only passes the value returned
 * by the host's `getFrame` straight back to {@link RenderBackend.uploadFrame}.
 */
export interface RenderBackend<F = unknown> {
  /** The device every GPU object in the compositor is created against. */
  readonly device: GPUDevice;

  /** Texture format of the root render target (browser: preferred canvas
   *  format, often `bgra8unorm`; Node: typically `rgba8unorm`). The main
   *  pipeline is built against this; FBOs always use `rgba8unorm`. */
  readonly outputFormat: GPUTextureFormat;

  /**
   * Upload a host frame for `key` into a (cached) texture and return its view.
   * Implementations cache by `key` identity and reuse the texture across
   * frames, recreating it only when the source dimensions change.
   */
  uploadFrame(key: object, frame: F): GPUTextureView;

  /**
   * Ensure a solid-`color` tile texture exists for `key` and return its view.
   * `color` is any CSS color string (from a composition's `backgroundColor`).
   * Implementations cache by color so a stable fill isn't re-rasterized.
   */
  uploadFill(key: object, color: string): GPUTextureView;

  /** Drop any frame/fill textures whose keys aren't in `active`. Called
   *  periodically by the compositor, not every frame. */
  prune(active: Set<object>): void;

  /**
   * Acquire the view the root pass renders into, sized `width`×`height`.
   * Browser: the current swapchain texture. Node: a persistent offscreen
   * target that {@link present} reads back.
   */
  acquireTarget(width: number, height: number): GPUTextureView;

  /**
   * Called once after the frame's command buffer is submitted. Browser: a
   * no-op (presentation is implicit). Node: copy the offscreen target to a
   * buffer and map it for readback. May be async.
   */
  present?(): void | Promise<void>;

  /** Release backend-owned GPU resources (textures, scratch canvases). The
   *  device itself is owned by whoever created the backend. */
  dispose(): void;
}

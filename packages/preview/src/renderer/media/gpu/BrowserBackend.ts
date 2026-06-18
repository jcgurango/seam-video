/**
 * Browser {@link RenderBackend} for the live preview. Provides the compositor
 * with a WebGPU device from the canvas, uploads frames via
 * `copyExternalImageToTexture` (the {@link TextureManager}), rasterizes solid
 * fills on a 1×1 OffscreenCanvas, and targets the canvas swapchain. Presenting
 * is implicit, so there's no `present()`.
 */
import type { RenderBackend } from "@seam/compositor";
import { TextureManager } from "./TextureManager.js";

export type BrowserFrame = HTMLCanvasElement | OffscreenCanvas;

export class BrowserBackend implements RenderBackend<BrowserFrame> {
  device!: GPUDevice;
  outputFormat!: GPUTextureFormat;
  private context!: GPUCanvasContext;
  private textures!: TextureManager;

  /** Last color rasterised per fill key — lets us skip re-painting the 1×1
   *  tile when a composition's bg color is stable across frames. */
  private fillColors = new Map<object, string>();
  private fillTile: OffscreenCanvas | null = null;
  private fillTileCtx: OffscreenCanvasRenderingContext2D | null = null;

  async init(canvas: HTMLCanvasElement): Promise<void> {
    const adapter = await navigator.gpu?.requestAdapter();
    if (!adapter) throw new Error("WebGPU not supported");
    this.device = await adapter.requestDevice();

    this.context = canvas.getContext("webgpu")!;
    this.outputFormat = navigator.gpu.getPreferredCanvasFormat();
    this.context.configure({
      device: this.device,
      format: this.outputFormat,
      alphaMode: "premultiplied",
    });

    this.textures = new TextureManager(this.device);
  }

  uploadFrame(key: object, frame: BrowserFrame): GPUTextureView {
    return this.textures.upload(key, frame);
  }

  uploadFill(key: object, color: string): GPUTextureView {
    if (!this.fillTile) {
      this.fillTile = new OffscreenCanvas(1, 1);
      this.fillTileCtx = this.fillTile.getContext("2d");
    }
    if (this.fillColors.get(key) !== color) {
      const ctx = this.fillTileCtx;
      if (ctx) {
        ctx.clearRect(0, 0, 1, 1);
        ctx.fillStyle = color;
        ctx.fillRect(0, 0, 1, 1);
      }
      this.fillColors.set(key, color);
    }
    // Always (re-)upload so TextureManager.prune sees the entry as touched.
    return this.textures.upload(key, this.fillTile);
  }

  prune(active: Set<object>): void {
    this.textures.prune(active);
    for (const key of this.fillColors.keys()) {
      if (!active.has(key)) this.fillColors.delete(key);
    }
  }

  acquireTarget(): GPUTextureView {
    return this.context.getCurrentTexture().createView();
  }

  dispose(): void {
    this.textures?.dispose();
    this.fillColors.clear();
    this.fillTile = null;
    this.fillTileCtx = null;
  }
}

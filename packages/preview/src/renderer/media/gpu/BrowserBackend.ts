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

  /** ONE shared 1×1 tile every fill is rasterized on, then copied into the
   *  key's own texture. `fillTileColor` is what the tile currently holds —
   *  the repaint test must compare against THAT, not against a per-key
   *  record: with several fills per frame (root background + a shape's fill
   *  + its stroke, …) a key whose colour hadn't changed would otherwise
   *  upload whatever colour the previous key left on the tile (a white
   *  stroke turned the whole canvas white; a red circle appearing turned a
   *  magenta rect red). */
  private fillTile: OffscreenCanvas | null = null;
  private fillTileCtx: OffscreenCanvasRenderingContext2D | null = null;
  private fillTileColor: string | null = null;

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
    if (this.fillTileColor !== color) {
      const ctx = this.fillTileCtx;
      if (ctx) {
        ctx.clearRect(0, 0, 1, 1);
        ctx.fillStyle = color;
        ctx.fillRect(0, 0, 1, 1);
      }
      this.fillTileColor = color;
    }
    // A 1×1 copy per fill per frame — cheap, and it keeps each key's texture
    // holding its own colour regardless of what other keys painted since.
    return this.textures.upload(key, this.fillTile);
  }

  prune(active: Set<object>): void {
    this.textures.prune(active);
  }

  acquireTarget(): GPUTextureView {
    return this.context.getCurrentTexture().createView();
  }

  dispose(): void {
    this.textures?.dispose();
    this.fillTile = null;
    this.fillTileCtx = null;
    this.fillTileColor = null;
  }
}

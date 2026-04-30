/**
 * Manages GPU textures for video clip frames. Handles uploading
 * HTMLCanvasElement / OffscreenCanvas data to GPUTexture and caching
 * textures by clip identity so they can be reused across frames.
 */

import type { ResolvedClip, ResolvedText } from "@seam/core";

type TextureKey = ResolvedClip | ResolvedText;

interface TextureEntry {
  texture: GPUTexture;
  view: GPUTextureView;
  width: number;
  height: number;
}

export class TextureManager {
  private device: GPUDevice;
  private entries = new Map<TextureKey, TextureEntry>();

  constructor(device: GPUDevice) {
    this.device = device;
  }

  /**
   * Upload a canvas frame for a clip to the GPU. Returns the texture view.
   * Reuses the existing texture if the dimensions haven't changed.
   */
  upload(
    clip: TextureKey,
    source: HTMLCanvasElement | OffscreenCanvas,
  ): GPUTextureView {
    const w = source.width;
    const h = source.height;

    let entry = this.entries.get(clip);

    if (!entry || entry.width !== w || entry.height !== h) {
      entry?.texture.destroy();

      const texture = this.device.createTexture({
        size: [w, h],
        format: "rgba8unorm",
        usage:
          GPUTextureUsage.TEXTURE_BINDING |
          GPUTextureUsage.COPY_DST |
          GPUTextureUsage.RENDER_ATTACHMENT,
      });

      entry = { texture, view: texture.createView(), width: w, height: h };
      this.entries.set(clip, entry);
    }

    this.device.queue.copyExternalImageToTexture(
      { source },
      { texture: entry.texture },
      [w, h],
    );

    return entry.view;
  }

  /** Remove textures for clips that are no longer active. */
  prune(activeClips: Set<TextureKey>): void {
    for (const [clip, entry] of this.entries) {
      if (!activeClips.has(clip)) {
        entry.texture.destroy();
        this.entries.delete(clip);
      }
    }
  }

  dispose(): void {
    for (const entry of this.entries.values()) {
      entry.texture.destroy();
    }
    this.entries.clear();
  }
}

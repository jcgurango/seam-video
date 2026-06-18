/**
 * Headless (Dawn) {@link RenderBackend} for the Node renderer. Mirrors the
 * preview's BrowserBackend, but with no DOM:
 *
 *   - frames upload via `device.queue.writeTexture` from raw RGBA bytes
 *     (there is no `copyExternalImageToTexture` / canvas in Node),
 *   - solid fills are 1×1 RGBA textures parsed from the CSS color string,
 *   - the root pass renders into a persistent offscreen `rgba8unorm` target,
 *   - `present()` copies that target to a buffer and maps it for readback,
 *     leaving the composited frame in {@link NodeBackend.pixels}.
 *
 * The device is owned by the caller (who creates it from the `webgpu` Dawn
 * bindings and assigns the WebGPU globals); the backend just uses it.
 */
import type { RenderBackend } from "@seam/compositor";

/** A decoded/rasterized frame as tightly-packed RGBA8 (row stride = width*4). */
export interface NodeFrame {
  data: Uint8Array | Uint8ClampedArray;
  width: number;
  height: number;
}

interface TexEntry {
  texture: GPUTexture;
  view: GPUTextureView;
  width: number;
  height: number;
}

const TARGET_FORMAT: GPUTextureFormat = "rgba8unorm";

export class NodeBackend implements RenderBackend<NodeFrame> {
  readonly device: GPUDevice;
  readonly outputFormat = TARGET_FORMAT;

  private entries = new Map<object, TexEntry>();
  private fillColors = new Map<object, string>();

  // Offscreen target + a ring of readback buffers (triple-buffered by
  // default), (re)allocated on size change. The single target is fine — the
  // queue serializes each frame's copy before the next frame's render — so
  // only the readback staging buffers must be N-deep so several `mapAsync`s
  // can be in flight at once instead of stalling the GPU one frame at a time.
  private target: GPUTexture | null = null;
  private targetW = 0;
  private targetH = 0;
  private bytesPerRow = 0;
  private readonly ringSize: number;
  private ring: GPUBuffer[] = [];
  private nextSlot = 0;
  /** Frames submitted but not yet drained, oldest first (FIFO). */
  private inFlight: { slot: number; mapped: Promise<undefined> }[] = [];

  constructor(device: GPUDevice, bufferCount = 3) {
    this.device = device;
    this.ringSize = Math.max(1, bufferCount);
  }

  /** Number of submitted-but-not-yet-drained frames. */
  get inFlightCount(): number {
    return this.inFlight.length;
  }

  uploadFrame(key: object, frame: NodeFrame): GPUTextureView {
    const entry = this.ensureTexture(key, frame.width, frame.height);
    this.device.queue.writeTexture(
      { texture: entry.texture },
      frame.data as GPUAllowSharedBufferSource,
      { bytesPerRow: frame.width * 4, rowsPerImage: frame.height },
      [frame.width, frame.height],
    );
    return entry.view;
  }

  uploadFill(key: object, color: string): GPUTextureView {
    const entry = this.ensureTexture(key, 1, 1);
    // Re-rasterize only when the color changes; always re-upload so the
    // texture stays "touched" for prune().
    if (this.fillColors.get(key) !== color) this.fillColors.set(key, color);
    const [r, g, b, a] = parseColor(color);
    this.device.queue.writeTexture(
      { texture: entry.texture },
      new Uint8Array([r, g, b, a]) as GPUAllowSharedBufferSource,
      { bytesPerRow: 4, rowsPerImage: 1 },
      [1, 1],
    );
    return entry.view;
  }

  prune(active: Set<object>): void {
    for (const [key, entry] of this.entries) {
      if (!active.has(key)) {
        entry.texture.destroy();
        this.entries.delete(key);
        this.fillColors.delete(key);
      }
    }
  }

  acquireTarget(width: number, height: number): GPUTextureView {
    if (!this.target || this.targetW !== width || this.targetH !== height) {
      this.target?.destroy();
      for (const b of this.ring) b.destroy();
      this.targetW = width;
      this.targetH = height;
      this.bytesPerRow = align256(width * 4);
      this.target = this.device.createTexture({
        size: [width, height],
        format: TARGET_FORMAT,
        usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
      });
      this.ring = Array.from({ length: this.ringSize }, () =>
        this.device.createBuffer({
          size: this.bytesPerRow * height,
          usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
        }),
      );
      this.nextSlot = 0;
    }
    return this.target.createView();
  }

  /**
   * Submit the target→buffer copy and START its `mapAsync` without awaiting —
   * the readback overlaps subsequent frames' GPU work. The caller drains via
   * {@link drainOldest} once {@link inFlightCount} reaches the ring size, so a
   * slot is never reused while still mapped.
   */
  present(): void {
    if (!this.target) return;
    const slot = this.nextSlot;
    this.nextSlot = (this.nextSlot + 1) % this.ringSize;
    const buffer = this.ring[slot];

    const enc = this.device.createCommandEncoder();
    enc.copyTextureToBuffer(
      { texture: this.target },
      { buffer, bytesPerRow: this.bytesPerRow, rowsPerImage: this.targetH },
      [this.targetW, this.targetH],
    );
    this.device.queue.submit([enc.finish()]);
    this.inFlight.push({ slot, mapped: buffer.mapAsync(GPUMapMode.READ) });
  }

  /** Await the oldest in-flight readback and return its tightly-packed RGBA. */
  async drainOldest(): Promise<Uint8Array> {
    const job = this.inFlight.shift();
    if (!job) throw new Error("NodeBackend.drainOldest: nothing in flight");
    await job.mapped;
    const buffer = this.ring[job.slot];
    const w = this.targetW;
    const h = this.targetH;
    const padded = new Uint8Array(buffer.getMappedRange());
    const tight = new Uint8Array(w * h * 4);
    const rowBytes = w * 4;
    for (let y = 0; y < h; y++) {
      tight.set(
        padded.subarray(y * this.bytesPerRow, y * this.bytesPerRow + rowBytes),
        y * rowBytes,
      );
    }
    buffer.unmap();
    return tight;
  }

  dispose(): void {
    for (const entry of this.entries.values()) entry.texture.destroy();
    this.entries.clear();
    this.fillColors.clear();
    this.target?.destroy();
    for (const b of this.ring) b.destroy();
    this.ring = [];
    this.inFlight = [];
    this.target = null;
  }

  private ensureTexture(key: object, w: number, h: number): TexEntry {
    let entry = this.entries.get(key);
    if (!entry || entry.width !== w || entry.height !== h) {
      entry?.texture.destroy();
      const texture = this.device.createTexture({
        size: [w, h],
        format: TARGET_FORMAT,
        usage:
          GPUTextureUsage.TEXTURE_BINDING |
          GPUTextureUsage.COPY_DST |
          GPUTextureUsage.RENDER_ATTACHMENT,
      });
      entry = { texture, view: texture.createView(), width: w, height: h };
      this.entries.set(key, entry);
    }
    return entry;
  }
}

const align256 = (n: number): number => Math.ceil(n / 256) * 256;

/**
 * Minimal CSS color parser for composition `backgroundColor`s. Handles hex
 * (#rgb/#rgba/#rrggbb/#rrggbbaa), rgb()/rgba(), and `transparent`. Returns
 * straight (non-premultiplied) RGBA bytes to match the browser fill path.
 * Unknown strings fall back to opaque black.
 */
export function parseColor(input: string): [number, number, number, number] {
  const c = input.trim().toLowerCase();
  if (c === "transparent") return [0, 0, 0, 0];

  if (c[0] === "#") {
    let hex = c.slice(1);
    if (hex.length === 3 || hex.length === 4) {
      hex = hex
        .split("")
        .map((ch) => ch + ch)
        .join("");
    }
    const r = parseInt(hex.slice(0, 2), 16);
    const g = parseInt(hex.slice(2, 4), 16);
    const b = parseInt(hex.slice(4, 6), 16);
    const a = hex.length >= 8 ? parseInt(hex.slice(6, 8), 16) : 255;
    if ([r, g, b, a].every((n) => Number.isFinite(n))) return [r, g, b, a];
  }

  const m = c.match(/^rgba?\(([^)]+)\)$/);
  if (m) {
    const parts = m[1].split(/[, /]+/).filter(Boolean);
    const r = Math.round(Number(parts[0]));
    const g = Math.round(Number(parts[1]));
    const b = Math.round(Number(parts[2]));
    const a = parts[3] != null ? Math.round(Number(parts[3]) * 255) : 255;
    if ([r, g, b, a].every((n) => Number.isFinite(n))) return [r, g, b, a];
  }

  return [0, 0, 0, 255];
}

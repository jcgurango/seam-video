/**
 * WebGPU renderer for the preview timeline. Renders all visible clips
 * to a single canvas using textured quads with proper objectFit/scissoring.
 *
 * Phase 1: Blit-only (no filter shaders).
 * Phase 2: Per-clip filter shaders (YUV-space, matching FFmpeg).
 * Phase 3: FBO render-to-texture for composition-level filters.
 */

import type { ResolvedClip } from "@seam/core";
import { TextureManager } from "./TextureManager.js";
import type { DrawCommand } from "./RenderList.js";

// ── WGSL Shader ──

const BLIT_SHADER = /* wgsl */ `
struct Uniforms {
  // dest rect in pixels: x, y, w, h
  dest: vec4f,
  // canvas dimensions + opacity
  canvas_w: f32,
  canvas_h: f32,
  opacity: f32,
  _pad: f32,
}

@group(0) @binding(0) var<uniform> u: Uniforms;
@group(1) @binding(0) var tex_sampler: sampler;
@group(1) @binding(1) var tex: texture_2d<f32>;

struct VSOut {
  @builtin(position) pos: vec4f,
  @location(0) uv: vec2f,
}

// Two-triangle fullscreen quad via vertex index
var<private> quad: array<vec2f, 6> = array(
  vec2f(0, 0), vec2f(1, 0), vec2f(0, 1),
  vec2f(0, 1), vec2f(1, 0), vec2f(1, 1),
);

@vertex
fn vs(@builtin(vertex_index) vi: u32) -> VSOut {
  let p = quad[vi];
  // Map [0,1] quad to dest rect in pixels, then to NDC
  let px = u.dest.x + p.x * u.dest.z;
  let py = u.dest.y + p.y * u.dest.w;
  let ndc_x = (px / u.canvas_w) * 2.0 - 1.0;
  let ndc_y = 1.0 - (py / u.canvas_h) * 2.0;
  return VSOut(vec4f(ndc_x, ndc_y, 0.0, 1.0), p);
}

@fragment
fn fs(input: VSOut) -> @location(0) vec4f {
  let color = textureSample(tex, tex_sampler, input.uv);
  return vec4f(color.rgb, color.a * u.opacity);
}
`;

const UNIFORM_SIZE = 32; // bytes: 2 × vec4f
const UNIFORM_ALIGN = 256; // minUniformBufferOffsetAlignment
const MAX_DRAWS = 64;

export class WebGPURenderer {
  private device!: GPUDevice;
  private context!: GPUCanvasContext;
  private pipeline!: GPURenderPipeline;
  private sampler!: GPUSampler;
  private uniformBuffer!: GPUBuffer;
  private uniformBindGroupLayout!: GPUBindGroupLayout;
  private textureBindGroupLayout!: GPUBindGroupLayout;
  private textures!: TextureManager;
  private canvasWidth = 0;
  private canvasHeight = 0;
  private _ready = false;

  // Cached per-slot uniform bind groups (stable across frames)
  private uniformBindGroups: GPUBindGroup[] = [];
  // Cached texture bind groups per clip (invalidated on texture resize)
  private texBindGroupCache = new Map<
    ResolvedClip,
    { view: GPUTextureView; bg: GPUBindGroup }
  >();
  // Reusable uniform staging buffer
  private uniformStaging = new ArrayBuffer(MAX_DRAWS * UNIFORM_ALIGN);
  // Frame counter for pruning (don't prune every frame)
  private frameCount = 0;

  get ready(): boolean {
    return this._ready;
  }

  async init(canvas: HTMLCanvasElement): Promise<void> {
    const adapter = await navigator.gpu?.requestAdapter();
    if (!adapter) throw new Error("WebGPU not supported");

    this.device = await adapter.requestDevice();

    this.context = canvas.getContext("webgpu")!;
    const format = navigator.gpu.getPreferredCanvasFormat();

    this.context.configure({
      device: this.device,
      format,
      alphaMode: "premultiplied",
    });

    // Bind group layouts
    this.uniformBindGroupLayout = this.device.createBindGroupLayout({
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
          buffer: { type: "uniform" },
        },
      ],
    });

    this.textureBindGroupLayout = this.device.createBindGroupLayout({
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.FRAGMENT,
          sampler: { type: "filtering" },
        },
        {
          binding: 1,
          visibility: GPUShaderStage.FRAGMENT,
          texture: { sampleType: "float" },
        },
      ],
    });

    const pipelineLayout = this.device.createPipelineLayout({
      bindGroupLayouts: [
        this.uniformBindGroupLayout,
        this.textureBindGroupLayout,
      ],
    });

    const shaderModule = this.device.createShaderModule({
      code: BLIT_SHADER,
    });

    this.pipeline = this.device.createRenderPipeline({
      layout: pipelineLayout,
      vertex: { module: shaderModule, entryPoint: "vs" },
      fragment: {
        module: shaderModule,
        entryPoint: "fs",
        targets: [
          {
            format,
            blend: {
              color: {
                srcFactor: "src-alpha",
                dstFactor: "one-minus-src-alpha",
                operation: "add",
              },
              alpha: {
                srcFactor: "one",
                dstFactor: "one-minus-src-alpha",
                operation: "add",
              },
            },
          },
        ],
      },
      primitive: { topology: "triangle-list" },
    });

    this.sampler = this.device.createSampler({
      magFilter: "linear",
      minFilter: "linear",
    });

    // Pre-allocate uniform buffer
    this.uniformBuffer = this.device.createBuffer({
      size: MAX_DRAWS * UNIFORM_ALIGN,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    // Pre-create uniform bind groups for each slot
    for (let i = 0; i < MAX_DRAWS; i++) {
      this.uniformBindGroups.push(
        this.device.createBindGroup({
          layout: this.uniformBindGroupLayout,
          entries: [
            {
              binding: 0,
              resource: {
                buffer: this.uniformBuffer,
                offset: i * UNIFORM_ALIGN,
                size: UNIFORM_SIZE,
              },
            },
          ],
        }),
      );
    }

    this.textures = new TextureManager(this.device);
    this._ready = true;
  }

  resize(width: number, height: number): void {
    this.canvasWidth = width;
    this.canvasHeight = height;
  }

  render(
    commands: DrawCommand[],
    getFrame: (
      clip: ResolvedClip,
    ) => HTMLCanvasElement | OffscreenCanvas | null,
  ): void {
    if (!this._ready) return;

    this.frameCount++;
    const drawCount = Math.min(commands.length, MAX_DRAWS);
    const activeClips = new Set<ResolvedClip>();

    // Pre-upload textures and write uniform data
    const texBGs: (GPUBindGroup | null)[] = [];

    for (let i = 0; i < drawCount; i++) {
      const cmd = commands[i];
      activeClips.add(cmd.clip);

      const frame = getFrame(cmd.clip);
      if (!frame) {
        texBGs.push(null);
        continue;
      }

      // Upload texture (TextureManager skips if dimensions unchanged internally)
      const textureView = this.textures.upload(cmd.clip, frame);

      // Cache texture bind group — only recreate if the view changed (texture resized)
      let cached = this.texBindGroupCache.get(cmd.clip);
      if (!cached || cached.view !== textureView) {
        cached = {
          view: textureView,
          bg: this.device.createBindGroup({
            layout: this.textureBindGroupLayout,
            entries: [
              { binding: 0, resource: this.sampler },
              { binding: 1, resource: textureView },
            ],
          }),
        };
        this.texBindGroupCache.set(cmd.clip, cached);
      }
      texBGs.push(cached.bg);

      // Write uniforms into reusable staging buffer
      const f32 = new Float32Array(this.uniformStaging, i * UNIFORM_ALIGN, 8);
      f32[0] = cmd.quadX;
      f32[1] = cmd.quadY;
      f32[2] = cmd.quadW;
      f32[3] = cmd.quadH;
      f32[4] = this.canvasWidth;
      f32[5] = this.canvasHeight;
      f32[6] = cmd.opacity;
      f32[7] = 0;
    }

    if (drawCount > 0) {
      this.device.queue.writeBuffer(
        this.uniformBuffer,
        0,
        this.uniformStaging,
        0,
        drawCount * UNIFORM_ALIGN,
      );
    }

    // Prune stale textures every 60 frames (~1s)
    if (this.frameCount % 60 === 0) {
      this.textures.prune(activeClips);
      // Also prune stale bind group cache entries
      for (const clip of this.texBindGroupCache.keys()) {
        if (!activeClips.has(clip)) {
          this.texBindGroupCache.delete(clip);
        }
      }
    }

    // Render pass
    const swapChainView = this.context.getCurrentTexture().createView();
    const encoder = this.device.createCommandEncoder();

    const pass = encoder.beginRenderPass({
      colorAttachments: [
        {
          view: swapChainView,
          clearValue: { r: 0, g: 0, b: 0, a: 1 },
          loadOp: "clear",
          storeOp: "store",
        },
      ],
    });

    pass.setPipeline(this.pipeline);

    for (let i = 0; i < drawCount; i++) {
      const texBG = texBGs[i];
      if (!texBG) continue;

      const cmd = commands[i];

      // Scissor to container bounds (clamped to canvas)
      const sx = Math.max(0, Math.round(cmd.scissorX));
      const sy = Math.max(0, Math.round(cmd.scissorY));
      const sw = Math.min(
        Math.round(cmd.scissorW),
        this.canvasWidth - sx,
      );
      const sh = Math.min(
        Math.round(cmd.scissorH),
        this.canvasHeight - sy,
      );
      if (sw <= 0 || sh <= 0) continue;

      pass.setScissorRect(sx, sy, sw, sh);
      pass.setBindGroup(0, this.uniformBindGroups[i]);
      pass.setBindGroup(1, texBG);
      pass.draw(6);
    }

    pass.end();
    this.device.queue.submit([encoder.finish()]);
  }

  dispose(): void {
    this.textures?.dispose();
    this.uniformBuffer?.destroy();
    this.texBindGroupCache.clear();
    this._ready = false;
  }
}

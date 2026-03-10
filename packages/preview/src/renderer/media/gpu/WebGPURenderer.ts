/**
 * WebGPU renderer for the preview timeline. Renders all visible clips
 * to a single canvas using textured quads with proper objectFit/scissoring.
 *
 * Phase 1: Blit-only — done.
 * Phase 2: Per-clip filter shaders (YUV-space, matching FFmpeg).
 * Phase 3: FBO render-to-texture for composition-level filters.
 */

import type { ResolvedClip, Filter } from "@seam/core";
import { TextureManager } from "./TextureManager.js";
import type { DrawCommand } from "./RenderList.js";

// ── WGSL Shader ──
//
// Combined blit + filter shader. Applies all filters in one pass.
// With identity values the filter math is a no-op (output = input).
//
// FFmpeg eq operates on YUV (BT.601):
//   Y_out = clamp((pow(Y, 1/gamma) - 0.5) * contrast + 0.5 + brightness)
//   U_out = clamp((U - 0.5) * saturation + 0.5)
//   V_out = clamp((V - 0.5) * saturation + 0.5)

const SHADER = /* wgsl */ `
struct Uniforms {
  // Geometry
  dest: vec4f,                       //  0: x, y, w, h in pixels
  canvas_opacity: vec4f,             // 16: canvas_w, canvas_h, opacity, _pad
  // adjust (eq) filter — identity: brightness=0, contrast=1, saturation=1, gamma=1
  eq: vec4f,                         // 32: brightness, contrast, saturation, gamma
  // colorbalance — identity: all zeros
  cb_shadows: vec4f,                 // 48: rs, gs, bs, _pad
  cb_midtones: vec4f,                // 64: rm, gm, bm, _pad
  cb_highlights: vec4f,              // 80: rh, gh, bh, _pad
  // colortemperature — identity: 1,1,1
  ct_scale: vec4f,                   // 96: r_scale, g_scale, b_scale, _pad
}

@group(0) @binding(0) var<uniform> u: Uniforms;
@group(1) @binding(0) var tex_sampler: sampler;
@group(1) @binding(1) var tex: texture_2d<f32>;

struct VSOut {
  @builtin(position) pos: vec4f,
  @location(0) uv: vec2f,
}

var<private> quad: array<vec2f, 6> = array(
  vec2f(0, 0), vec2f(1, 0), vec2f(0, 1),
  vec2f(0, 1), vec2f(1, 0), vec2f(1, 1),
);

@vertex
fn vs(@builtin(vertex_index) vi: u32) -> VSOut {
  let p = quad[vi];
  let px = u.dest.x + p.x * u.dest.z;
  let py = u.dest.y + p.y * u.dest.w;
  let ndc_x = (px / u.canvas_opacity.x) * 2.0 - 1.0;
  let ndc_y = 1.0 - (py / u.canvas_opacity.y) * 2.0;
  return VSOut(vec4f(ndc_x, ndc_y, 0.0, 1.0), p);
}

// ── BT.601 conversion ──

fn rgb_to_yuv(rgb: vec3f) -> vec3f {
  let y = 0.299 * rgb.r + 0.587 * rgb.g + 0.114 * rgb.b;
  let u = -0.169 * rgb.r - 0.331 * rgb.g + 0.500 * rgb.b + 0.5;
  let v =  0.500 * rgb.r - 0.419 * rgb.g - 0.081 * rgb.b + 0.5;
  return vec3f(y, u, v);
}

fn yuv_to_rgb(yuv: vec3f) -> vec3f {
  let y = yuv.x;
  let u = yuv.y - 0.5;
  let v = yuv.z - 0.5;
  let r = y + 1.402 * v;
  let g = y - 0.344 * u - 0.714 * v;
  let b = y + 1.772 * u;
  return vec3f(r, g, b);
}

@fragment
fn fs(input: VSOut) -> @location(0) vec4f {
  let color = textureSample(tex, tex_sampler, input.uv);
  var rgb = color.rgb;

  // ── adjust (eq) filter ──
  // Convert to YUV, apply eq formula, convert back
  var yuv = rgb_to_yuv(rgb);

  // Luma: Y_out = (pow(Y, 1/gamma) - 0.5) * contrast + 0.5 + brightness
  let gamma_inv = 1.0 / u.eq.w;  // eq.w = gamma
  let y_gamma = pow(clamp(yuv.x, 0.0, 1.0), gamma_inv);
  yuv.x = (y_gamma - 0.5) * u.eq.y + 0.5 + u.eq.x;  // eq.x = brightness, eq.y = contrast

  // Chroma: saturation
  yuv.y = (yuv.y - 0.5) * u.eq.z + 0.5;  // eq.z = saturation
  yuv.z = (yuv.z - 0.5) * u.eq.z + 0.5;

  rgb = clamp(yuv_to_rgb(yuv), vec3f(0.0), vec3f(1.0));

  // ── colorbalance ──
  // Exact match of FFmpeg vf_colorbalance.c get_component().
  // Lightness = max(R,G,B) + min(R,G,B)  (range [0,2], NOT divided by 2).
  // Constants: a=4, b=0.333, scale=0.7.
  let cb_l = max(max(rgb.r, rgb.g), rgb.b) + min(min(rgb.r, rgb.g), rgb.b);
  let sw = clamp((0.333 - cb_l) * 4.0 + 0.5, 0.0, 1.0) * 0.7;
  let mw = clamp((cb_l - 0.333) * 4.0 + 0.5, 0.0, 1.0)
         * clamp((1.0 - cb_l - 0.333) * 4.0 + 0.5, 0.0, 1.0) * 0.7;
  let hw = clamp((cb_l + 0.333 - 1.0) * 4.0 + 0.5, 0.0, 1.0) * 0.7;
  rgb.r = clamp(rgb.r + u.cb_shadows.x * sw + u.cb_midtones.x * mw + u.cb_highlights.x * hw, 0.0, 1.0);
  rgb.g = clamp(rgb.g + u.cb_shadows.y * sw + u.cb_midtones.y * mw + u.cb_highlights.y * hw, 0.0, 1.0);
  rgb.b = clamp(rgb.b + u.cb_shadows.z * sw + u.cb_midtones.z * mw + u.cb_highlights.z * hw, 0.0, 1.0);

  // ── colortemperature ──
  // Pre-computed RGB scale factors relative to 6500K reference (identity = 1,1,1).
  rgb *= u.ct_scale.xyz;
  rgb = clamp(rgb, vec3f(0.0), vec3f(1.0));

  return vec4f(rgb, color.a * u.canvas_opacity.z);
}
`;

// 7 × vec4f = 112 bytes
const UNIFORM_SIZE = 112;
const UNIFORM_ALIGN = 256;
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

  private uniformBindGroups: GPUBindGroup[] = [];
  private texBindGroupCache = new Map<
    ResolvedClip,
    { view: GPUTextureView; bg: GPUBindGroup }
  >();
  private uniformStaging = new ArrayBuffer(MAX_DRAWS * UNIFORM_ALIGN);
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

    const shaderModule = this.device.createShaderModule({ code: SHADER });

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

    this.uniformBuffer = this.device.createBuffer({
      size: MAX_DRAWS * UNIFORM_ALIGN,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

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
    const texBGs: (GPUBindGroup | null)[] = [];

    for (let i = 0; i < drawCount; i++) {
      const cmd = commands[i];
      activeClips.add(cmd.clip);

      const frame = getFrame(cmd.clip);
      if (!frame) {
        texBGs.push(null);
        continue;
      }

      const textureView = this.textures.upload(cmd.clip, frame);

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

      // Write uniforms
      const f32 = new Float32Array(
        this.uniformStaging,
        i * UNIFORM_ALIGN,
        UNIFORM_SIZE / 4,
      );
      // dest (vec4f)
      f32[0] = cmd.quadX;
      f32[1] = cmd.quadY;
      f32[2] = cmd.quadW;
      f32[3] = cmd.quadH;
      // Extract filter params from clip
      const filterParams = extractFilterParams(cmd.clip.filters);

      // canvas_opacity (vec4f) — combine structural opacity with filter opacity
      f32[4] = this.canvasWidth;
      f32[5] = this.canvasHeight;
      f32[6] = cmd.opacity * filterParams.opacity;
      f32[7] = 0;
      // eq (vec4f)
      f32[8] = filterParams.brightness;
      f32[9] = filterParams.contrast;
      f32[10] = filterParams.saturation;
      f32[11] = filterParams.gamma;
      // cb_shadows (vec4f): rs, gs, bs
      f32[12] = filterParams.cb_rs;
      f32[13] = filterParams.cb_gs;
      f32[14] = filterParams.cb_bs;
      f32[15] = 0;
      // cb_midtones (vec4f): rm, gm, bm
      f32[16] = filterParams.cb_rm;
      f32[17] = filterParams.cb_gm;
      f32[18] = filterParams.cb_bm;
      f32[19] = 0;
      // cb_highlights (vec4f): rh, gh, bh
      f32[20] = filterParams.cb_rh;
      f32[21] = filterParams.cb_gh;
      f32[22] = filterParams.cb_bh;
      f32[23] = 0;
      // ct_scale (vec4f): pre-computed RGB multipliers
      f32[24] = filterParams.ct_r;
      f32[25] = filterParams.ct_g;
      f32[26] = filterParams.ct_b;
      f32[27] = 0;
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

    if (this.frameCount % 60 === 0) {
      this.textures.prune(activeClips);
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

// ── Filter param extraction ──

interface FilterParams {
  brightness: number;
  contrast: number;
  saturation: number;
  gamma: number;
  opacity: number;
  cb_rs: number; cb_gs: number; cb_bs: number;
  cb_rm: number; cb_gm: number; cb_bm: number;
  cb_rh: number; cb_gh: number; cb_bh: number;
  ct_r: number; ct_g: number; ct_b: number;
}

const IDENTITY_PARAMS: FilterParams = {
  brightness: 0, contrast: 1, saturation: 1, gamma: 1, opacity: 1,
  cb_rs: 0, cb_gs: 0, cb_bs: 0,
  cb_rm: 0, cb_gm: 0, cb_bm: 0,
  cb_rh: 0, cb_gh: 0, cb_bh: 0,
  ct_r: 1, ct_g: 1, ct_b: 1,
};

function extractFilterParams(filters?: Filter[]): FilterParams {
  if (!filters?.length) return IDENTITY_PARAMS;

  const p = { ...IDENTITY_PARAMS };

  for (const f of filters) {
    switch (f.type) {
      case "adjust":
        if (f.brightness != null) p.brightness += f.brightness;
        if (f.contrast != null) p.contrast *= f.contrast;
        if (f.saturation != null) p.saturation *= f.saturation;
        if (f.gamma != null) p.gamma *= f.gamma;
        break;
      case "opacity":
        p.opacity *= f.value;
        break;
      case "colorbalance":
        p.cb_rs += f.rs ?? 0; p.cb_gs += f.gs ?? 0; p.cb_bs += f.bs ?? 0;
        p.cb_rm += f.rm ?? 0; p.cb_gm += f.gm ?? 0; p.cb_bm += f.bm ?? 0;
        p.cb_rh += f.rh ?? 0; p.cb_gh += f.gh ?? 0; p.cb_bh += f.bh ?? 0;
        break;
      case "colortemperature": {
        const { r, g, b } = tempToScale(f.temperature ?? 6500);
        p.ct_r *= r; p.ct_g *= g; p.ct_b *= b;
        break;
      }
    }
  }

  return p;
}

/**
 * Convert color temperature (Kelvin) to RGB scale factors relative to 6500K.
 * Planckian locus approximation (Tanner Helland algorithm).
 */
function tempToRGB(temp: number): { r: number; g: number; b: number } {
  const t = temp / 100;
  let r: number, g: number, b: number;

  if (t <= 66) {
    r = 255;
  } else {
    r = 329.698727446 * Math.pow(t - 60, -0.1332047592);
  }

  if (t <= 66) {
    g = 99.4708025861 * Math.log(t) - 161.1195681661;
  } else {
    g = 288.1221695283 * Math.pow(t - 60, -0.0755148492);
  }

  if (t >= 66) {
    b = 255;
  } else if (t <= 19) {
    b = 0;
  } else {
    b = 138.5177312231 * Math.log(t - 10) - 305.0447927307;
  }

  return {
    r: Math.max(0, Math.min(255, r)),
    g: Math.max(0, Math.min(255, g)),
    b: Math.max(0, Math.min(255, b)),
  };
}

function tempToScale(temp: number): { r: number; g: number; b: number } {
  const target = tempToRGB(temp);
  const ref = tempToRGB(6500);
  return {
    r: target.r / ref.r,
    g: target.g / ref.g,
    b: target.b / ref.b,
  };
}

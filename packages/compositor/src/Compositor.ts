/**
 * Platform-neutral WebGPU compositor. Renders a {@link RenderCommand} tree to
 * a backend-provided target using textured quads. Compositions with filters
 * render to intermediate textures (FBO) so filters apply to the composite.
 *
 * This is the preview's old `WebGPURenderer` with the four browser-specific
 * touch points lifted behind a {@link RenderBackend}: device + output format,
 * frame upload, fill rasterization, and target acquisition / present. The GPU
 * algorithm (pipelines, uniforms, FBO pool, encode loop) is unchanged and is
 * shared verbatim between the live preview and the headless Node renderer.
 *
 * The shader handles all filter types in a single pass per quad:
 *   adjust (eq) — BT.601 YUV, matching FFmpeg's eq formula
 *   colorbalance — FFmpeg's exact weight functions (a=4, b=0.333, scale=0.7)
 *   colortemperature — Planckian locus RGB scaling
 *   opacity — alpha multiply
 */

import type { Filter } from "@seam/core";
import type { RenderBackend } from "./backend.js";
import type {
  RenderCommand,
  DrawCommand,
  FillCommand,
  GroupCommand,
} from "./RenderList.js";

/** Anything a {@link DrawCommand} can carry — addressed by object identity. */
type Drawable = DrawCommand["clip"];

// ── WGSL Shader ──

const SHADER = /* wgsl */ `
struct Uniforms {
  dest: vec4f,
  canvas_opacity: vec4f,
  eq: vec4f,
  cb_shadows: vec4f,
  cb_midtones: vec4f,
  cb_highlights: vec4f,
  ct_scale: vec4f,
  rot: vec4f, // rotation_radians, pivot_x, pivot_y, _
  crop: vec4f, // u0, v0, u1, v1 — visible source sub-rect (inset); full = 0,0,1,1
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
  var px = u.dest.x + p.x * u.dest.z;
  var py = u.dest.y + p.y * u.dest.w;
  // Rotate about the pivot (in target-pixel space). Screen y is down, so
  // this matrix gives clockwise-positive rotation (matches the spec).
  let rot = u.rot.x;
  if (rot != 0.0) {
    let c = cos(rot);
    let s = sin(rot);
    let dx = px - u.rot.y;
    let dy = py - u.rot.z;
    px = u.rot.y + dx * c - dy * s;
    py = u.rot.z + dx * s + dy * c;
  }
  let ndc_x = (px / u.canvas_opacity.x) * 2.0 - 1.0;
  let ndc_y = 1.0 - (py / u.canvas_opacity.y) * 2.0;
  // Map the quad corner into the visible source sub-rect (inset/crop).
  let uv = u.crop.xy + p * (u.crop.zw - u.crop.xy);
  return VSOut(vec4f(ndc_x, ndc_y, 0.0, 1.0), uv);
}

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

  // ── adjust (eq) — matches FFmpeg's create_lut order ──
  var yuv = rgb_to_yuv(rgb);
  // Step 1: contrast + brightness (before gamma)
  var y = u.eq.y * (yuv.x - 0.5) + 0.5 + u.eq.x;
  // Step 2: gamma (applied to the contrast/brightness result)
  y = max(y, 0.0);
  let gamma_inv = 1.0 / u.eq.w;
  y = pow(y, gamma_inv);
  yuv.x = y;
  yuv.y = (yuv.y - 0.5) * u.eq.z + 0.5;
  yuv.z = (yuv.z - 0.5) * u.eq.z + 0.5;
  rgb = clamp(yuv_to_rgb(yuv), vec3f(0.0), vec3f(1.0));

  // ── colorbalance ──
  let cb_l = max(max(rgb.r, rgb.g), rgb.b) + min(min(rgb.r, rgb.g), rgb.b);
  let sw = clamp((0.333 - cb_l) * 4.0 + 0.5, 0.0, 1.0) * 0.7;
  let mw = clamp((cb_l - 0.333) * 4.0 + 0.5, 0.0, 1.0)
         * clamp((1.0 - cb_l - 0.333) * 4.0 + 0.5, 0.0, 1.0) * 0.7;
  let hw = clamp((cb_l + 0.333 - 1.0) * 4.0 + 0.5, 0.0, 1.0) * 0.7;
  rgb.r = clamp(rgb.r + u.cb_shadows.x * sw + u.cb_midtones.x * mw + u.cb_highlights.x * hw, 0.0, 1.0);
  rgb.g = clamp(rgb.g + u.cb_shadows.y * sw + u.cb_midtones.y * mw + u.cb_highlights.y * hw, 0.0, 1.0);
  rgb.b = clamp(rgb.b + u.cb_shadows.z * sw + u.cb_midtones.z * mw + u.cb_highlights.z * hw, 0.0, 1.0);

  // ── colortemperature ──
  rgb = clamp(rgb * u.ct_scale.xyz, vec3f(0.0), vec3f(1.0));

  return vec4f(rgb, color.a * u.canvas_opacity.z);
}
`;

const UNIFORM_SIZE = 144; // 9 × vec4f
const UNIFORM_ALIGN = 256;
const MAX_DRAWS = 128;
const FBO_FORMAT: GPUTextureFormat = "rgba8unorm";

export class Compositor<F = unknown> {
  private readonly backend: RenderBackend<F>;
  private device!: GPUDevice;
  private pipeline!: GPURenderPipeline;
  private fboPipeline!: GPURenderPipeline; // same shader, targets FBO_FORMAT
  private sampler!: GPUSampler;
  private uniformBuffer!: GPUBuffer;
  private uniformBindGroupLayout!: GPUBindGroupLayout;
  private textureBindGroupLayout!: GPUBindGroupLayout;
  private canvasWidth = 0;
  private canvasHeight = 0;
  private _ready = false;

  private uniformBindGroups: GPUBindGroup[] = [];
  private texBindGroupCache = new Map<
    object | symbol,
    { view: GPUTextureView; bg: GPUBindGroup }
  >();
  private uniformStaging = new ArrayBuffer(MAX_DRAWS * UNIFORM_ALIGN);
  /** Byte view of {@link uniformStaging} for `writeBuffer` — Dawn's Node
   *  bindings mishandle a raw ArrayBuffer source, so we always hand it a
   *  typed-array view (valid in the browser too). */
  private uniformStagingBytes = new Uint8Array(this.uniformStaging);
  private frameCount = 0;
  private drawSlot = 0;
  private activeClips = new Set<object>();

  // FBO pool: keyed by "WxH", reused across frames
  private fboPool = new Map<string, GPUTexture[]>();
  private fboInUse: GPUTexture[] = [];

  constructor(backend: RenderBackend<F>) {
    this.backend = backend;
  }

  get ready(): boolean {
    return this._ready;
  }

  /**
   * Build pipelines, sampler, uniform buffer and bind groups against the
   * backend's device. Idempotent: a second call tears down first so a host
   * can rebind to a fresh device (e.g. canvas remount).
   */
  init(): void {
    if (this._ready) this.dispose();

    this.device = this.backend.device;
    const format = this.backend.outputFormat;

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

    const makePipeline = (targetFormat: GPUTextureFormat) =>
      this.device.createRenderPipeline({
        layout: pipelineLayout,
        vertex: { module: shaderModule, entryPoint: "vs" },
        fragment: {
          module: shaderModule,
          entryPoint: "fs",
          targets: [
            {
              format: targetFormat,
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

    this.pipeline = makePipeline(format);
    this.fboPipeline = makePipeline(FBO_FORMAT);

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

    this._ready = true;
  }

  resize(width: number, height: number): void {
    this.canvasWidth = width;
    this.canvasHeight = height;
  }

  async render(
    commands: RenderCommand[],
    getFrame: (clip: Drawable) => F | null,
  ): Promise<void> {
    if (!this._ready) return;

    this.frameCount++;
    this.drawSlot = 0;
    this.activeClips.clear();

    // Return all FBOs to pool
    for (const tex of this.fboInUse) {
      const key = `${tex.width}x${tex.height}`;
      let pool = this.fboPool.get(key);
      if (!pool) {
        pool = [];
        this.fboPool.set(key, pool);
      }
      pool.push(tex);
    }
    this.fboInUse.length = 0;

    // Phase 1: Prepare all draws recursively (upload textures, write uniforms)
    this.prepareCommands(commands, getFrame);

    // Phase 2: Flush uniform buffer
    if (this.drawSlot > 0) {
      this.device.queue.writeBuffer(
        this.uniformBuffer,
        0,
        this.uniformStagingBytes,
        0,
        this.drawSlot * UNIFORM_ALIGN,
      );
    }

    // Phase 3: Encode render passes
    const encoder = this.device.createCommandEncoder();
    const targetView = this.backend.acquireTarget(
      this.canvasWidth,
      this.canvasHeight,
    );
    this.encodeCommands(
      encoder,
      commands,
      targetView,
      this.canvasWidth,
      this.canvasHeight,
      true,
      this.pipeline,
    );
    this.device.queue.submit([encoder.finish()]);

    // Present / read back (backend-specific; browser is a no-op)
    await this.backend.present?.();

    // Prune stale textures periodically
    if (this.frameCount % 60 === 0) {
      this.backend.prune(this.activeClips);
      for (const clip of this.texBindGroupCache.keys()) {
        if (typeof clip !== "symbol" && !this.activeClips.has(clip)) {
          this.texBindGroupCache.delete(clip);
        }
      }
    }
  }

  // ── Phase 1: Prepare ──

  private prepareCommands(
    commands: RenderCommand[],
    getFrame: (clip: Drawable) => F | null,
  ): void {
    for (const cmd of commands) {
      if (cmd.type === "draw") {
        this.prepareDraw(cmd, getFrame);
      } else if (cmd.type === "fill") {
        this.prepareFill(cmd);
      } else {
        this.prepareGroup(cmd, getFrame);
      }
    }
  }

  private prepareFill(cmd: FillCommand): void {
    const slot = this.drawSlot++;
    if (slot >= MAX_DRAWS) return;
    (cmd as any)._slot = slot;
    this.activeClips.add(cmd.key);

    const view = this.backend.uploadFill(cmd.key, cmd.color);
    this.cacheTexBindGroup(cmd.key, view);
    this.writeFillUniforms(slot, cmd);
  }

  private prepareDraw(
    cmd: DrawCommand,
    getFrame: (clip: Drawable) => F | null,
  ): void {
    const slot = this.drawSlot++;
    if (slot >= MAX_DRAWS) return;

    this.activeClips.add(cmd.clip);
    (cmd as any)._slot = slot;

    const frame = getFrame(cmd.clip);
    if (!frame) {
      (cmd as any)._hasFrame = false;
      return;
    }
    (cmd as any)._hasFrame = true;

    const textureView = this.backend.uploadFrame(cmd.clip, frame);
    this.cacheTexBindGroup(cmd.clip, textureView);
    this.writeUniforms(slot, cmd);
  }

  private prepareGroup(
    cmd: GroupCommand,
    getFrame: (clip: Drawable) => F | null,
  ): void {
    // Prepare children first (they render into the FBO)
    this.prepareCommands(cmd.children, getFrame);

    // Reserve a slot for the FBO composite draw
    const slot = this.drawSlot++;
    if (slot >= MAX_DRAWS) return;
    (cmd as any)._slot = slot;

    // Acquire FBO
    const fbo = this.acquireFBO(Math.round(cmd.fboW), Math.round(cmd.fboH));
    (cmd as any)._fbo = fbo;

    // Create texture bind group for sampling the FBO
    const fboView = fbo.createView();
    const fboKey = Symbol();
    (cmd as any)._fboKey = fboKey;
    this.cacheTexBindGroup(fboKey, fboView);

    // Write uniforms for the FBO→parent composite draw
    this.writeGroupUniforms(slot, cmd);
  }

  private writeUniforms(slot: number, cmd: DrawCommand): void {
    const fp = extractFilterParams(cmd.clip.filters);
    const f32 = new Float32Array(
      this.uniformStaging,
      slot * UNIFORM_ALIGN,
      UNIFORM_SIZE / 4,
    );
    f32[0] = cmd.quadX;
    f32[1] = cmd.quadY;
    f32[2] = cmd.quadW;
    f32[3] = cmd.quadH;
    f32[4] = 0; // canvas_w — set during encode
    f32[5] = 0; // canvas_h — set during encode
    f32[6] = cmd.opacity; // node opacity already folded in by RenderList
    f32[7] = 0;
    f32[8] = fp.brightness;
    f32[9] = fp.contrast;
    f32[10] = fp.saturation;
    f32[11] = fp.gamma;
    f32[12] = fp.cb_rs; f32[13] = fp.cb_gs; f32[14] = fp.cb_bs; f32[15] = 0;
    f32[16] = fp.cb_rm; f32[17] = fp.cb_gm; f32[18] = fp.cb_bm; f32[19] = 0;
    f32[20] = fp.cb_rh; f32[21] = fp.cb_gh; f32[22] = fp.cb_bh; f32[23] = 0;
    f32[24] = fp.ct_r; f32[25] = fp.ct_g; f32[26] = fp.ct_b; f32[27] = 0;
    f32[28] = cmd.rotation; f32[29] = cmd.pivotX; f32[30] = cmd.pivotY; f32[31] = 0;
    writeCrop(f32, cmd.sourceRect);
  }

  private writeFillUniforms(slot: number, cmd: FillCommand): void {
    const f32 = new Float32Array(
      this.uniformStaging,
      slot * UNIFORM_ALIGN,
      UNIFORM_SIZE / 4,
    );
    f32[0] = cmd.destX;
    f32[1] = cmd.destY;
    f32[2] = cmd.destW;
    f32[3] = cmd.destH;
    f32[4] = 0; // canvas_w — set during encode
    f32[5] = 0; // canvas_h — set during encode
    f32[6] = cmd.opacity;
    f32[7] = 0;
    // Identity filter params — fill has no per-channel transforms.
    f32[8] = 0; f32[9] = 1; f32[10] = 1; f32[11] = 1;
    f32[12] = 0; f32[13] = 0; f32[14] = 0; f32[15] = 0;
    f32[16] = 0; f32[17] = 0; f32[18] = 0; f32[19] = 0;
    f32[20] = 0; f32[21] = 0; f32[22] = 0; f32[23] = 0;
    f32[24] = 1; f32[25] = 1; f32[26] = 1; f32[27] = 0;
    // Fills are never rotated (a rotated comp's bg fill rides inside its FBO).
    f32[28] = 0; f32[29] = 0; f32[30] = 0; f32[31] = 0;
    writeCrop(f32, undefined); // fills sample no sub-rect
  }

  private writeGroupUniforms(slot: number, cmd: GroupCommand): void {
    const fp = extractFilterParams(cmd.filters);
    const f32 = new Float32Array(
      this.uniformStaging,
      slot * UNIFORM_ALIGN,
      UNIFORM_SIZE / 4,
    );
    // The FBO quad is drawn at the group's dest rect on the parent
    f32[0] = cmd.destX;
    f32[1] = cmd.destY;
    f32[2] = cmd.destW;
    f32[3] = cmd.destH;
    f32[4] = 0; // canvas_w — set during encode
    f32[5] = 0; // canvas_h — set during encode
    f32[6] = cmd.opacity; // node opacity already folded in by RenderList
    f32[7] = 0;
    f32[8] = fp.brightness;
    f32[9] = fp.contrast;
    f32[10] = fp.saturation;
    f32[11] = fp.gamma;
    f32[12] = fp.cb_rs; f32[13] = fp.cb_gs; f32[14] = fp.cb_bs; f32[15] = 0;
    f32[16] = fp.cb_rm; f32[17] = fp.cb_gm; f32[18] = fp.cb_bm; f32[19] = 0;
    f32[20] = fp.cb_rh; f32[21] = fp.cb_gh; f32[22] = fp.cb_bh; f32[23] = 0;
    f32[24] = fp.ct_r; f32[25] = fp.ct_g; f32[26] = fp.ct_b; f32[27] = 0;
    f32[28] = cmd.rotation; f32[29] = cmd.pivotX; f32[30] = cmd.pivotY; f32[31] = 0;
    writeCrop(f32, cmd.sourceRect);
  }

  // ── Phase 3: Encode ──

  private encodeCommands(
    encoder: GPUCommandEncoder,
    commands: RenderCommand[],
    targetView: GPUTextureView,
    targetW: number,
    targetH: number,
    clear: boolean,
    pipeline: GPURenderPipeline,
  ): void {
    // First: recursively encode all group children into their FBOs
    for (const cmd of commands) {
      if (cmd.type === "group") {
        const fbo = (cmd as any)._fbo as GPUTexture;
        if (!fbo) continue;
        this.encodeCommands(
          encoder,
          cmd.children,
          fbo.createView(),
          Math.round(cmd.fboW),
          Math.round(cmd.fboH),
          true,
          this.fboPipeline,
        );
      }
    }

    // Then: single render pass for this level
    const pass = encoder.beginRenderPass({
      colorAttachments: [
        {
          view: targetView,
          clearValue: { r: 0, g: 0, b: 0, a: clear ? 1 : 0 },
          loadOp: clear ? "clear" : "load",
          storeOp: "store",
        },
      ],
    });

    pass.setPipeline(pipeline);

    for (const cmd of commands) {
      const slot = (cmd as any)._slot as number;
      if (slot == null || slot >= MAX_DRAWS) continue;

      if (cmd.type === "fill") {
        const cached = this.texBindGroupCache.get(cmd.key);
        if (!cached) continue;

        const f32 = new Float32Array(
          this.uniformStaging,
          slot * UNIFORM_ALIGN,
          UNIFORM_SIZE / 4,
        );
        f32[4] = targetW;
        f32[5] = targetH;
        this.device.queue.writeBuffer(
          this.uniformBuffer,
          slot * UNIFORM_ALIGN + 16,
          this.uniformStagingBytes,
          slot * UNIFORM_ALIGN + 16,
          8,
        );

        const sx = Math.max(0, Math.round(cmd.scissorX));
        const sy = Math.max(0, Math.round(cmd.scissorY));
        const sw = Math.min(Math.round(cmd.scissorW), targetW - sx);
        const sh = Math.min(Math.round(cmd.scissorH), targetH - sy);
        if (sw <= 0 || sh <= 0) continue;

        pass.setScissorRect(sx, sy, sw, sh);
        pass.setBindGroup(0, this.uniformBindGroups[slot]);
        pass.setBindGroup(1, cached.bg);
        pass.draw(6);
        continue;
      }

      if (cmd.type === "draw") {
        if (!(cmd as any)._hasFrame) continue;

        const cached = this.texBindGroupCache.get(cmd.clip);
        if (!cached) continue;

        // Patch canvas size into uniform staging (written during prepare,
        // but canvas size depends on the render target)
        const f32 = new Float32Array(
          this.uniformStaging,
          slot * UNIFORM_ALIGN,
          UNIFORM_SIZE / 4,
        );
        f32[4] = targetW;
        f32[5] = targetH;
        // Re-upload just this slot
        this.device.queue.writeBuffer(
          this.uniformBuffer,
          slot * UNIFORM_ALIGN + 16, // offset to canvas_opacity.x
          this.uniformStagingBytes,
          slot * UNIFORM_ALIGN + 16,
          8, // 2 floats
        );

        const sx = Math.max(0, Math.round(cmd.scissorX));
        const sy = Math.max(0, Math.round(cmd.scissorY));
        const sw = Math.min(Math.round(cmd.scissorW), targetW - sx);
        const sh = Math.min(Math.round(cmd.scissorH), targetH - sy);
        if (sw <= 0 || sh <= 0) continue;

        pass.setScissorRect(sx, sy, sw, sh);
        pass.setBindGroup(0, this.uniformBindGroups[slot]);
        pass.setBindGroup(1, cached.bg);
        pass.draw(6);
      } else {
        // Group: draw FBO texture with filters
        const fboKey = (cmd as any)._fboKey as symbol;
        const cached = this.texBindGroupCache.get(fboKey);
        if (!cached) continue;

        // Patch canvas size
        const f32 = new Float32Array(
          this.uniformStaging,
          slot * UNIFORM_ALIGN,
          UNIFORM_SIZE / 4,
        );
        f32[4] = targetW;
        f32[5] = targetH;
        this.device.queue.writeBuffer(
          this.uniformBuffer,
          slot * UNIFORM_ALIGN + 16,
          this.uniformStagingBytes,
          slot * UNIFORM_ALIGN + 16,
          8,
        );

        const sx = Math.max(0, Math.round(cmd.scissorX));
        const sy = Math.max(0, Math.round(cmd.scissorY));
        const sw = Math.min(Math.round(cmd.scissorW), targetW - sx);
        const sh = Math.min(Math.round(cmd.scissorH), targetH - sy);
        if (sw <= 0 || sh <= 0) continue;

        pass.setScissorRect(sx, sy, sw, sh);
        pass.setBindGroup(0, this.uniformBindGroups[slot]);
        pass.setBindGroup(1, cached.bg);
        pass.draw(6);
      }
    }

    pass.end();
  }

  // ── FBO Pool ──

  private acquireFBO(w: number, h: number): GPUTexture {
    const key = `${w}x${h}`;
    const pool = this.fboPool.get(key);
    let tex: GPUTexture | undefined;
    if (pool?.length) {
      tex = pool.pop()!;
    } else {
      tex = this.device.createTexture({
        size: [w, h],
        format: FBO_FORMAT,
        usage:
          GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
      });
    }
    this.fboInUse.push(tex);
    return tex;
  }

  // ── Helpers ──

  private cacheTexBindGroup(
    key: object | symbol,
    view: GPUTextureView,
  ): void {
    let cached = this.texBindGroupCache.get(key);
    if (!cached || cached.view !== view) {
      cached = {
        view,
        bg: this.device.createBindGroup({
          layout: this.textureBindGroupLayout,
          entries: [
            { binding: 0, resource: this.sampler },
            { binding: 1, resource: view },
          ],
        }),
      };
      this.texBindGroupCache.set(key, cached);
    }
  }

  dispose(): void {
    this.uniformBuffer?.destroy();
    this.texBindGroupCache.clear();
    for (const pool of this.fboPool.values()) {
      for (const tex of pool) tex.destroy();
    }
    for (const tex of this.fboInUse) tex.destroy();
    this.fboPool.clear();
    this.fboInUse.length = 0;
    // Drop per-device bind groups so a subsequent init() rebuilds them
    // against the new device rather than appending to a stale list.
    this.uniformBindGroups.length = 0;
    this.activeClips.clear();
    this._ready = false;
  }
}

// ── Filter param extraction ──

interface FilterParams {
  brightness: number;
  contrast: number;
  saturation: number;
  gamma: number;
  cb_rs: number; cb_gs: number; cb_bs: number;
  cb_rm: number; cb_gm: number; cb_bm: number;
  cb_rh: number; cb_gh: number; cb_bh: number;
  ct_r: number; ct_g: number; ct_b: number;
}

const IDENTITY_PARAMS: FilterParams = {
  brightness: 0, contrast: 1, saturation: 1, gamma: 1,
  cb_rs: 0, cb_gs: 0, cb_bs: 0,
  cb_rm: 0, cb_gm: 0, cb_bm: 0,
  cb_rh: 0, cb_gh: 0, cb_bh: 0,
  ct_r: 1, ct_g: 1, ct_b: 1,
};

/** Write the crop sub-rect (uniform float slots 32–35). Absent → full 0,0,1,1. */
function writeCrop(
  f32: Float32Array,
  sr: { u0: number; v0: number; u1: number; v1: number } | undefined,
): void {
  f32[32] = sr?.u0 ?? 0;
  f32[33] = sr?.v0 ?? 0;
  f32[34] = sr?.u1 ?? 1;
  f32[35] = sr?.v1 ?? 1;
}

// Filters are static now (opacity was ejected to a node field), so this is a
// plain fold over their literal params — no per-frame sampling.
function extractFilterParams(filters: Filter[] | undefined): FilterParams {
  if (!filters?.length) return IDENTITY_PARAMS;

  const p = { ...IDENTITY_PARAMS };

  for (const f of filters) {
    switch (f.type) {
      case "adjust":
        p.brightness += f.brightness ?? 0;
        p.contrast *= f.contrast ?? 1;
        p.saturation *= f.saturation ?? 1;
        p.gamma *= f.gamma ?? 1;
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

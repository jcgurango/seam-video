/**
 * Platform-neutral WebGPU compositor. Renders a {@link RenderCommand} tree to
 * a backend-provided target using textured quads. Compositions that need it
 * (extension fields, rotation, opacity, inset, distort, corner mask) render
 * to intermediate textures (FBO) so the effect applies to the composite.
 *
 * This is the preview's old `WebGPURenderer` with the four browser-specific
 * touch points lifted behind a {@link RenderBackend}: device + output format,
 * frame upload, fill rasterization, and target acquisition / present. The GPU
 * algorithm (pipelines, uniforms, FBO pool, encode loop) is unchanged and is
 * shared verbatim between the live preview and the headless Node renderer.
 *
 * One pass per quad. The fragment shader is ASSEMBLED per Seam instance:
 *   colour stages — per-pixel colour functions contributed by extensions
 *                   (`seam.colorStages`), fused in registration order; each
 *                   owns a run of slots in the `ext` uniform array
 *   opacity — alpha multiply
 *   shape — analytic rounded-rect / ellipse coverage (signed distance, 1px
 *           AA): the geometry of a `rect`/`circle` fill, or the `cornerRadius`
 *           mask on any textured draw / composited group
 */

import { quadWeights, type Quad, type Seam } from "@seam/core";
import type { RenderBackend } from "./backend.js";
import {
  NO_FIELDS,
  type RenderCommand,
  type DrawCommand,
  type FillCommand,
  type GroupCommand,
  type FieldValues,
  type ShapeGeometry,
} from "./RenderList.js";

/** What the compositor needs from a Seam instance: the contributed colour
 *  stages and how many uniform slots they take. */
export type CompositorExtensions = Pick<Seam, "colorStages" | "colorSlots">;

/** Anything a {@link DrawCommand} can carry — addressed by object identity. */
type Drawable = DrawCommand["clip"];

// ── WGSL Shader ──

/** Float offsets of the fixed uniform members (each a vec4f). The extension
 *  colour-stage slots follow at {@link EXT_BASE}. */
const U_ROT = 8;
const U_CROP = 12;
const U_CORNERS = 16; // c01, c23, cw — 12 floats
const U_SHAPE = 28;
const EXT_BASE = 32;
const FIXED_VEC4S = EXT_BASE / 4;

/** Assemble the shader for one extension set. `ext` always has at least one
 *  slot (WGSL has no zero-length arrays). */
function buildShader(ext: CompositorExtensions): string {
  const slots = Math.max(1, ext.colorSlots);
  const stageSource = ext.colorStages.map((st) => st.wgsl).join("\n");
  const stageCalls = ext.colorStages
    .map((st) => {
      const args = Array.from({ length: st.slots }, (_, i) => `u.ext[${st.offset + i}]`);
      return `  rgb = ${st.entry}(${["rgb", ...args].join(", ")});`;
    })
    .join("\n");
  return SHADER_HEAD.replace("__EXT_SLOTS__", String(slots)) + stageSource + SHADER_FS_OPEN + stageCalls + SHADER_FS_CLOSE;
}

const SHADER_HEAD = /* wgsl */ `
struct Uniforms {
  dest: vec4f,
  canvas_opacity: vec4f,
  rot: vec4f, // rotation_radians, pivot_x, pivot_y, distort_enabled (0/1)
  crop: vec4f, // u0, v0, u1, v1 — visible source sub-rect (inset); full = 0,0,1,1
  c01: vec4f, // distort corners TL.xy, TR.xy (target px, pre-rotation)
  c23: vec4f, // distort corners BR.xy, BL.xy
  cw: vec4f,  // per-corner homogeneous weights (TL, TR, BR, BL) → clip.w
  shape: vec4f, // kind (0 none / 1 roundrect / 2 ellipse), radius px, outer inset px, inner inset px (<0 = solid)
  ext: array<vec4f, __EXT_SLOTS__>, // extension colour-stage slots
}

@group(0) @binding(0) var<uniform> u: Uniforms;
@group(1) @binding(0) var tex_sampler: sampler;
@group(1) @binding(1) var tex: texture_2d<f32>;

struct VSOut {
  @builtin(position) pos: vec4f,
  @location(0) uv: vec2f,
  // Quad-local coordinate (0..1 across the dest rect, before crop/rotation) —
  // the shape mask is evaluated in this space.
  @location(1) local: vec2f,
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
  // Corner-pin (distort): put this vertex at its pinned corner instead of the
  // dest rect, and carry the corner's homogeneous weight into clip.w so the
  // rasterizer interpolates uv projectively (a true perspective warp, no
  // crease along the diagonal). Weights are all 1 for an ordinary draw.
  var w = 1.0;
  if (u.rot.w != 0.0) {
    let right = p.x > 0.5;
    let bottom = p.y > 0.5;
    let top_xy = select(u.c01.xy, u.c01.zw, right);
    let bot_xy = select(u.c23.zw, u.c23.xy, right);
    let xy = select(top_xy, bot_xy, bottom);
    px = xy.x;
    py = xy.y;
    w = select(select(u.cw.x, u.cw.y, right), select(u.cw.w, u.cw.z, right), bottom);
  }
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
  return VSOut(vec4f(ndc_x * w, ndc_y * w, 0.0, w), uv, p);
}

// Signed distance (px) from p (px from the quad center) to the shape's
// boundary, inset by inset px. Negative inside.
fn shape_dist(p: vec2f, size: vec2f, kind: f32, radius: f32, inset: f32) -> f32 {
  let half = size * 0.5 - vec2f(inset, inset);
  if (kind > 1.5) {
    // Ellipse inscribed in the (inset) box. First-order distance estimate:
    // f / |∇f| with f = |p/ab| − 1 — exact for circles, close for ellipses.
    let ab = max(half, vec2f(1e-3, 1e-3));
    let f = length(p / ab) - 1.0;
    let g = length(p / (ab * ab));
    return select(f * min(ab.x, ab.y), f / g, g > 1e-6);
  }
  // Rounded rect: corner radius shrinks with the inset and is capped at the
  // shorter half-side (a 50% radius on a square is exactly a circle).
  let r = clamp(radius - inset, 0.0, max(min(half.x, half.y), 0.0));
  let q = abs(p) - half + vec2f(r, r);
  return length(max(q, vec2f(0.0, 0.0))) + min(max(q.x, q.y), 0.0) - r;
}

// Pixel coverage of the inside of a signed-distance boundary (1px AA in
// screen space via the derivative, so rotation/scale don't soften the edge).
fn coverage(d: f32) -> f32 {
  let aa = max(fwidth(d), 1e-4);
  return clamp(0.5 - d / aa, 0.0, 1.0);
}

`;

const SHADER_FS_OPEN = /* wgsl */ `
@fragment
fn fs(input: VSOut) -> @location(0) vec4f {
  let color = textureSample(tex, tex_sampler, input.uv);
  var rgb = color.rgb;

  // ── extension colour stages (registration order) ──
`;

const SHADER_FS_CLOSE = /* wgsl */ `

  // ── shape / cornerRadius mask ──
  // Computed unconditionally (derivatives need uniform control flow); a kind
  // of 0 yields full coverage.
  let pl = (input.local - vec2f(0.5, 0.5)) * u.dest.zw;
  let d_outer = shape_dist(pl, u.dest.zw, u.shape.x, u.shape.y, u.shape.z);
  let d_inner = shape_dist(pl, u.dest.zw, u.shape.x, u.shape.y, u.shape.w);
  var cov = coverage(d_outer);
  if (u.shape.w >= 0.0) { cov = cov - coverage(d_inner); }
  cov = select(1.0, clamp(cov, 0.0, 1.0), u.shape.x > 0.5);

  return vec4f(rgb, color.a * u.canvas_opacity.z * cov);
}
`;

const MAX_DRAWS = 128;
const FBO_FORMAT: GPUTextureFormat = "rgba8unorm";

export class Compositor<F = unknown> {
  private readonly backend: RenderBackend<F>;
  private readonly ext: CompositorExtensions;
  /** Bytes of one draw's uniform block, and its 256-aligned stride. */
  private readonly uniformSize: number;
  private readonly uniformAlign: number;
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
  private uniformStaging: ArrayBuffer;
  /** Byte view of {@link uniformStaging} for `writeBuffer` — Dawn's Node
   *  bindings mishandle a raw ArrayBuffer source, so we always hand it a
   *  typed-array view (valid in the browser too). */
  private uniformStagingBytes: Uint8Array<ArrayBuffer>;
  private frameCount = 0;
  private drawSlot = 0;
  private activeClips = new Set<object>();

  // FBO pool: keyed by "WxH", reused across frames
  private fboPool = new Map<string, GPUTexture[]>();
  private fboInUse: GPUTexture[] = [];

  /** `ext`: the Seam instance (or its `colorStages` / `colorSlots`) — the
   *  shader and uniform layout are built for that extension set. */
  constructor(backend: RenderBackend<F>, ext: CompositorExtensions) {
    this.backend = backend;
    this.ext = ext;
    this.uniformSize = (FIXED_VEC4S + Math.max(1, ext.colorSlots)) * 16;
    this.uniformAlign = Math.ceil(this.uniformSize / 256) * 256;
    this.uniformStaging = new ArrayBuffer(MAX_DRAWS * this.uniformAlign);
    this.uniformStagingBytes = new Uint8Array(this.uniformStaging);
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

    const shaderModule = this.device.createShaderModule({ code: buildShader(this.ext) });

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
      size: MAX_DRAWS * this.uniformAlign,
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
                offset: i * this.uniformAlign,
                size: this.uniformSize,
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
        this.drawSlot * this.uniformAlign,
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

  /** Let each colour stage fill its uniform slots from the command's sampled
   *  field values (an empty set = every field at its default). */
  private writeStages(f32: Float32Array, fields: FieldValues): void {
    for (const st of this.ext.colorStages) {
      const at = EXT_BASE + st.offset * 4;
      st.prepare(fields, f32.subarray(at, at + st.slots * 4));
    }
  }

  private writeUniforms(slot: number, cmd: DrawCommand): void {
    const f32 = new Float32Array(
      this.uniformStaging,
      slot * this.uniformAlign,
      this.uniformSize / 4,
    );
    f32[0] = cmd.quadX;
    f32[1] = cmd.quadY;
    f32[2] = cmd.quadW;
    f32[3] = cmd.quadH;
    f32[4] = 0; // canvas_w — set during encode
    f32[5] = 0; // canvas_h — set during encode
    f32[6] = cmd.opacity; // node opacity already folded in by RenderList
    f32[7] = 0;
    f32[U_ROT] = cmd.rotation; f32[U_ROT + 1] = cmd.pivotX; f32[U_ROT + 2] = cmd.pivotY; f32[U_ROT + 3] = 0;
    writeCrop(f32, cmd.sourceRect);
    writeCorners(f32, undefined); // leaves aren't corner-pinned (comp-only)
    writeShape(f32, cmd.mask);
    this.writeStages(f32, cmd.fields);
  }

  private writeFillUniforms(slot: number, cmd: FillCommand): void {
    const f32 = new Float32Array(
      this.uniformStaging,
      slot * this.uniformAlign,
      this.uniformSize / 4,
    );
    f32[0] = cmd.destX;
    f32[1] = cmd.destY;
    f32[2] = cmd.destW;
    f32[3] = cmd.destH;
    f32[4] = 0; // canvas_w — set during encode
    f32[5] = 0; // canvas_h — set during encode
    f32[6] = cmd.opacity;
    f32[7] = 0;
    // Shape fills rotate about their origin like any node; background fills
    // pass 0 (a rotated comp's bg fill rides inside its FBO).
    f32[U_ROT] = cmd.rotation; f32[U_ROT + 1] = cmd.pivotX; f32[U_ROT + 2] = cmd.pivotY; f32[U_ROT + 3] = 0;
    writeCrop(f32, undefined); // fills sample no sub-rect
    writeCorners(f32, undefined);
    writeShape(f32, cmd.shape);
    this.writeStages(f32, cmd.fields ?? NO_FIELDS);
  }

  private writeGroupUniforms(slot: number, cmd: GroupCommand): void {
    const f32 = new Float32Array(
      this.uniformStaging,
      slot * this.uniformAlign,
      this.uniformSize / 4,
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
    f32[U_ROT] = cmd.rotation; f32[U_ROT + 1] = cmd.pivotX; f32[U_ROT + 2] = cmd.pivotY;
    f32[U_ROT + 3] = cmd.corners ? 1 : 0; // distort flag — vs reads geometry from c01/c23
    writeCrop(f32, cmd.sourceRect);
    writeCorners(f32, cmd.corners);
    writeShape(f32, cmd.mask);
    this.writeStages(f32, cmd.fields);
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
    // FBO layers clear to *transparent* so a composition's unfilled regions
    // stay see-through when the layer is composited back (esp. at opacity < 1).
    // The root target clears to opaque black — the final canvas base. Clearing
    // an FBO opaque-black turned a transparent-bg comp's empty area into black
    // that bled in during an opacity fade.
    transparentClear = false,
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
          true,
        );
      }
    }

    // Then: single render pass for this level
    const pass = encoder.beginRenderPass({
      colorAttachments: [
        {
          view: targetView,
          clearValue: { r: 0, g: 0, b: 0, a: clear && !transparentClear ? 1 : 0 },
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
          slot * this.uniformAlign,
          this.uniformSize / 4,
        );
        f32[4] = targetW;
        f32[5] = targetH;
        this.device.queue.writeBuffer(
          this.uniformBuffer,
          slot * this.uniformAlign + 16,
          this.uniformStagingBytes,
          slot * this.uniformAlign + 16,
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
          slot * this.uniformAlign,
          this.uniformSize / 4,
        );
        f32[4] = targetW;
        f32[5] = targetH;
        // Re-upload just this slot
        this.device.queue.writeBuffer(
          this.uniformBuffer,
          slot * this.uniformAlign + 16, // offset to canvas_opacity.x
          this.uniformStagingBytes,
          slot * this.uniformAlign + 16,
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
        // Group: draw the FBO texture (colour stages, opacity, mask)
        const fboKey = (cmd as any)._fboKey as symbol;
        const cached = this.texBindGroupCache.get(fboKey);
        if (!cached) continue;

        // Patch canvas size
        const f32 = new Float32Array(
          this.uniformStaging,
          slot * this.uniformAlign,
          this.uniformSize / 4,
        );
        f32[4] = targetW;
        f32[5] = targetH;
        this.device.queue.writeBuffer(
          this.uniformBuffer,
          slot * this.uniformAlign + 16,
          this.uniformStagingBytes,
          slot * this.uniformAlign + 16,
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

/** Write the crop sub-rect (4 floats at U_CROP). Absent → full 0,0,1,1. */
function writeCrop(
  f32: Float32Array,
  sr: { u0: number; v0: number; u1: number; v1: number } | undefined,
): void {
  f32[U_CROP] = sr?.u0 ?? 0;
  f32[U_CROP + 1] = sr?.v0 ?? 0;
  f32[U_CROP + 2] = sr?.u1 ?? 1;
  f32[U_CROP + 3] = sr?.v1 ?? 1;
}

/** Write the corner-pin quad (12 floats at U_CORNERS): TL/TR, BR/BL in target px
 *  plus the per-corner homogeneous weights. Absent → zeros + unit weights
 *  (ignored by the shader when `rot.w` is 0). */
function writeCorners(f32: Float32Array, corners: Quad | undefined): void {
  if (!corners) {
    for (let i = 0; i < 8; i++) f32[U_CORNERS + i] = 0;
    for (let i = 8; i < 12; i++) f32[U_CORNERS + i] = 1;
    return;
  }
  const [tl, tr, br, bl] = corners;
  const c = U_CORNERS;
  f32[c] = tl.x; f32[c + 1] = tl.y; f32[c + 2] = tr.x; f32[c + 3] = tr.y;
  f32[c + 4] = br.x; f32[c + 5] = br.y; f32[c + 6] = bl.x; f32[c + 7] = bl.y;
  const w = quadWeights(corners);
  f32[c + 8] = w[0]; f32[c + 9] = w[1]; f32[c + 10] = w[2]; f32[c + 11] = w[3];
}

/** Write the shape / mask geometry (4 floats at U_SHAPE). Absent → kind 0 (the
 *  shader then yields full coverage). */
function writeShape(f32: Float32Array, shape: ShapeGeometry | undefined): void {
  if (!shape) {
    f32[U_SHAPE] = 0; f32[U_SHAPE + 1] = 0; f32[U_SHAPE + 2] = 0; f32[U_SHAPE + 3] = -1;
    return;
  }
  f32[U_SHAPE] = shape.kind === "ellipse" ? 2 : 1;
  f32[U_SHAPE + 1] = shape.radius;
  f32[U_SHAPE + 2] = shape.outerInset;
  f32[U_SHAPE + 3] = shape.innerInset;
}

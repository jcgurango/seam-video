/// <reference types="@webgpu/types" />
/**
 * HDR → SDR tone mapping on the GPU — the render loop's path.
 *
 * Same maths as `tonemapToRgba` in `hdrToSdr.ts` (read that file for the
 * pipeline and where it comes from), as one fragment pass on the compositor's
 * own Dawn device: the decoded Y'CbCr planes upload as three `r16uint`
 * textures and the pass writes an `rgba8unorm` texture the compositor samples
 * directly — the frame never comes back to the CPU. The container/authored
 * rotation is folded into the same pass (the CPU path needs a second walk
 * over the pixels for it).
 *
 * The curve is evaluated analytically per pixel instead of through LUTs, so
 * the two implementations differ by rounding only (≤ 1 code; pinned in
 * `__tests__/hdr-to-sdr-gpu.test.ts`). Constants are injected from
 * `HDR_CONSTANTS` — never retype them here.
 *
 * Measured on 1080p HLG (`bench/hdr-tonemap.ts`): ~3 ms per frame including
 * the plane copy and upload, against ~45 ms for the scalar TypeScript loop
 * (and ~9 ms for mediabunny's plain RGBA conversion of an SDR frame).
 */
import type { NodeFrame } from "./NodeBackend.js";
import {
  HDR_CONSTANTS,
  gamutMatrix,
  lumaCoefficients,
  yuvScaling,
  type YuvPicture,
} from "./hdrToSdr.js";

export type QuarterTurn = 0 | 90 | 180 | 270;

/** WGSL float literal. */
const f = (n: number): string => (Number.isInteger(n) ? `${n}.0` : `${n}`);

function shaderSource(): string {
  const C = HDR_CONSTANTS;
  return /* wgsl */ `
struct Params {
  gamut0: vec4f,          // rows of the primaries matrix (xyz)
  gamut1: vec4f,
  gamut2: vec4f,
  yuv: vec4f,             // yOff, 1/yRange, cMid, 1/cRange  (code values)
  luma: vec4f,            // Kr, Kb
  srcSize: vec2u,         // coded luma size
  sub: vec2u,             // log2 chroma subsampling
  rotation: u32,          // clockwise degrees: 0 / 90 / 180 / 270
  transfer: u32,          // 0 = HLG, 1 = PQ
};

@group(0) @binding(0) var<uniform> p: Params;
@group(0) @binding(1) var yTex: texture_2d<u32>;
@group(0) @binding(2) var uTex: texture_2d<u32>;
@group(0) @binding(3) var vTex: texture_2d<u32>;

@vertex
fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
  // One triangle covering the target.
  let x = f32((i << 1u) & 2u) * 2.0 - 1.0;
  let y = f32(i & 2u) * 2.0 - 1.0;
  return vec4f(x, y, 0.0, 1.0);
}

fn hlgToLinear(x: vec3f) -> vec3f {
  let lo = 4.0 * x * x;
  let hi = exp((x - vec3f(${f(C.ARIB_B67_C)})) / ${f(C.ARIB_B67_A)}) + vec3f(${f(C.ARIB_B67_B)});
  let scene = max(select(lo, hi, x > vec3f(0.5)) / 12.0, vec3f(0.0));
  return ${f(C.HLG_SCALE)} * pow(scene, vec3f(${f(C.HLG_GAMMA)}));
}

fn pqToLinear(x: vec3f) -> vec3f {
  let xpow = pow(max(x, vec3f(0.0)), vec3f(1.0 / ${f(C.ST2084_M2)}));
  let num = max(xpow - vec3f(${f(C.ST2084_C1)}), vec3f(0.0));
  let den = max(vec3f(${f(C.ST2084_C2)}) - ${f(C.ST2084_C3)} * xpow, vec3f(1e-6));
  return pow(num / den, vec3f(1.0 / ${f(C.ST2084_M1)})) * ${f(C.PQ_SCALE)};
}

fn toLinear(x: vec3f) -> vec3f {
  if (p.transfer == 1u) { return pqToLinear(x); }
  return hlgToLinear(x);
}

fn hable(x: f32) -> f32 {
  let a = 0.15; let b = 0.50; let c = 0.10; let d = 0.20; let e = 0.02; let f = 0.30;
  return (x * (x * a + b * c) + d * e) / (x * (x * a + b) + d * f) - e / f;
}

@fragment
fn fs(@builtin(position) pos: vec4f) -> @location(0) vec4f {
  // Output pixel → coded source pixel (inverse of a clockwise rotation).
  let d = vec2u(pos.xy);
  let w = p.srcSize.x;
  let h = p.srcSize.y;
  var s = d;
  if (p.rotation == 90u) { s = vec2u(d.y, h - 1u - d.x); }
  else if (p.rotation == 180u) { s = vec2u(w - 1u - d.x, h - 1u - d.y); }
  else if (p.rotation == 270u) { s = vec2u(w - 1u - d.y, d.x); }
  let c = vec2u(s.x >> p.sub.x, s.y >> p.sub.y);

  // Y'CbCr codes → R'G'B' signal.
  let yy = (f32(textureLoad(yTex, s, 0).r) - p.yuv.x) * p.yuv.y;
  let cb = (f32(textureLoad(uTex, c, 0).r) - p.yuv.z) * p.yuv.w;
  let cr = (f32(textureLoad(vTex, c, 0).r) - p.yuv.z) * p.yuv.w;
  let kr = p.luma.x;
  let kb = p.luma.y;
  let kg = 1.0 - kr - kb;
  let sig = clamp(vec3f(
    yy + 2.0 * (1.0 - kr) * cr,
    yy - (2.0 * kb * (1.0 - kb) / kg) * cb - (2.0 * kr * (1.0 - kr) / kg) * cr,
    yy + 2.0 * (1.0 - kb) * cb,
  ), vec3f(0.0), vec3f(1.0));

  // One gain for the pixel, from its brightest channel (pre-gamut).
  let lin = toLinear(sig);
  let peakSig = toLinear(vec3f(max(sig.r, max(sig.g, sig.b)))).r;
  var gain = 0.0;
  if (peakSig > 0.0) {
    gain = max(hable(peakSig) / ${f(C.HABLE_PEAK)}, 0.0) / peakSig;
  }

  let mapped = clamp(vec3f(
    dot(p.gamut0.xyz, lin),
    dot(p.gamut1.xyz, lin),
    dot(p.gamut2.xyz, lin),
  ) * gain, vec3f(0.0), vec3f(1.0));
  return vec4f(pow(mapped, vec3f(1.0 / 2.4)), 1.0);
}
`;
}

interface Pipeline {
  pipeline: GPURenderPipeline;
  layout: GPUBindGroupLayout;
}

// One pipeline per device, shared by every converter on it.
const pipelines = new WeakMap<GPUDevice, Pipeline>();

function pipelineFor(device: GPUDevice): Pipeline {
  let entry = pipelines.get(device);
  if (!entry) {
    const module = device.createShaderModule({ code: shaderSource() });
    const plane: GPUBindGroupLayoutEntry["texture"] = { sampleType: "uint" };
    const layout = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.FRAGMENT, buffer: { type: "uniform" } },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: plane },
        { binding: 2, visibility: GPUShaderStage.FRAGMENT, texture: plane },
        { binding: 3, visibility: GPUShaderStage.FRAGMENT, texture: plane },
      ],
    });
    const pipeline = device.createRenderPipeline({
      layout: device.createPipelineLayout({ bindGroupLayouts: [layout] }),
      vertex: { module, entryPoint: "vs" },
      fragment: { module, entryPoint: "fs", targets: [{ format: "rgba8unorm" }] },
      primitive: { topology: "triangle-list" },
    });
    entry = { pipeline, layout };
    pipelines.set(device, entry);
  }
  return entry;
}

const PARAMS_BYTES = 112;
/** Frames whose pixels live in a texture carry no CPU bytes. */
const NO_DATA = new Uint8Array(0);

interface Plane {
  texture: GPUTexture;
  width: number;
  height: number;
}

/**
 * Tone-maps HDR pictures into a texture it owns. One per decode cursor: each
 * {@link convert} overwrites the previous output, which is safe in the render
 * loop because a frame's draw is submitted before the next one is prepared
 * (the queue orders them). Textures are reallocated only when the geometry
 * changes.
 */
export class HdrToSdrGpu {
  private readonly params = new ArrayBuffer(PARAMS_BYTES);
  private readonly paramsF32 = new Float32Array(this.params);
  private readonly paramsU32 = new Uint32Array(this.params);
  private readonly uniforms: GPUBuffer;
  private planes: [Plane, Plane, Plane] | null = null;
  private bindGroup: GPUBindGroup | null = null;
  private target: GPUTexture | null = null;
  private targetView: GPUTextureView | null = null;

  constructor(private readonly device: GPUDevice) {
    this.uniforms = device.createBuffer({
      size: PARAMS_BYTES,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
  }

  /** The texture the last {@link convert} rendered into (tests / readback). */
  get texture(): GPUTexture | null {
    return this.target;
  }

  /**
   * Tone-map `pic` to SDR BT.709, rotated clockwise by `rotation`, and return
   * it as a display-oriented frame backed by this converter's texture. The
   * GPU work is submitted before returning; nothing is awaited.
   */
  convert(pic: YuvPicture, rotation: QuarterTurn = 0): NodeFrame {
    const { device } = this;
    const { width, height, subX, subY } = pic;
    const cw = (width + (1 << subX) - 1) >> subX;
    const ch = (height + (1 << subY) - 1) >> subY;
    const swap = rotation === 90 || rotation === 270;
    const outW = swap ? height : width;
    const outH = swap ? width : height;

    const planes = this.ensurePlanes(width, height, cw, ch);
    this.upload(planes[0], pic.y, pic.yStride);
    this.upload(planes[1], pic.u, pic.uStride);
    this.upload(planes[2], pic.v, pic.vStride);

    if (!this.target || this.target.width !== outW || this.target.height !== outH) {
      this.target?.destroy();
      this.target = device.createTexture({
        size: [outW, outH],
        format: "rgba8unorm",
        usage:
          GPUTextureUsage.RENDER_ATTACHMENT |
          GPUTextureUsage.TEXTURE_BINDING |
          GPUTextureUsage.COPY_SRC,
      });
      this.targetView = this.target.createView();
    }

    const { yOff, yRange, cMid, cRange } = yuvScaling(pic);
    const [kr, kb] = lumaCoefficients(pic.matrix);
    const m = gamutMatrix(pic.primaries);
    const fl = this.paramsF32;
    fl.set([m[0]!, m[1]!, m[2]!, 0, m[3]!, m[4]!, m[5]!, 0, m[6]!, m[7]!, m[8]!, 0], 0);
    fl.set([yOff, 1 / yRange, cMid, 1 / cRange], 12);
    fl.set([kr, kb, 0, 0], 16);
    this.paramsU32.set([width, height, subX, subY, rotation, pic.transfer === "pq" ? 1 : 0], 20);
    device.queue.writeBuffer(this.uniforms, 0, this.params);

    const { pipeline } = pipelineFor(device);
    const encoder = device.createCommandEncoder();
    const pass = encoder.beginRenderPass({
      colorAttachments: [{ view: this.targetView!, loadOp: "clear", storeOp: "store" }],
    });
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, this.bindGroup!);
    pass.draw(3);
    pass.end();
    device.queue.submit([encoder.finish()]);

    return { data: NO_DATA, width: outW, height: outH, view: this.targetView! };
  }

  dispose(): void {
    if (this.planes) for (const p of this.planes) p.texture.destroy();
    this.planes = null;
    this.bindGroup = null;
    this.target?.destroy();
    this.target = null;
    this.targetView = null;
    this.uniforms.destroy();
  }

  private ensurePlanes(w: number, h: number, cw: number, ch: number): [Plane, Plane, Plane] {
    const p = this.planes;
    if (p && p[0].width === w && p[0].height === h && p[1].width === cw && p[1].height === ch) {
      return p;
    }
    if (p) for (const plane of p) plane.texture.destroy();
    const make = (width: number, height: number): Plane => ({
      width,
      height,
      texture: this.device.createTexture({
        size: [width, height],
        format: "r16uint",
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
      }),
    });
    const planes: [Plane, Plane, Plane] = [make(w, h), make(cw, ch), make(cw, ch)];
    this.planes = planes;
    this.bindGroup = this.device.createBindGroup({
      layout: pipelineFor(this.device).layout,
      entries: [
        { binding: 0, resource: { buffer: this.uniforms } },
        { binding: 1, resource: planes[0].texture.createView() },
        { binding: 2, resource: planes[1].texture.createView() },
        { binding: 3, resource: planes[2].texture.createView() },
      ],
    });
    return planes;
  }

  private upload(plane: Plane, samples: Uint16Array, stride: number): void {
    this.device.queue.writeTexture(
      { texture: plane.texture },
      new Uint8Array(samples.buffer, samples.byteOffset, samples.byteLength) as GPUAllowSharedBufferSource,
      { bytesPerRow: stride * 2, rowsPerImage: plane.height },
      [plane.width, plane.height],
    );
  }
}

/** Read an `rgba8unorm` texture back as tightly packed RGBA (tests / bench). */
export async function readTextureRgba(device: GPUDevice, texture: GPUTexture): Promise<Uint8Array> {
  const { width, height } = texture;
  const bytesPerRow = Math.ceil((width * 4) / 256) * 256;
  const buffer = device.createBuffer({
    size: bytesPerRow * height,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
  });
  const encoder = device.createCommandEncoder();
  encoder.copyTextureToBuffer({ texture }, { buffer, bytesPerRow, rowsPerImage: height }, [width, height]);
  device.queue.submit([encoder.finish()]);
  await buffer.mapAsync(GPUMapMode.READ);
  const padded = new Uint8Array(buffer.getMappedRange());
  const out = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    out.set(padded.subarray(y * bytesPerRow, y * bytesPerRow + width * 4), y * width * 4);
  }
  buffer.unmap();
  buffer.destroy();
  return out;
}

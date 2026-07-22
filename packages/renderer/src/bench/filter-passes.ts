/// <reference types="@webgpu/types" />
/**
 * Empirical GPU-cost comparison: fused single-pass filtering (what the
 * compositor does today) vs a per-filter WGSL pass chain (what authored-order
 * / stackable filters would require).
 *
 * The "heavy grade" filter is a representative HSL-style per-pixel grade used
 * to bracket expensive-vs-cheap filter cost; it models fragment work, it is not
 * a shipped filter.
 *
 * Uses the headless Dawn device with `timestamp-query` to measure real GPU
 * time around the render pass(es). For each config we render the same logical
 * filter stack two ways and report the median GPU time over many iterations.
 *
 *   Fused:   1 pass, one fragment shader applies every filter in sequence.
 *   Chained: N passes ping-ponging between textures, one filter per pass.
 *
 * Run:  npx tsx packages/renderer/src/bench/filter-passes.ts
 */
import { create, globals } from "webgpu";

// Pin the Dawn instance at module scope (GC root — see gpu.ts).
// Disable timestamp quantization (default ~65.5µs granularity) for precision.
Object.assign(globalThis, globals);
const instance = create(["disable-dawn-features=timestamp_quantization"]);

// ── WGSL ──

const COMMON = /* wgsl */ `
struct U {
  eq: vec4f,    // brightness, contrast, saturation, gamma
  cbS: vec4f, cbM: vec4f, cbH: vec4f,
  ct: vec4f,    // r,g,b scale
  twFlags: vec4f, // f0type, f1type, opType, preview
  twF0: vec4f, twF1: vec4f, twOp0: vec4f, twOp1: vec4f,
};
@group(0) @binding(0) var<uniform> u: U;
@group(0) @binding(1) var samp: sampler;
@group(0) @binding(2) var tex: texture_2d<f32>;

struct VsOut { @builtin(position) pos: vec4f, @location(0) uv: vec2f };
@vertex fn vs(@builtin(vertex_index) i: u32) -> VsOut {
  var p = array<vec2f,3>(vec2f(-1.,-1.), vec2f(3.,-1.), vec2f(-1.,3.));
  var o: VsOut;
  o.pos = vec4f(p[i], 0., 1.);
  var uv = 0.5 * (p[i] + vec2f(1., 1.));
  uv.y = 1. - uv.y;
  o.uv = uv;
  return o;
}

fn rgb2yuv(c: vec3f) -> vec3f {
  return vec3f(0.299*c.r+0.587*c.g+0.114*c.b,
              -0.169*c.r-0.331*c.g+0.5*c.b+0.5,
               0.5*c.r-0.419*c.g-0.081*c.b+0.5);
}
fn yuv2rgb(y: vec3f) -> vec3f {
  let u_ = y.y-0.5; let v=y.z-0.5;
  return vec3f(y.x+1.402*v, y.x-0.344*u_-0.714*v, y.x+1.772*u_);
}
fn applyAdjust(rgb: vec3f) -> vec3f {
  var yuv = rgb2yuv(rgb);
  var yy = u.eq.y*(yuv.x-0.5)+0.5+u.eq.x;
  yy = pow(max(yy,0.), 1./u.eq.w);
  yuv.x = yy;
  yuv.y = (yuv.y-0.5)*u.eq.z+0.5;
  yuv.z = (yuv.z-0.5)*u.eq.z+0.5;
  return clamp(yuv2rgb(yuv), vec3f(0.), vec3f(1.));
}
fn applyCB(rgb: vec3f) -> vec3f {
  let l = max(max(rgb.r,rgb.g),rgb.b)+min(min(rgb.r,rgb.g),rgb.b);
  let sw = clamp((0.333-l)*4.+0.5,0.,1.)*0.7;
  let mw = clamp((l-0.333)*4.+0.5,0.,1.)*clamp((1.-l-0.333)*4.+0.5,0.,1.)*0.7;
  let hw = clamp((l+0.333-1.)*4.+0.5,0.,1.)*0.7;
  var o = rgb;
  o.r = clamp(rgb.r+u.cbS.x*sw+u.cbM.x*mw+u.cbH.x*hw,0.,1.);
  o.g = clamp(rgb.g+u.cbS.y*sw+u.cbM.y*mw+u.cbH.y*hw,0.,1.);
  o.b = clamp(rgb.b+u.cbS.z*sw+u.cbM.z*mw+u.cbH.z*hw,0.,1.);
  return o;
}
fn applyCT(rgb: vec3f) -> vec3f { return clamp(rgb*u.ct.xyz, vec3f(0.), vec3f(1.)); }

fn rgb2hsl(c: vec3f) -> vec3f {
  let mx=max(max(c.r,c.g),c.b); let mn=min(min(c.r,c.g),c.b);
  let l=(mx+mn)*0.5; var h=0.; var s=0.; let d=mx-mn;
  if (d>1e-6) {
    s=d/(1.-abs(2.*l-1.));
    if (mx==c.r) { h=((c.g-c.b)/d)%6.; }
    else if (mx==c.g) { h=(c.b-c.r)/d+2.; }
    else { h=(c.r-c.g)/d+4.; }
    h=h*60.; if (h<0.) { h=h+360.; }
  }
  return vec3f(h, s*100., l*100.);
}
fn hue2rgb(p: f32, q: f32, t0: f32) -> f32 {
  var t=t0; if (t<0.) {t=t+1.;} if (t>1.) {t=t-1.;}
  if (t<1./6.) { return p+(q-p)*6.*t; }
  if (t<1./2.) { return q; }
  if (t<2./3.) { return p+(q-p)*(2./3.-t)*6.; }
  return p;
}
fn hsl2rgb(hsl: vec3f) -> vec3f {
  let h=hsl.x/360.; let s=clamp(hsl.y/100.,0.,1.); let l=clamp(hsl.z/100.,0.,1.);
  if (s<=1e-6) { return vec3f(l,l,l); }
  let q=select(l+s-l*s, l*(1.+s), l<0.5); let p=2.*l-q;
  return vec3f(hue2rgb(p,q,h+1./3.), hue2rgb(p,q,h), hue2rgb(p,q,h-1./3.));
}
fn twWeight(kind: f32, pp: vec4f, hsl: vec3f) -> f32 {
  if (kind<0.) { return 1.; }
  let halfW=pp.y*0.5; let feather=pp.z; var d: f32;
  if (kind<0.5) { var df=abs(hsl.x-pp.x)%360.; if (df>180.){df=360.-df;} d=df; }
  else if (kind<1.5) { d=abs(hsl.y-pp.x); } else { d=abs(hsl.z-pp.x); }
  if (d>=halfW) { return 0.; }
  if (feather>0.) { return clamp((halfW-d)/feather,0.,1.); }
  return 1.;
}
fn applyHeavyGrade(rgb: vec3f) -> vec3f {
  let hsl=rgb2hsl(rgb);
  let mask=twWeight(u.twFlags.x,u.twF0,hsl)*twWeight(u.twFlags.y,u.twF1,hsl);
  // push op (the representative operation)
  let w=vec3f(0.2126,0.7152,0.0722);
  let lin=dot(rgb,w);
  var p=rgb+(u.twOp0.xyz-rgb)*u.twOp0.w;
  p=p+vec3f(lin-dot(p,w));
  return clamp(mix(rgb,p,mask), vec3f(0.), vec3f(1.));
}
`;

function chainedFs(fn: string): string {
  return `${COMMON}
@fragment fn fs(inp: VsOut) -> @location(0) vec4f {
  let c = textureSample(tex, samp, inp.uv);
  return vec4f(${fn}(c.rgb), c.a);
}`;
}

function fusedFs(fns: string[]): string {
  const body = fns.map((f) => `  rgb = ${f}(rgb);`).join("\n");
  return `${COMMON}
@fragment fn fs(inp: VsOut) -> @location(0) vec4f {
  let c = textureSample(tex, samp, inp.uv);
  var rgb = c.rgb;
${body}
  return vec4f(rgb, c.a);
}`;
}

const FORMAT: GPUTextureFormat = "rgba8unorm";

interface Ctx {
  device: GPUDevice;
  hasTS: boolean;
  layout: GPUBindGroupLayout;
  pipelineLayout: GPUPipelineLayout;
  sampler: GPUSampler;
  uniform: GPUBuffer;
}

async function setup(): Promise<Ctx> {
  const adapter = await instance.requestAdapter({ powerPreference: "high-performance" });
  if (!adapter) throw new Error("no adapter");
  const hasTS = adapter.features.has("timestamp-query");
  const device = await adapter.requestDevice({
    requiredFeatures: hasTS ? (["timestamp-query"] as GPUFeatureName[]) : [],
  });
  const layout = device.createBindGroupLayout({
    entries: [
      { binding: 0, visibility: GPUShaderStage.FRAGMENT, buffer: { type: "uniform" } },
      { binding: 1, visibility: GPUShaderStage.FRAGMENT, sampler: {} },
      { binding: 2, visibility: GPUShaderStage.FRAGMENT, texture: {} },
    ],
  });
  const pipelineLayout = device.createPipelineLayout({ bindGroupLayouts: [layout] });
  const sampler = device.createSampler({ magFilter: "linear", minFilter: "linear" });

  // Representative non-identity params (10 × vec4f = 160 bytes).
  const f = new Float32Array(40);
  f.set([0.05, 1.1, 1.2, 1.05], 0); // eq
  f.set([0.05, 0.0, -0.04], 4); // cbS
  f.set([0.02, 0.0, 0.02], 8); // cbM
  f.set([-0.03, 0.0, 0.05], 12); // cbH
  f.set([1.06, 1.0, 0.94], 16); // ct
  f.set([1, -1, 2, 0], 20); // twFlags: f0=sat, f1 none, op=push
  f.set([50, 40, 10, 0], 24); // twF0
  f.set([0, 0, 0, 0], 28); // twF1
  f.set([0.9, 0.5, 0.1, 0.5], 32); // twOp0 (push target + strength)
  const uniform = device.createBuffer({
    size: f.byteLength,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });
  device.queue.writeBuffer(uniform, 0, f);

  return { device, hasTS, layout, pipelineLayout, sampler, uniform };
}

function makePipeline(ctx: Ctx, fsSource: string): GPURenderPipeline {
  const mod = ctx.device.createShaderModule({ code: fsSource });
  return ctx.device.createRenderPipeline({
    layout: ctx.pipelineLayout,
    vertex: { module: mod, entryPoint: "vs" },
    fragment: { module: mod, entryPoint: "fs", targets: [{ format: FORMAT }] },
    primitive: { topology: "triangle-list" },
  });
}

function makeTex(ctx: Ctx, w: number, h: number): GPUTexture {
  return ctx.device.createTexture({
    size: [w, h],
    format: FORMAT,
    usage:
      GPUTextureUsage.RENDER_ATTACHMENT |
      GPUTextureUsage.TEXTURE_BINDING |
      GPUTextureUsage.COPY_DST,
  });
}

interface Pass {
  pipeline: GPURenderPipeline;
  inputView: GPUTextureView;
  targetView: GPUTextureView;
}

/** Median GPU time (ms) over `iters` for a fixed ordered list of passes. */
async function measure(ctx: Ctx, passes: Pass[], iters: number): Promise<number> {
  const { device } = ctx;
  const bindGroups = passes.map((p) =>
    device.createBindGroup({
      layout: ctx.layout,
      entries: [
        { binding: 0, resource: { buffer: ctx.uniform } },
        { binding: 1, resource: ctx.sampler },
        { binding: 2, resource: p.inputView },
      ],
    }),
  );

  const querySet = ctx.hasTS
    ? device.createQuerySet({ type: "timestamp", count: 2 })
    : null;
  const resolveBuf = querySet
    ? device.createBuffer({ size: 16, usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC })
    : null;
  const readBuf = querySet
    ? device.createBuffer({ size: 16, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ })
    : null;

  const runOnce = (measured: boolean): GPUCommandBuffer => {
    const enc = device.createCommandEncoder();
    passes.forEach((p, i) => {
      // Timestamp only the start of the first pass and the end of the last —
      // middle passes get no timestampWrites (both-undefined is invalid).
      let ts: GPURenderPassTimestampWrites | undefined;
      if (measured && querySet) {
        if (passes.length === 1) {
          ts = { querySet, beginningOfPassWriteIndex: 0, endOfPassWriteIndex: 1 };
        } else if (i === 0) {
          ts = { querySet, beginningOfPassWriteIndex: 0 };
        } else if (i === passes.length - 1) {
          ts = { querySet, endOfPassWriteIndex: 1 };
        }
      }
      const pass = enc.beginRenderPass({
        colorAttachments: [
          { view: p.targetView, clearValue: { r: 0, g: 0, b: 0, a: 1 }, loadOp: "clear", storeOp: "store" },
        ],
        ...(ts ? { timestampWrites: ts } : {}),
      });
      pass.setPipeline(p.pipeline);
      pass.setBindGroup(0, bindGroups[i]);
      pass.draw(3);
      pass.end();
    });
    if (measured && querySet && resolveBuf && readBuf) {
      enc.resolveQuerySet(querySet, 0, 2, resolveBuf, 0);
      enc.copyBufferToBuffer(resolveBuf, 0, readBuf, 0, 16);
    }
    return enc.finish();
  };

  // Warmup.
  for (let i = 0; i < 12; i++) device.queue.submit([runOnce(false)]);
  await device.queue.onSubmittedWorkDone();

  const samples: number[] = [];
  if (querySet && readBuf) {
    for (let i = 0; i < iters; i++) {
      device.queue.submit([runOnce(true)]);
      await readBuf.mapAsync(GPUMapMode.READ);
      const t = new BigInt64Array(readBuf.getMappedRange().slice(0));
      readBuf.unmap();
      const ns = Number(t[1] - t[0]);
      if (ns > 0) samples.push(ns / 1e6); // → ms
    }
  } else {
    // Fallback: wall-clock around a batch + queue sync.
    const batch = 50;
    for (let i = 0; i < iters; i++) {
      const start = performance.now();
      for (let j = 0; j < batch; j++) device.queue.submit([runOnce(false)]);
      await device.queue.onSubmittedWorkDone();
      samples.push((performance.now() - start) / batch);
    }
  }
  // Min = least-contended sample ≈ true uncontended GPU cost (noise only adds).
  samples.sort((a, b) => a - b);
  return samples[0];
}

async function main() {
  const ctx = await setup();
  console.log(`Dawn device ready. timestamp-query: ${ctx.hasTS ? "yes" : "NO (wall-clock fallback)"}\n`);

  const ITERS = ctx.hasTS ? 120 : 40;

  // Pipelines (one per fragment shader; shared across resolutions).
  const pAdjust = makePipeline(ctx, chainedFs("applyAdjust"));
  const pCB = makePipeline(ctx, chainedFs("applyCB"));
  const pCT = makePipeline(ctx, chainedFs("applyCT"));
  const pTweak = makePipeline(ctx, chainedFs("applyHeavyGrade"));
  const chainPipes = { applyAdjust: pAdjust, applyCB: pCB, applyCT: pCT, applyHeavyGrade: pTweak };
  const fusedReal4 = makePipeline(ctx, fusedFs(["applyAdjust", "applyCB", "applyCT", "applyHeavyGrade"]));

  // Reusable textures sized per resolution.
  function texPair(w: number, h: number) {
    const src = makeTex(ctx, w, h);
    const a = makeTex(ctx, w, h);
    const b = makeTex(ctx, w, h);
    // Seed src with a gradient so sampling isn't degenerate.
    const data = new Uint8Array(w * h * 4);
    for (let i = 0; i < w * h; i++) {
      data[i * 4] = (i * 7) & 255;
      data[i * 4 + 1] = (i * 13) & 255;
      data[i * 4 + 2] = (i * 29) & 255;
      data[i * 4 + 3] = 255;
    }
    ctx.device.queue.writeTexture({ texture: src }, data, { bytesPerRow: w * 4, rowsPerImage: h }, [w, h]);
    return { src: src.createView(), a: a.createView(), b: b.createView() };
  }

  function chainPasses(
    views: { src: GPUTextureView; a: GPUTextureView; b: GPUTextureView },
    fns: (keyof typeof chainPipes)[],
  ): Pass[] {
    return fns.map((fn, i) => ({
      pipeline: chainPipes[fn],
      inputView: i === 0 ? views.src : i % 2 === 1 ? views.a : views.b,
      targetView: i % 2 === 0 ? views.a : views.b,
    }));
  }

  const RES: [number, number, string][] = [
    [1280, 720, "720p"],
    [1920, 1080, "1080p"],
    [1080, 1920, "1080×1920 (default)"],
    [3840, 2160, "4K"],
  ];

  console.log("=== Real stack: adjust + colorbalance + colortemperature + heavy grade ===");
  console.log("res                     fused(1 pass)   chained(4 pass)   ratio");
  for (const [w, h, label] of RES) {
    const v = texPair(w, h);
    const fused = await measure(ctx, [{ pipeline: fusedReal4, inputView: v.src, targetView: v.a }], ITERS);
    const chained = await measure(
      ctx,
      chainPasses(v, ["applyAdjust", "applyCB", "applyCT", "applyHeavyGrade"]),
      ITERS,
    );
    console.log(
      `${label.padEnd(22)}  ${fmt(fused)}        ${fmt(chained)}         ${(chained / fused).toFixed(2)}×`,
    );
  }

  console.log("\n=== Scaling: K × adjust @ 1080×1920 (fused loop vs K passes) ===");
  console.log("K     fused           chained          ratio   per-extra-pass");
  const v2 = texPair(1080, 1920);
  let prevChain = 0;
  for (const K of [1, 2, 4, 8]) {
    const fns = Array.from({ length: K }, () => "applyAdjust") as (keyof typeof chainPipes)[];
    const fused = await measure(ctx, [{ pipeline: makePipeline(ctx, fusedFs(fns)), inputView: v2.src, targetView: v2.a }], ITERS);
    const chained = await measure(ctx, chainPasses(v2, fns), ITERS);
    const perPass = K > 1 ? (chained - prevChain) / (K - (K / 2)) : 0;
    prevChain = chained;
    console.log(
      `${String(K).padEnd(4)}  ${fmt(fused)}        ${fmt(chained)}         ${(chained / fused).toFixed(2)}×   ${K > 1 ? fmt(perPass) : "—"}`,
    );
  }

  console.log("\n=== Scaling: K × heavy grade (heavy ALU) @ 1080×1920 ===");
  console.log("K     fused           chained          ratio");
  for (const K of [1, 2, 4]) {
    const fns = Array.from({ length: K }, () => "applyHeavyGrade") as (keyof typeof chainPipes)[];
    const fused = await measure(ctx, [{ pipeline: makePipeline(ctx, fusedFs(fns)), inputView: v2.src, targetView: v2.a }], ITERS);
    const chained = await measure(ctx, chainPasses(v2, fns), ITERS);
    console.log(`${String(K).padEnd(4)}  ${fmt(fused)}        ${fmt(chained)}         ${(chained / fused).toFixed(2)}×`);
  }

  console.log("\nDone.");
}

function fmt(ms: number): string {
  return `${ms.toFixed(4)} ms`.padStart(11);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

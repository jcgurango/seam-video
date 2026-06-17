// Spike: prove a pure-Node.js render pipeline can replace MLT.
//   decode (mediabunny/server) -> upload (writeTexture) -> composite (Dawn WebGPU)
//   -> readback (copyTextureToBuffer) -> encode (mediabunny) -> mp4
//
// To make the GPU work undeniable, we composite the decoded video frame onto a
// magenta background at a rect that ROTATES and SCALES across the 30 output
// frames. A passthrough copy could never produce that. Each output frame also
// samples a later source timestamp, so the video content itself advances too.

import { create, globals } from "webgpu";
import { writeFileSync } from "node:fs";
import zlib from "node:zlib";
import { registerMediabunnyServer } from "@mediabunny/server";
import {
  Input, FilePathSource, ALL_FORMATS, VideoSampleSink,
  Output, Mp4OutputFormat, FilePathTarget, VideoSampleSource, VideoSample,
  QUALITY_HIGH,
} from "mediabunny";

registerMediabunnyServer();
Object.assign(globalThis, globals);

const OUT_W = 720, OUT_H = 1280, FPS = 30, N_FRAMES = 30;
const stage = (s) => console.log(`\n=== ${s} ===`);

// ---------------------------------------------------------------- 1. Dawn device
stage("1. Dawn headless WebGPU device");
const gpu = create([]);
const adapter = await gpu.requestAdapter();
if (!adapter) throw new Error("no WebGPU adapter from Dawn");
const device = await adapter.requestDevice();
device.lost.then((info) => console.error("DEVICE LOST:", info.message));
console.log("adapter:", adapter.info?.description || adapter.info?.architecture || "ok");

// ---------------------------------------------------------------- 2. Decoder
stage("2. mediabunny decode (Node, via NodeAV/libav)");
const input = new Input({ source: new FilePathSource("input.mp4"), formats: ALL_FORMATS });
const track = await input.getPrimaryVideoTrack();
if (!track) throw new Error("no video track");
const srcDur = await track.computeDuration();
console.log(`source: ${track.codec} ${track.displayWidth}x${track.displayHeight}, ${srcDur.toFixed(2)}s`);
const sink = new VideoSampleSink(track);

// Pull one RGBA frame at a given source time -> {data, w, h}
async function rgbaFrameAt(t) {
  const sample = await sink.getSample(t);
  if (!sample) throw new Error(`no sample at ${t}`);
  const w = sample.codedWidth, h = sample.codedHeight;
  const size = sample.allocationSize({ format: "RGBA" });
  const data = new Uint8Array(size);
  await sample.copyTo(data, { format: "RGBA" });
  sample.close();
  return { data, w, h };
}

// ---------------------------------------------------------------- 3. GPU pipeline
stage("3. WGSL composite pipeline (sampled texture on rotated/scaled quad)");
const FMT = "rgba8unorm";
const shader = device.createShaderModule({
  code: /* wgsl */ `
struct U {
  // rect in pixels: center.xy, halfSize.xy ; rot (radians) ; canvas.xy
  center: vec2f, half: vec2f, rot: f32, _pad: f32, canvas: vec2f,
};
@group(0) @binding(0) var<uniform> u: U;
@group(0) @binding(1) var samp: sampler;
@group(0) @binding(2) var tex: texture_2d<f32>;

struct VsOut { @builtin(position) pos: vec4f, @location(0) uv: vec2f };

@vertex fn vs(@builtin(vertex_index) vi: u32) -> VsOut {
  // unit quad corners + uvs
  var corner = array<vec2f,6>(
    vec2f(-1,-1), vec2f(1,-1), vec2f(-1,1),
    vec2f(-1,1),  vec2f(1,-1), vec2f(1,1));
  var uvs = array<vec2f,6>(
    vec2f(0,1), vec2f(1,1), vec2f(0,0),
    vec2f(0,0), vec2f(1,1), vec2f(1,0));
  let c = corner[vi];
  // scale to halfSize, rotate, translate to center (pixel space)
  let s = sin(u.rot); let co = cos(u.rot);
  let p = c * u.half;
  let r = vec2f(p.x*co - p.y*s, p.x*s + p.y*co) + u.center;
  // pixel -> NDC (flip Y)
  let ndc = vec2f(r.x / u.canvas.x * 2.0 - 1.0, 1.0 - r.y / u.canvas.y * 2.0);
  var o: VsOut;
  o.pos = vec4f(ndc, 0.0, 1.0);
  o.uv = uvs[vi];
  return o;
}
@fragment fn fs(in: VsOut) -> @location(0) vec4f {
  return textureSample(tex, samp, in.uv);
}`,
});

const pipeline = device.createRenderPipeline({
  layout: "auto",
  vertex: { module: shader, entryPoint: "vs" },
  fragment: { module: shader, entryPoint: "fs", targets: [{ format: FMT }] },
  primitive: { topology: "triangle-list" },
});
const sampler = device.createSampler({ magFilter: "linear", minFilter: "linear" });
const uBuf = device.createBuffer({ size: 48, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });

// Offscreen render target (the "canvas") + its texture, plus a padded readback buffer
const target = device.createTexture({
  size: [OUT_W, OUT_H], format: FMT,
  usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
});
const bytesPerRow = Math.ceil((OUT_W * 4) / 256) * 256; // copyTextureToBuffer needs 256-aligned rows
const readBuf = device.createBuffer({ size: bytesPerRow * OUT_H, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });

// upload a decoded frame into a fresh GPU texture
function uploadTexture(frame) {
  const tex = device.createTexture({
    size: [frame.w, frame.h], format: FMT,
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
  });
  device.queue.writeTexture(
    { texture: tex },
    frame.data,
    { bytesPerRow: frame.w * 4, rowsPerImage: frame.h },
    [frame.w, frame.h],
  );
  return tex;
}

// render one composited frame, return tightly-packed RGBA bytes (OUT_W*OUT_H*4)
async function renderFrame(tex, rot, scale) {
  // fit video into a `scale` fraction of the canvas, preserving aspect (contain)
  const texW = tex.width, texH = tex.height;
  const boxW = OUT_W * scale, boxH = OUT_H * scale;
  const k = Math.min(boxW / texW, boxH / texH);
  const halfW = (texW * k) / 2, halfH = (texH * k) / 2;
  const uni = new Float32Array([
    OUT_W / 2, OUT_H / 2,   // center
    halfW, halfH,           // half size
    rot, 0,                 // rot, pad
    OUT_W, OUT_H,           // canvas
  ]);
  device.queue.writeBuffer(uBuf, 0, uni);

  const bind = device.createBindGroup({
    layout: pipeline.getBindGroupLayout(0),
    entries: [
      { binding: 0, resource: { buffer: uBuf } },
      { binding: 1, resource: sampler },
      { binding: 2, resource: tex.createView() },
    ],
  });

  const enc = device.createCommandEncoder();
  const pass = enc.beginRenderPass({
    colorAttachments: [{
      view: target.createView(),
      clearValue: { r: 0.85, g: 0.0, b: 0.55, a: 1 }, // magenta bg
      loadOp: "clear", storeOp: "store",
    }],
  });
  pass.setPipeline(pipeline);
  pass.setBindGroup(0, bind);
  pass.draw(6);
  pass.end();
  enc.copyTextureToBuffer(
    { texture: target },
    { buffer: readBuf, bytesPerRow, rowsPerImage: OUT_H },
    [OUT_W, OUT_H],
  );
  device.queue.submit([enc.finish()]);

  await readBuf.mapAsync(GPUMapMode.READ);
  const padded = new Uint8Array(readBuf.getMappedRange());
  const tight = new Uint8Array(OUT_W * OUT_H * 4);
  for (let y = 0; y < OUT_H; y++) {
    tight.set(padded.subarray(y * bytesPerRow, y * bytesPerRow + OUT_W * 4), y * OUT_W * 4);
  }
  readBuf.unmap();
  return tight;
}

// ---------------------------------------------------------------- 4. Encoder
stage("4. mediabunny encode -> out.mp4 (H.264)");
const output = new Output({ format: new Mp4OutputFormat(), target: new FilePathTarget("out.mp4") });
const vsource = new VideoSampleSource({ codec: "avc", bitrate: QUALITY_HIGH });
output.addVideoTrack(vsource, { frameRate: FPS });
await output.start();

// ---------------------------------------------------------------- 5. The loop
stage("5. render + encode 30 frames");
let firstTight = null, lastTight = null;
for (let i = 0; i < N_FRAMES; i++) {
  const t = Math.min((i / N_FRAMES) * srcDur, srcDur - 0.001); // advance through source
  const frame = await rgbaFrameAt(t);
  const tex = uploadTexture(frame);
  const rot = (i / N_FRAMES) * Math.PI * 0.5;        // sweep 0..90deg
  const scale = 0.55 + 0.35 * Math.sin((i / N_FRAMES) * Math.PI); // pulse size
  const rgba = await renderFrame(tex, rot, scale);
  tex.destroy();

  if (i === 0) firstTight = rgba;
  if (i === N_FRAMES - 1) lastTight = rgba;

  const sample = new VideoSample(rgba, {
    format: "RGBA", codedWidth: OUT_W, codedHeight: OUT_H, timestamp: i / FPS, duration: 1 / FPS,
  });
  await vsource.add(sample);
  sample.close();
  process.stdout.write(`\r  frame ${i + 1}/${N_FRAMES}`);
}
console.log();
await output.finalize();

// ---------------------------------------------------------------- 6. PNG witnesses
stage("6. write PNG stills (frame 0 + last) for eyeballing");
function writePNG(path, w, h, rgba) {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0; // filter: none
    Buffer.from(rgba.buffer, y * w * 4, w * 4).copy(raw, y * (w * 4 + 1) + 1);
  }
  const idat = zlib.deflateSync(raw);
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body) >>> 0);
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 6; // 8-bit RGBA
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr), chunk("IDAT", idat), chunk("IEND", Buffer.alloc(0)),
  ]);
  writeFileSync(path, png);
}
let crcTable;
function crc32(buf) {
  if (!crcTable) {
    crcTable = new Int32Array(256);
    for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crcTable[n] = c; }
  }
  let c = ~0;
  for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return ~c;
}
writePNG("frame0.png", OUT_W, OUT_H, firstTight);
writePNG("frame_last.png", OUT_W, OUT_H, lastTight);
console.log("wrote frame0.png, frame_last.png, out.mp4");

input.dispose?.();
console.log("\nDONE.");
process.exit(0); // Dawn-node segfaults during native teardown at natural exit (WIP); bail cleanly

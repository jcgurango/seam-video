/**
 * Bench: cost of the HDR → SDR conversion per decoded frame — the GPU pass
 * the render loop uses (`hdrToSdrGpu.ts`, timed to GPU completion) and the
 * TypeScript reference (`hdrToSdr.ts`) — next to mediabunny's plain RGBA
 * conversion of the same sample.
 *
 *   npx tsx packages/renderer/src/bench/hdr-tonemap.ts <hdr-video> [frames=30]
 */
import { registerMediabunnyServer } from "@mediabunny/server";
import { Input, FilePathSource, VideoSampleSink, ALL_FORMATS } from "mediabunny";
import { HdrToSdrConverter, isHdrSample } from "../hdrToSdr.js";
import { HdrToSdrGpu } from "../hdrToSdrGpu.js";
import { createGpuDevice } from "../gpu.js";

registerMediabunnyServer();

const [path, framesArg] = process.argv.slice(2);
if (!path) {
  console.error("usage: hdr-tonemap.ts <hdr-video> [frames=30]");
  process.exit(1);
}
const frames = Number(framesArg ?? 30);

const input = new Input({ source: new FilePathSource(path), formats: ALL_FORMATS });
const track = await input.getPrimaryVideoTrack();
if (!track) throw new Error("no video track");
const sink = new VideoSampleSink(track);
const conv = new HdrToSdrConverter();
const device = await createGpuDevice();
const gpu = new HdrToSdrGpu(device);

let n = 0;
let tonemapMs = 0;
let plainMs = 0;
let gpuMs = 0;
let centre = "";
for await (const sample of sink.samples()) {
  if (n === 0) {
    console.log(
      `${sample.codedWidth}x${sample.codedHeight} ${sample.format}`,
      JSON.stringify(sample.colorSpace),
      isHdrSample(sample) ? "" : "(NOT HDR-tagged)",
    );
  }
  const t0 = performance.now();
  const rgba = await conv.toRgba(sample);
  const t1 = performance.now();
  const plain = new Uint8Array(sample.allocationSize({ format: "RGBA" }));
  await sample.copyTo(plain, { format: "RGBA" });
  const t2 = performance.now();
  const pic = await conv.readPicture(sample);
  if (pic) {
    gpu.convert(pic, 0);
    await device.queue.onSubmittedWorkDone();
  }
  const t3 = performance.now();
  // First frame is JIT warm-up + LUT / pipeline build; keep it out of the average.
  if (n > 0) {
    tonemapMs += t1 - t0;
    plainMs += t2 - t1;
    gpuMs += t3 - t2;
  } else {
    const o = ((sample.codedHeight >> 1) * sample.codedWidth + (sample.codedWidth >> 1)) * 4;
    centre = `centre px: tone-mapped ${rgba.slice(o, o + 3).join(",")}  plain ${plain.slice(o, o + 3).join(",")}`;
  }
  sample.close();
  if (++n > frames) break;
}
console.log(centre);
console.log(
  `${n - 1} frames: GPU tone-map ${(gpuMs / (n - 1)).toFixed(2)} ms/frame, ` +
    `TypeScript tone-map ${(tonemapMs / (n - 1)).toFixed(2)} ms/frame, ` +
    `plain RGBA ${(plainMs / (n - 1)).toFixed(2)} ms/frame`,
);
gpu.dispose();
conv.dispose();
input.dispose();

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { registerMediabunnyServer } from "@mediabunny/server";
import { Input, FilePathSource, VideoSampleSink, ALL_FORMATS } from "mediabunny";
import type { ResolvedClip } from "@seam/core";
import { createGpuDevice } from "../gpu.js";
import { HdrToSdrConverter, tonemapToRgba, type YuvPicture } from "../hdrToSdr.js";
import { HdrToSdrGpu, readTextureRgba, type QuarterTurn } from "../hdrToSdrGpu.js";
import { FrameSource, rotateRGBA } from "../frameSource.js";
import { NodeBackend } from "../NodeBackend.js";

// The render loop tone-maps HDR clips in a WGSL pass on real Dawn
// (hdrToSdrGpu.ts); `tonemapToRgba` is the reference it must agree with. The
// shader evaluates the curve analytically where the reference uses LUTs, so
// "agree" means rounding: every channel of every pixel within GPU_TOLERANCE.

registerMediabunnyServer();

const GPU_TOLERANCE = 1;
const here = dirname(fileURLToPath(import.meta.url));
const fixtures = join(here, "fixtures");

let device: GPUDevice;
beforeAll(async () => {
  device = await createGpuDevice();
});

/** Deterministic noisy picture: every code range, saturated chroma included. */
function noise(over: Partial<YuvPicture> = {}): YuvPicture {
  const width = over.width ?? 37;
  const height = over.height ?? 21;
  const depth = over.depth ?? 10;
  const subX = over.subX ?? 1;
  const subY = over.subY ?? 1;
  const cw = (width + subX) >> subX;
  const ch = (height + subY) >> subY;
  // Strides wider than the row, like a decoder's padded planes.
  const yStride = width + 3;
  const cStride = cw + 5;
  let seed = 12345;
  const rnd = (n: number) => {
    seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
    return (seed >>> 8) % n;
  };
  const codes = 1 << depth;
  const y = new Uint16Array(yStride * height);
  const u = new Uint16Array(cStride * ch);
  const v = new Uint16Array(cStride * ch);
  for (let i = 0; i < y.length; i++) y[i] = rnd(codes);
  for (let i = 0; i < u.length; i++) {
    u[i] = rnd(codes);
    v[i] = rnd(codes);
  }
  return {
    width,
    height,
    depth,
    subX,
    subY,
    y,
    u,
    v,
    yStride,
    uStride: cStride,
    vStride: cStride,
    transfer: "hlg",
    primaries: "bt2020",
    matrix: "bt2020-ncl",
    fullRange: false,
    ...over,
  };
}

function maxDiff(a: Uint8Array, b: Uint8Array): number {
  expect(a.length).toBe(b.length);
  let worst = 0;
  for (let i = 0; i < a.length; i++) worst = Math.max(worst, Math.abs(a[i]! - b[i]!));
  return worst;
}

async function gpuRgba(conv: HdrToSdrGpu, pic: YuvPicture, rotation: QuarterTurn = 0) {
  const frame = conv.convert(pic, rotation);
  expect(frame.view).toBeDefined();
  expect(frame.data.length).toBe(0);
  return { frame, rgba: await readTextureRgba(device, conv.texture!) };
}

describe("HDR → SDR on the GPU", () => {
  const conv = { current: null as HdrToSdrGpu | null };
  beforeAll(() => {
    conv.current = new HdrToSdrGpu(device);
  });
  afterAll(() => conv.current?.dispose());

  const VARIANTS: [string, Partial<YuvPicture>][] = [
    ["HLG 10-bit 4:2:0 limited", {}],
    ["PQ 10-bit 4:2:0 limited", { transfer: "pq" }],
    ["HLG full range", { fullRange: true }],
    ["HLG 12-bit", { depth: 12 }],
    ["HLG 8-bit", { depth: 8 }],
    ["HLG 4:2:2", { subY: 0 }],
    ["PQ 4:4:4", { transfer: "pq", subX: 0, subY: 0 }],
    ["BT.709 primaries + matrix", { primaries: "bt709", matrix: "bt709" }],
    ["even dimensions", { width: 64, height: 32 }],
  ];

  it.each(VARIANTS)("matches the reference: %s", async (_name, over) => {
    const pic = noise(over);
    const { frame, rgba } = await gpuRgba(conv.current!, pic);
    expect([frame.width, frame.height]).toEqual([pic.width, pic.height]);
    expect(maxDiff(rgba, tonemapToRgba(pic))).toBeLessThanOrEqual(GPU_TOLERANCE);
  });

  it.each([90, 180, 270] as const)("folds a %i° rotation into the pass", async (rotation) => {
    const pic = noise();
    const { frame, rgba } = await gpuRgba(conv.current!, pic, rotation);
    const want = rotateRGBA(tonemapToRgba(pic), pic.width, pic.height, rotation);
    expect([frame.width, frame.height]).toEqual([want.width, want.height]);
    expect(maxDiff(rgba, want.data as Uint8Array)).toBeLessThanOrEqual(GPU_TOLERANCE);
  });

  it("reuses its textures across frames and reallocates on a size change", async () => {
    const c = new HdrToSdrGpu(device);
    try {
      const a = noise();
      await gpuRgba(c, a);
      const first = c.texture;
      const again = await gpuRgba(c, { ...a, transfer: "pq" });
      expect(c.texture).toBe(first);
      expect(maxDiff(again.rgba, tonemapToRgba({ ...a, transfer: "pq" }))).toBeLessThanOrEqual(
        GPU_TOLERANCE,
      );
      const b = noise({ width: 20, height: 12 });
      const resized = await gpuRgba(c, b);
      expect(c.texture).not.toBe(first);
      expect(maxDiff(resized.rgba, tonemapToRgba(b))).toBeLessThanOrEqual(GPU_TOLERANCE);
    } finally {
      c.dispose();
    }
  });

  // Same pinned greys as hdr-to-sdr.test.ts, through the decoder.
  it.each([
    ["hlg-283", 48],
    ["hlg-502", 94],
    ["hlg-720", 158],
    ["hlg-940", 243],
    ["pq-573", 173],
  ] as const)("tone-maps fixture %s to grey %i", async (name, grey) => {
    const input = new Input({
      source: new FilePathSource(join(fixtures, `${name}.mp4`)),
      formats: ALL_FORMATS,
    });
    const reader = new HdrToSdrConverter();
    try {
      const track = await input.getPrimaryVideoTrack();
      const sample = await new VideoSampleSink(track!).getSample(0);
      const pic = await reader.readPicture(sample!);
      sample!.close();
      expect(pic).not.toBeNull();
      const { rgba } = await gpuRgba(conv.current!, pic!);
      for (let i = 0; i < rgba.length; i += 4) {
        for (const c of [0, 1, 2]) expect(Math.abs(rgba[i + c]! - grey)).toBeLessThanOrEqual(1);
        expect(rgba[i + 3]).toBe(255);
      }
    } finally {
      reader.dispose();
      input.dispose();
    }
  });
});

describe("FrameSource with a device", () => {
  const clip = (source: string): ResolvedClip =>
    ({
      type: "clip",
      source,
      sourceIn: 0,
      sourceOut: 0.1,
      speed: 1,
      timelineStart: 0,
      timelineEnd: 0.1,
    }) as unknown as ResolvedClip;

  it("hands HDR clip frames over as textures the backend passes straight through", async () => {
    const fs = new FrameSource(fixtures, undefined, device);
    const backend = new NodeBackend(device, 1);
    try {
      const node = clip("hlg-720.mp4");
      await fs.openSource(node.source);
      await fs.prepare([{ node, drawTime: 0 }]);
      const frame = fs.get(node)!;
      expect(frame).not.toBeNull();
      expect([frame.width, frame.height]).toEqual([64, 64]);
      expect(frame.view).toBeDefined();
      expect(frame.data.length).toBe(0);
      expect(backend.uploadFrame(node, frame)).toBe(frame.view);
    } finally {
      backend.dispose();
      await fs.dispose();
    }
  });

  it("stays on CPU RGBA without one", async () => {
    const fs = new FrameSource(fixtures);
    try {
      const node = clip("hlg-720.mp4");
      await fs.openSource(node.source);
      await fs.prepare([{ node, drawTime: 0 }]);
      const frame = fs.get(node)!;
      expect(frame.view).toBeUndefined();
      expect(Array.from(frame.data.subarray(0, 4))).toEqual([158, 158, 158, 255]);
    } finally {
      await fs.dispose();
    }
  });
});

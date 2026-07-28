import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createCanvas } from "@napi-rs/canvas";
import { registerMediabunnyServer } from "@mediabunny/server";
import {
  Input,
  Output,
  FilePathSource,
  FilePathTarget,
  Mp4OutputFormat,
  VideoSampleSource,
  VideoSample,
  VideoSampleSink,
  ALL_FORMATS,
} from "mediabunny";
import type { ResolvedClip } from "@seam/core";
import { FrameSource } from "../frameSource.js";

// The high-speed clip cursor (keyframe-aware forward re-seek in decodeClip)
// must return byte-identical frames to random-access getSample — for sparse
// jumps that cross keyframes, same-GOP jumps that advance sequentially, dense
// 1× stepping under the seek gate, and backward jumps.

registerMediabunnyServer();

const FPS = 30;
const DUR = 12; // seconds
const GOP = 1; // keyframe interval, seconds
const W = 160;
const H = 90;

let dir: string;
let videoPath: string;

async function generate(path: string): Promise<void> {
  const output = new Output({
    format: new Mp4OutputFormat(),
    target: new FilePathTarget(path),
  });
  const source = new VideoSampleSource({
    codec: "avc",
    bitrate: 1_000_000,
    keyFrameInterval: GOP,
  });
  output.addVideoTrack(source, { frameRate: FPS });
  await output.start();
  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext("2d");
  const total = DUR * FPS;
  for (let i = 0; i < total; i++) {
    ctx.fillStyle = `hsl(${((i / total) * 360).toFixed(2)}, 60%, 40%)`;
    ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = "#fff";
    ctx.fillRect((i * 7) % (W - 20), (i * 3) % (H - 20), 20, 20);
    const id = ctx.getImageData(0, 0, W, H);
    const sample = new VideoSample(new Uint8Array(id.data.buffer.slice(0)), {
      format: "RGBA",
      codedWidth: W,
      codedHeight: H,
      timestamp: i / FPS,
      duration: 1 / FPS,
    });
    await source.add(sample);
    sample.close();
  }
  await output.finalize();
}

/** Ground truth: random-access decode at `t`, RGBA bytes. */
async function truthAt(sink: VideoSampleSink, t: number): Promise<Uint8Array> {
  const sample = await sink.getSample(t);
  if (!sample) throw new Error(`no sample at ${t}`);
  const buf = new Uint8Array(sample.allocationSize({ format: "RGBA" }));
  await sample.copyTo(buf, { format: "RGBA" });
  sample.close();
  return buf;
}

function clipNode(speed: number): ResolvedClip {
  return {
    type: "clip",
    source: videoPath,
    sourceIn: 0,
    sourceOut: DUR,
    speed,
    orientation: 0,
  } as unknown as ResolvedClip;
}

let truthSink: VideoSampleSink;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "seam-frame-seek-"));
  videoPath = join(dir, "src.mp4");
  await generate(videoPath);
  const input = new Input({
    source: new FilePathSource(videoPath),
    formats: ALL_FORMATS,
  });
  const track = await input.getPrimaryVideoTrack();
  if (!track) throw new Error("no video track");
  truthSink = new VideoSampleSink(track);
}, 60_000);

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("FrameSource high-speed clip cursor", () => {
  it("sparse forward jumps match random-access decode", async () => {
    // 19.7× at 30fps out → ~0.657s source jumps: above the seek gate, and a
    // mix of keyframe-crossing (re-seek) and same-GOP (advance) steps.
    const speed = 19.7;
    const node = clipNode(speed);
    const fs = new FrameSource(dir);
    const outFrames = Math.floor((DUR / speed) * FPS);
    expect(outFrames).toBeGreaterThan(10);
    for (let i = 0; i < outFrames; i++) {
      const drawTime = i / FPS;
      await fs.prepare([{ node, drawTime }]);
      const frame = fs.get(node);
      expect(frame, `frame at drawTime ${drawTime}`).not.toBeNull();
      const truth = await truthAt(truthSink, drawTime * speed);
      expect(frame!.width).toBe(W);
      expect(frame!.height).toBe(H);
      expect(
        Buffer.from(frame!.data.buffer, frame!.data.byteOffset, frame!.data.byteLength).equals(
          Buffer.from(truth),
        ),
        `bytes at source time ${(drawTime * speed).toFixed(3)}`,
      ).toBe(true);
    }
    fs.dispose();
  }, 60_000);

  it("dense 1× stepping stays sequential and correct", async () => {
    const node = clipNode(1);
    const fs = new FrameSource(dir);
    for (let i = 0; i < 40; i++) {
      const drawTime = i / FPS;
      await fs.prepare([{ node, drawTime }]);
      const frame = fs.get(node);
      const truth = await truthAt(truthSink, drawTime);
      expect(
        Buffer.from(frame!.data.buffer, frame!.data.byteOffset, frame!.data.byteLength).equals(
          Buffer.from(truth),
        ),
        `bytes at ${drawTime.toFixed(3)}`,
      ).toBe(true);
    }
    fs.dispose();
  }, 60_000);

  it("backward jump after a far seek restarts correctly", async () => {
    const speed = 50;
    const node = clipNode(speed);
    const fs = new FrameSource(dir);
    // Jump deep into the source…
    await fs.prepare([{ node, drawTime: 0.2 }]); // source t = 10s
    // …then back to the start.
    await fs.prepare([{ node, drawTime: 0 }]);
    const frame = fs.get(node);
    const truth = await truthAt(truthSink, 0);
    expect(
      Buffer.from(frame!.data.buffer, frame!.data.byteOffset, frame!.data.byteLength).equals(
        Buffer.from(truth),
      ),
    ).toBe(true);
    fs.dispose();
  }, 60_000);
});

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

// A reversed clip (`reverse: true`, authored `out < in` / negative duration)
// must show exactly the frames random-access decode gives at
// `sourceOut − drawTime·speed`: stepping backwards through the decoded-sample
// window, across window refills (GOP 30 frames > the 12-sample window) and
// across keyframes.

registerMediabunnyServer();

const FPS = 30;
const DUR = 8;
const GOP = 1;
const W = 160;
const H = 90;
/** Mid-frame offset so `sourceOut − i/FPS` never sits on a sample boundary. */
const HALF = 0.5 / FPS;

let dir: string;
let videoPath: string;
let truthSink: VideoSampleSink;

async function generate(path: string): Promise<void> {
  const output = new Output({ format: new Mp4OutputFormat(), target: new FilePathTarget(path) });
  const source = new VideoSampleSource({ codec: "avc", bitrate: 1_000_000, keyFrameInterval: GOP });
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

async function truthAt(t: number): Promise<Uint8Array> {
  const sample = await truthSink.getSample(t);
  if (!sample) throw new Error(`no sample at ${t}`);
  const buf = new Uint8Array(sample.allocationSize({ format: "RGBA" }));
  await sample.copyTo(buf, { format: "RGBA" });
  sample.close();
  return buf;
}

function reversed(sourceIn: number, sourceOut: number, speed: number): ResolvedClip {
  return {
    type: "clip",
    source: videoPath,
    sourceIn,
    sourceOut,
    speed,
    reverse: true,
    orientation: 0,
  } as unknown as ResolvedClip;
}

async function expectFrame(fs: FrameSource, node: ResolvedClip, drawTime: number): Promise<void> {
  await fs.prepare([{ node, drawTime }]);
  const frame = fs.get(node);
  const sourceTime = node.sourceOut - drawTime * node.speed;
  expect(frame, `frame at drawTime ${drawTime}`).not.toBeNull();
  const truth = await truthAt(sourceTime);
  expect(
    Buffer.from(frame!.data.buffer, frame!.data.byteOffset, frame!.data.byteLength).equals(
      Buffer.from(truth),
    ),
    `bytes at source time ${sourceTime.toFixed(4)}`,
  ).toBe(true);
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "seam-frame-reverse-"));
  videoPath = join(dir, "src.mp4");
  await generate(videoPath);
  const input = new Input({ source: new FilePathSource(videoPath), formats: ALL_FORMATS });
  const track = await input.getPrimaryVideoTrack();
  if (!track) throw new Error("no video track");
  truthSink = new VideoSampleSink(track);
}, 60_000);

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("FrameSource reversed clip", () => {
  it("1× backward stepping matches random-access decode across GOPs", async () => {
    const node = reversed(2 + HALF, 6 + HALF, 1);
    const fs = new FrameSource(dir);
    // 4 s = 120 frames = 4 GOPs and ~10 window refills.
    for (let i = 0; i < 120; i++) await expectFrame(fs, node, i / FPS);
    await fs.dispose();
  }, 60_000);

  it("a sped-up reversed clip skips frames correctly", async () => {
    const node = reversed(HALF, 7 + HALF, 3.5);
    const fs = new FrameSource(dir);
    for (let i = 0; i < 60; i++) await expectFrame(fs, node, i / FPS);
    await fs.dispose();
  }, 60_000);

  it("a slowed reversed clip holds each frame", async () => {
    const node = reversed(3 + HALF, 4 + HALF, 0.25);
    const fs = new FrameSource(dir);
    for (let i = 0; i < 60; i++) await expectFrame(fs, node, i / FPS);
    await fs.dispose();
  }, 60_000);

  it("jumping forward again (loop restart) refills the window", async () => {
    const node = reversed(2 + HALF, 6 + HALF, 1);
    const fs = new FrameSource(dir);
    await expectFrame(fs, node, 3.5);
    await expectFrame(fs, node, 0);
    await expectFrame(fs, node, 1 / FPS);
    await fs.dispose();
  }, 60_000);
});

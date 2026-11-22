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
import { createSeam, resolveSpatial, type Composition } from "@seam/core";
import { buildRenderList, type DrawCommand, type RenderCommand } from "@seam/compositor";
import { FrameSource, collectDrawables } from "../frameSource.js";

const seam = createSeam();
const { resolveComposition } = seam;

// End-to-end `underflow: "loop"` on the renderer's video path: the render list
// wraps the looping clip's drawTime, and the FrameSource cursor (which only
// ever advances) must re-seek at every wrap so the frame shown in cycle N is
// byte-identical to the random-access decode of the same source time.

registerMediabunnyServer();

const FPS = 30;
const DUR = 4; // seconds of source
const W = 160;
const H = 90;

let dir: string;
let videoPath: string;
let truthSink: VideoSampleSink;

async function generate(path: string): Promise<void> {
  const output = new Output({
    format: new Mp4OutputFormat(),
    target: new FilePathTarget(path),
  });
  const source = new VideoSampleSource({ codec: "avc", bitrate: 1_000_000, keyFrameInterval: 1 });
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

async function truthAt(t: number): Promise<Buffer> {
  const sample = await truthSink.getSample(t);
  if (!sample) throw new Error(`no sample at ${t}`);
  const buf = new Uint8Array(sample.allocationSize({ format: "RGBA" }));
  await sample.copyTo(buf, { format: "RGBA" });
  sample.close();
  return Buffer.from(buf);
}

function draws(commands: RenderCommand[]): DrawCommand[] {
  const out: DrawCommand[] = [];
  for (const c of commands) {
    if (c.type === "draw") out.push(c);
    else if (c.type === "group") out.push(...draws(c.children));
  }
  return out;
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "seam-frame-loop-"));
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

describe("underflow: loop — renderer video path", () => {
  it("replays source [1, 2.5] across a 5s span, frame-exact at every wrap", async () => {
    const doc: Composition = {
      type: "composition",
      contentWidth: W,
      contentHeight: H,
      children: [
        {
          type: "clip",
          source: "src.mp4",
          in: 1,
          out: 2.5,
          underflow: "loop",
          duration: 5,
        },
      ],
    };
    const timeline = resolveSpatial(resolveComposition(doc), W, H);
    expect(timeline.duration).toBe(5);
    const fs = new FrameSource(dir);
    const period = 1.5;
    // Step the output frame by frame like render.ts does; the clip cursor
    // sees a backward jump at 1.5s, 3s and 4.5s and must re-seek.
    for (let i = 0; i < 5 * FPS; i++) {
      const t = i / FPS;
      const commands = buildRenderList(seam, timeline, t, W, H, () => ({ w: W, h: H }));
      const ds = draws(commands);
      expect(ds, `clip active at ${t}`).toHaveLength(1);
      const expectedLocal = ((t % period) + period) % period;
      expect(ds[0].drawTime).toBeCloseTo(expectedLocal, 6);
      await fs.prepare(collectDrawables(commands));
      const frame = fs.get(ds[0].clip as never);
      expect(frame, `frame at ${t}`).not.toBeNull();
      const truth = await truthAt(1 + expectedLocal);
      expect(
        Buffer.from(frame!.data.buffer, frame!.data.byteOffset, frame!.data.byteLength).equals(truth),
        `bytes at output ${t.toFixed(3)} (source ${(1 + expectedLocal).toFixed(3)})`,
      ).toBe(true);
    }
    await fs.dispose();
  }, 60_000);
});

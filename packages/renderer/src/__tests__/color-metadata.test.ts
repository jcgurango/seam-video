import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
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

// Render outputs must be real BT.709 limited-range video, tagged as such —
// not just tagged. Encodes a pure-red frame the way render.ts does and checks
// both halves:
//   1. the file carries complete colour metadata (VUI + colr → getColorSpace)
//   2. the encoded YUV actually used the BT.709 matrix, not swscale's BT.601
//      default (pure red: 709 ⇒ Y≈63 Cb≈102 Cr≈240; 601 would give Y≈81).
// Backed by patches/@mediabunny__server@1.48.1.patch — if a dependency bump
// drops the patch, the second test is the tripwire.

registerMediabunnyServer();

// Not smaller: this machine's encoder may be h264_nvenc, which rejects tiny
// frames ("Frame Dimension less than the minimum supported value").
const W = 256;
const H = 128;
const FPS = 30;
const FRAMES = 10;

let dir: string;
let videoPath: string;

async function encodeSolidRed(path: string): Promise<void> {
  const output = new Output({
    format: new Mp4OutputFormat(),
    target: new FilePathTarget(path),
  });
  const source = new VideoSampleSource({ codec: "avc", bitrate: 2_000_000 });
  output.addVideoTrack(source, { frameRate: FPS });
  await output.start();
  const pixels = new Uint8Array(W * H * 4);
  for (let i = 0; i < W * H; i++) {
    pixels[i * 4] = 255;
    pixels[i * 4 + 3] = 255;
  }
  for (let i = 0; i < FRAMES; i++) {
    const sample = new VideoSample(pixels.slice(), {
      format: "RGBA",
      codedWidth: W,
      codedHeight: H,
      timestamp: i / FPS,
      duration: 1 / FPS,
      // Mirrors render.ts: gamma-encoded full-range RGB in.
      colorSpace: {
        primaries: "bt709",
        transfer: "iec61966-2-1",
        matrix: "rgb",
        fullRange: true,
      },
    });
    await source.add(sample);
    sample.close();
  }
  await output.finalize();
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "seam-color-"));
  videoPath = join(dir, "red.mp4");
  await encodeSolidRed(videoPath);
}, 60_000);

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("render encode colour handling", () => {
  it("tags the output BT.709 limited-range (VUI/colr complete)", async () => {
    const input = new Input({
      source: new FilePathSource(videoPath),
      formats: ALL_FORMATS,
    });
    const track = (await input.getPrimaryVideoTrack())!;
    expect(track).toBeTruthy();
    const cs = await track.getColorSpace();
    expect(cs.primaries).toBe("bt709");
    expect(cs.transfer).toBe("bt709");
    expect(cs.matrix).toBe("bt709");
    expect(cs.fullRange).toBe(false);
  });

  it("encodes RGB→YUV with the BT.709 matrix, not the 601 default", async () => {
    const input = new Input({
      source: new FilePathSource(videoPath),
      formats: ALL_FORMATS,
    });
    const track = (await input.getPrimaryVideoTrack())!;
    const sink = new VideoSampleSink(track);
    const sample = (await sink.getSample(FRAMES / 2 / FPS))!;
    expect(sample).toBeTruthy();
    expect(sample.format).toBe("I420");
    const buf = new Uint8Array(sample.allocationSize());
    await sample.copyTo(buf);
    sample.close();

    // Center of each yuv420p plane.
    const y = buf[(H / 2) * W + W / 2];
    const u = buf[W * H + (H / 4) * (W / 2) + W / 4];
    const v = buf[W * H + (W / 2) * (H / 2) + (H / 4) * (W / 2) + W / 4];

    // BT.709 limited for (255,0,0): Y'=63, Cb=102, Cr=240 (±4 for encode loss).
    expect(Math.abs(y - 63)).toBeLessThanOrEqual(4);
    expect(Math.abs(u - 102)).toBeLessThanOrEqual(4);
    expect(Math.abs(v - 240)).toBeLessThanOrEqual(4);
    // Explicitly not BT.601 (Y'≈81, Cb≈90).
    expect(Math.abs(y - 81)).toBeGreaterThan(8);
  });
});

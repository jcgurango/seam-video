/**
 * Empirical decode-cost comparison for high-speed clips: the old forward-drain
 * cursor (decode every skipped sample) vs the keyframe-aware cursor restart in
 * `FrameSource.decodeClip` (re-seek when the jump crosses a keyframe).
 *
 * Generates a synthetic mp4 (cached in the OS tmpdir), then samples it at the
 * sparse source times a `speed`× clip produces at `outFps` output, both ways,
 * and reports wall time. The sequential strategy replicates the pre-fix
 * decodeClip loop exactly (including the RGBA conversion of kept frames).
 *
 * Run:  npx tsx packages/renderer/src/bench/speed-seek.ts
 *       [--duration 200] [--fps 30] [--gop 2] [--speed 100] [--out-fps 30]
 *       [--file /path/to/real.mp4]   (skips generation, benches a real clip)
 */
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
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

registerMediabunnyServer();

const EPS = 1e-4;

function arg(name: string, def: number): number {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? Number(process.argv[i + 1]) : def;
}

const fileIdx = process.argv.indexOf("--file");
const FILE = fileIdx >= 0 ? process.argv[fileIdx + 1] : null;

let DURATION = arg("duration", 200);
const FPS = arg("fps", 30);
const GOP = arg("gop", 2);
const SPEED = arg("speed", 100);
const OUT_FPS = arg("out-fps", 30);

const W = 640;
const H = 360;

async function generate(path: string): Promise<void> {
  const output = new Output({
    format: new Mp4OutputFormat(),
    target: new FilePathTarget(path),
  });
  const source = new VideoSampleSource({
    codec: "avc",
    bitrate: 3_000_000,
    keyFrameInterval: GOP,
  });
  output.addVideoTrack(source, { frameRate: FPS });
  await output.start();

  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext("2d");
  const total = Math.round(DURATION * FPS);
  for (let i = 0; i < total; i++) {
    // Non-trivial, changing content so inter-frame prediction has real work.
    ctx.fillStyle = `hsl(${((i / total) * 360).toFixed(2)}, 60%, 40%)`;
    ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = "#fff";
    ctx.fillRect((i * 7) % (W - 40), (i * 3) % (H - 40), 40, 40);
    ctx.font = "28px sans-serif";
    ctx.fillText(`frame ${i}`, 20, 44);
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
    if (i % (FPS * 10) === 0) process.stdout.write(`\r  encoding ${i}/${total}`);
  }
  await output.finalize();
  process.stdout.write(`\r  encoded ${total} frames                 \n`);
}

/** Sparse source-time targets of a `SPEED`× clip rendered at OUT_FPS. */
function targets(): number[] {
  const outFrames = Math.max(1, Math.floor((DURATION / SPEED) * OUT_FPS));
  const out: number[] = [];
  for (let i = 0; i < outFrames; i++) out.push((i / OUT_FPS) * SPEED);
  return out;
}

/** Pre-fix decodeClip: one forward iterator, drain every sample up to each
 *  target, RGBA-convert the kept frame. */
async function runSequential(
  path: string,
  times: number[],
): Promise<{ ms: number; decoded: number }> {
  const input = new Input({
    source: new FilePathSource(path),
    formats: ALL_FORMATS,
  });
  const track = await input.getPrimaryVideoTrack();
  if (!track) throw new Error("no video track");
  const sink = new VideoSampleSink(track);

  const t0 = performance.now();
  const iter = sink.samples(Math.max(0, times[0]))[Symbol.asyncIterator]();
  let current: VideoSample | null = null;
  let pending: VideoSample | null = null;
  let decoded = 0;
  for (const st of times) {
    let advanced = false;
    for (;;) {
      if (pending) {
        if (pending.timestamp <= st + EPS) {
          current?.close();
          current = pending;
          pending = null;
          advanced = true;
          continue;
        }
        break;
      }
      const res = await iter.next();
      if (res.done) break;
      decoded++;
      if (res.value.timestamp <= st + EPS) {
        current?.close();
        current = res.value;
        advanced = true;
      } else {
        pending = res.value;
        break;
      }
    }
    if (current && advanced) {
      const buf = new Uint8Array(current.allocationSize({ format: "RGBA" }));
      await current.copyTo(buf, { format: "RGBA" });
    }
  }
  const ms = performance.now() - t0;
  current?.close();
  pending?.close();
  await iter.return?.(undefined);
  return { ms, decoded };
}

/** Post-fix path: the real FrameSource (keyframe-aware cursor restart). */
async function runFrameSource(
  path: string,
  times: number[],
): Promise<{ ms: number }> {
  const node = {
    type: "clip",
    source: path,
    sourceIn: 0,
    sourceOut: DURATION,
    speed: SPEED,
    orientation: 0,
  } as unknown as ResolvedClip;
  const fs = new FrameSource(dirname(path));
  await fs.openSource(path);

  const t0 = performance.now();
  for (let i = 0; i < times.length; i++) {
    await fs.prepare([{ node, drawTime: times[i] / SPEED }]);
    if (!fs.get(node)) throw new Error(`no frame at source time ${times[i]}`);
  }
  const ms = performance.now() - t0;
  fs.dispose();
  return { ms };
}

let path: string;
if (FILE) {
  path = FILE;
  const input = new Input({
    source: new FilePathSource(path),
    formats: ALL_FORMATS,
  });
  const track = await input.getPrimaryVideoTrack();
  if (!track) throw new Error(`no video track in ${path}`);
  DURATION = await track.computeDuration();
  console.log(
    `real clip ${path}: ${DURATION.toFixed(1)}s, ` +
      `${track.displayWidth}×${track.displayHeight}`,
  );
} else {
  path = join(tmpdir(), `seam-speed-seek-${DURATION}s-${FPS}fps-gop${GOP}.mp4`);
  if (!existsSync(path)) {
    console.log(`generating ${path} (${DURATION}s @ ${FPS}fps, GOP ${GOP}s)…`);
    await generate(path);
  } else {
    console.log(`using cached ${path}`);
  }
}

const times = targets();
console.log(
  `\n${SPEED}× speed → ${times.length} output frames @ ${OUT_FPS}fps, ` +
    `source jump ${(SPEED / OUT_FPS).toFixed(2)}s/frame\n`,
);

const seek = await runFrameSource(path, times);
const seq = await runSequential(path, times);

console.log(`sequential drain (old): ${seq.ms.toFixed(0)} ms  (${seq.decoded} samples decoded)`);
console.log(`keyframe seek    (new): ${seek.ms.toFixed(0)} ms`);
console.log(`speedup: ${(seq.ms / seek.ms).toFixed(1)}×`);

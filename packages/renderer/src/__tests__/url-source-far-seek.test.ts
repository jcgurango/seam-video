import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync, readFileSync, statSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createCanvas } from "@napi-rs/canvas";
import { registerMediabunnyServer } from "@mediabunny/server";
import {
  Input,
  Output,
  UrlSource,
  FilePathTarget,
  Mp4OutputFormat,
  VideoSampleSource,
  VideoSample,
  EncodedPacketSink,
  ALL_FORMATS,
} from "mediabunny";

// Pins the mediabunny ≥ 1.61.5 UrlSource read orchestrator against a deadlock
// that 1.48.1 had: a read arriving while every worker is busy was queued, and
// queued reads were only dispatched when a pool slot looked free — but a
// stopped worker stayed in the pool, so the slot check never passed. Over a
// network (latency ≫ 0) a cut-up timeline hits it within a few hundred
// frames; the render silently stalls. Minimal shape: two far-apart reads in
// flight at once on a single-worker source over a slow Range server. 1.48.1
// hangs on the very first pair; a bump that regresses this fails by timeout.
// The renderer no longer reads http sources through UrlSource (it uses
// @seam/media-source's PlannedSource, a CustomSource), but CustomSource runs on
// the same ReadOrchestrator, so this stays the floor's tripwire.

registerMediabunnyServer();

const FPS = 30;
const DUR = 20; // s — big enough that the far read lands outside any prefetch
const W = 640;
const H = 360;
const LATENCY_MS = 20;

let dir: string;
let server: Server;
let url: string;

async function generate(path: string): Promise<void> {
  const output = new Output({ format: new Mp4OutputFormat(), target: new FilePathTarget(path) });
  const vs = new VideoSampleSource({ codec: "avc", bitrate: 3_000_000, keyFrameInterval: 1 });
  output.addVideoTrack(vs, { frameRate: FPS });
  await output.start();
  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext("2d");
  for (let i = 0; i < DUR * FPS; i++) {
    // Busy, non-repeating content so the encoder actually spends the bitrate.
    for (let k = 0; k < 40; k++) {
      ctx.fillStyle = `hsl(${(i * 7 + k * 37) % 360},70%,${30 + (k % 5) * 10}%)`;
      ctx.fillRect((k * 53 + i * 3) % W, (k * 29 + i) % H, 60, 40);
    }
    const id = ctx.getImageData(0, 0, W, H);
    const s = new VideoSample(new Uint8Array(id.data.buffer.slice(0)), {
      format: "RGBA",
      codedWidth: W,
      codedHeight: H,
      timestamp: i / FPS,
      duration: 1 / FPS,
    });
    await vs.add(s);
    s.close();
  }
  await output.finalize();
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "seam-far-seek-"));
  const file = join(dir, "v.mp4");
  await generate(file);
  const size = statSync(file).size;
  const data = readFileSync(file);
  server = createServer((req, res) => {
    const m = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range ?? "");
    setTimeout(() => {
      if (!m) {
        res.writeHead(200, { "content-length": size, "accept-ranges": "bytes" });
        res.end(data);
        return;
      }
      const start = Number(m[1]);
      const end = Math.min(m[2] ? Number(m[2]) : size - 1, size - 1);
      res.writeHead(206, {
        "content-range": `bytes ${start}-${end}/${size}`,
        "content-length": end - start + 1,
        "accept-ranges": "bytes",
      });
      res.end(data.subarray(start, end + 1));
    }, LATENCY_MS);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  url = `http://127.0.0.1:${(server.address() as { port: number }).port}/v.mp4`;
}, 120_000);

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  rmSync(dir, { recursive: true, force: true });
});

describe("UrlSource far seeks", () => {
  it("serves concurrent far-apart reads on a single-worker source (no queued-read deadlock)", async () => {
    let rng = 12345;
    const rand = () => ((rng = (rng * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
    for (let i = 0; i < 10; i++) {
      const t1 = rand() * (DUR / 2);
      const t2 = DUR / 2 + rand() * (DUR / 2 - 1);
      const input = new Input({ source: new UrlSource(url, { parallelism: 1 }), formats: ALL_FORMATS });
      const track = await input.getPrimaryVideoTrack();
      expect(track).not.toBeNull();
      const sink = new EncodedPacketSink(track!);
      const [p1, p2] = await Promise.all([sink.getPacket(t1), sink.getPacket(t2)]);
      expect(p1?.timestamp).toBeCloseTo(t1, 0);
      expect(p2?.timestamp).toBeCloseTo(t2, 0);
      input.dispose();
    }
  }, 30_000);
});

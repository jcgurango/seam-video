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
  FilePathTarget,
  Mp4OutputFormat,
  VideoSampleSource,
  VideoSample,
  VideoSampleSink,
  ALL_FORMATS,
} from "mediabunny";
import { BlockStores, CutPlanner, PlannedSource, LIVE_TAG, type Cut } from "@seam/media-source";
import { openMediaSource } from "../mediaInput.js";

// End-to-end shape of the remote path: a cut-up timeline over a Range server.
// The planner warms every cut's bytes (keyframe → out point) through bounded
// requests, after which the live decoder's reads inside those cuts are all
// cache hits — no request is ever open-ended, and a far seek between cuts is
// served from memory instead of a fresh stream.

registerMediabunnyServer();

const FPS = 30;
const DUR = 20;
const W = 640;
const H = 360;
const BLOCK = 256 * 1024;

let dir: string;
let server: Server;
let url: string;
let ranges: string[] = [];

async function generate(path: string): Promise<void> {
  const output = new Output({ format: new Mp4OutputFormat(), target: new FilePathTarget(path) });
  const vs = new VideoSampleSource({ codec: "avc", bitrate: 3_000_000, keyFrameInterval: 1 });
  output.addVideoTrack(vs, { frameRate: FPS });
  await output.start();
  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext("2d");
  for (let i = 0; i < DUR * FPS; i++) {
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
  dir = mkdtempSync(join(tmpdir(), "seam-planned-"));
  const file = join(dir, "v.mp4");
  await generate(file);
  const size = statSync(file).size;
  const data = readFileSync(file);
  server = createServer((req, res) => {
    const range = req.headers.range ?? "";
    ranges.push(range);
    const m = /^bytes=(\d+)-(\d*)$/.exec(range);
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
    }, 10);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  url = `http://127.0.0.1:${(server.address() as { port: number }).port}/v.mp4`;
}, 120_000);

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
  rmSync(dir, { recursive: true, force: true });
});

const cuts: Cut[] = [
  { id: "0", kind: "clip", source: "", sourceIn: 2, sourceOut: 3, start: 0, end: 1 },
  { id: "1", kind: "clip", source: "", sourceIn: 10.2, sourceOut: 11.5, start: 1, end: 2.3 },
  { id: "2", kind: "clip", source: "", sourceIn: 17, sourceOut: 18, start: 2.3, end: 3.3 },
];

describe("PlannedSource + CutPlanner", () => {
  it("warms every cut with bounded requests; live reads inside cuts then hit the cache", async () => {
    ranges = [];
    const stores = new BlockStores({ blockSize: BLOCK, readAhead: false });
    const planner = new CutPlanner({ stores, horizon: 60, maxConcurrent: 1 });
    planner.setCuts(cuts.map((c) => ({ ...c, source: url })));
    expect(planner.cutCount).toBe(3);
    planner.update(0);
    await planner.idle();
    for (const c of cuts) expect(planner.statusOf(c.id)).toBe("done");
    const store = stores.get(url);
    for (const c of cuts) {
      const r = store.rangeOf(c.id);
      expect(r, `span of cut ${c.id}`).not.toBeNull();
      expect(store.coverage(c.id)).toBe(1);
    }
    // Spans are disjoint and ordered like the source times.
    const r0 = store.rangeOf("0")!;
    const r1 = store.rangeOf("1")!;
    const r2 = store.rangeOf("2")!;
    expect(r0.last).toBeLessThan(r1.first + 1);
    expect(r1.last).toBeLessThan(r2.first + 1);
    for (const r of ranges) expect(r).toMatch(/^bytes=\d+-\d+$/);

    // Live decoder over the same store: frames at the cut times come from
    // memory (the index was pinned by the planner's open as well).
    const warm = stores.stats();
    const input = new Input({ source: new PlannedSource(store, LIVE_TAG), formats: ALL_FORMATS });
    const track = await input.getPrimaryVideoTrack();
    const sink = new VideoSampleSink(track!);
    for (const c of cuts) {
      for (const t of [c.sourceIn, (c.sourceIn + c.sourceOut) / 2, c.sourceOut - 0.05]) {
        const sample = await sink.getSample(t);
        expect(sample?.timestamp).toBeCloseTo(t, 1);
        sample?.close();
      }
    }
    const after = stores.stats();
    expect(after.misses - warm.misses).toBe(0);
    expect(after.requests - warm.requests).toBe(0);
    input.dispose();
    planner.dispose();
    stores.dispose();
  }, 60_000);

  it("sheds the farthest cut first under pressure and re-warms it when the playhead arrives", async () => {
    // Cut 2 sits 15 s out — beyond the live reads' own rank (10), so under
    // pressure it goes before the live working set, which goes before cuts 0/1.
    const far: Cut[] = [cuts[0], cuts[1], { ...cuts[2], start: 15, end: 16 }];
    const stores = new BlockStores({ blockSize: BLOCK, readAhead: false, budgetBytes: 4 * 1024 * 1024, protectRecentBlocks: 2 });
    const planner = new CutPlanner({ stores, horizon: 60, maxConcurrent: 1 });
    planner.setCuts(far.map((c) => ({ ...c, source: url })));
    planner.update(0);
    await planner.idle();
    const store = stores.get(url);
    for (const c of far) expect(store.coverage(c.id), `cut ${c.id} warm`).toBe(1);
    // Live reads of unrelated bytes until the budget bites.
    const size = await store.size();
    let off = Math.floor(size / 2);
    for (let i = 0; i < 12 && store.coverage("2") === 1; i++, off += BLOCK) {
      await store.read(off, off + BLOCK, LIVE_TAG);
    }
    expect(store.coverage("2")).toBeLessThan(1);
    expect(store.coverage("0")).toBe(1);
    // Playhead reaches cut 2: it is distance 0 now and gets re-warmed.
    planner.update(15.5);
    await planner.idle();
    expect(planner.statusOf("2")).toBe("done");
    expect(store.coverage("2")).toBe(1);
    planner.dispose();
    stores.dispose();
  }, 60_000);

  it("openMediaSource routes http(s) through the shared block cache", () => {
    const stores = new BlockStores();
    const src = openMediaSource(url, "/nowhere", stores);
    expect(src).toBeInstanceOf(PlannedSource);
    expect(stores.has(url)).toBe(true);
    stores.dispose();
  });
});

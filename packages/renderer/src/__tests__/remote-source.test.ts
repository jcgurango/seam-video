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
import { isRemoteSource, openMediaSource, resolveSourcePath } from "../mediaInput.js";

// A "remote .seam" (every source a cloud streaming URL) must render without a
// download step: http(s) sources open through mediabunny's byte-range
// UrlSource and decode to the same frames the local file does.

registerMediabunnyServer();

const FPS = 30;
const DUR = 2;
const W = 160;
const H = 90;

let dir: string;
let videoPath: string;
let server: Server;
let baseUrl: string;
let requests = 0;

async function generate(path: string): Promise<void> {
  const output = new Output({
    format: new Mp4OutputFormat(),
    target: new FilePathTarget(path),
  });
  const source = new VideoSampleSource({
    codec: "avc",
    bitrate: 500_000,
    keyFrameInterval: 1,
  });
  output.addVideoTrack(source, { frameRate: FPS });
  await output.start();
  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext("2d");
  const total = DUR * FPS;
  for (let i = 0; i < total; i++) {
    ctx.fillStyle = `hsl(${((i / total) * 360).toFixed(2)}, 60%, 40%)`;
    ctx.fillRect(0, 0, W, H);
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

/** Minimal static file server with HTTP Range support (what a cloud media
 *  endpoint provides, and what UrlSource relies on to stream). */
function serve(root: string): Promise<{ server: Server; url: string }> {
  const server = createServer((req, res) => {
    requests++;
    const file = join(root, decodeURIComponent(new URL(req.url!, "http://x").pathname));
    let size: number;
    try {
      size = statSync(file).size;
    } catch {
      res.writeHead(404).end();
      return;
    }
    const data = readFileSync(file);
    const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? "");
    res.setHeader("accept-ranges", "bytes");
    res.setHeader("content-type", "video/mp4");
    if (range) {
      const start = range[1] ? Number(range[1]) : size - Number(range[2]);
      const end = range[2] && range[1] ? Math.min(Number(range[2]), size - 1) : size - 1;
      res.writeHead(206, {
        "content-range": `bytes ${start}-${end}/${size}`,
        "content-length": end - start + 1,
      });
      res.end(req.method === "HEAD" ? undefined : data.subarray(start, end + 1));
    } else {
      res.writeHead(200, { "content-length": size });
      res.end(req.method === "HEAD" ? undefined : data);
    }
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as { port: number };
      resolve({ server, url: `http://127.0.0.1:${addr.port}` });
    });
  });
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "seam-remote-source-"));
  videoPath = join(dir, "src.mp4");
  await generate(videoPath);
  ({ server, url: baseUrl } = await serve(dir));
}, 60_000);

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  rmSync(dir, { recursive: true, force: true });
});

async function truthAt(t: number): Promise<Uint8Array> {
  const input = new Input({ source: new FilePathSource(videoPath), formats: ALL_FORMATS });
  const track = await input.getPrimaryVideoTrack();
  const sample = await new VideoSampleSink(track!).getSample(t);
  if (!sample) throw new Error(`no sample at ${t}`);
  const buf = new Uint8Array(sample.allocationSize({ format: "RGBA" }));
  await sample.copyTo(buf, { format: "RGBA" });
  sample.close();
  return buf;
}

describe("mediaInput", () => {
  it("classifies http(s) URLs as remote and leaves them unjoined", () => {
    expect(isRemoteSource("https://cloud.test/api/media/x/file?token=t")).toBe(true);
    expect(isRemoteSource("HTTP://cloud.test/a.mp4")).toBe(true);
    expect(isRemoteSource("media/a.mp4")).toBe(false);
    expect(isRemoteSource("/abs/a.mp4")).toBe(false);
    expect(resolveSourcePath("https://c.test/a.mp4", "/base")).toBe("https://c.test/a.mp4");
    expect(resolveSourcePath("a.mp4", "/base")).toBe("/base/a.mp4");
    expect(resolveSourcePath("/abs/a.mp4", "/base")).toBe("/abs/a.mp4");
    expect(openMediaSource("a.mp4", "/base")).toBeInstanceOf(FilePathSource);
    expect(openMediaSource("https://c.test/a.mp4", "/base")).not.toBeInstanceOf(FilePathSource);
  });
});

describe("FrameSource over http", () => {
  it("opens a remote clip by URL and decodes the same frames as the local file", async () => {
    const url = `${baseUrl}/src.mp4?token=abc`;
    const node = {
      type: "clip",
      source: url,
      timelineStart: 0,
      duration: DUR,
      sourceIn: 0,
      sourceOut: DUR,
      speed: 1,
      orientation: 0,
    } as unknown as ResolvedClip;

    // basePath is irrelevant for a URL — give it a bogus one to prove it.
    const fs = new FrameSource("/nonexistent/base");
    const entry = await fs.openSource(url);
    expect(entry.width).toBe(W);
    expect(entry.height).toBe(H);
    expect(requests).toBeGreaterThan(0);

    for (const t of [0, 0.5, 1.5]) {
      await fs.prepare([{ node, drawTime: t }]);
      const frame = fs.get(node);
      expect(frame, `frame at ${t}`).not.toBeNull();
      expect(frame!.width).toBe(W);
      expect(Buffer.from(frame!.data)).toEqual(Buffer.from(await truthAt(t)));
    }
    await fs.dispose?.();
  }, 60_000);
});

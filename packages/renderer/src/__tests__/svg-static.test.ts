import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createCanvas } from "@napi-rs/canvas";
import { rasterizeSvg } from "../svgImage.js";
import { classifyStatic } from "../staticKind.js";

// SVG statics must keep their embedded <image href="data:…"> content and
// text (comment-card exports put the avatar in a data URI). Skia's loadImage
// drops the image silently; the Cairo path renders it.

function fixtureSvg(): string {
  const c = createCanvas(8, 8);
  const ctx = c.getContext("2d");
  ctx.fillStyle = "#ff0000";
  ctx.fillRect(0, 0, 8, 8);
  const png = c.toBuffer("image/png").toString("base64");
  return `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="200" height="100" viewBox="0 0 200 100">
  <rect width="200" height="100" fill="#000"/>
  <image x="10" y="10" width="40" height="40" xlink:href="data:image/png;base64,${png}"/>
  <text x="70" y="40" font-family="Liberation Sans" font-size="30" fill="#fff">Hi</text>
</svg>`;
}

const px = (r: { data: Uint8ClampedArray; width: number }, x: number, y: number) => {
  const i = (y * r.width + x) * 4;
  return [r.data[i], r.data[i + 1], r.data[i + 2], r.data[i + 3]];
};

describe("SVG statics", () => {
  it("classifies by content, not by name (remote sources have no extension)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "seam-sniff-"));
    const svgFile = join(dir, "noext");
    const pngFile = join(dir, "also-noext");
    writeFileSync(svgFile, fixtureSvg());
    writeFileSync(pngFile, createCanvas(2, 2).toBuffer("image/png"));
    const server = createServer((req, res) => {
      // Mirrors Seam Cloud's `/api/media/<id>/file?token=…`: Range honoured.
      const body = req.url?.startsWith("/svg") ? Buffer.from(fixtureSvg()) : createCanvas(2, 2).toBuffer("image/png");
      const m = /bytes=(\d+)-(\d+)?/.exec(req.headers.range ?? "");
      if (m) {
        const a = Number(m[1]);
        const b = Math.min(body.length - 1, m[2] ? Number(m[2]) : body.length - 1);
        res.writeHead(206, { "content-range": `bytes ${a}-${b}/${body.length}` });
        res.end(body.subarray(a, b + 1));
      } else {
        res.writeHead(200);
        res.end(body);
      }
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    try {
      expect(await classifyStatic(svgFile)).toBe("svg");
      expect(await classifyStatic(pngFile)).toBe("raster");
      expect(await classifyStatic(`${base}/svg/file?token=1`)).toBe("svg");
      expect(await classifyStatic(`${base}/png/file?token=1`)).toBe("raster");
    } finally {
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rasterizes embedded data-URI images and text from a file and over http", async () => {
    const dir = mkdtempSync(join(tmpdir(), "seam-svg-"));
    const file = join(dir, "card.svg");
    const svg = fixtureSvg();
    writeFileSync(file, svg);
    const server = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "image/svg+xml" });
      res.end(svg);
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/card.svg`;
    try {
      for (const src of [file, url]) {
        const r = await rasterizeSvg(src);
        expect([r.width, r.height]).toEqual([200, 100]);
        // Inside the embedded image: red.
        const [er, eg, eb, ea] = px(r, 30, 30);
        expect(ea).toBe(255);
        expect(er).toBeGreaterThan(200);
        expect(eg).toBeLessThan(50);
        expect(eb).toBeLessThan(50);
        // Background stays black.
        expect(px(r, 190, 90).slice(0, 3)).toEqual([0, 0, 0]);
        // Some white ink in the text box.
        let ink = 0;
        for (let y = 15; y < 45; y++) for (let x = 70; x < 110; x++) if (px(r, x, y)[0] > 128) ink++;
        expect(ink).toBeGreaterThan(20);
      }
    } finally {
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

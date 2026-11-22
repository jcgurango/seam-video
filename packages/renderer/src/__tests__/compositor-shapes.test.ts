import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  createSeam,
  resolveSpatial,
  type Composition,
} from "@seam/core";
import { buildRenderList, Compositor } from "@seam/compositor";
import { createGpuDevice } from "../gpu.js";
import { NodeBackend, type NodeFrame } from "../NodeBackend.js";

const seam = createSeam();
const { parseSeamFile, resolveComposition } = seam;

// `rect` / `circle` nodes and the universal `cornerRadius` mask are rasterized
// analytically in the shared WGSL shader (signed distance + 1px AA). Pin the
// geometry on real Dawn: a stroked rounded rect has its fill inset by the
// stroke, a circle is empty at its corners, and a rounded mask clips a
// composition's corners.

const W = 128;
const H = 128;

let device: GPUDevice;
let backend: NodeBackend;
let compositor: Compositor<NodeFrame>;

beforeAll(async () => {
  device = await createGpuDevice();
  backend = new NodeBackend(device, 1);
  compositor = new Compositor<NodeFrame>(backend, seam);
  compositor.init();
  compositor.resize(W, H);
});

afterAll(() => {
  compositor?.dispose();
  backend?.dispose();
});

async function renderPixels(doc: Composition, t: number): Promise<Uint8Array> {
  const r = parseSeamFile(JSON.stringify(doc));
  if (!r.success) throw new Error(r.errors.join(", "));
  const timeline = resolveSpatial(resolveComposition(r.data as Composition), W, H);
  const commands = buildRenderList(timeline, t, W, H, () => null);
  await compositor.render(commands, () => null);
  return backend.drainOldest();
}

function px(pixels: Uint8Array, x: number, y: number): [number, number, number] {
  const i = (Math.round(y) * W + Math.round(x)) * 4;
  return [pixels[i], pixels[i + 1], pixels[i + 2]];
}

const isRed = ([r, g, b]: number[]) => r > 200 && g < 40 && b < 40;
const isBlue = ([r, g, b]: number[]) => b > 200 && r < 40 && g < 40;
const isGreen = ([r, g, b]: number[]) => g > 200 && r < 40 && b < 40;
const isBlack = ([r, g, b]: number[]) => r < 20 && g < 20 && b < 20;

describe("Compositor — rect / circle / cornerRadius", () => {
  it("draws a stroked rect with the fill inset by the stroke", async () => {
    const doc: Composition = {
      type: "composition",
      contentWidth: W,
      contentHeight: H,
      children: [
        {
          type: "rect",
          duration: 1,
          fill: "#ff0000",
          stroke: "#0000ff",
          strokeWidth: 10,
          size: { x: 80, y: 60 },
          origin: "0%",
          translation: { x: "0% + 20", y: "0% + 30" },
        },
      ],
    };
    const p = await renderPixels(doc, 0.5);
    // Outside the box: untouched background.
    expect(isBlack(px(p, 10, 10))).toBe(true);
    expect(isBlack(px(p, 110, 100))).toBe(true);
    // Inside the stroke band (5px into the box) and well inside (fill).
    expect(isBlue(px(p, 25, 60))).toBe(true);
    expect(isBlue(px(p, 60, 35))).toBe(true);
    expect(isRed(px(p, 60, 60))).toBe(true);
    expect(isRed(px(p, 35, 45))).toBe(true);
  });

  it("a circle is empty at the corners of its box and filled at the centre", async () => {
    const doc: Composition = {
      type: "composition",
      contentWidth: W,
      contentHeight: H,
      children: [{ type: "circle", duration: 1, fill: "#00ff00", size: 100 }],
    };
    const p = await renderPixels(doc, 0.5);
    // Box spans 14..114. Corners are outside the inscribed circle.
    expect(isBlack(px(p, 18, 18))).toBe(true);
    expect(isBlack(px(p, 110, 110))).toBe(true);
    expect(isGreen(px(p, 64, 64))).toBe(true);
    // Just inside the rim along the horizontal axis.
    expect(isGreen(px(p, 18, 64))).toBe(true);
    expect(isGreen(px(p, 110, 64))).toBe(true);
  });

  it("cornerRadius 50% masks a composition into a circle", async () => {
    const doc: Composition = {
      type: "composition",
      contentWidth: W,
      contentHeight: H,
      children: [
        {
          type: "composition",
          duration: 1,
          backgroundColor: "#ff0000",
          size: 100,
          cornerRadius: "50%",
          children: [{ type: "data", data: null, duration: 1 }],
        },
      ],
    };
    const p = await renderPixels(doc, 0.5);
    expect(isBlack(px(p, 18, 18))).toBe(true);
    expect(isBlack(px(p, 110, 18))).toBe(true);
    expect(isRed(px(p, 64, 64))).toBe(true);
    expect(isRed(px(p, 18, 64))).toBe(true);
  });

  it("a rotated rect lands where the rotation says", async () => {
    // 20×80 bar, origin at its top-left, placed at (64,64), rotated 90° cw →
    // occupies x∈[-16..64]→visible part [0,64], y∈[64,84].
    const doc: Composition = {
      type: "composition",
      contentWidth: W,
      contentHeight: H,
      children: [
        {
          type: "rect",
          duration: 1,
          fill: "#ff0000",
          size: { x: 20, y: 80 },
          origin: "0%",
          translation: "0% + 64",
          rotation: 90,
        },
      ],
    };
    const p = await renderPixels(doc, 0.5);
    expect(isRed(px(p, 30, 74))).toBe(true);
    expect(isBlack(px(p, 74, 100))).toBe(true); // where the un-rotated bar would be
    expect(isBlack(px(p, 30, 50))).toBe(true);
  });

  it("named CSS colours render like the browser (not black)", async () => {
    const doc: Composition = {
      type: "composition",
      contentWidth: W,
      contentHeight: H,
      children: [{ type: "rect", duration: 1, fill: "green", size: 100 }],
    };
    const p = px(await renderPixels(doc, 0.5), 64, 64);
    // CSS "green" is #008000.
    expect(p[0]).toBeLessThan(10);
    expect(p[1]).toBeGreaterThan(110);
    expect(p[1]).toBeLessThan(150);
    expect(p[2]).toBeLessThan(10);
  });

  // JC's two preview repros (2026-10-16): several fills in one frame must each
  // keep their own colour. The preview's BrowserBackend shared one 1×1 tile
  // and skipped repainting per key, so a stroke's white leaked into the root
  // background and a circle's red into a rect. The renderer writes per key;
  // this pins the shared compositor side for both scenes.
  it("a stroked rect leaves the background black and the fill its own colour", async () => {
    const doc: Composition = {
      type: "composition",
      contentWidth: W,
      contentHeight: H,
      backgroundColor: "#000000",
      children: [
        {
          type: "rect",
          duration: 1,
          fill: "#ff0000",
          stroke: "#ffffff",
          strokeWidth: 4,
          size: { x: 80, y: 40 },
        },
      ],
    };
    const p = await renderPixels(doc, 0.5);
    expect(isBlack(px(p, 8, 8))).toBe(true); // background untouched
    expect(isRed(px(p, 64, 64))).toBe(true); // fill
    const edge = px(p, 26, 64); // 2px inside the left edge: stroke band
    expect(edge[0]).toBeGreaterThan(200);
    expect(edge[1]).toBeGreaterThan(200);
    expect(edge[2]).toBeGreaterThan(200);
  });

  it("a second shape appearing does not recolour the first", async () => {
    const doc: Composition = {
      type: "composition",
      contentWidth: W,
      contentHeight: H,
      children: [
        {
          type: "rect",
          id: "anchor",
          duration: 2,
          fill: "#0000ff",
          size: { x: 60, y: 30 },
          origin: "0%",
          translation: "0%",
        },
        {
          type: "circle",
          duration: 1,
          fill: "#ff0000",
          size: 40,
          origin: "0%",
          translation: { x: "0% + 80", y: "0% + 80" },
          start: "anchor@50%",
        },
      ],
    };
    const before = await renderPixels(doc, 0.5);
    expect(isBlue(px(before, 30, 15))).toBe(true);
    expect(isBlack(px(before, 100, 100))).toBe(true);
    const after = await renderPixels(doc, 1.5);
    expect(isBlue(px(after, 30, 15))).toBe(true); // still blue once the circle is on
    expect(isRed(px(after, 100, 100))).toBe(true);
  });

  it("fill colours tween between keyframes", async () => {
    const doc: Composition = {
      type: "composition",
      contentWidth: W,
      contentHeight: H,
      children: [
        {
          type: "rect",
          duration: 2,
          fill: [[0, "#ff0000"], [2, "#0000ff"]],
          size: 100,
        },
      ],
    };
    const a = px(await renderPixels(doc, 0), 64, 64);
    const b = px(await renderPixels(doc, 1), 64, 64);
    expect(isRed(a)).toBe(true);
    // Midway: roughly equal red and blue, no green.
    expect(Math.abs(b[0] - b[2])).toBeLessThan(30);
    expect(b[1]).toBeLessThan(30);
    expect(b[0]).toBeGreaterThan(80);
  });
});

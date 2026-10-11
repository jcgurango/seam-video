import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  parseSeamFile,
  resolveComposition,
  resolveSpatial,
  squareToQuad,
  applyHomography,
  type Composition,
} from "@seam/core";
import { buildRenderList, Compositor } from "@seam/compositor";
import { createGpuDevice } from "../gpu.js";
import { NodeBackend, type NodeFrame } from "../NodeBackend.js";

// `distort` corner-pins a composition's composited content. This pins the
// shader's behaviour on real Dawn: the warped quad is drawn where the corners
// say (outside the pins is empty), and the texture is interpolated
// PROJECTIVELY — a bilinear two-triangle blit would put the red/blue seam in a
// different place (and crease it along the diagonal).

const W = 128;
const H = 128;

let device: GPUDevice;
let backend: NodeBackend;
let compositor: Compositor<NodeFrame>;

beforeAll(async () => {
  device = await createGpuDevice();
  backend = new NodeBackend(device, 1);
  compositor = new Compositor<NodeFrame>(backend);
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
const isBlack = ([r, g, b]: number[]) => r < 20 && g < 20 && b < 20;

// A full-canvas comp whose content is blue with the LEFT HALF red, with its
// bottom-left corner pinned to the bottom centre (x3: "50%").
const doc: Composition = {
  type: "composition",
  contentWidth: W,
  contentHeight: H,
  children: [
    {
      type: "composition",
      duration: 1,
      distort: { x3: "50%" },
      backgroundColor: "#0000ff",
      children: [
        {
          type: "composition",
          duration: 1,
          backgroundColor: "#ff0000",
          origin: "0%",
          translation: "0%",
          size: { x: "50%", y: "100%" },
          children: [{ type: "empty", duration: 1 }],
        },
      ],
    },
  ],
};

describe("Compositor — distort (corner pin)", () => {
  it("draws the content as the pinned quad and warps it projectively", async () => {
    const pixels = await renderPixels(doc, 0.5);

    // Outside the pinned quad (bottom-left region vacated by the BL corner).
    expect(isBlack(px(pixels, 10, 120))).toBe(true);
    // Top edge is untouched: left red, right blue.
    expect(isRed(px(pixels, 8, 4))).toBe(true);
    expect(isBlue(px(pixels, 120, 4))).toBe(true);

    // The red/blue seam is the image of u = 0.5. Under the homography it runs
    // through `applyHomography(m, 0.5, 0.5)`; a bilinear blit would put the
    // (0.5, 0.5) texel at the corner average instead (x 80, y 64), and at the
    // projective mid-point's row it would still read red 4px to the right of
    // the seam. Assert the projective placement.
    const m = squareToQuad([
      { x: 0, y: 0 },
      { x: W, y: 0 },
      { x: W, y: H },
      { x: W / 2, y: H },
    ]);
    const mid = applyHomography(m, 0.5, 0.5);
    expect(mid.x).toBeCloseTo((2 / 3) * W, 6);
    expect(mid.y).toBeCloseTo((2 / 3) * H, 6);
    expect(isRed(px(pixels, mid.x - 4, mid.y))).toBe(true);
    expect(isBlue(px(pixels, mid.x + 4, mid.y))).toBe(true);
  });

  it("identity distort renders exactly like no distort", async () => {
    const plain = structuredClone(doc);
    delete (plain.children![0] as { distort?: unknown }).distort;
    const identity = structuredClone(doc);
    (identity.children![0] as { distort?: unknown }).distort = { x0: "0%", y3: "100%" };
    const a = await renderPixels(plain, 0.5);
    const b = await renderPixels(identity, 0.5);
    expect(Buffer.compare(Buffer.from(a), Buffer.from(b))).toBe(0);
    expect(isRed(px(a, 10, 120))).toBe(true);
  });
});

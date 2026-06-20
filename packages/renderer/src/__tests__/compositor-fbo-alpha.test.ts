import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  parseSeamFile,
  resolveComposition,
  resolveSpatial,
  type Composition,
} from "@seam/core";
import { buildRenderList } from "@seam/compositor";
import { Compositor } from "@seam/compositor";
import { createGpuDevice } from "../gpu.js";
import { NodeBackend, type NodeFrame } from "../NodeBackend.js";

// Regression: a composition with a transparent (unspecified) background and
// opacity < 1 takes the FBO path. The FBO must clear TRANSPARENT — clearing it
// opaque-black turned the comp's empty regions into black that bled into the
// parent during an opacity fade. Render a transparent-bg comp at opacity 0.5
// over a red root background and confirm the result stays red, not darkened.

const W = 64;
const H = 64;

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

async function renderCenterPixel(doc: Composition, t: number): Promise<number[]> {
  const r = parseSeamFile(JSON.stringify(doc));
  if (!r.success) throw new Error(r.errors.join(", "));
  const timeline = resolveSpatial(resolveComposition(r.data as Composition), W, H);
  const commands = buildRenderList(timeline, t, W, H, () => null);
  await compositor.render(commands, () => null);
  const pixels = await backend.drainOldest();
  const idx = (Math.floor(H / 2) * W + Math.floor(W / 2)) * 4;
  return [pixels[idx], pixels[idx + 1], pixels[idx + 2], pixels[idx + 3]];
}

describe("Compositor — FBO transparent clear", () => {
  // Red background, a transparent-bg child composition at opacity 0.5 covering
  // the canvas. Its FBO is empty (its only child is an `empty`), so the layer
  // contributes nothing — the red must show through undarkened.
  const doc = (opacity: number): Composition => ({
    type: "composition",
    contentWidth: W,
    contentHeight: H,
    backgroundColor: "#ff0000",
    children: [
      {
        type: "composition",
        opacity,
        duration: 1,
        children: [{ type: "empty", duration: 1 }],
      },
    ],
  });

  it("keeps a transparent-bg comp see-through at opacity 0.5 (no black bleed)", async () => {
    const [r, g, b] = await renderCenterPixel(doc(0.5), 0.5);
    // Pre-fix the FBO cleared opaque-black → red blended to ~ (127, 0, 0).
    expect(r).toBeGreaterThan(230);
    expect(g).toBeLessThan(25);
    expect(b).toBeLessThan(25);
  });

  it("matches the flattened (opacity 1) result", async () => {
    const [r, g, b] = await renderCenterPixel(doc(1), 0.5);
    expect(r).toBeGreaterThan(230);
    expect(g).toBeLessThan(25);
    expect(b).toBeLessThan(25);
  });
});

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  createSeam,
  resolveSpatial,
  type Child,
  type Composition,
} from "@seam/core";
import { buildRenderList, Compositor } from "@seam/compositor";
import { adjustments } from "@seam/extension-adjustments";
import { createGpuDevice } from "../gpu.js";
import { NodeBackend, type NodeFrame } from "../NodeBackend.js";

const seam = createSeam([adjustments]);
const { parseSeamFile, resolveComposition } = seam;

// The Adjustments extension (brightness / contrast / saturation / gamma /
// temperature / tint) pinned on real Dawn. The expected pixels for everything
// except `tint` were captured from the old `filters`-array implementation
// BEFORE adjustments moved to the extension, so this is the tripwire that the
// move reproduced the old output exactly. `tint` is new with the extension.

const W = 64;
const H = 64;

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

interface Adjust {
  brightness?: number;
  contrast?: number;
  saturation?: number;
  gamma?: number;
  temperature?: number;
  tint?: number;
}

/** Author `adj` onto a node: flat, first-class fields. */
function adjusted<T extends Child>(node: T, adj: Adjust): T {
  return { ...node, ...adj } as T;
}

const FILL = "#c06030"; // 192, 96, 48

function rect(): Child {
  return { type: "rect", duration: 1, fill: FILL } as Child;
}

async function render(
  child: Child,
  root: Record<string, unknown> = {},
  t = 0.5,
): Promise<[number, number, number]> {
  const doc = {
    type: "composition",
    contentWidth: W,
    contentHeight: H,
    ...root,
    children: [child],
  } as Composition;
  const r = parseSeamFile(JSON.stringify(doc));
  if (!r.success) throw new Error(r.errors.join(", "));
  const timeline = resolveSpatial(resolveComposition(r.data as Composition), W, H);
  const commands = buildRenderList(timeline, t, W, H, () => null);
  await compositor.render(commands, () => null);
  const pixels = await backend.drainOldest();
  const i = ((H / 2) * W + W / 2) * 4;
  return [pixels[i], pixels[i + 1], pixels[i + 2]];
}

// 192,96,48 with green ×0.75 / red and blue ×0.75.
const TINT_PLUS = [192, 72, 48];
const TINT_MINUS = [144, 96, 36];
// Saturation 0.5: halfway between grey (119) and the fill.
const KF_MID = [156, 108, 84];

const CASES: Array<[string, Adjust, [number, number, number]]> = [
  ["identity", {}, [192, 96, 48]],
  ["brightness +0.2", { brightness: 0.2 }, [243, 147, 99]],
  ["brightness -0.3", { brightness: -0.3 }, [115, 20, 0]],
  ["contrast 1.5", { contrast: 1.5 }, [188, 92, 44]],
  ["contrast 0.5", { contrast: 0.5 }, [196, 100, 52]],
  ["saturation 0", { saturation: 0 }, [119, 119, 119]],
  ["saturation 2", { saturation: 2 }, [255, 73, 0]],
  ["gamma 2", { gamma: 2 }, [247, 151, 103]],
  ["gamma 0.5", { gamma: 0.5 }, [128, 33, 0]],
  ["temperature 3000", { temperature: 3000 }, [192, 67, 21]],
  ["temperature 10000", { temperature: 10000 }, [152, 82, 49]],
  [
    "combined",
    { brightness: 0.1, contrast: 1.2, saturation: 0.5, gamma: 1.5, temperature: 5000 },
    [210, 145, 114],
  ],
];

describe("Compositor — colour adjustments", () => {
  for (const [name, adj, want] of CASES) {
    it(`leaf: ${name}`, async () => {
      const got = await render(adjusted(rect(), adj));
      expect(got).toEqual(want);
    });
  }

  // A composition takes the FBO path: its children composite first and the
  // adjustment applies to the group.
  for (const [name, adj, want] of CASES) {
    it(`group: ${name}`, async () => {
      const comp = { type: "composition", duration: 1, children: [rect()] } as Child;
      const got = await render(adjusted(comp, adj));
      expect(got).toEqual(want);
    });
  }

  // ── New with the extension (no pre-extension reference) ──

  it("tint: + pulls green down, − pulls red and blue down", async () => {
    const plus = await render(adjusted(rect(), { tint: 0.5 }));
    const minus = await render(adjusted(rect(), { tint: -0.5 }));
    expect(plus).toEqual(TINT_PLUS);
    expect(minus).toEqual(TINT_MINUS);
  });

  it("keyframed: sampled in the node's own time", async () => {
    const node = { ...rect(), saturation: [[0, 0], ["100%", 1]] } as unknown as Child;
    // t = 0 → saturation 0 (grey); the pinned "saturation 0" value.
    expect(await render(node, {}, 0)).toEqual([119, 119, 119]);
    const mid = await render(node, {}, 0.5);
    expect(mid).toEqual(KF_MID);
  });

  it("on the root composition: applies to the whole frame", async () => {
    expect(await render(rect(), { saturation: 0 })).toEqual([119, 119, 119]);
    expect(await render(rect(), { brightness: 0.2 })).toEqual([243, 147, 99]);
  });

  it("stacks through nesting: a comp's adjustment applies on top of its child's", async () => {
    const inner = adjusted(rect(), { brightness: 0.2 });
    const comp = { type: "composition", duration: 1, children: [inner] } as Child;
    // brightness +0.2 (243,147,99) then saturation 0 on the group → grey.
    const [r, g, b] = await render(adjusted(comp, { saturation: 0 }));
    expect(r).toBe(g);
    expect(g).toBe(b);
    expect(r).toBeGreaterThan(119);
  });
});

describe("Compositor — no colour stages installed", () => {
  it("draws the fill untouched", async () => {
    const bare = createSeam();
    const c = new Compositor<NodeFrame>(backend, bare);
    c.init();
    c.resize(W, H);
    try {
      const doc: Composition = {
        type: "composition",
        contentWidth: W,
        contentHeight: H,
        children: [rect()],
      };
      const r = bare.parseSeamFile(JSON.stringify(doc));
      if (!r.success) throw new Error(r.errors.join(", "));
      const timeline = resolveSpatial(bare.resolveComposition(r.data as Composition), W, H);
      await c.render(buildRenderList(timeline, 0.5, W, H, () => null), () => null);
      const pixels = await backend.drainOldest();
      const i = ((H / 2) * W + W / 2) * 4;
      expect([pixels[i], pixels[i + 1], pixels[i + 2]]).toEqual([192, 96, 48]);
    } finally {
      c.dispose();
    }
  });
});

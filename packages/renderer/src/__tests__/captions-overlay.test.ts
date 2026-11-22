import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createSeam, resolveSpatial, type Composition } from "@seam/core";
import { buildRenderList, Compositor } from "@seam/compositor";
import { captions } from "@seam/extension-captions/render";
import { text as textExtension } from "@seam/extension-text/render";
import { createGpuDevice } from "../gpu.js";
import { NodeBackend, type NodeFrame } from "../NodeBackend.js";
import { FrameSource, collectDrawables } from "../frameSource.js";

// The Captions overlay on real Dawn, end to end through the renderer's frame
// provider. A caption is not a text node, but it shares the layout code — so
// a caption shown at a surface must come out PIXEL-IDENTICAL to a text node
// carrying the same style, filling the same canvas. That equivalence is what
// lets a project move its baked-in caption text over to captions without the
// picture changing.

const W = 256;
const H = 256;
const seam = createSeam([textExtension, captions]);

let device: GPUDevice;
let backend: NodeBackend;
let compositor: Compositor<NodeFrame>;
let source: FrameSource;

beforeAll(async () => {
  device = await createGpuDevice();
  backend = new NodeBackend(device, 1);
  compositor = new Compositor<NodeFrame>(backend, seam);
  compositor.init();
  compositor.resize(W, H);
  source = new FrameSource(process.cwd(), undefined, seam);
});

afterAll(async () => {
  compositor?.dispose();
  backend?.dispose();
  await source?.dispose();
});

async function render(doc: unknown, t: number): Promise<Buffer> {
  const r = seam.parseSeamFile(JSON.stringify(doc));
  if (!r.success) throw new Error(r.errors.join(", "));
  const { doc: compiled } = seam.compileSeamFile(r.data);
  const timeline = resolveSpatial(seam.resolveComposition(compiled as Composition), W, H);
  const commands = buildRenderList(seam, timeline, t, W, H, () => null);
  await source.prepare(collectDrawables(commands));
  await compositor.render(commands, (n) => source.get(n));
  return Buffer.from(await backend.drainOldest());
}

const STYLE = {
  fontFamily: "Liberation Sans",
  fontSize: 28,
  color: "white",
  fontWeight: "bold",
  strokeColor: "black",
  strokeWidth: 6,
  verticalAlign: "bottom",
  padding: [20, 12],
} as const;

const root = (extra: object, children: unknown[]) => ({
  type: "composition",
  contentWidth: W,
  contentHeight: H,
  backgroundColor: "#204060",
  ...extra,
  children,
});
const bg = { type: "rect", duration: 4, fill: "#c06030", size: 80 };
const text = (value: string, extra: object = {}) => ({ type: "text", text: value, duration: 4, start: 0, ...STYLE, ...extra });
const inked = (px: Buffer) => {
  // Any near-white pixel = caption fill.
  for (let i = 0; i < px.length; i += 4) if (px[i] > 240 && px[i + 1] > 240 && px[i + 2] > 240) return true;
  return false;
};

describe("captions overlay", () => {
  it("a caption renders exactly like a text node with the surface's style", async () => {
    const asText = await render(root({}, [bg, text("It's gonna rain")]), 0.5);
    const asCaption = await render(
      root({ captionStyle: STYLE }, [
        bg,
        {
          type: "caption",
          start: 0,
          duration: 4,
          children: [
            { type: "word", text: "It's", duration: 0.3 },
            { type: "word", text: "gonna", duration: 0.3 },
            { type: "word", text: "rain", duration: 0.4 },
          ],
        },
      ]),
      0.5,
    );
    expect(inked(asText)).toBe(true);
    expect(asCaption.equals(asText)).toBe(true);
  });

  it("speaker and per-caption overrides match the same text styling", async () => {
    const asText = await render(
      root({}, [bg, text("LIT", { color: "pink", fontSize: 44, fontStyle: "italic" })]),
      0.5,
    );
    const asCaption = await render(
      root({ captionStyle: { ...STYLE, speakers: { faye: { color: "pink" } } } }, [
        bg,
        { type: "caption", start: 0, text: "LIT", duration: 4, speaker: "faye", style: { fontSize: 44, fontStyle: "italic" } },
      ]),
      0.5,
    );
    expect(asCaption.equals(asText)).toBe(true);
  });

  it("a caption nested in compositions bubbles to the root, untouched by their transforms", async () => {
    const flat = await render(root({ captionStyle: STYLE }, [bg, { type: "caption", start: 0, text: "hello", duration: 4 }]), 0.5);
    const nested = await render(
      root({ captionStyle: STYLE }, [
        bg,
        {
          type: "composition",
          start: 0,
          // Shrunk, rotated, faded: none of it reaches the caption.
          size: 40,
          rotation: 30,
          opacity: 0.3,
          children: [{ type: "composition", children: [{ type: "caption", text: "hello", duration: 4 }] }],
        },
      ]),
      0.5,
    );
    expect(nested.equals(flat)).toBe(true);
  });

  it("nothing is drawn outside a caption's span, when the root is off, or when a composition swallows it", async () => {
    const bare = await render(root({}, [bg]), 0.5);
    const cap = { type: "caption", start: 0, text: "hello", duration: 1 };
    expect((await render(root({ captionStyle: STYLE }, [bg, cap]), 2)).equals(bare)).toBe(true);
    expect((await render(root({ captionStyle: STYLE, captions: "off" }, [bg, cap]), 0.5)).equals(bare)).toBe(true);
    expect(
      (
        await render(
          root({ captionStyle: STYLE }, [bg, { type: "composition", start: 0, captions: "off", children: [cap] }]),
          0.5,
        )
      ).equals(bare),
    ).toBe(true);
  });

  it("a composition that is a surface draws its captions inside its own box", async () => {
    // The surface is the left half; its caption text must stay in that half.
    const px = await render(
      root({ captions: "off" }, [
        {
          type: "composition",
          captions: "show",
          captionStyle: { ...STYLE, verticalAlign: "center", padding: 0 },
          origin: "0%",
          translation: "0%",
          size: { x: "50%", y: "100%" },
          contentWidth: W / 2,
          contentHeight: H,
          children: [{ type: "caption", text: "hi", duration: 4 }],
        },
      ]),
      0.5,
    );
    let left = 0;
    let right = 0;
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const i = (y * W + x) * 4;
        if (px[i] > 240 && px[i + 1] > 240 && px[i + 2] > 240) x < W / 2 ? left++ : right++;
      }
    }
    expect(left).toBeGreaterThan(20);
    expect(right).toBe(0);
  });
});

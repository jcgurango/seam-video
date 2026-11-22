import { describe, it, expect } from "vitest";
import { createSeam, resolveSpatial, type Composition, type ResolvedExtensionNode } from "@seam/core";
import { buildRenderList, type RenderCommand } from "@seam/compositor";
import { text, measureText, layoutText } from "@seam/extension-text/render";
import { createInnerMeasurer } from "../nodeRasterizers.js";
import { installCanvasShim } from "../text/canvasShim.js";

// `wrap: false` text: its inner canvas is the measured size of the text, on
// the real Skia + Pretext path the renderer uses.

const seam = createSeam([text]);
const W = 1080;
const H = 1920;

function drawOf(children: unknown[], t = 0, root: object = {}) {
  const measurer = createInnerMeasurer(seam, ".");
  const temporal = seam.resolveComposition({ type: "composition", ...root, children } as unknown as Composition);
  const timeline = resolveSpatial(temporal, W, H, { measure: measurer.measure });
  const commands = buildRenderList(seam, timeline, t, W, H, (node, at) => {
    if (!("extension" in node)) return null;
    const m = measurer.measure(node as ResolvedExtensionNode, at ?? 0);
    return m ? { w: m.width, h: m.height } : null;
  });
  const draw = commands.find((c): c is Extract<RenderCommand, { type: "draw" }> => c.type === "draw")!;
  return { draw, node: timeline.children[0] as unknown as { intrinsicWidth: number; intrinsicHeight: number } };
}

describe("text with wrap: false", () => {
  it("measures the widest line and the line count, plus padding", () => {
    installCanvasShim();
    const base = { runs: [{ text: "hello" }], fontSize: 50, duration: 1, wrap: false as const };
    const one = measureText(base, 0);
    const two = measureText({ ...base, runs: [{ text: "hello\nhello hello" }] }, 0);
    expect(one.height).toBe(60); // one line of 1.2 × 50
    expect(two.height).toBe(120);
    expect(two.width).toBeGreaterThan(one.width * 2);
    const padded = measureText({ ...base, padding: [10, 30] }, 0);
    expect(padded).toEqual({ width: one.width + 60, height: one.height + 20 });
    // Laid out at its own size it stays on one line, however narrow that is
    // compared with what wrapping would need.
    const long = { ...base, runs: [{ text: "a very long single line of text that never wraps" }] };
    const m = measureText(long, 0);
    const lines = new Set(layoutText(long, 0, m.width, m.height).glyphs.map((g) => g.y));
    expect(lines.size).toBe(1);
    expect(new Set(layoutText({ ...long, wrap: true }, 0, 200, 600).glyphs.map((g) => g.y)).size).toBeGreaterThan(1);
  });

  it("draws at its measured size, fitted into the parent like an image", () => {
    const { draw, node } = drawOf([{ type: "text", text: "hello", fontSize: 50, duration: 2, wrap: false }]);
    // The texture is the measured box…
    expect(draw.contentW).toBe(node.intrinsicWidth);
    expect(draw.contentH).toBe(60);
    // …and the default objectFit scales it to the parent's width, centred.
    expect(draw.quadX).toBeCloseTo(0, 3);
    expect(draw.quadW).toBeCloseTo(W, 3);
    expect(draw.quadH).toBeCloseTo((W * 60) / node.intrinsicWidth, 3);
  });

  it("a parent with objectFit: center keeps it at its true pixel size, placed by origin / translation", () => {
    const { draw, node } = drawOf(
      [{ type: "text", text: "hello", fontSize: 50, duration: 2, wrap: false, origin: "0%", translation: { x: 100, y: 200 } }],
      0,
      { objectFit: "center" },
    );
    expect([draw.quadW, draw.quadH]).toEqual([node.intrinsicWidth, 60]);
    // translation: px offset from the parent's centre; origin 0% = its top-left.
    expect([draw.quadX, draw.quadY]).toEqual([W / 2 + 100, H / 2 + 200]);
  });

  it("fitSelf: center on the text itself does the same without touching the parent", () => {
    const { draw, node } = drawOf([
      { type: "text", text: "hello", fontSize: 50, duration: 2, wrap: false, fitSelf: "center" },
    ]);
    expect([draw.quadW, draw.quadH]).toEqual([node.intrinsicWidth, 60]);
    expect(draw.quadX).toBeCloseTo((W - node.intrinsicWidth) / 2, 3);
  });

  it("a keyframed font size re-measures every frame", () => {
    const node = { type: "text", text: "hello", duration: 2, wrap: false, fontSize: [[0, 50], [2, 100]] };
    const a = drawOf([node], 0, { objectFit: "center" }).draw;
    const b = drawOf([node], 1, { objectFit: "center" }).draw;
    expect(a.contentH).toBe(60);
    expect(b.contentH).toBe(90); // 1.2 × 75
    expect(b.quadW!).toBeGreaterThan(a.quadW!);
  });
});

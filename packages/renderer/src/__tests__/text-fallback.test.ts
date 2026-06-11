import { describe, it, expect } from "vitest";
import { layoutText, drawTextLayout } from "@seam/core";
import type { ResolvedText } from "@seam/core";
import { createCanvas } from "@napi-rs/canvas";
import { installCanvasShim } from "../text/canvasShim.js";

// Exercises the text-node rasterization path end to end: core's layout +
// draw (which now append CJK/emoji fallbacks to every font string) on the
// same @napi-rs/canvas the renderer uses. Confirms missing-script glyphs
// fall through to the bundled fonts — and that emoji render in colour.

function textNode(text: string): ResolvedText {
  return {
    type: "text",
    runs: [{ text }],
    contentWidth: 400,
    contentHeight: 120,
    timelineStart: 0,
    timelineEnd: 1,
  } as ResolvedText;
}

function rasterize(text: string): { ink: number; colored: number } {
  installCanvasShim();
  const layout = layoutText(textNode(text), 0);
  const canvas = createCanvas(
    Math.max(1, Math.ceil(layout.width)),
    Math.max(1, Math.ceil(layout.height)),
  );
  const ctx = canvas.getContext("2d");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  drawTextLayout(ctx as any, layout);
  const { width, height } = canvas;
  const data = ctx.getImageData(0, 0, width, height).data;
  let ink = 0;
  let colored = 0;
  for (let i = 0; i < data.length; i += 4) {
    const a = data[i + 3];
    if (a <= 10) continue;
    ink++;
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    if (Math.abs(r - g) > 25 || Math.abs(g - b) > 25 || Math.abs(r - b) > 25) {
      colored++;
    }
  }
  return { ink, colored };
}

describe("text node CJK/emoji fallback (renderer)", () => {
  it("renders CJK via the Noto fallback", () => {
    expect(rasterize("日本語").ink).toBeGreaterThan(100);
  });

  it("renders emoji in colour via OpenMoji", () => {
    const { ink, colored } = rasterize("😀🎉");
    expect(ink).toBeGreaterThan(100);
    expect(colored).toBeGreaterThan(50);
  });

  it("MEASURES CJK with the fallback (Pretext layout width matches a real measureText)", () => {
    installCanvasShim();
    const text = "日本語のテキスト";
    const layout = layoutText(textNode(text), 0);

    // Direct measurement with the fallback-bearing font the draw pass uses.
    const probe = createCanvas(10, 10).getContext("2d");
    probe.font = layout.glyphs[0].font; // includes Liberation + CJK + OpenMoji
    const expected = probe.measureText(text).width;

    // If Pretext had measured tofu (no fallback), the laid-out width would
    // diverge sharply from the real CJK advances. Allow a small tolerance
    // for kerning/fragment padding.
    expect(layout.width).toBeGreaterThan(expected * 0.95);
    // Sanity: CJK is ~full-em wide, so 8 chars dwarf any tofu box run.
    expect(layout.width).toBeGreaterThan(text.length * 0.7 * 16);
  });
});

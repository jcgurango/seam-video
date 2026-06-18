import { describe, it, expect } from "vitest";
import {
  resolveComposition,
  resolveSpatial,
  type Composition,
} from "@seam/core";
import { buildRenderList, type RenderCommand, type DrawCommand } from "../RenderList.js";

const W = 1080;
const H = 1920;

/** Flatten the render list (a duration/speed comp without filters flattens into
 *  the parent pass, but recurse into any FBO groups just in case). */
function draws(commands: RenderCommand[]): DrawCommand[] {
  const out: DrawCommand[] = [];
  for (const c of commands) {
    if (c.type === "draw") out.push(c);
    else if (c.type === "group") out.push(...draws(c.children));
  }
  return out;
}

function renderAt(root: Composition, t: number): DrawCommand[] {
  const timeline = resolveSpatial(resolveComposition(root), W, H);
  return draws(buildRenderList(timeline, t, W, H, () => ({ w: W, h: H })));
}

describe("buildRenderList — duration-compressed composition", () => {
  // Repro of the freeze bug: a composition with `duration: 2` wrapping two
  // sequential clips (~48s of inner content) compressed into a 2s output at
  // ~24x. The inner-window time the compositor recurses children with must
  // range over the inner span (~48s), NOT be clamped to the output `duration`
  // (2s) — clamping pinned inner time at 2s, freezing clip1 and starving clip2.
  const CLIP1_OUT = 19.116451266762056;
  const CLIP2_OUT = 29;
  const root: Composition = {
    type: "composition",
    contentWidth: W,
    contentHeight: H,
    children: [
      {
        type: "composition",
        duration: 2,
        children: [
          { type: "clip", source: "clip1.mov", in: 0, out: CLIP1_OUT },
          { type: "clip", source: "clip2.mov", in: 0, out: CLIP2_OUT },
        ],
      },
    ],
  };

  const span = CLIP1_OUT + CLIP2_OUT; // ~48.1s inner window
  const speed = span / 2; // ~24.06x

  it("draws clip2 in the back half of the compressed output", () => {
    const ds = renderAt(root, 1.5);
    const sources = ds.map((d) => (d.clip as { source: string }).source);
    expect(sources).toContain("clip2.mov");
    expect(sources).not.toContain("clip1.mov");

    // drawTime addresses the source: at output 1.5s, inner time is 1.5*speed,
    // and clip2 starts at CLIP1_OUT inside the inner window.
    const clip2 = ds.find((d) => (d.clip as { source: string }).source === "clip2.mov")!;
    expect(clip2.drawTime).toBeCloseTo(1.5 * speed - CLIP1_OUT, 4);
  });

  it("keeps clip1 advancing past the old freeze point", () => {
    // clip1 stays active until inner ~19.1s (output ~0.79s). The buggy clamp
    // pinned inner time at 2s once output exceeded 2/speed ≈ 0.083s, so any
    // sample after that froze. Sample at 0.5s — clip1 is still on, and its
    // source time must be 0.5*speed (~12s), far beyond the old 2s ceiling.
    const ds = renderAt(root, 0.5);
    const clip1 = ds.find((d) => (d.clip as { source: string }).source === "clip1.mov")!;
    expect(clip1).toBeTruthy();
    expect(clip1.drawTime).toBeCloseTo(0.5 * speed, 4);
    expect(clip1.drawTime).toBeGreaterThan(2); // would be pinned at 2 when buggy
  });

  it("reaches the end of clip2's inner range near the output end", () => {
    const ds = renderAt(root, 1.99);
    const clip2 = ds.find((d) => (d.clip as { source: string }).source === "clip2.mov")!;
    expect(clip2).toBeTruthy();
    // Inner time clamps to the inner span (not 2s), so clip2 plays to its tail.
    expect(clip2.drawTime).toBeGreaterThan(CLIP2_OUT - 1);
  });

  // Wrapping the duration-compressed comp in plain (speed 1) compositions must
  // not change anything: cropChildrenToWindow recurses into the nested comp and
  // must map the outer window into the child's INNER coords by its speed, else
  // clip2 (inner ~19.1s) is dropped during resolve — transparent in both hosts.
  it("survives being wrapped in outer compositions", () => {
    const wrapped: Composition = {
      type: "composition",
      contentWidth: W,
      contentHeight: H,
      children: [
        { type: "composition", children: [root.children[0]] },
      ],
    };
    const ds = renderAt(wrapped, 1.5);
    const sources = ds.map((d) => (d.clip as { source: string }).source);
    expect(sources).toContain("clip2.mov");
    expect(sources).not.toContain("clip1.mov");
    const clip2 = ds.find((d) => (d.clip as { source: string }).source === "clip2.mov")!;
    expect(clip2.drawTime).toBeCloseTo(1.5 * speed - CLIP1_OUT, 4);
  });
});

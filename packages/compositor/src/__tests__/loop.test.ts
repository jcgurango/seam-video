import { describe, it, expect } from "vitest";
import { resolveComposition, resolveSpatial, type Composition } from "@seam/core";
import { buildRenderList, type RenderCommand, type DrawCommand } from "../RenderList.js";

// `underflow: "loop"`: the render list wraps a looping node's CONTENT time
// (clip source time / composition inner time) into one cycle per frame while
// the node's own keyframes (opacity here) keep running over the whole span.

const W = 1080;
const H = 1920;

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

const over = (id: string) => ({
  start: { anchor: id, timeSource: "output" as const, anchorPoint: "0%" },
  end: { anchor: id, timeSource: "output" as const, anchorPoint: "100%" },
});

const src = (d: DrawCommand) => (d.clip as { source?: string }).source;

describe("buildRenderList — underflow: loop", () => {
  it("a looping clip's drawTime wraps every cycle", () => {
    const root: Composition = {
      type: "composition",
      contentWidth: W,
      contentHeight: H,
      children: [{ id: "bg", type: "static", source: "bg.png", duration: 10 }],
      attachments: [
        { type: "clip", source: "b.mp4", in: 5, out: 8, underflow: "loop", ...over("bg") },
      ],
    };
    const at = (t: number) => renderAt(root, t).find((d) => src(d) === "b.mp4")!;
    expect(at(1).drawTime).toBeCloseTo(1);
    expect(at(4).drawTime).toBeCloseTo(1);
    expect(at(7.5).drawTime).toBeCloseTo(1.5);
    expect(at(9.9).drawTime).toBeCloseTo(0.9);
    // frameSource/preview add sourceIn: 5 + 1.5 = 6.5s of the file at t=7.5.
  });

  it("a looping composition replays its inner window (JC's example)", () => {
    const root: Composition = {
      type: "composition",
      contentWidth: W,
      contentHeight: H,
      children: [{ id: "bg", type: "static", source: "bg.png", duration: 10 }],
      attachments: [
        {
          type: "composition",
          underflow: "loop",
          children: [{ type: "clip", in: 0.5, out: 1.5, source: "video.mp4" }],
          ...over("bg"),
        },
      ],
    };
    for (const t of [0.25, 3.25, 9.25]) {
      const d = renderAt(root, t).find((x) => src(x) === "video.mp4");
      expect(d, `clip active at ${t}`).toBeTruthy();
      expect(d!.drawTime).toBeCloseTo(0.25);
    }
    // Never past the inner window: at 0.999 the first cycle, at 1.0 the second.
    expect(renderAt(root, 0.999).find((x) => src(x) === "video.mp4")!.drawTime).toBeCloseTo(0.999);
    expect(renderAt(root, 1).find((x) => src(x) === "video.mp4")!.drawTime).toBeCloseTo(0);
  });

  it("the looping node's own keyframes run over the full span", () => {
    const root: Composition = {
      type: "composition",
      contentWidth: W,
      contentHeight: H,
      children: [{ id: "bg", type: "static", source: "bg.png", duration: 10 }],
      attachments: [
        {
          type: "clip",
          source: "b.mp4",
          in: 0,
          out: 2,
          underflow: "loop",
          opacity: [[0, 1], [10, 0]],
          ...over("bg"),
        },
      ],
    };
    const d = renderAt(root, 5).find((x) => src(x) === "b.mp4")!;
    expect(d.drawTime).toBeCloseTo(1); // 5 mod 2
    expect(d.opacity).toBeCloseTo(0.5); // 5 of 10, not 1 of 2
  });
});

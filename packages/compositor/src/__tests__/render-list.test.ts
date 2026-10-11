import { describe, it, expect } from "vitest";
import {
  resolveComposition,
  resolveSpatial,
  squareToQuad,
  applyHomography,
  type Composition,
} from "@seam/core";
import {
  buildRenderList,
  type RenderCommand,
  type DrawCommand,
  type GroupCommand,
} from "../RenderList.js";

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

function groups(commands: RenderCommand[]): GroupCommand[] {
  const out: GroupCommand[] = [];
  for (const c of commands) {
    if (c.type === "group") {
      out.push(c);
      out.push(...groups(c.children));
    }
  }
  return out;
}

function commandsAt(root: Composition, t: number): RenderCommand[] {
  const timeline = resolveSpatial(resolveComposition(root), W, H);
  return buildRenderList(timeline, t, W, H, () => ({ w: W, h: H }));
}

function renderAt(root: Composition, t: number): DrawCommand[] {
  return draws(commandsAt(root, t));
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
        { type: "composition", children: [(root.children ?? [])[0]] },
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

describe("buildRenderList — animatable contentWidth", () => {
  // A composition whose inner canvas (contentWidth) animates must be sampled
  // per-frame: the FBO resizes and children re-layout against the live inner
  // canvas. Root is 1000×1000; the inner comp's contentWidth animates 100%→50%
  // (1000→500) over its 4s body, opacity 0.5 forces the FBO path so we can read
  // the group's fboW.
  function root(): Composition {
    return {
      type: "composition",
      contentWidth: 1000,
      contentHeight: 1000,
      children: [
        {
          type: "composition",
          opacity: 0.5,
          contentWidth: [
            [0, "100%"],
            [4, "50%"],
          ],
          children: [
            // Fixed 200px box, centered in the inner canvas — its position
            // tracks the inner canvas center, so re-layout is observable.
            {
              type: "clip",
              source: "inner.mov",
              in: 0,
              out: 4,
              translation: "50%",
              size: 200,
            },
          ],
        },
      ],
    };
  }

  it("resizes the FBO as contentWidth animates", () => {
    const g0 = groups(commandsAt(root(), 0))[0];
    const g2 = groups(commandsAt(root(), 2))[0];
    const g4 = groups(commandsAt(root(), 3.99))[0];
    expect(g0.fboW).toBeCloseTo(1000, 0); // 100% of 1000
    expect(g2.fboW).toBeCloseTo(750, 0); // 75% (half-way 100→50)
    expect(g4.fboW).toBeLessThan(550); // approaching 50% (500)
  });

  it("re-lays-out a centered child against the live inner canvas", () => {
    // Child is a 200px box centered: quadX = innerW/2 - 100 in FBO coords.
    const c0 = draws(commandsAt(root(), 0)).find(
      (d) => (d.clip as { source: string }).source === "inner.mov",
    )!;
    const c2 = draws(commandsAt(root(), 2)).find(
      (d) => (d.clip as { source: string }).source === "inner.mov",
    )!;
    expect(c0.quadX).toBeCloseTo(1000 / 2 - 100, 0); // 400
    expect(c2.quadX).toBeCloseTo(750 / 2 - 100, 0); // 275
    // The box width itself stays fixed (200px) — only its placement reflows.
    expect(c0.quadW).toBeCloseTo(200, 0);
    expect(c2.quadW).toBeCloseTo(200, 0);
  });
});

describe("buildRenderList — distort (corner pin)", () => {
  const distorted = (distort: unknown, extra: Record<string, unknown> = {}): Composition => ({
    type: "composition",
    contentWidth: W,
    contentHeight: H,
    children: [
      {
        type: "composition",
        duration: 2,
        distort,
        ...extra,
        children: [{ type: "empty", duration: 2 }],
      } as never,
    ],
  });

  it("identity corners stay on the flattened path (no group, no corners)", () => {
    const cmds = commandsAt(distorted({}), 1);
    expect(groups(cmds)).toHaveLength(0);
  });

  it("forces the FBO path and maps corners into target pixels", () => {
    const cmds = commandsAt(distorted({ x1: "50%", y3: -100 }), 1);
    const g = groups(cmds);
    expect(g).toHaveLength(1);
    const corners = g[0].corners!;
    // The comp fills the canvas (1080×1920), so content px = target px.
    expect(corners[0]).toEqual({ x: 0, y: 0 });
    expect(corners[1].x).toBeCloseTo(540);
    expect(corners[1].y).toBeCloseTo(0);
    expect(corners[2].x).toBeCloseTo(1080);
    expect(corners[2].y).toBeCloseTo(1920);
    expect(corners[3].x).toBeCloseTo(0);
    expect(corners[3].y).toBeCloseTo(1820);
    // Layout box unchanged — distort never moves the dest rect.
    expect(g[0].destX).toBe(0);
    expect(g[0].destW).toBe(W);
    expect(g[0].destH).toBe(H);
  });

  it("widens the scissor to the pinned corners (content may spill the box)", () => {
    // Half-size comp centred; pull its top-right corner far outside its box.
    const cmds = commandsAt(
      distorted({ x1: "200%", y1: "-50%" }, { size: "50%" }),
      1,
    );
    const g = groups(cmds)[0];
    // Box is 540×960 at (270, 480). TR corner → (270 + 1080, 480 − 480).
    expect(g.corners![1].x).toBeCloseTo(1350);
    expect(g.corners![1].y).toBeCloseTo(0);
    expect(g.scissorX).toBeCloseTo(270);
    expect(g.scissorY).toBeCloseTo(0);
    // Clamped to the canvas on the right (1350 > 1080).
    expect(g.scissorX + g.scissorW).toBeCloseTo(W);
    expect(g.scissorY + g.scissorH).toBeCloseTo(480 + 960);
  });

  it("samples % against the inner canvas, scaled onto the display box", () => {
    // Inner canvas 200×100 fit into 1080×1920 → natural 1080×540 box.
    const cmds = commandsAt(
      distorted({ x1: "50%" }, { contentWidth: 200, contentHeight: 100 }),
      1,
    );
    const g = groups(cmds)[0];
    expect(g.destW).toBeCloseTo(1080);
    expect(g.destH).toBeCloseTo(540);
    expect(g.corners![1].x).toBeCloseTo(g.destX + 540);
    expect(g.corners![1].y).toBeCloseTo(g.destY);
  });

  it("with an inset, the visible window's corners go through the full-canvas warp", () => {
    // Left-half window; the canvas's TR corner pulled down 50%. The drawn quad
    // is the window's corners mapped through the FULL canvas's homography
    // (the window is a sub-rect of the warped canvas, not its own pin set),
    // then laid onto the window's output box the way the un-distorted crop is.
    const cmds = commandsAt(
      distorted({ y1: "50%" }, { inset: [0, "50%", 0, 0] }),
      1,
    );
    const g = groups(cmds)[0];
    expect(g.sourceRect).toEqual({ u0: 0, v0: 0, u1: 0.5, v1: 1 });
    // Window output box: x 0..540 (sourceRect u 0..0.5 fills it), y 0..1920.
    expect(g.destW).toBeCloseTo(540);
    const m = squareToQuad([
      { x: 0, y: 0 },
      { x: 1, y: 0.5 },
      { x: 1, y: 1 },
      { x: 0, y: 1 },
    ]);
    const q = applyHomography(m, 0.5, 0); // window's top-right
    const [tl, tr] = g.corners!;
    expect(tl).toEqual({ x: 0, y: 0 });
    expect(tr.x).toBeCloseTo((q.x / 0.5) * 540);
    expect(tr.y).toBeCloseTo(q.y * 1920);
    // This pin set is projective (opposite edges not parallel), so u=0.5 is
    // NOT the linear midpoint of the warped top edge.
    expect(tr.x).toBeGreaterThan(540);
  });

  it("animates: the corner set tweens in output time", () => {
    const doc = distorted([[0, {}], [2, { x1: "0%" }]]);
    const at0 = groups(commandsAt(doc, 0));
    expect(at0).toHaveLength(0); // identity at t=0 → flattened
    const at1 = groups(commandsAt(doc, 1))[0];
    expect(at1.corners![1].x).toBeCloseTo(540);
  });
});

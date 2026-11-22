import { describe, it, expect } from "vitest";
import {
  createSeam,
  resolveSpatial,
  type Composition,
} from "@seam/core";
import {
  buildRenderList,
  type RenderCommand,
  type DrawCommand,
  type FillCommand,
  type GroupCommand,
} from "../RenderList.js";
import { map as mapExtension } from "@seam/extension-map";

const seam = createSeam([mapExtension]);
const { resolveComposition } = seam;

const W = 1000;
const H = 500;

function commandsAt(root: Composition, t: number, cw = W, ch = H): RenderCommand[] {
  const timeline = resolveSpatial(resolveComposition(root), cw, ch);
  return buildRenderList(seam, timeline, t, cw, ch, () => ({ w: 100, h: 100 }));
}

function fills(cmds: RenderCommand[]): FillCommand[] {
  const out: FillCommand[] = [];
  for (const c of cmds) {
    if (c.type === "fill") out.push(c);
    else if (c.type === "group") out.push(...fills(c.children));
  }
  return out;
}
function draws(cmds: RenderCommand[]): DrawCommand[] {
  const out: DrawCommand[] = [];
  for (const c of cmds) {
    if (c.type === "draw") out.push(c);
    else if (c.type === "group") out.push(...draws(c.children));
  }
  return out;
}

describe("buildRenderList — rect / circle", () => {
  const root: Composition = {
    type: "composition",
    contentWidth: W,
    contentHeight: H,
    children: [
      {
        type: "rect",
        duration: 2,
        fill: [[0, "#ff0000"], [2, "#0000ff"]],
        stroke: "black",
        strokeWidth: 6,
        cornerRadius: "50%",
        size: { x: 200, y: 50 },
        origin: "0%",
        translation: { x: "0% + 10", y: "0% + 20" },
      },
    ],
  };

  it("emits a fill (inset by the stroke) and a stroke ring with stable keys", () => {
    const a = fills(commandsAt(root, 0));
    expect(a).toHaveLength(2);
    const [fill, stroke] = a;
    expect(fill.color).toBe("#ff0000");
    expect(fill.destX).toBe(10);
    expect(fill.destY).toBe(20);
    expect(fill.destW).toBe(200);
    expect(fill.destH).toBe(50);
    // 50% of the shorter side (50px) → 25px radius.
    expect(fill.shape).toEqual({ kind: "roundrect", radius: 25, outerInset: 6, innerInset: -1 });
    expect(stroke.color).toBe("black");
    expect(stroke.shape).toEqual({ kind: "roundrect", radius: 25, outerInset: 0, innerInset: 6 });

    // Keys are per RESOLVED node: stable across frames of one timeline.
    const timeline = resolveSpatial(resolveComposition(root), W, H);
    const list = (t: number) =>
      fills(buildRenderList(seam, timeline, t, W, H, () => null));
    const a0 = list(0);
    const b = list(1);
    expect(b[0].key).toBe(a0[0].key);
    expect(b[1].key).toBe(a0[1].key);
    expect(b[0].key).not.toBe(b[1].key);
    // Colour tweens: rgb(128,0,128)-ish purple at the midpoint.
    expect(b[0].color).toMatch(/^rgb\(/);
    expect(b[0].color).not.toBe(a[0].color);
  });

  it("a circle is an ellipse fill; fill: none skips the fill draw", () => {
    const circle: Composition = {
      type: "composition",
      contentWidth: W,
      contentHeight: H,
      children: [
        { type: "circle", duration: 1, fill: "none", stroke: "white", strokeWidth: 3, size: 120 },
      ],
    };
    const f = fills(commandsAt(circle, 0.5));
    expect(f).toHaveLength(1);
    expect(f[0].shape?.kind).toBe("ellipse");
    expect(f[0].shape?.innerInset).toBe(3);
    // Centered 120×120 in a 1000×500 canvas.
    expect(f[0].destX).toBe(440);
    expect(f[0].destY).toBe(190);
  });

  it("defaults the fill to black and scales strokes/radii by the viewport", () => {
    const doc: Composition = {
      type: "composition",
      contentWidth: W,
      contentHeight: H,
      children: [
        { type: "rect", duration: 1, size: 100, cornerRadius: 10, strokeWidth: 4, stroke: "red" },
      ],
    };
    // Render the 1000×500 canvas at half size → 0.5 scale.
    const f = fills(commandsAt(doc, 0, 500, 250));
    expect(f[0].color).toBe("black");
    expect(f[0].shape?.radius).toBe(5);
    expect(f[0].shape?.outerInset).toBe(2);
    expect(f[0].destW).toBe(50);
  });

  it("rotates a shape about its origin", () => {
    const doc: Composition = {
      type: "composition",
      contentWidth: W,
      contentHeight: H,
      children: [
        { type: "rect", duration: 1, size: 100, rotation: 90, origin: "0%", translation: "0% + 100" },
      ],
    };
    const f = fills(commandsAt(doc, 0));
    expect(f[0].rotation).toBeCloseTo(Math.PI / 2, 9);
    expect(f[0].pivotX).toBe(100);
    expect(f[0].pivotY).toBe(100);
    // Scissor widens to the rotated AABB: the quad swings to x ∈ [0, 100].
    expect(f[0].scissorX).toBeCloseTo(0, 6);
    expect(f[0].scissorW).toBeCloseTo(100, 6);
  });
});

describe("buildRenderList — cornerRadius mask", () => {
  it("masks a textured leaf and forces a composition through an FBO", () => {
    const doc: Composition = {
      type: "composition",
      contentWidth: W,
      contentHeight: H,
      children: [
        { type: "static", source: "a.png", duration: 1, size: 100, cornerRadius: 20 },
        {
          type: "composition",
          duration: 1,
          cornerRadius: "50%",
          children: [{ type: "static", source: "b.png", duration: 1 }],
        },
      ],
    };
    const t0 = commandsAt(doc, 0.5);
    const leaf = draws(t0)[0];
    expect(leaf.mask).toEqual({ kind: "roundrect", radius: 20, outerInset: 0, innerInset: -1 });

    const t1 = commandsAt(doc, 1.5);
    const group = t1.find((c) => c.type === "group") as GroupCommand;
    expect(group).toBeTruthy();
    // 50% of the shorter side of the full-canvas comp (500) → 250.
    expect(group.mask?.radius).toBe(250);
    expect(draws(t1)[0].mask).toBeUndefined();
  });
});

describe("buildRenderList — map", () => {
  // Camera exactly at the origin of the mercator world, zoom chosen so the
  // projection is easy to reason about: at zoom 0 the world is 512px wide.
  const map: Composition["children"] extends (infer C)[] | undefined ? C : never = {
    type: "map",
    source: "area.pmtiles",
    duration: 4,
    latitude: 0,
    longitude: 0,
    zoom: [[0, 0], [4, 1]],
    paths: [
      { id: "r", color: "red", points: [[0, 0], [90, 0]], progress: [[0, 0], [4, 1]] },
    ],
    children: [
      { type: "rect", id: "geo", duration: 4, fill: "red", size: 10, pin: { latitude: 0, longitude: 90 } },
      { type: "rect", start: 0, duration: 4, fill: "blue", size: 10, pin: { path: "r" } },
      { type: "rect", start: 0, duration: 4, fill: "green", size: 10, pin: { path: "r", position: 0.5 }, translation: { x: 7, y: -3 } },
      { type: "rect", start: 0, duration: 4, fill: "white", size: 10 },
    ],
  } as never;

  const root: Composition = {
    type: "composition",
    contentWidth: 512,
    contentHeight: 512,
    children: [map],
  };

  it("draws the basemap at the inner canvas with map-local drawTime, then the attachments", () => {
    const cmds = commandsAt(root, 1, 512, 512);
    const base = draws(cmds)[0];
    expect((base.clip as { type: string }).type).toBe("map");
    expect(base.drawTime).toBe(1);
    expect(base.contentW).toBe(512);
    expect(base.contentH).toBe(512);
    expect(base.fields).toEqual({});
    expect(cmds.indexOf(base)).toBeLessThan(cmds.findIndex((c) => c.type === "fill"));
  });

  it("places pinned attachments at the projected pin and offsets by translation", () => {
    // t=0: zoom 0 → world 512px wide, centre (256,256). lng 90 → x = 384.
    const f = fills(commandsAt(root, 0, 512, 512));
    const geo = f.find((c) => c.color === "red")!;
    expect(geo.destX + geo.destW / 2).toBeCloseTo(384, 6);
    expect(geo.destY + geo.destH / 2).toBeCloseTo(256, 6);

    // Path pin with no position rides the path's progress (0 at t=0 → start).
    const head = f.find((c) => c.color === "blue")!;
    expect(head.destX + head.destW / 2).toBeCloseTo(256, 6);

    // Halfway along the path (lng 45 → x 320), then +7/-3 px.
    const mid = f.find((c) => c.color === "green")!;
    expect(mid.destX + mid.destW / 2).toBeCloseTo(320 + 7, 6);
    expect(mid.destY + mid.destH / 2).toBeCloseTo(256 - 3, 6);

    // Unpinned attachments lay out against the map canvas as usual (centred).
    const plain = f.find((c) => c.color === "white")!;
    expect(plain.destX + plain.destW / 2).toBeCloseTo(256, 6);
  });

  it("samples the camera in map-local time (zoom tween moves the pin)", () => {
    // t=4 → zoom 1: world 1024px, lng 90 → x = 512 - 256 (centre offset) = 512.
    // Mid-way the zoom tweens in scale space, so just assert monotonic drift.
    const x = (t: number) => {
      const f = fills(commandsAt(root, t, 512, 512));
      const geo = f.find((c) => c.color === "red")!;
      return geo.destX + geo.destW / 2;
    };
    expect(x(0)).toBeCloseTo(384, 6);
    expect(x(3.999)).toBeCloseTo(512, 0);
    expect(x(2)).toBeGreaterThan(384);
    expect(x(2)).toBeLessThan(512);
  });

  it("a map cut by a composition window keeps its camera: it does not restart", () => {
    // The same map inside a composition whose window starts 2 s in. One second
    // into that composition is second 3 of the map — the basemap draw carries
    // that time, and the geo pin sits where it does at t=3 uncut.
    const windowed: Composition = {
      type: "composition",
      contentWidth: 512,
      contentHeight: 512,
      children: [{ type: "composition", in: 2, children: [map] } as never],
    };
    const geoX = (doc: Composition, t: number) => {
      const geo = fills(commandsAt(doc, t, 512, 512)).find((c) => c.color === "red")!;
      return geo.destX + geo.destW / 2;
    };
    const base = draws(commandsAt(windowed, 1, 512, 512))[0];
    expect((base.clip as { type: string }).type).toBe("map");
    expect(base.drawTime).toBe(3);
    expect(geoX(windowed, 1)).toBeCloseTo(geoX(root, 3), 6);
    expect(geoX(windowed, 0)).toBeCloseTo(geoX(root, 2), 6);
    // The path pin riding the reveal head (progress) follows the same clock.
    const head = (doc: Composition, t: number) => {
      const blue = fills(commandsAt(doc, t, 512, 512)).find((c) => c.color === "blue")!;
      return blue.destX + blue.destW / 2;
    };
    expect(head(windowed, 1)).toBeCloseTo(head(root, 3), 6);
  });

  it("a map with opacity < 1 or a cornerRadius composites through an FBO", () => {
    const doc: Composition = {
      type: "composition",
      contentWidth: 512,
      contentHeight: 512,
      children: [{ ...(map as object), opacity: 0.5 } as never],
    };
    const cmds = commandsAt(doc, 1, 512, 512);
    const group = cmds.find((c) => c.type === "group") as GroupCommand;
    expect(group).toBeTruthy();
    expect(group.opacity).toBe(0.5);
    expect(group.children[0].type).toBe("draw");
    expect(fills(group.children)).toHaveLength(4);
  });
});

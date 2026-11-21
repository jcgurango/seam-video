import { describe, expect, it } from "vitest";
import { resolveComposition, type Child, type SeamFile } from "@seam/core";
import {
  applyTransformDrag,
  nudgeLength,
  transformCapabilities,
  type TransformGeometry,
} from "../transformEdit.js";
import { apply, invert, locateNode, mul, type LocatedNode } from "../viewportLocate.js";

const noMedia = () => null;
const locate = (doc: SeamFile, indices: number[], t = 0, media = noMedia as never) =>
  locateNode(doc, resolveComposition(doc, { uncropped: true }), indices, t, media);

const rect = (extra: Record<string, unknown> = {}): Child =>
  ({ type: "rect", duration: 5, start: 0, size: { x: 200, y: 100 }, ...extra }) as Child;
const docOf = (...children: Child[]): SeamFile =>
  ({ type: "composition", contentWidth: 1000, contentHeight: 500, children }) as SeamFile;

/** Apply a drag and re-locate, so assertions are about where things land. */
function dragged(node: Child, drag: Parameters<typeof applyTransformDrag>[2]) {
  const before = locate(docOf(node), [0])!;
  const next = applyTransformDrag(node, before, drag);
  return { next, before, after: locate(docOf(next), [0])! };
}

describe("nudgeLength", () => {
  it("moves the percentage first", () => {
    expect(nudgeLength("40%", 100, 1000, 50)).toBe("50%");
    // Absent → the property's default percentage.
    expect(nudgeLength(undefined, 100, 1000, 50)).toBe("60%");
    expect(nudgeLength(undefined, -100, 1000, 100)).toBe("90%");
  });
  it("moves the pixel number when one is authored", () => {
    expect(nudgeLength(10, 5, 1000, 50)).toBe(15);
    expect(nudgeLength("50% + 10", 5, 1000, 50)).toBe("50% + 15");
    expect(nudgeLength("50% + 10", -30, 1000, 50)).toBe("50% - 20");
  });
  it("falls back to pixels when there is nothing to take a percentage of", () => {
    expect(nudgeLength(undefined, 12, 0, 50)).toBe("50% + 12");
  });
  it("leaves the value alone for a zero delta", () => {
    expect(nudgeLength("40%", 0, 1000, 50)).toBe("40%");
    expect(nudgeLength(undefined, 0, 1000, 50)).toBeUndefined();
  });
});

describe("locateNode", () => {
  it("places a root node's box and origin", () => {
    const l = locate(docOf(rect({ translation: { x: "0%", y: "0%" } })), [0])!;
    expect(l.box).toEqual({ x: -100, y: -50, width: 200, height: 100 });
    expect(l.pivot).toEqual({ x: 0, y: 0 });
    expect(l.rotation).toBe(0);
  });

  it("is null when the node isn't under the playhead", () => {
    expect(locate(docOf(rect()), [0], 7)).toBeNull();
  });

  it("uses the probed media size for a clip's natural rect", () => {
    const doc = docOf({ type: "clip", source: "v.mp4", in: 0, out: 5 } as Child);
    const l = locate(doc, [0], 0, (() => ({ w: 400, h: 400 })) as never)!;
    // 400×400 fit into 1000×500 → 500×500, centred.
    expect(l.box).toEqual({ x: 250, y: 0, width: 500, height: 500 });
  });

  it("maps a nested node through its composition's box, speed and window", () => {
    const comp = {
      type: "composition",
      start: 0,
      in: 2,
      speed: 2,
      contentWidth: 100,
      contentHeight: 100,
      size: { x: 200, y: 200 },
      translation: { x: "0% + 300", y: "0% + 200" },
      children: [
        { type: "rect", duration: 3, start: 0, size: 10 },
        { type: "rect", duration: 3, start: 3, size: 20, translation: { x: "0%", y: "0%" } },
      ],
    } as unknown as Child;
    const doc = docOf(comp);
    // Global 1s → inner 2 + 1·2 = 4s: the second rect.
    expect(locate(doc, [0, 0], 1)).toBeNull();
    const l = locate(doc, [0, 1], 1)!;
    expect(l.parentW).toBe(100);
    // Inner (0,0) is the comp's top-left: (300,200) − 100; inner px are 2×.
    expect(apply(l.parentToCanvas, { x: 0, y: 0 })).toEqual({ x: 200, y: 100 });
    expect(apply(l.parentToCanvas, { x: 100, y: 100 })).toEqual({ x: 400, y: 300 });
  });

  it("carries an ancestor's rotation and distort into the child mapping", () => {
    const comp = (extra: Record<string, unknown>) =>
      docOf({
        type: "composition",
        start: 0,
        contentWidth: 100,
        contentHeight: 100,
        size: 100,
        children: [{ type: "rect", duration: 3, size: 10 }],
        ...extra,
      } as unknown as Child);
    // 90° clockwise about the centre (500,250): inner top-left → top-right.
    const rot = locate(comp({ rotation: 90 }), [0, 0])!;
    const p = apply(rot.parentToCanvas, { x: 0, y: 0 });
    expect(p.x).toBeCloseTo(550);
    expect(p.y).toBeCloseTo(200);
    // Pin the top-right corner 40px right: that corner follows the pin.
    const dist = locate(comp({ distort: { x1: 40 } }), [0, 0])!;
    const q = apply(dist.parentToCanvas, { x: 100, y: 0 });
    expect(q.x).toBeCloseTo(590);
    expect(q.y).toBeCloseTo(200);
    const self = locate(comp({ distort: { x1: 40 } }), [0])!;
    expect(self.inner!.distorted).toBe(true);
    // Undistorted map: where an authored pin position shows.
    const pin = apply(mul(self.parentToCanvas, self.inner!.toParent), {
      x: self.inner!.corners.x1,
      y: self.inner!.corners.y1,
    });
    expect(pin.x).toBeCloseTo(590);
    expect(invert(self.inner!.toParent)).not.toBeNull();
  });
});

describe("applyTransformDrag — move", () => {
  it("moves an absent translation's percentage", () => {
    const { next, before, after } = dragged(rect(), { kind: "move", dx: 30, dy: -10 });
    expect((next as { translation: unknown }).translation).toEqual({ x: "53%", y: "48%" });
    expect(Object.keys((next as { translation: object }).translation)).toEqual(["x", "y"]);
    expect(after.box.x).toBeCloseTo(before.box.x + 30);
    expect(after.box.y).toBeCloseTo(before.box.y - 10);
  });
  it("moves a percentage, or the pixel number where one is authored", () => {
    const { next } = dragged(rect({ translation: { x: "10%", y: "50% + 4" } }), {
      kind: "move",
      dx: 100,
      dy: 5,
    });
    expect((next as { translation: unknown }).translation).toEqual({ x: "20%", y: "50% + 9" });
  });
  it("leaves a keyframed translation alone", () => {
    const node = rect({ translation: [[0, 0], [1, 10]] });
    expect(transformCapabilities(node).move).toBe(false);
    expect(applyTransformDrag(node, locate(docOf(node), [0])!, { kind: "move", dx: 5, dy: 5 })).toBe(node);
  });
});

describe("applyTransformDrag — scale", () => {
  it("scales about a centred origin: the handle follows the pointer", () => {
    // Right-middle handle dragged 30px right → +60 width (both sides grow).
    const { next, after } = dragged(rect(), {
      kind: "scale", hx: 1, hy: 0.5, dx: 30, dy: 99, uniform: false,
    });
    expect((next as { size: unknown }).size).toEqual({ x: 260, y: 100 });
    expect(after.box.x + after.box.width).toBeCloseTo(600 + 30);
  });
  it("corner handles change both axes independently; Shift keeps the aspect", () => {
    const free = dragged(rect(), { kind: "scale", hx: 1, hy: 1, dx: 50, dy: 10, uniform: false });
    expect((free.next as { size: unknown }).size).toEqual({ x: 300, y: 120 });
    const uni = dragged(rect(), { kind: "scale", hx: 1, hy: 1, dx: 50, dy: 10, uniform: true });
    expect((uni.next as { size: unknown }).size).toEqual({ x: 300, y: 150 });
    const mid = dragged(rect(), { kind: "scale", hx: 1, hy: 0.5, dx: 50, dy: 0, uniform: true });
    expect((mid.next as { size: unknown }).size).toEqual({ x: 300, y: 150 });
  });
  it("respects an off-centre origin and rotation", () => {
    // Origin at the left edge: the right handle moves 1:1 with the width.
    const left = dragged(rect({ origin: { x: "0%", y: "50%" } }), {
      kind: "scale", hx: 1, hy: 0.5, dx: 30, dy: 0, uniform: false,
    });
    expect((left.next as { size: unknown }).size).toEqual({ x: 230, y: 100 });
    // Rotated 90°: the box's x axis points down the screen.
    const rot = dragged(rect({ rotation: 90 }), {
      kind: "scale", hx: 1, hy: 0.5, dx: 0, dy: 20, uniform: false,
    });
    expect((rot.next as { size: unknown }).size).toEqual({ x: 240, y: 100 });
  });
  it("percent-only and absent sizes scale their percentage", () => {
    const pct = dragged(rect({ size: "50%" }), {
      kind: "scale", hx: 1, hy: 0.5, dx: 50, dy: 0, uniform: false,
    });
    // 50% of 1000 = 500 wide; +100 → 60%.
    expect((pct.next as { size: unknown }).size).toEqual({ x: "60%", y: "50%" });
    const absent = dragged(rect({ size: undefined }), {
      kind: "scale", hx: 1, hy: 0.5, dx: -50, dy: 0, uniform: false,
    });
    expect((absent.next as { size: unknown }).size).toEqual({ x: "90%", y: "100%" });
    expect(absent.after.box.height).toBe(500);
  });
});

describe("applyTransformDrag — origin & rotate", () => {
  it("moving the origin keeps the box where it is", () => {
    for (const rotation of [0, 30]) {
      const { before, after, next } = dragged(rect({ rotation }), { kind: "origin", dx: 40, dy: 25 });
      expect(after.pivot.x).toBeCloseTo(before.pivot.x + 40);
      expect(after.pivot.y).toBeCloseTo(before.pivot.y + 25);
      const corner = (l: LocatedNode) => {
        const r = (l.rotation * Math.PI) / 180;
        const vx = l.box.x - l.pivot.x;
        const vy = l.box.y - l.pivot.y;
        return {
          x: l.pivot.x + vx * Math.cos(r) - vy * Math.sin(r),
          y: l.pivot.y + vx * Math.sin(r) + vy * Math.cos(r),
        };
      };
      expect(corner(after).x).toBeCloseTo(corner(before).x, 0);
      expect(corner(after).y).toBeCloseTo(corner(before).y, 0);
      expect((next as { translation: unknown }).translation).toEqual({ x: "54%", y: "55%" });
    }
  });
  it("origin defaults to the percentage; only an authored pixel number moves", () => {
    const origin = (extra: Record<string, unknown>) =>
      (dragged(rect(extra), { kind: "origin", dx: 40, dy: 25 }).next as { origin: unknown }).origin;
    // 200×100 box: +40 → +20%, +25 → +25%.
    expect(origin({})).toEqual({ x: "70%", y: "75%" });
    expect(origin({ origin: "10%" })).toEqual({ x: "30%", y: "35%" });
    expect(origin({ origin: { x: 5, y: "0% + 5" } })).toEqual({ x: 45, y: "0% + 30" });
  });
  it("a snapped axis is the exact percentage; the other axis stays free", () => {
    for (const rotation of [0, 30]) {
      // x snaps to the right edge (dropping the authored px), y moves freely.
      const { next, before, after } = dragged(rect({ rotation, origin: { x: 12, y: "20%" } }), {
        kind: "origin", dx: 3, dy: 10, snapX: 1,
      });
      const o = (next as { origin: { x: unknown; y: string } }).origin;
      expect(o.x).toBe("100%");
      expect(o.y).toMatch(/%$/);
      expect(after.pivot.x - after.box.x).toBeCloseTo(200);
      // The box (tracked by its centre) stays put.
      const centre = (l: LocatedNode) => {
        const r = (l.rotation * Math.PI) / 180;
        const vx = l.box.x + l.box.width / 2 - l.pivot.x;
        const vy = l.box.y + l.box.height / 2 - l.pivot.y;
        return {
          x: l.pivot.x + vx * Math.cos(r) - vy * Math.sin(r),
          y: l.pivot.y + vx * Math.sin(r) + vy * Math.cos(r),
        };
      };
      expect(centre(after).x).toBeCloseTo(centre(before).x, 0);
      expect(centre(after).y).toBeCloseTo(centre(before).y, 0);
    }
    const both = dragged(rect(), { kind: "origin", dx: 0, dy: 0, snapX: 0.5, snapY: 0 });
    expect((both.next as { origin: unknown }).origin).toEqual({ x: "50%", y: "0%" });
  });
  it("rotates by the delta, snapping the delta to 15° with Shift", () => {
    const node = rect({ rotation: 7 });
    const g = locate(docOf(node), [0])!;
    expect((applyTransformDrag(node, g, { kind: "rotate", deltaDeg: 22.34, snap: false }) as { rotation: number }).rotation).toBe(29.3);
    expect((applyTransformDrag(node, g, { kind: "rotate", deltaDeg: 22.34, snap: true }) as { rotation: number }).rotation).toBe(22);
  });
});

describe("applyTransformDrag — distort", () => {
  const comp = (extra: Record<string, unknown> = {}): Child =>
    ({
      type: "composition", start: 0, contentWidth: 100, contentHeight: 100,
      children: [{ type: "rect", duration: 3 }], ...extra,
    }) as unknown as Child;
  const geom: TransformGeometry = {
    parentW: 1000, parentH: 500, naturalW: 500, naturalH: 500,
    box: { x: 250, y: 0, width: 500, height: 500 }, pivot: { x: 500, y: 250 }, rotation: 0, inner: { width: 100, height: 100 },
  };
  it("moves an absent corner's percentage and keeps the other corners", () => {
    const next = applyTransformDrag(comp({ distort: { x0: 5 } }), geom, {
      kind: "distort", corner: 2, dx: -10, dy: 4,
    });
    expect((next as { distort: unknown }).distort).toEqual({ x0: 5, x2: "90%", y2: "104%" });
    // An authored pixel offset takes the delta itself.
    const px = applyTransformDrag(comp({ distort: { x0: 5 } }), geom, {
      kind: "distort", corner: 0, dx: 3, dy: 0,
    });
    expect((px as { distort: unknown }).distort).toEqual({ x0: 8 });
  });
  it("moves a percent-only corner's percentage", () => {
    const next = applyTransformDrag(comp({ distort: { x1: "100%" } }), geom, {
      kind: "distort", corner: 1, dx: -10, dy: 0,
    });
    expect((next as { distort: unknown }).distort).toEqual({ x1: "90%" });
  });
  it("is composition-only", () => {
    const node = rect();
    expect(applyTransformDrag(node, geom, { kind: "distort", corner: 0, dx: 1, dy: 1 })).toBe(node);
  });
});

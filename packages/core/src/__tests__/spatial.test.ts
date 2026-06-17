import { describe, it, expect } from "vitest";
import { resolveSpatial, resolveBoxProps } from "../layout/resolve-spatial.js";
import type {
  ResolvedTimeline,
  ResolvedClip,
  ResolvedComposition,
} from "../resolved-types.js";

function makeClip(overrides: Partial<ResolvedClip> = {}): ResolvedClip {
  return {
    type: "clip",
    source: "test.mp4",
    sourceIn: 0,
    sourceOut: 5,
    timelineStart: 0,
    timelineEnd: 5,
    speed: 1,
    ...overrides,
  };
}

describe("resolveSpatial — no spatialInput", () => {
  it("sets canvas dimensions and inherits root objectFit", () => {
    const timeline: ResolvedTimeline = { duration: 5, children: [makeClip()] };
    const result = resolveSpatial(timeline, 1920, 1080);
    expect(result.width).toBe(1920);
    expect(result.height).toBe(1080);
    const clip = result.children[0] as ResolvedClip;
    expect(clip.spatial).toBeUndefined();
    // Default objectFit "fit" flows from root onto children.
    expect(clip.objectFit).toBe("fit");
  });

  it("respects an explicit root objectFit", () => {
    const timeline: ResolvedTimeline = {
      duration: 5,
      objectFit: "cover",
      children: [makeClip()],
    };
    const result = resolveSpatial(timeline, 1920, 1080);
    const clip = result.children[0] as ResolvedClip;
    expect(clip.objectFit).toBe("cover");
  });
});

describe("resolveSpatial — defaults (origin/translation/size)", () => {
  it("size defaults to 100% of parent — covers the parent rect", () => {
    const timeline: ResolvedTimeline = {
      duration: 5,
      children: [makeClip({ spatialInput: { translation: 0 } })],
    };
    const result = resolveSpatial(timeline, 1920, 1080);
    const clip = result.children[0] as ResolvedClip;
    // size:"100%" with no intrinsic media → natural = parent dims, so
    // width/height = 1920×1080 and the box is centered (translation=0
    // means parent center; origin defaults to center of self).
    expect(clip.spatial).toEqual({ x: 0, y: 0, width: 1920, height: 1080 });
  });

  it("translation=0 means parent center; origin defaults to item center", () => {
    const timeline: ResolvedTimeline = {
      duration: 5,
      children: [
        makeClip({ spatialInput: { translation: 0, size: 200 } }),
      ],
    };
    const result = resolveSpatial(timeline, 1000, 1000);
    const clip = result.children[0] as ResolvedClip;
    // 200×200 box, origin = center of self (100,100), translation = parent
    // center (500,500). Top-left = (500 - 100, 500 - 100) = (400, 400).
    expect(clip.spatial).toEqual({ x: 400, y: 400, width: 200, height: 200 });
  });
});

describe("resolveSpatial — size", () => {
  it("number-only is a literal pixel box", () => {
    const timeline: ResolvedTimeline = {
      duration: 5,
      children: [
        makeClip({ spatialInput: { size: 150, translation: 0 } }),
      ],
    };
    const result = resolveSpatial(timeline, 1000, 1000);
    const clip = result.children[0] as ResolvedClip;
    expect(clip.spatial!.width).toBe(150);
    expect(clip.spatial!.height).toBe(150);
  });

  it("'50%' is half the post-objectFit natural size", () => {
    const timeline: ResolvedTimeline = {
      duration: 5,
      children: [
        makeClip({ spatialInput: { size: "50%", translation: 0 } }),
      ],
    };
    const result = resolveSpatial(timeline, 1000, 1000);
    const clip = result.children[0] as ResolvedClip;
    // No intrinsic media → natural = parent (1000×1000) → 50% = 500.
    expect(clip.spatial!.width).toBe(500);
    expect(clip.spatial!.height).toBe(500);
  });

  it("'100% - 100' subtracts pixels from the natural size", () => {
    const timeline: ResolvedTimeline = {
      duration: 5,
      children: [
        makeClip({ spatialInput: { size: "100% - 100", translation: 0 } }),
      ],
    };
    const result = resolveSpatial(timeline, 1000, 1000);
    const clip = result.children[0] as ResolvedClip;
    expect(clip.spatial!.width).toBe(900);
    expect(clip.spatial!.height).toBe(900);
  });

  it("per-axis size object scales each axis independently", () => {
    const timeline: ResolvedTimeline = {
      duration: 5,
      children: [
        makeClip({
          spatialInput: { size: { x: "50%", y: 100 }, translation: 0 },
        }),
      ],
    };
    const result = resolveSpatial(timeline, 1000, 1000);
    const clip = result.children[0] as ResolvedClip;
    expect(clip.spatial!.width).toBe(500);
    expect(clip.spatial!.height).toBe(100); // literal pixels (size default percent = 0)
  });
});

describe("resolveSpatial — translation", () => {
  it("number-only positions the item's center at parent center + pixels", () => {
    const timeline: ResolvedTimeline = {
      duration: 5,
      children: [
        makeClip({
          spatialInput: { size: 100, translation: { x: 50, y: -25 } },
        }),
      ],
    };
    const result = resolveSpatial(timeline, 1000, 1000);
    const clip = result.children[0] as ResolvedClip;
    // Parent center (500,500) + (50, -25) = (550, 475). Top-left = that minus origin (50,50).
    expect(clip.spatial).toEqual({ x: 500, y: 425, width: 100, height: 100 });
  });

  it("'0%' overrides the center default — places item's origin at parent top-left", () => {
    const timeline: ResolvedTimeline = {
      duration: 5,
      children: [
        makeClip({
          spatialInput: { size: 100, translation: "0%", origin: "0%" },
        }),
      ],
    };
    const result = resolveSpatial(timeline, 1000, 1000);
    const clip = result.children[0] as ResolvedClip;
    // origin "0%" = (0,0) on item; translation "0%" = (0,0) on parent.
    expect(clip.spatial).toEqual({ x: 0, y: 0, width: 100, height: 100 });
  });

  it("'100% - 10' pins the origin near the parent's bottom-right", () => {
    const timeline: ResolvedTimeline = {
      duration: 5,
      children: [
        makeClip({
          spatialInput: {
            size: 100,
            translation: "100% - 10",
            origin: "100%",
          },
        }),
      ],
    };
    const result = resolveSpatial(timeline, 1000, 1000);
    const clip = result.children[0] as ResolvedClip;
    // translation = (1000-10, 1000-10) = (990, 990).
    // origin = (100, 100) on a 100×100 item. Top-left = (890, 890).
    expect(clip.spatial).toEqual({ x: 890, y: 890, width: 100, height: 100 });
  });
});

describe("resolveSpatial — origin", () => {
  it("'0%' puts the item's top-left at the translation point", () => {
    const timeline: ResolvedTimeline = {
      duration: 5,
      children: [
        makeClip({
          spatialInput: { size: 200, translation: { x: 100, y: 100 }, origin: "0%" },
        }),
      ],
    };
    const result = resolveSpatial(timeline, 1000, 1000);
    const clip = result.children[0] as ResolvedClip;
    // translation default percent = 50% → center (500,500) + (100,100) = (600,600).
    // origin "0%" = (0,0) on item. Top-left = (600,600).
    expect(clip.spatial).toEqual({ x: 600, y: 600, width: 200, height: 200 });
  });

  it("'100% - 20' pulls the anchor in 20px from bottom-right of self", () => {
    const timeline: ResolvedTimeline = {
      duration: 5,
      children: [
        makeClip({
          spatialInput: { size: 100, translation: 0, origin: "100% - 20" },
        }),
      ],
    };
    const result = resolveSpatial(timeline, 1000, 1000);
    const clip = result.children[0] as ResolvedClip;
    // origin = (100-20, 100-20) = (80, 80). translation = (500,500).
    // Top-left = (500 - 80, 500 - 80) = (420, 420).
    expect(clip.spatial).toEqual({ x: 420, y: 420, width: 100, height: 100 });
  });
});

describe("resolveSpatial — composition / contentWidth", () => {
  it("composition contentWidth defines child coord space", () => {
    const inner = makeClip({
      spatialInput: { size: "100%", translation: 0 },
    });
    const timeline: ResolvedTimeline = {
      duration: 5,
      children: [
        {
          type: "composition",
          timelineStart: 0,
          timelineEnd: 5,
          duration: 5,
          speed: 1,
          contentWidth: 800,
          contentHeight: 600,
          children: [inner],
          spatialInput: { size: 800, translation: 0 },
        } as ResolvedComposition,
      ],
    };
    const result = resolveSpatial(timeline, 1920, 1080);
    const comp = result.children[0] as ResolvedComposition;
    const clip = comp.children[0] as ResolvedClip;
    // Inside the comp, parent dims = (800, 600). size "100%" → 800×600.
    expect(clip.spatial).toEqual({ x: 0, y: 0, width: 800, height: 600 });
  });

  it("composition contentWidth as percentage resolves against parent", () => {
    const timeline: ResolvedTimeline = {
      duration: 5,
      children: [
        {
          type: "composition",
          timelineStart: 0,
          timelineEnd: 5,
          duration: 5,
          speed: 1,
          contentWidth: "50%",
          contentHeight: "25%",
          children: [],
        } as ResolvedComposition,
      ],
    };
    const result = resolveSpatial(timeline, 1920, 1080);
    const comp = result.children[0] as ResolvedComposition;
    expect(comp.contentWidth).toBe(960); // 50% of 1920
    expect(comp.contentHeight).toBe(270); // 25% of 1080
  });

  it("root composition contentWidth cannot be a percentage", () => {
    const timeline: ResolvedTimeline = {
      duration: 5,
      contentWidth: "50%",
      children: [],
    };
    expect(() => resolveSpatial(timeline, 1920, 1080)).toThrow(
      /contentWidth.*cannot use a percentage/,
    );
  });
});

describe("resolveSpatial — rotation", () => {
  it("bakes a static rotation onto spatial with the origin pivot", () => {
    const timeline: ResolvedTimeline = {
      duration: 5,
      children: [
        {
          type: "composition",
          timelineStart: 0,
          timelineEnd: 5,
          duration: 5,
          speed: 1,
          children: [],
          spatialInput: { size: 200, translation: 0, rotation: 30 },
        } as ResolvedComposition,
      ],
    };
    const result = resolveSpatial(timeline, 1000, 1000);
    const comp = result.children[0] as ResolvedComposition;
    // 200×200 box centered at (500,500); origin defaults to item center
    // (100,100), which is also the rotation pivot.
    expect(comp.spatial).toEqual({
      x: 400,
      y: 400,
      width: 200,
      height: 200,
      rotation: 30,
      originX: 100,
      originY: 100,
    });
    // Static rotation → spatialInput stripped (rect carries everything).
    expect(comp.spatialInput).toBeUndefined();
  });

  it("origin pivot follows a non-center origin", () => {
    const timeline: ResolvedTimeline = {
      duration: 5,
      children: [
        {
          type: "composition",
          timelineStart: 0,
          timelineEnd: 5,
          duration: 5,
          speed: 1,
          children: [],
          // origin at top-left of the item.
          spatialInput: { size: 200, translation: 0, origin: "0%", rotation: 45 },
        } as ResolvedComposition,
      ],
    };
    const result = resolveSpatial(timeline, 1000, 1000);
    const comp = result.children[0] as ResolvedComposition;
    // origin = (0,0) lands on translation = parent center (500,500), so
    // top-left = (500,500); pivot is the item's top-left corner.
    expect(comp.spatial).toEqual({
      x: 500,
      y: 500,
      width: 200,
      height: 200,
      rotation: 45,
      originX: 0,
      originY: 0,
    });
  });

  it("leaves rotation/origin off the rect when rotation is absent", () => {
    const timeline: ResolvedTimeline = {
      duration: 5,
      children: [
        {
          type: "composition",
          timelineStart: 0,
          timelineEnd: 5,
          duration: 5,
          speed: 1,
          children: [],
          spatialInput: { size: 200, translation: 0 },
        } as ResolvedComposition,
      ],
    };
    const result = resolveSpatial(timeline, 1000, 1000);
    const comp = result.children[0] as ResolvedComposition;
    expect(comp.spatial).toEqual({ x: 400, y: 400, width: 200, height: 200 });
    expect(comp.spatial!.rotation).toBeUndefined();
  });
});

describe("resolveSpatial — animation passthrough", () => {
  it("keeps spatialInput on the resolved node when keyframed", () => {
    const timeline: ResolvedTimeline = {
      duration: 5,
      children: [
        makeClip({
          spatialInput: {
            size: 100,
            translation: [
              [0, { x: 0, y: 0 }],
              ["100%", { x: 100, y: 0 }],
            ],
          },
        }),
      ],
    };
    const result = resolveSpatial(timeline, 1000, 1000);
    const clip = result.children[0] as ResolvedClip;
    expect(clip.spatialInput).toBeDefined();
    expect(clip.spatialInput!.translation).toBeDefined();
  });

  it("retains spatialInput on clip/static even when not keyframed", () => {
    // The resolver doesn't know intrinsic media dims for clip/static,
    // so it can't bake the correct `spatial`. The renderer always
    // re-evaluates against probed media size, which requires the
    // authored input to still be present.
    const timeline: ResolvedTimeline = {
      duration: 5,
      children: [
        makeClip({ spatialInput: { size: 100, translation: 0 } }),
      ],
    };
    const result = resolveSpatial(timeline, 1000, 1000);
    const clip = result.children[0] as ResolvedClip;
    expect(clip.spatialInput).toBeDefined();
    expect(clip.spatialInput!.size).toBe(100);
  });

  it("keeps spatialInput when only rotation is keyframed", () => {
    const timeline: ResolvedTimeline = {
      duration: 5,
      children: [
        {
          type: "composition",
          timelineStart: 0,
          timelineEnd: 5,
          duration: 5,
          speed: 1,
          children: [],
          spatialInput: {
            size: 200,
            translation: 0,
            rotation: [
              [0, 0],
              ["100%", 90],
            ],
          },
        } as ResolvedComposition,
      ],
    };
    const result = resolveSpatial(timeline, 1000, 1000);
    const comp = result.children[0] as ResolvedComposition;
    expect(comp.spatialInput).toBeDefined();
    expect(comp.spatialInput!.rotation).toBeDefined();
  });

  it("strips spatialInput on composition/text when nothing is keyframed", () => {
    const timeline: ResolvedTimeline = {
      duration: 5,
      children: [
        {
          type: "composition",
          timelineStart: 0,
          timelineEnd: 5,
          duration: 5,
          speed: 1,
          children: [],
          spatialInput: { size: 100, translation: 0 },
        } as ResolvedComposition,
      ],
    };
    const result = resolveSpatial(timeline, 1000, 1000);
    const comp = result.children[0] as ResolvedComposition;
    expect(comp.spatialInput).toBeUndefined();
  });
});

describe("resolveSpatial — inset (crop)", () => {
  // A clip with no probed media → content box = parent dims (1920×1080).
  const insetClip = (inset: unknown, insetMode?: string) => {
    const timeline: ResolvedTimeline = {
      duration: 5,
      children: [makeClip({ spatialInput: { inset, insetMode } as never })],
    };
    const clip = resolveSpatial(timeline, 1920, 1080).children[0] as ResolvedClip;
    return clip.spatial!;
  };

  it("default mode 'window' clips in place — no reposition/resize", () => {
    // Left half (right: 50%) stays at the left, where the content box was.
    const r = insetClip([0, "50%", 0, 0]);
    expect(r).toMatchObject({ x: 0, y: 0, width: 960, height: 1080 });
    expect(r.sourceRect).toEqual({ u0: 0, v0: 0, u1: 0.5, v1: 1 });
  });

  it("symmetric inset: window stays where it was (also centered here)", () => {
    const r = insetClip(100);
    expect(r).toMatchObject({ x: 100, y: 100, width: 1720, height: 880 });
    expect(r.sourceRect).toEqual({
      u0: 100 / 1920,
      v0: 100 / 1080,
      u1: 1820 / 1920,
      v1: 980 / 1080,
    });
  });

  it("mode 'center' re-centers the window within the content box", () => {
    const r = insetClip([0, "50%", 0, 0], "center");
    // 960×1080 window centered in the 1920×1080 box → x = (1920-960)/2 = 480
    expect(r).toMatchObject({ x: 480, y: 0, width: 960, height: 1080 });
    expect(r.sourceRect).toEqual({ u0: 0, v0: 0, u1: 0.5, v1: 1 });
  });

  it("mode 'fit' scales the window (aspect-preserving) to fit, centered", () => {
    // window 960×1080 into 1920×1080: k = min(1920/960, 1080/1080) = 1 → 960×1080
    const r = insetClip([0, "50%", 0, 0], "fit");
    expect(r).toMatchObject({ x: 480, y: 0, width: 960, height: 1080 });
    // A wider crop letterboxes vertically: window 1920×540 (bottom 50% off) →
    // k = min(1920/1920, 1080/540) = 1 → unchanged; use a taller test instead.
    const r2 = insetClip(["25%", 0, "25%", 0], "fit"); // window 1920×540
    // k = min(1920/1920, 1080/540) = 1 → 1920×540, centered vertically
    expect(r2).toMatchObject({ x: 0, y: 270, width: 1920, height: 540 });
  });

  it("mode 'cover' fills the box aspect-preserving, cropping the window", () => {
    // Window = left half (960×1080, 8:9) into the 16:9 box → too tall, so the
    // source is cropped top/bottom to 16:9 (centered) and output fills the box.
    const r = insetClip([0, "50%", 0, 0], "cover");
    expect(r).toMatchObject({ x: 0, y: 0, width: 1920, height: 1080 });
    expect(r.sourceRect).toEqual({ u0: 0, v0: 0.25, u1: 0.5, v1: 0.75 });
  });

  it("[v, h] shorthand maps to top/bottom + left/right", () => {
    const r = insetClip([50, 100]);
    expect(r).toMatchObject({ width: 1720, height: 980 });
    expect(r.sourceRect).toEqual({
      u0: 100 / 1920,
      v0: 50 / 1080,
      u1: 1820 / 1920,
      v1: 1030 / 1080,
    });
  });

  it("no sourceRect when there's no inset (rects stay plain)", () => {
    const timeline: ResolvedTimeline = {
      duration: 5,
      children: [makeClip({ spatialInput: { translation: 0 } })],
    };
    const clip = resolveSpatial(timeline, 1920, 1080).children[0] as ResolvedClip;
    expect(clip.spatial!.sourceRect).toBeUndefined();
  });

  it("animated inset samples per frame via resolveBoxProps", () => {
    // left edge ramps 0 → 960 over [0,1]s; at t=0.5 it's 480.
    const half = resolveBoxProps(
      { inset: [[0, [0, 0, 0, 0]], [1, [0, 0, 0, 960]]] } as never,
      1920,
      1080,
      1920,
      1080,
      0.5,
      1,
    );
    expect(half.width).toBeCloseTo(1440); // 1920 - 480
    expect(half.sourceRect!.u0).toBeCloseTo(480 / 1920);
    expect(half.sourceRect!.u1).toBeCloseTo(1);
  });
});

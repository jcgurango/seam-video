import { describe, it, expect } from "vitest";
import { resolveSpatial } from "../layout/resolve-spatial.js";
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

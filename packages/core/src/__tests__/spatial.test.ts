import { describe, it, expect } from "vitest";
import { resolveSpatial } from "../layout/resolve-spatial.js";
import type { ResolvedTimeline, ResolvedClip, ResolvedComposition } from "../resolved-types.js";

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

describe("resolveSpatial", () => {
  it("sets canvas dimensions and default objectFit on nodes without spatial props", () => {
    const timeline: ResolvedTimeline = {
      duration: 5,
      children: [makeClip()],
    };

    const result = resolveSpatial(timeline, 1920, 1080);
    expect(result.width).toBe(1920);
    expect(result.height).toBe(1080);
    const clip = result.children[0] as ResolvedClip;
    expect(clip.spatial).toBeUndefined();
    // Default objectFit "fit" flows through from root
    expect(clip.objectFit).toBe("fit");
  });

  it("resolves pixel box props to spatial rect", () => {
    const timeline: ResolvedTimeline = {
      duration: 5,
      children: [
        makeClip({
          spatialInput: { left: "100px", top: "50px", width: "400px", height: "300px" },
        }),
      ],
    };

    const result = resolveSpatial(timeline, 1920, 1080);
    const clip = result.children[0] as ResolvedClip;
    expect(clip.spatial).toEqual({ x: 100, y: 50, width: 400, height: 300 });
    expect(clip.spatialInput).toBeUndefined();
  });

  it("resolves percentage values against canvas", () => {
    const timeline: ResolvedTimeline = {
      duration: 5,
      children: [
        makeClip({
          spatialInput: { left: "50%", top: "50%", width: "25%", height: "25%" },
        }),
      ],
    };

    const result = resolveSpatial(timeline, 1920, 1080);
    const clip = result.children[0] as ResolvedClip;
    expect(clip.spatial).toEqual({ x: 960, y: 540, width: 480, height: 270 });
  });

  it("computes width from left + right", () => {
    const timeline: ResolvedTimeline = {
      duration: 5,
      children: [
        makeClip({
          spatialInput: { left: "100px", right: "100px", top: "0px", height: "1080px" },
        }),
      ],
    };

    const result = resolveSpatial(timeline, 1920, 1080);
    const clip = result.children[0] as ResolvedClip;
    expect(clip.spatial).toEqual({ x: 100, y: 0, width: 1720, height: 1080 });
  });

  it("computes x from width + right", () => {
    const timeline: ResolvedTimeline = {
      duration: 5,
      children: [
        makeClip({
          spatialInput: { right: "10px", width: "400px", top: "0px", height: "300px" },
        }),
      ],
    };

    const result = resolveSpatial(timeline, 1920, 1080);
    const clip = result.children[0] as ResolvedClip;
    expect(clip.spatial!.x).toBe(1510); // 1920 - 10 - 400
  });

  it("passes through objectFit from parent to child", () => {
    const timeline: ResolvedTimeline = {
      duration: 5,
      children: [
        {
          type: "composition",
          timelineStart: 0,
          timelineEnd: 5,
          duration: 5,
          speed: 1,
          children: [
            makeClip({
              spatialInput: { left: "0px", width: "480px" },
            }),
          ],
          spatialInput: { objectFit: "cover", left: "0px", top: "0px", width: "1920px", height: "1080px" },
        },
      ],
    };

    const result = resolveSpatial(timeline, 1920, 1080);
    const overlay = result.children[0] as ResolvedComposition;
    // The overlay itself gets parent's default objectFit ("fit")
    expect(overlay.objectFit).toBe("fit");
    // The clip inside the overlay gets the overlay's explicit objectFit ("cover")
    const clip = overlay.children[0] as ResolvedClip;
    expect(clip.objectFit).toBe("cover");
  });

  it("passes through position value", () => {
    const timeline: ResolvedTimeline = {
      duration: 5,
      children: [
        makeClip({
          spatialInput: { position: "absolute", left: "10px", top: "10px", width: "100px", height: "100px" },
        }),
      ],
    };

    const result = resolveSpatial(timeline, 1920, 1080);
    const clip = result.children[0] as ResolvedClip;
    expect(clip.position).toBe("absolute");
  });

  it("resolves nested percentages against parent spatial rect", () => {
    const timeline: ResolvedTimeline = {
      duration: 5,
      children: [
        {
          type: "composition",
          timelineStart: 0,
          timelineEnd: 5,
          duration: 5,
          speed: 1,
          children: [
            makeClip({
              spatialInput: { left: "50%", top: "50%", width: "50%", height: "50%" },
            }),
          ],
          spatialInput: { left: "0px", top: "0px", width: "960px", height: "540px" },
        },
      ],
    };

    const result = resolveSpatial(timeline, 1920, 1080);
    const comp = result.children[0] as ResolvedComposition;
    const clip = comp.children[0] as ResolvedClip;
    // 50% of 960 = 480, 50% of 540 = 270
    expect(clip.spatial).toEqual({ x: 480, y: 270, width: 480, height: 270 });
  });

  it("defaults objectFit to fit through nested containers", () => {
    const timeline: ResolvedTimeline = {
      duration: 5,
      children: [
        {
          type: "composition",
          timelineStart: 0,
          timelineEnd: 5,
          duration: 5,
          speed: 1,
          children: [makeClip()],
        },
      ],
    };

    const result = resolveSpatial(timeline, 1920, 1080);
    const comp = result.children[0] as ResolvedComposition;
    expect(comp.objectFit).toBe("fit");
    const clip = comp.children[0] as ResolvedClip;
    expect(clip.objectFit).toBe("fit");
  });

  it("root objectFit overrides default", () => {
    const timeline: ResolvedTimeline = {
      duration: 5,
      objectFit: "cover",
      children: [makeClip()],
    };

    const result = resolveSpatial(timeline, 1920, 1080);
    const clip = result.children[0] as ResolvedClip;
    expect(clip.objectFit).toBe("cover");
  });

  it("contentWidth/contentHeight sets child coordinate space", () => {
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
          children: [
            makeClip({
              spatialInput: { left: "50%", top: "50%", width: "50%", height: "50%" },
            }),
          ],
        },
      ],
    };

    const result = resolveSpatial(timeline, 1920, 1080);
    const comp = result.children[0] as ResolvedComposition;
    // Composition gets objectFit rect: fit 800x600 into 1920x1080
    // scale = min(1920/800, 1080/600) = min(2.4, 1.8) = 1.8
    // size = 1440x1080, centered at (240, 0)
    expect(comp.spatial).toEqual({ x: 240, y: 0, width: 1440, height: 1080 });
    // Child resolves percentages against 800x600
    const clip = comp.children[0] as ResolvedClip;
    expect(clip.spatial).toEqual({ x: 400, y: 300, width: 400, height: 300 });
  });

  it("contentWidth/contentHeight on root sets child coordinate space", () => {
    const timeline: ResolvedTimeline = {
      duration: 5,
      contentWidth: 800,
      contentHeight: 600,
      children: [
        makeClip({
          spatialInput: { left: "0px", top: "0px", width: "100%", height: "100%" },
        }),
      ],
    };

    const result = resolveSpatial(timeline, 1920, 1080);
    const clip = result.children[0] as ResolvedClip;
    // 100% of 800 = 800, 100% of 600 = 600
    expect(clip.spatial).toEqual({ x: 0, y: 0, width: 800, height: 600 });
  });

  it("container without contentWidth uses display size for children", () => {
    const timeline: ResolvedTimeline = {
      duration: 5,
      children: [
        {
          type: "composition",
          timelineStart: 0,
          timelineEnd: 5,
          duration: 5,
          speed: 1,
          children: [
            makeClip({
              spatialInput: { width: "50%", height: "50%", left: "0px", top: "0px" },
            }),
          ],
        },
      ],
    };

    const result = resolveSpatial(timeline, 1920, 1080);
    const comp = result.children[0] as ResolvedComposition;
    expect(comp.spatial).toBeUndefined(); // no custom intrinsic dims
    const clip = comp.children[0] as ResolvedClip;
    // 50% of parent (1920x1080)
    expect(clip.spatial).toEqual({ x: 0, y: 0, width: 960, height: 540 });
  });

  it("contentWidth/contentHeight with explicit spatial uses inner dims for children", () => {
    const timeline: ResolvedTimeline = {
      duration: 5,
      children: [
        {
          type: "composition",
          timelineStart: 0,
          timelineEnd: 5,
          duration: 5,
          speed: 1,
          contentWidth: 640,
          contentHeight: 480,
          spatialInput: { left: "0px", top: "0px", width: "960px", height: "540px" },
          children: [
            makeClip({
              spatialInput: { width: "100%", height: "100%", left: "0px", top: "0px" },
            }),
          ],
        },
      ],
    };

    const result = resolveSpatial(timeline, 1920, 1080);
    const overlay = result.children[0] as ResolvedComposition;
    expect(overlay.spatial).toEqual({ x: 0, y: 0, width: 960, height: 540 });
    const clip = overlay.children[0] as ResolvedClip;
    // 100% of contentWidth/contentHeight (640x480)
    expect(clip.spatial).toEqual({ x: 0, y: 0, width: 640, height: 480 });
  });

  it("produces anchor with right edge only", () => {
    const timeline: ResolvedTimeline = {
      duration: 5,
      children: [
        makeClip({
          spatialInput: { right: "0px", width: "480px", top: "0px", height: "270px" },
        }),
      ],
    };

    const result = resolveSpatial(timeline, 1920, 1080);
    const clip = result.children[0] as ResolvedClip;
    expect(clip.anchor).toEqual({ right: 0, top: 0 });
    expect(clip.spatial!.x).toBe(1440); // 1920 - 0 - 480
  });

  it("produces anchor with both left and right edges", () => {
    const timeline: ResolvedTimeline = {
      duration: 5,
      children: [
        makeClip({
          spatialInput: { left: "100px", right: "100px", top: "50px", bottom: "50px" },
        }),
      ],
    };

    const result = resolveSpatial(timeline, 1920, 1080);
    const clip = result.children[0] as ResolvedClip;
    expect(clip.anchor).toEqual({ left: 100, right: 100, top: 50, bottom: 50 });
    expect(clip.spatial).toEqual({ x: 100, y: 50, width: 1720, height: 980 });
  });

  it("produces undefined anchor when no edges specified", () => {
    const timeline: ResolvedTimeline = {
      duration: 5,
      children: [
        makeClip({
          spatialInput: { width: "480px", height: "270px" },
        }),
      ],
    };

    const result = resolveSpatial(timeline, 1920, 1080);
    const clip = result.children[0] as ResolvedClip;
    expect(clip.anchor).toBeUndefined();
  });

  it("preserves anchor through to nested children", () => {
    const timeline: ResolvedTimeline = {
      duration: 5,
      children: [
        {
          type: "composition",
          timelineStart: 0,
          timelineEnd: 5,
          duration: 5,
          speed: 1,
          children: [
            makeClip({
              spatialInput: { right: "20px", bottom: "20px", width: "25%", height: "25%" },
            }),
          ],
        },
      ],
    };

    const result = resolveSpatial(timeline, 1920, 1080);
    const overlay = result.children[0] as ResolvedComposition;
    const clip = overlay.children[0] as ResolvedClip;
    expect(clip.anchor).toEqual({ right: 20, bottom: 20 });
    expect(clip.spatial).toEqual({ x: 1420, y: 790, width: 480, height: 270 });
  });

  it("omits objectFit when both width and height are explicit (overconstrained)", () => {
    const timeline: ResolvedTimeline = {
      duration: 5,
      objectFit: "fit",
      children: [
        makeClip({
          spatialInput: { left: "0px", width: "50%", height: "100px" },
        }),
      ],
    };

    const result = resolveSpatial(timeline, 1920, 1080);
    const clip = result.children[0] as ResolvedClip;
    expect(clip.spatial).toEqual({ x: 0, y: 490, width: 960, height: 100 });
    expect(clip.objectFit).toBeUndefined();
  });

  it("omits objectFit when opposing edges determine both dimensions", () => {
    const timeline: ResolvedTimeline = {
      duration: 5,
      children: [
        makeClip({
          spatialInput: { left: "0px", right: "0px", top: "0px", bottom: "0px" },
        }),
      ],
    };

    const result = resolveSpatial(timeline, 1920, 1080);
    const clip = result.children[0] as ResolvedClip;
    expect(clip.objectFit).toBeUndefined();
  });

  it("keeps objectFit when only one dimension is explicit", () => {
    const timeline: ResolvedTimeline = {
      duration: 5,
      objectFit: "cover",
      children: [
        makeClip({
          spatialInput: { width: "50%", top: "0px" },
        }),
      ],
    };

    const result = resolveSpatial(timeline, 1920, 1080);
    const clip = result.children[0] as ResolvedClip;
    expect(clip.objectFit).toBe("cover");
  });

  it("strips spatialInput after resolution", () => {
    const timeline: ResolvedTimeline = {
      duration: 5,
      children: [
        makeClip({
          spatialInput: { left: "0px", top: "0px", width: "100px", height: "100px" },
        }),
      ],
    };

    const result = resolveSpatial(timeline, 1920, 1080);
    const clip = result.children[0] as ResolvedClip;
    expect(clip.spatialInput).toBeUndefined();
  });
});

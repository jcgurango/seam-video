import { describe, it, expect } from "vitest";
import { mkdtemp, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ResolvedComposition, ResolvedTimeline } from "@seam/core";
import { buildMltDocument, isComplexComposition } from "../mlt-builder.js";
import { prerenderCompositionMlts } from "../composition-prerender.js";

// These tests construct already-resolved nodes directly (the shape
// `resolveSpatial` produces), since the builder consumes the resolved
// tree — `spatial` / `objectFit` / `filters` / `naturalWidth` etc.

function innerClip() {
  return {
    type: "clip" as const,
    source: "inner.mp4",
    timelineStart: 0,
    timelineEnd: 1,
    duration: 1,
    speed: 1,
    sourceIn: 0,
    sourceOut: 1,
  };
}

function nestedComp(extra: Partial<ResolvedComposition>): ResolvedComposition {
  return {
    type: "composition",
    timelineStart: 0,
    timelineEnd: 1,
    duration: 1,
    speed: 1,
    objectFit: "fit",
    contentWidth: 1080,
    contentHeight: 1920,
    naturalWidth: 1080,
    naturalHeight: 1920,
    children: [innerClip()],
    ...extra,
  } as ResolvedComposition;
}

function timelineWith(comp: ResolvedComposition): ResolvedTimeline {
  return {
    duration: 1,
    width: 1080,
    height: 1920,
    contentWidth: 1080,
    contentHeight: 1920,
    children: [comp],
  };
}

describe("isComplexComposition", () => {
  it("is true for filters / spatial / non-fit objectFit / backgroundColor", () => {
    expect(isComplexComposition(nestedComp({ filters: [{ type: "adjust", brightness: 0.2 }] }))).toBe(true);
    expect(isComplexComposition(nestedComp({ spatial: { x: 270, y: 480, width: 540, height: 960 } }))).toBe(true);
    expect(isComplexComposition(nestedComp({ objectFit: "cover" }))).toBe(true);
    // A bg fill is visible content flattening would drop → must layer.
    expect(isComplexComposition(nestedComp({ backgroundColor: "black" }))).toBe(true);
  });

  it("is false for a plain pass-through composition", () => {
    expect(isComplexComposition(nestedComp({}))).toBe(false);
  });
});

describe("overlay z-order (document order, not type)", () => {
  it("composites overlays in authored order regardless of node type", () => {
    // Authored: comp (made complex via backgroundColor) BELOW text. The
    // comp lands on a higher *track index* than text (comp tracks come
    // after text tracks), so if emit order followed track type the comp
    // would wrongly composite on top. z-order must emit the comp first.
    const comp = nestedComp({ backgroundColor: "black" });
    const text = {
      type: "text",
      text: "hi",
      timelineStart: 0,
      timelineEnd: 1,
      duration: 1,
    } as unknown as ResolvedComposition;
    const timeline: ResolvedTimeline = {
      duration: 1,
      width: 1080,
      height: 1920,
      contentWidth: 1080,
      contentHeight: 1920,
      children: [comp, text as never],
    };
    const { xml } = buildMltDocument(timeline, {
      width: 1080,
      height: 1920,
      fps: 30,
      compositionMlts: new Map([[comp, "/tmp/comp-0.mlt"]]),
      textRasters: new Map([
        [
          text as never,
          { path: "/tmp/t.png", isAnimated: false, frameCount: 1, width: 1080, height: 1920, timelineStart: 0, timelineEnd: 1 },
        ],
      ]),
    });
    // Overlay transitions in emit order (skip the video base, b_track=1).
    const bTracks = [...xml.matchAll(/<property name="b_track">(\d+)<\/property>/g)]
      .map((m) => Number(m[1]))
      .filter((t) => t !== 1);
    expect(bTracks.length).toBe(2);
    // comp lives on the higher track but is authored first → emitted first.
    expect(bTracks[0]).toBeGreaterThan(bTracks[1]);
  });
});

describe("rootSpeed (composition stretch)", () => {
  // A static at content-time [0,0.4]; a comp speed of 0.4 stretches it to
  // fill output [0,1] (= 30 frames @30fps), so the entry spans out="29",
  // not out="11" (the un-stretched 0.4s = 12 frames).
  const stretched: ResolvedTimeline = {
    duration: 1,
    width: 1080,
    height: 1920,
    contentWidth: 1080,
    contentHeight: 1920,
    children: [
      {
        type: "static",
        source: "still.png",
        sourceTime: 0,
        timelineStart: 0,
        timelineEnd: 0.4,
        duration: 0.4,
      } as unknown as ResolvedTimeline["children"][number],
    ],
  };

  it("stretches child timing by 1/rootSpeed", () => {
    const slow = buildMltDocument(stretched, { width: 1080, height: 1920, fps: 30, rootSpeed: 0.4 });
    expect(slow.xml).toMatch(/<entry producer="[^"]+" in="0" out="29"\/>/);
    const normal = buildMltDocument(stretched, { width: 1080, height: 1920, fps: 30 });
    expect(normal.xml).toMatch(/<entry producer="[^"]+" in="0" out="11"\/>/);
  });
});

describe("background base color", () => {
  function bgResource(xml: string): string | undefined {
    return xml.match(
      /<producer id="bg"[^>]*>\s*<property name="mlt_service">color<\/property>\s*<property name="resource">([^<]*)<\/property>/,
    )?.[1];
  }
  const base: ResolvedTimeline = {
    duration: 1,
    width: 1080,
    height: 1920,
    contentWidth: 1080,
    contentHeight: 1920,
    children: [],
  };

  it("defaults the root base to opaque black", () => {
    expect(bgResource(buildMltDocument(base, { width: 1080, height: 1920 }).xml)).toBe("black");
  });

  it("uses the timeline backgroundColor when set", () => {
    expect(
      bgResource(buildMltDocument({ ...base, backgroundColor: "#202020" }, { width: 1080, height: 1920 }).xml),
    ).toBe("#202020");
  });

  it("falls back to defaultBackgroundColor (transparent for sub-mlts)", () => {
    expect(
      bgResource(
        buildMltDocument(base, { width: 1080, height: 1920, defaultBackgroundColor: "#00000000" }).xml,
      ),
    ).toBe("#00000000");
    // an explicit backgroundColor still wins over the default
    expect(
      bgResource(
        buildMltDocument(
          { ...base, backgroundColor: "black" },
          { width: 1080, height: 1920, defaultBackgroundColor: "#00000000" },
        ).xml,
      ),
    ).toBe("black");
  });
});

describe("nested composition as external .mlt producer", () => {
  it("references the sub-mlt producer, places it, and applies wrapper filters", () => {
    const comp = nestedComp({
      spatial: { x: 270, y: 480, width: 540, height: 960 },
      filters: [{ type: "adjust", brightness: 0.3 }],
    });
    const compositionMlts = new Map([[comp, "/tmp/sidecar/comp-0.mlt"]]);
    const { xml } = buildMltDocument(timelineWith(comp), {
      width: 1080,
      height: 1920,
      fps: 30,
      compositionMlts,
    });
    expect(xml).toContain('resource="/tmp/sidecar/comp-0.mlt"');
    expect(xml).toMatch(/<playlist id="comp_v1">/);
    // wrapper filter → avfilter chain
    expect(xml).toContain("avfilter.eq");
    // placed at its display rect (270 480 540 960)
    expect(xml).toContain("270 480 540 960 1");
    // inner clip is NOT flattened into the parent
    expect(xml).not.toContain("inner.mp4");
  });

  it("flattens a trivial composition (children inline, no comp track)", () => {
    const comp = nestedComp({});
    const { xml } = buildMltDocument(timelineWith(comp), {
      width: 1080,
      height: 1920,
      fps: 30,
      compositionMlts: new Map(),
    });
    expect(xml).toContain("inner.mp4");
    expect(xml).not.toMatch(/<playlist id="comp_v1">/);
  });

  it("warns when a complex composition has no pre-rendered sub-mlt", () => {
    const comp = nestedComp({ spatial: { x: 270, y: 480, width: 540, height: 960 } });
    const { limitations } = buildMltDocument(timelineWith(comp), {
      width: 1080,
      height: 1920,
      fps: 30,
    });
    expect(limitations.some((l) => l.node === "composition" && l.field === "wrapper")).toBe(true);
  });
});

describe("inset (crop) windowing", () => {
  // A composition cropped to its left half: windowed extent 540×1920, source
  // sub-rect u∈[0,0.5]. The crop sub-`.mlt` should zoom-fill its 1080×1920
  // canvas by ×2 horizontally → an affine rect of "0 0 2160 1920 …".
  it("emits a cropping sub-.mlt that zoom-fills the visible sub-rect", async () => {
    const comp = nestedComp({
      spatial: {
        x: 270,
        y: 0,
        width: 540,
        height: 1920,
        sourceRect: { u0: 0, v0: 0, u1: 0.5, v1: 1 },
      },
    });
    const dir = await mkdtemp(join(tmpdir(), "seam-inset-"));
    const { compositionMlts } = await prerenderCompositionMlts(
      timelineWith(comp),
      dir,
      30,
    );
    const cropPath = compositionMlts.get(comp);
    expect(cropPath).toBeTruthy();
    const xml = await readFile(cropPath!, "utf-8");
    // The crop sub-.mlt references the content sub-.mlt and places it with the
    // ×2 zoom rect (width 1080/0.5 = 2160).
    expect(xml).toContain("mlt_service");
    expect(xml).toMatch(/rect">0 0 2160 1920/);
    // Two files written: the content source and the crop wrapper.
    const files = await readdir(dir);
    expect(files.length).toBe(2);
  });

  it("animated inset bakes the crop-zoom as an affine rect keyframe string", async () => {
    // inset ramps 0 → left:50% over the comp's 1s; the crop-zoom rect is
    // sampled per frame and emitted as a multi-stop `rect` keyframe string.
    const comp = nestedComp({
      duration: 1,
      spatialInput: { inset: [[0, [0, 0, 0, 0]], [1, [0, 0, 0, "50%"]]] },
      spatial: {
        x: 0,
        y: 0,
        width: 1080,
        height: 1920,
        sourceRect: { u0: 0, v0: 0, u1: 1, v1: 1 },
      },
    });
    const dir = await mkdtemp(join(tmpdir(), "seam-inset-anim-"));
    const { compositionMlts } = await prerenderCompositionMlts(
      timelineWith(comp),
      dir,
      30,
    );
    const xml = await readFile(compositionMlts.get(comp)!, "utf-8");
    // The cropNode placement is a multi-stop `rect` keyframe string
    // (`f=X Y W H A;f=…`) — the crop-zoom baked per frame.
    expect(xml).toMatch(/name="rect">[^<]*;[^<]*</);
  });
});

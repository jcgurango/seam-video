import { describe, it, expect } from "vitest";
import { resolveSpatial, type ResolvedTimeline } from "@seam/core";
import { buildMltDocument } from "../mlt-builder.js";
import type { IntrinsicSizeMap } from "../media-probe.js";

const PROBED: IntrinsicSizeMap = new Map([
  ["sq.mp4", { width: 1000, height: 1000 }],
]);

/** Portrait 1080×1920 timeline with one square-source clip carrying the
 *  given spatial input. */
function rotTimeline(spatialInput: Record<string, unknown>): ResolvedTimeline {
  const raw = {
    duration: 1,
    width: 1080,
    height: 1920,
    contentWidth: 1080,
    contentHeight: 1920,
    children: [
      {
        type: "clip" as const,
        source: "sq.mp4",
        timelineStart: 0,
        timelineEnd: 1,
        duration: 1,
        speed: 1,
        sourceIn: 0,
        sourceOut: 1,
        spatialInput,
      },
    ],
  };
  return resolveSpatial(raw as unknown as ResolvedTimeline, 1080, 1920);
}

function build(spatialInput: Record<string, unknown>) {
  return buildMltDocument(rotTimeline(spatialInput), {
    width: 1080,
    height: 1920,
    fps: 30,
    intrinsicSizes: PROBED,
  });
}

/** All overlay transition blocks (skip the track-0 video-fill transition). */
function overlayTransitions(xml: string): string[] {
  return [...xml.matchAll(/<transition>[\s\S]*?<\/transition>/g)]
    .map((m) => m[0])
    .filter((t) => t.includes('name="in"')); // overlays carry in/out
}

describe("spatial rotation → MLT", () => {
  it("non-rotated overlay stays on affine, no rotation props", () => {
    const { xml } = build({ size: 200, translation: 0 });
    const ov = overlayTransitions(xml);
    expect(ov.length).toBe(1);
    expect(ov[0]).toContain("<property name=\"mlt_service\">affine</property>");
    expect(ov[0]).not.toContain('name="rotation"');
    expect(ov[0]).not.toContain('name="rotate_center"');
    // 200×200 centered at (540,960), origin center → x=440 y=860.
    expect(ov[0]).toContain('<property name="rect">440 860 200 200 1</property>');
  });

  it("rotated overlay composites via qtblend with rotation + rotate_center", () => {
    const { xml } = build({ size: 200, translation: 0, rotation: 90 });
    const ov = overlayTransitions(xml);
    expect(ov.length).toBe(1);
    expect(ov[0]).toContain('<property name="mlt_service">qtblend</property>');
    expect(ov[0]).toContain('<property name="rotation">90</property>');
    expect(ov[0]).toContain('<property name="rotate_center">1</property>');
    // origin = center → no pivot-compensation shift → rect unchanged.
    expect(ov[0]).toContain('<property name="rect">440 860 200 200 1</property>');
  });

  it("compensates the rect for a non-center origin pivot", () => {
    // origin = top-left of the item; translation 0 lands it at canvas
    // center (540,960), so the un-rotated rect is at (540,960).
    const { xml } = build({ size: 200, translation: 0, origin: "0%", rotation: 90 });
    const ov = overlayTransitions(xml);
    // d = origin − center = (-100,-100); R(d) clockwise 90° = (100,-100);
    // shift = d − R(d) = (-200, 0) → rect x = 540-200 = 340, y = 960.
    expect(ov[0]).toContain('<property name="rect">340 960 200 200 1</property>');
    expect(ov[0]).toContain('<property name="rotation">90</property>');
  });

  it("animated rotation emits keyframed rotation alongside the rect", () => {
    const { xml } = build({
      size: 200,
      translation: 0,
      rotation: [
        [0, 0],
        ["100%", 90],
      ],
    });
    const ov = overlayTransitions(xml);
    expect(ov[0]).toContain('<property name="mlt_service">qtblend</property>');
    const rot = ov[0].match(/<property name="rotation">([^<]+)<\/property>/)?.[1];
    expect(rot).toBeTruthy();
    // Keyframed `frame=value;...`, starting at 0 and climbing toward 90
    // (the final owned frame is one short of the endpoint, so ~87°).
    expect(rot).toMatch(/^0=0;/);
    expect(rot).toContain(";");
    const lastVal = Number(rot!.split(";").at(-1)!.split("=")[1]);
    expect(lastVal).toBeGreaterThan(80);
    expect(lastVal).toBeLessThanOrEqual(90);
  });
});

import { describe, it, expect } from "vitest";
import type { ResolvedStatic, ResolvedTimeline } from "@seam/core";
import { buildMltDocument } from "../mlt-builder.js";

function timelineWithStatic(node: Partial<ResolvedStatic>): ResolvedTimeline {
  const stat = {
    type: "static",
    source: "clip.mp4",
    sourceTime: 0.5,
    timelineStart: 0,
    timelineEnd: 1,
    duration: 1,
    ...node,
  } as ResolvedStatic;
  return {
    duration: 1,
    width: 1080,
    height: 1920,
    contentWidth: 1080,
    contentHeight: 1920,
    children: [stat],
  };
}

describe("video-source static (freeze-frame)", () => {
  it("freezes via a producer-level freeze filter at the source frame", () => {
    // sourceTime 0.5s @ 30fps → frame 15; duration 1s → 30 frames.
    const { xml } = buildMltDocument(timelineWithStatic({}), {
      width: 1080,
      height: 1920,
      fps: 30,
    });
    // The freeze filter lives on the producer (producer-absolute `frame`,
    // so it's independent of where the static sits on the timeline), with
    // no before/after flags (freeze everywhere). The entry is untrimmed.
    expect(xml).toMatch(
      /<producer id="[^"]+"[^>]*>\s*<property name="audio_index">-1<\/property>\s*<filter>\s*<property name="mlt_service">freeze<\/property>\s*<property name="frame">15<\/property>\s*<\/filter>\s*<\/producer>/,
    );
    expect(xml).toMatch(/<entry producer="[^"]+" in="0" out="29"\/>/);
    expect(xml).not.toContain("freeze_after");
    expect(xml).not.toContain("freeze_before");
  });

  it("image-source static still rides qimage frame 0 (in=0)", () => {
    const { xml } = buildMltDocument(timelineWithStatic({ source: "still.png" }), {
      width: 1080,
      height: 1920,
      fps: 30,
    });
    expect(xml).toContain('<property name="mlt_service">qimage</property>');
    expect(xml).toMatch(/<entry producer="[^"]+" in="0" out="29"\/>/);
    expect(xml).not.toContain("freeze");
  });
});

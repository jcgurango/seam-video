import { describe, it, expect } from "vitest";
import { secondsToFrames } from "../frame-utils.js";
import { buildMlt } from "../mlt-builder.js";
import { serializeToXml } from "../xml-serializer.js";
import type { ResolvedTimeline } from "@seam/core";

describe("secondsToFrames", () => {
  it("converts seconds to frames at 30fps", () => {
    expect(secondsToFrames(1, 30)).toBe(30);
    expect(secondsToFrames(0.5, 30)).toBe(15);
    expect(secondsToFrames(0, 30)).toBe(0);
  });

  it("rounds to nearest frame", () => {
    expect(secondsToFrames(1.017, 30)).toBe(31);
  });
});

describe("buildMlt", () => {
  it("builds a simple two-clip timeline", () => {
    const timeline: ResolvedTimeline = {
      duration: 8,
      children: [
        {
          type: "clip",
          source: "a.mp4",
          sourceIn: 0,
          sourceOut: 3,
          timelineStart: 0,
          timelineEnd: 3,
          speed: 1,
        },
        {
          type: "clip",
          source: "b.mp4",
          sourceIn: 5,
          sourceOut: 10,
          timelineStart: 3,
          timelineEnd: 8,
          speed: 1,
        },
      ],
    };

    const doc = buildMlt(timeline, 30);

    expect(doc.producers).toHaveLength(2);
    expect(doc.producers[0]).toMatchObject({ resource: "a.mp4" });
    expect(doc.producers[1]).toMatchObject({ resource: "b.mp4" });
    expect(doc.playlist).toHaveLength(2);
  });

  it("reuses producers for same source", () => {
    const timeline: ResolvedTimeline = {
      duration: 6,
      children: [
        {
          type: "clip",
          source: "video.mp4",
          sourceIn: 0,
          sourceOut: 3,
          timelineStart: 0,
          timelineEnd: 3,
          speed: 1,
        },
        {
          type: "clip",
          source: "video.mp4",
          sourceIn: 5,
          sourceOut: 8,
          timelineStart: 3,
          timelineEnd: 6,
          speed: 1,
        },
      ],
    };

    const doc = buildMlt(timeline, 30);
    expect(doc.producers).toHaveLength(1);
  });

  it("handles speed with timewarp resource", () => {
    const timeline: ResolvedTimeline = {
      duration: 5,
      children: [
        {
          type: "clip",
          source: "video.mp4",
          sourceIn: 0,
          sourceOut: 10,
          timelineStart: 0,
          timelineEnd: 5,
          speed: 2,
        },
      ],
    };

    const doc = buildMlt(timeline, 30);
    expect(doc.producers[0].resource).toBe("timewarp:2:video.mp4");
  });

  it("inserts blanks for empty segments", () => {
    const timeline: ResolvedTimeline = {
      duration: 8,
      children: [
        {
          type: "clip",
          source: "a.mp4",
          sourceIn: 0,
          sourceOut: 3,
          timelineStart: 0,
          timelineEnd: 3,
          speed: 1,
        },
        {
          type: "empty",
          timelineStart: 3,
          timelineEnd: 5,
        },
        {
          type: "clip",
          source: "b.mp4",
          sourceIn: 0,
          sourceOut: 3,
          timelineStart: 5,
          timelineEnd: 8,
          speed: 1,
        },
      ],
    };

    const doc = buildMlt(timeline, 30);
    expect(doc.playlist).toHaveLength(3);
    expect(doc.playlist[1]).toEqual({ length: 60 }); // 2 seconds * 30fps
  });

  it("inserts blank for gap at timeline start", () => {
    const timeline: ResolvedTimeline = {
      duration: 8,
      children: [
        {
          type: "clip",
          source: "a.mp4",
          sourceIn: 0,
          sourceOut: 3,
          timelineStart: 5,
          timelineEnd: 8,
          speed: 1,
        },
      ],
    };

    const doc = buildMlt(timeline, 30);
    expect(doc.playlist).toHaveLength(2);
    expect(doc.playlist[0]).toEqual({ length: 150 }); // 5s * 30fps
  });
});

describe("serializeToXml", () => {
  it("produces valid MLT XML", () => {
    const timeline: ResolvedTimeline = {
      duration: 8,
      children: [
        {
          type: "clip",
          source: "a.mp4",
          sourceIn: 0,
          sourceOut: 3,
          timelineStart: 0,
          timelineEnd: 3,
          speed: 1,
        },
        {
          type: "clip",
          source: "b.mp4",
          sourceIn: 5,
          sourceOut: 10,
          timelineStart: 3,
          timelineEnd: 8,
          speed: 1,
        },
      ],
    };

    const doc = buildMlt(timeline, 30);
    const xml = serializeToXml(doc);

    expect(xml).toContain('<?xml version="1.0"');
    expect(xml).toContain("<mlt>");
    expect(xml).toContain('frame_rate_num="30"');
    expect(xml).toContain('<producer id="producer0">');
    expect(xml).toContain("<property name=\"resource\">a.mp4</property>");
    expect(xml).toContain('<producer id="producer1">');
    expect(xml).toContain("<property name=\"resource\">b.mp4</property>");
    expect(xml).toContain('producer="producer0"');
    expect(xml).toContain('producer="producer1"');
    expect(xml).toContain('<playlist id="playlist0">');
    expect(xml).toContain('<tractor id="tractor0"');
    expect(xml).toContain("</mlt>");
  });

  it("snapshot: simple two-clip timeline", () => {
    const timeline: ResolvedTimeline = {
      duration: 5,
      children: [
        {
          type: "clip",
          source: "intro.mp4",
          sourceIn: 0,
          sourceOut: 2,
          timelineStart: 0,
          timelineEnd: 2,
          speed: 1,
        },
        {
          type: "clip",
          source: "main.mp4",
          sourceIn: 10,
          sourceOut: 13,
          timelineStart: 2,
          timelineEnd: 5,
          speed: 1,
        },
      ],
    };

    const doc = buildMlt(timeline, 30);
    const xml = serializeToXml(doc);

    expect(xml).toMatchInlineSnapshot(`
      "<?xml version="1.0" encoding="utf-8"?>
      <mlt>
        <profile frame_rate_num="30" frame_rate_den="1" width="1920" height="1080" sample_aspect_num="1" sample_aspect_den="1" display_aspect_num="1920" display_aspect_den="1080" progressive="1" />
        <producer id="producer0">
          <property name="resource">intro.mp4</property>
        </producer>
        <producer id="producer1">
          <property name="resource">main.mp4</property>
        </producer>
        <playlist id="playlist0">
          <entry producer="producer0" in="0" out="59" />
          <entry producer="producer1" in="300" out="389" />
        </playlist>
        <tractor id="tractor0" out="149">
          <track producer="playlist0" />
        </tractor>
      </mlt>
      "
    `);
  });
});

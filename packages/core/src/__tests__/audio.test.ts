import { describe, it, expect } from "vitest";
import { resolveComposition } from "../layout/resolve.js";
import { parseSeamFile } from "../validate.js";
import type { Composition } from "../types.js";

function comp(
  overrides: Partial<Composition> & { children: Composition["children"] }
): Composition {
  return { type: "composition", ...overrides };
}

describe("audio", () => {
  it("resolves a simple audio clip with same temporal shape as a clip", () => {
    const result = resolveComposition(
      comp({
        children: [
          { type: "audio", source: "track.mp3", in: 0, out: 4 },
        ],
      })
    );

    expect(result.duration).toBe(4);
    expect(result.children[0]).toMatchObject({
      type: "audio",
      source: "track.mp3",
      sourceIn: 0,
      sourceOut: 4,
      timelineStart: 0,
      timelineEnd: 4,
      speed: 1,
    });
  });

  it("places audio sequentially in a composition next to clips", () => {
    const result = resolveComposition(
      comp({
        children: [
          { type: "clip", source: "v.mp4", in: 0, out: 3 },
          { type: "audio", source: "a.mp3", in: 0, out: 2 },
        ],
      })
    );

    expect(result.duration).toBe(5);
    expect(result.children[1]).toMatchObject({
      type: "audio",
      timelineStart: 3,
      timelineEnd: 5,
    });
  });

  it("applies speed to audio (halves natural duration)", () => {
    const result = resolveComposition(
      comp({
        children: [
          { type: "audio", source: "a.mp3", in: 0, out: 10, speed: 2 },
        ],
      })
    );

    expect(result.duration).toBe(5);
    const audio = result.children[0];
    expect(audio.type).toBe("audio");
    if (audio.type === "audio") {
      expect(audio.speed).toBe(2);
      expect(audio.sourceIn).toBe(0);
      expect(audio.sourceOut).toBe(10);
    }
  });

  it("applies stretch overflow to audio (speed up to fit)", () => {
    const result = resolveComposition(
      comp({
        duration: 5,
        children: [
          {
            type: "audio",
            source: "a.mp3",
            in: 0,
            out: 10,
            flex: 1,
            overflow: "stretch",
          },
        ],
      })
    );

    const audio = result.children[0];
    if (audio.type === "audio") {
      expect(audio.speed).toBe(2); // 10s of source crammed into 5s
      expect(audio.timelineEnd - audio.timelineStart).toBeCloseTo(5);
    }
  });

  it("can be used as an attachment with start anchor", () => {
    const result = resolveComposition(
      comp({
        children: [
          { id: "main", type: "clip", source: "v.mp4", in: 0, out: 10 },
        ],
        attachments: [
          {
            type: "audio",
            source: "vo.mp3",
            in: 0,
            out: 3,
            start: { anchor: "main", timeSource: "output", anchorPoint: "50%" },
          },
        ],
      })
    );

    expect(result.children[1]).toMatchObject({
      type: "audio",
      timelineStart: 5,
      timelineEnd: 8,
    });
  });

  it("rejects spatial fields via schema", () => {
    const result = parseSeamFile(
      JSON.stringify({
        type: "composition",
        children: [
          {
            type: "audio",
            source: "a.mp3",
            in: 0,
            out: 4,
            // Spatial — invalid for audio
            width: "50%",
          },
        ],
      })
    );
    expect(result.success).toBe(false);
  });

  it("rejects filters via schema", () => {
    const result = parseSeamFile(
      JSON.stringify({
        type: "composition",
        children: [
          {
            type: "audio",
            source: "a.mp3",
            in: 0,
            out: 4,
            filters: [{ type: "opacity", value: 0.5 }],
          },
        ],
      })
    );
    expect(result.success).toBe(false);
  });

  it("rejects both speed and duration set on audio", () => {
    const result = parseSeamFile(
      JSON.stringify({
        type: "composition",
        children: [
          {
            type: "audio",
            source: "a.mp3",
            in: 0,
            out: 4,
            speed: 2,
            duration: 1,
          },
        ],
      })
    );
    expect(result.success).toBe(false);
  });
});

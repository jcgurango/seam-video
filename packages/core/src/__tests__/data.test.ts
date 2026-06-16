import { describe, it, expect } from "vitest";
import { resolveComposition } from "../layout/resolve.js";
import { parseSeamFile } from "../validate.js";
import type { Composition } from "../types.js";

function comp(
  overrides: Partial<Composition> & { children: Composition["children"] }
): Composition {
  return { type: "composition", ...overrides };
}

describe("data node", () => {
  it("takes up its declared duration as a sequential child", () => {
    const result = resolveComposition(
      comp({
        children: [
          { type: "clip", source: "a.mp4", in: 0, out: 3 },
          { type: "data", data: { foo: "bar" }, duration: 2 },
          { type: "clip", source: "b.mp4", in: 0, out: 4 },
        ],
      })
    );

    expect(result.duration).toBe(9);
    expect(result.children[1]).toMatchObject({
      type: "data",
      data: { foo: "bar" },
      timelineStart: 3,
      timelineEnd: 5,
    });
    expect(result.children[2]).toMatchObject({
      timelineStart: 5,
      timelineEnd: 9,
    });
  });

  it("defaults to zero duration when omitted", () => {
    const result = resolveComposition(
      comp({
        children: [
          { type: "clip", source: "a.mp4", in: 0, out: 3 },
          { type: "data", data: { marker: true } },
        ],
      })
    );

    expect(result.duration).toBe(3);
    expect(result.children[1]).toMatchObject({
      type: "data",
      timelineStart: 3,
      timelineEnd: 3,
    });
  });

  it("preserves arbitrary JSON data through resolution", () => {
    const payload = {
      nested: { array: [1, 2, 3], flag: true },
      string: "hello",
      n: 42,
    };
    const result = resolveComposition(
      comp({
        children: [
          { type: "data", data: payload, duration: 1 },
        ],
      })
    );

    expect(result.children[0]).toMatchObject({
      type: "data",
      data: payload,
    });
  });

  it("works as an attachment with a single anchor (zero-duration marker)", () => {
    const result = resolveComposition(
      comp({
        children: [
          { id: "intro", type: "clip", source: "v.mp4", in: 0, out: 10 },
        ],
        attachments: [
          {
            type: "data",
            data: { kind: "cue" },
            start: {
              anchor: "intro",
              timeSource: "output",
              anchorPoint: "100%",
              offset: -3,
            },
          },
        ],
      })
    );

    // Anchor at 100% of [0,10] = 10, offset -3 → start 7. No end → use natural
    // duration (0 since no `duration` was given).
    expect(result.children[1]).toMatchObject({
      type: "data",
      data: { kind: "cue" },
      timelineStart: 7,
      timelineEnd: 7,
    });
  });

  it("spans start..end when both anchors are pinned, ignoring duration", () => {
    const result = resolveComposition(
      comp({
        children: [
          { id: "main", type: "clip", source: "v.mp4", in: 0, out: 10 },
        ],
        attachments: [
          {
            type: "data",
            data: { caption: "hi" },
            duration: 1,
            start: { anchor: "main", timeSource: "output", anchorPoint: "20%" },
            end: { anchor: "main", timeSource: "output", anchorPoint: "60%" },
          },
        ],
      })
    );

    // [2, 6] from anchors — duration field is irrelevant once both ends pinned.
    expect(result.children[1]).toMatchObject({
      type: "data",
      timelineStart: 2,
      timelineEnd: 6,
    });
  });

  it("can be referenced as an anchor by other children", () => {
    const result = resolveComposition(
      comp({
        children: [
          { id: "marker", type: "data", data: null, duration: 5 },
        ],
        attachments: [
          {
            type: "clip",
            source: "b.mp4",
            in: 0,
            out: 2,
            start: { anchor: "marker", timeSource: "output", anchorPoint: "100%" },
          },
        ],
      })
    );

    // marker spans [0,5]; 100% = 5
    expect(result.children[1]).toMatchObject({
      source: "b.mp4",
      timelineStart: 5,
      timelineEnd: 7,
    });
  });

  it("rejects spatial fields via schema", () => {
    const result = parseSeamFile(
      JSON.stringify({
        type: "composition",
        children: [
          {
            type: "data",
            data: {},
            duration: 1,
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
            type: "data",
            data: {},
            duration: 1,
            filters: [{ type: "adjust", brightness: 0.5 }],
          },
        ],
      })
    );
    expect(result.success).toBe(false);
  });

  it("preserves tags through resolution when present", () => {
    const result = parseSeamFile(
      JSON.stringify({
        type: "composition",
        children: [
          {
            type: "data",
            data: { foo: 1 },
            duration: 1,
            tags: ["marker", "punchline"],
          },
        ],
      })
    );
    expect(result.success).toBe(true);
    if (result.success) {
      const node = resolveComposition(result.data).children[0];
      if (node.type === "data") {
        expect(node.tags).toEqual(["marker", "punchline"]);
      }
    }
  });

  it("omits tags from resolved output when absent or empty", () => {
    const result = parseSeamFile(
      JSON.stringify({
        type: "composition",
        children: [{ type: "data", data: {}, duration: 1 }],
      })
    );
    expect(result.success).toBe(true);
    if (result.success) {
      const node = resolveComposition(result.data).children[0];
      if (node.type === "data") {
        expect(node.tags).toBeUndefined();
      }
    }
  });

  it("rejects non-string tags", () => {
    const result = parseSeamFile(
      JSON.stringify({
        type: "composition",
        children: [
          { type: "data", data: {}, duration: 1, tags: ["ok", 7] },
        ],
      })
    );
    expect(result.success).toBe(false);
  });
});

import { describe, it, expect } from "vitest";
import { validate } from "../validate.js";
import {
  buildFlat,
  interpolateFrames,
  type FilledFrame,
} from "../animation/interp.js";

describe("graphic schema validation", () => {
  it("accepts a minimal graphic with one keyframe", () => {
    const result = validate({
      type: "composition",
      children: [
        {
          type: "graphic",
          duration: 2,
          frames: [
            [0, [{ type: "Rect", left: 0, top: 0, width: 100, height: 100 }]],
          ],
        },
      ],
    });
    expect(result.success).toBe(true);
  });

  it("accepts Length stamps but rejects Length box dims on inner objects", () => {
    // Frame stamps are seam-domain — Length is fine.
    const stampsOk = validate({
      type: "composition",
      children: [
        {
          type: "graphic",
          duration: 2,
          contentWidth: 1080,
          contentHeight: 1920,
          frames: [
            ["0%", [{ type: "Rect", left: 100, top: 100, width: 500, height: 500, fill: "tomato" }]],
            ["100%", [{ type: "Rect", left: 500, top: 200, width: 300, height: 300, fill: "navy" }], "ease-out"],
          ],
        },
      ],
    });
    expect(stampsOk.success).toBe(true);

    // Inner-object props are fabric-domain — Length strings should not
    // round-trip through the schema.
    const innerLengthRejected = validate({
      type: "composition",
      children: [
        {
          type: "graphic",
          duration: 2,
          frames: [
            [0, [{ type: "Rect", left: "10%", top: 0, width: 100, height: 100 }]],
          ],
        },
      ],
    });
    expect(innerLengthRejected.success).toBe(false);
  });

  it("accepts a graphic with clips and a Clip-instance keyframe object", () => {
    const result = validate({
      type: "composition",
      children: [
        {
          type: "graphic",
          duration: 3,
          clips: [
            {
              id: "wave",
              type: "graphic",
              duration: 1,
              loop: true,
              frames: [
                [
                  0,
                  [{ type: "Circle", radius: 20, fill: "magenta" }],
                ],
                [
                  1,
                  [{ type: "Circle", radius: 40, fill: "magenta" }],
                ],
              ],
            },
          ],
          frames: [
            [
              0,
              [
                {
                  type: "Clip",
                  id: "w1",
                  clipId: "wave",
                  startPosition: 0,
                  left: 100,
                  top: 100,
                },
              ],
            ],
          ],
        },
      ],
    });
    expect(result.success).toBe(true);
  });

  it("accepts a Map element with paths", () => {
    const result = validate({
      type: "composition",
      children: [
        {
          type: "graphic",
          duration: 2,
          frames: [
            [
              0,
              [
                {
                  type: "Map",
                  source: "tokyo.pmtiles",
                  latitude: 34.25,
                  longitude: 133.08,
                  zoom: 12,
                  width: 480,
                  height: 320,
                  paths: [
                    {
                      color: "tomato",
                      points: [
                        [132.45, 33.84],
                        [132.46, 33.85],
                        [132.48, 33.87],
                      ],
                      progress: 0,
                      lineWidth: 4,
                    },
                  ],
                },
              ],
            ],
          ],
        },
      ],
    });
    expect(result.success).toBe(true);
  });

  it("rejects a graphic without frames", () => {
    const result = validate({
      type: "composition",
      children: [{ type: "graphic", duration: 2 }],
    });
    expect(result.success).toBe(false);
  });

  it("rejects a Map without a source", () => {
    const result = validate({
      type: "composition",
      children: [
        {
          type: "graphic",
          duration: 2,
          frames: [
            [0, [{ type: "Map", latitude: 0, longitude: 0, zoom: 1 }]],
          ],
        },
      ],
    });
    expect(result.success).toBe(false);
  });

  it("rejects a MapPath without color or points", () => {
    const result = validate({
      type: "composition",
      children: [
        {
          type: "graphic",
          duration: 2,
          frames: [
            [
              0,
              [
                {
                  type: "Map",
                  source: "a.pmtiles",
                  paths: [{ color: "red", points: [[0, 0]] }],
                },
              ],
            ],
          ],
        },
      ],
    });
    expect(result.success).toBe(false);
  });
});

describe("interp engine", () => {
  function makeFrame(tree: Record<string, unknown>[], frameIndex: number): FilledFrame {
    const flat: Record<string, Record<string, unknown>> = {};
    buildFlat(tree, "", flat);
    return { tree, flat, frameIndex };
  }

  it("lerps numeric props with linear easing by default", () => {
    const prev = makeFrame(
      [{ id: "a", type: "Rect", left: 0, top: 0, width: 100, height: 100 }],
      0,
    );
    const next = makeFrame(
      [{ id: "a", type: "Rect", left: 200, top: 50, width: 100, height: 100 }],
      1,
    );
    const snap = interpolateFrames(prev, next, 0.5);
    expect(snap.a.left).toBeCloseTo(100);
    expect(snap.a.top).toBeCloseTo(25);
  });

  it("respects per-object easing override (from the destination keyframe)", () => {
    // Easing governs the tween *arriving at* a keyframe, so it's authored on
    // the `next` object (matches core's sampleFrames + every animated value).
    const prev = makeFrame([{ id: "a", type: "Rect", left: 0 }], 0);
    const next = makeFrame(
      [{ id: "a", type: "Rect", left: 100, easing: "ease-in" }],
      1,
    );
    // ease-in (cubic): t=0.5 → 0.5^3 = 0.125
    const snap = interpolateFrames(prev, next, 0.5, "linear");
    expect(snap.a.left).toBeCloseTo(12.5, 1);
  });

  it("falls back to frame-level easing when object has none", () => {
    const prev = makeFrame([{ id: "a", type: "Rect", left: 0 }], 0);
    const next = makeFrame([{ id: "a", type: "Rect", left: 100 }], 1);
    const snap = interpolateFrames(prev, next, 0.5, "ease-out");
    // ease-out (cubic): t=0.5 → 1 - (1-0.5)^3 = 0.875
    expect(snap.a.left).toBeCloseTo(87.5, 1);
  });

  it("applies revolutions + angleDirection to angle", () => {
    const prev = makeFrame([{ id: "a", type: "Rect", angle: 0 }], 0);
    const next = makeFrame(
      [{ id: "a", type: "Rect", angle: 90, revolutions: 1, angleDirection: "cw" }],
      1,
    );
    // 1 full cw turn + 90 = 450 total. At t=0.5: 225.
    const snap = interpolateFrames(prev, next, 0.5);
    expect(snap.a.angle).toBeCloseTo(225);
  });

  it("freezes at prev when next is missing the same id", () => {
    const prev = makeFrame(
      [
        { id: "a", type: "Rect", left: 0 },
        { id: "b", type: "Rect", left: 0 },
      ],
      0,
    );
    const next = makeFrame([{ id: "a", type: "Rect", left: 100 }], 1);
    const snap = interpolateFrames(prev, next, 0.5);
    expect(snap.a.left).toBeCloseTo(50); // lerped
    expect(snap.b.left).toBe(0); // frozen at prev
  });

  it("interpolates Map zoom in scale-space (linear in 2^-zoom)", () => {
    const prev = makeFrame(
      [{ id: "m", type: "Map", source: "x", latitude: 0, longitude: 0, zoom: 4 }],
      0,
    );
    const next = makeFrame(
      [{ id: "m", type: "Map", source: "x", latitude: 0, longitude: 0, zoom: 8 }],
      1,
    );
    const snap = interpolateFrames(prev, next, 0.5);
    // s0 = 2^-4 = 0.0625, s1 = 2^-8 = 0.00390625
    // scale at t=0.5 = (0.0625 + 0.00390625) / 2 = 0.033203125
    // zoom = -log2(0.033203125) ≈ 4.9124
    expect(snap.m.zoom as number).toBeCloseTo(4.9124, 3);
    // Sanity: NOT linear zoom (which would be 6.0).
    expect(snap.m.zoom as number).toBeLessThan(6.0);
  });

  it("falls back to plain numeric lerp for non-Map zoom keys", () => {
    // A Rect with an authored `zoom` prop (e.g. some unrelated custom
    // attribute) shouldn't trigger the log-scale branch.
    const prev = makeFrame([{ id: "r", type: "Rect", zoom: 0 }], 0);
    const next = makeFrame([{ id: "r", type: "Rect", zoom: 10 }], 1);
    const snap = interpolateFrames(prev, next, 0.5);
    expect(snap.r.zoom as number).toBeCloseTo(5);
  });

  it("interpolates Map paths color + progress + lineWidth per index", () => {
    const prev = makeFrame(
      [
        {
          id: "m",
          type: "Map",
          source: "a.pmtiles",
          paths: [
            {
              color: "rgb(0, 0, 0)",
              points: [[0, 0], [1, 1]],
              progress: 0,
              lineWidth: 2,
            },
          ],
        },
      ],
      0,
    );
    const next = makeFrame(
      [
        {
          id: "m",
          type: "Map",
          source: "a.pmtiles",
          paths: [
            {
              color: "rgb(255, 255, 255)",
              points: [[0, 0], [1, 1]],
              progress: 1,
              lineWidth: 10,
            },
          ],
        },
      ],
      1,
    );
    const snap = interpolateFrames(prev, next, 0.5);
    const path = (snap.m.paths as Array<Record<string, unknown>>)[0];
    expect(path.progress).toBeCloseTo(0.5);
    expect(path.lineWidth).toBeCloseTo(6);
    // points stay from prev (discrete)
    expect(path.points).toEqual([[0, 0], [1, 1]]);
    // color halfway between black and white = ~127.5 grey
    expect(path.color).toMatch(/rgb\(12[78], 12[78], 12[78]\)/);
  });

  it("path keys use id when present, positional index otherwise", () => {
    const tree: Record<string, unknown>[] = [
      { id: "named", type: "Rect" },
      { type: "Rect" },
    ];
    const flat: Record<string, Record<string, unknown>> = {};
    buildFlat(tree, "", flat);
    expect(Object.keys(flat).sort()).toEqual(["1", "named"]);
  });

  it("group children get nested paths", () => {
    const tree: Record<string, unknown>[] = [
      {
        id: "g",
        type: "Group",
        objects: [
          { id: "inner", type: "Rect" },
          { type: "Circle" },
        ],
      },
    ];
    const flat: Record<string, Record<string, unknown>> = {};
    buildFlat(tree, "", flat);
    expect(Object.keys(flat).sort()).toEqual(["g", "g.1", "g.inner"]);
  });
});

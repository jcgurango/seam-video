import { describe, it, expect } from "vitest";
import { fillFrame } from "../graphic/fill.js";
import {
  precomputeGraphicPlayback,
  snapshotAt,
} from "../graphic/playback.js";
import {
  renderSnapshotToPng,
  renderFilledFrameToPng,
} from "../graphic/render.js";

describe("graphic render", () => {
  it("produces a non-empty PNG for a single rect", async () => {
    const filled = await fillFrame(
      [{ type: "Rect", left: 10, top: 10, width: 80, height: 80, fill: "tomato" }],
      0,
    );
    const buf = await renderFilledFrameToPng(filled, {
      contentWidth: 100,
      contentHeight: 100,
    });
    expect(buf.length).toBeGreaterThan(100);
    // PNG magic bytes.
    expect(buf[0]).toBe(0x89);
    expect(buf[1]).toBe(0x50);
    expect(buf[2]).toBe(0x4e);
    expect(buf[3]).toBe(0x47);
  }, 15000);

  it("interpolates between two keyframes mid-pair", async () => {
    const playback = await precomputeGraphicPlayback({
      duration: 1,
      frames: [
        [0, [{ id: "r", type: "Rect", left: 0, top: 0, width: 50, height: 50, fill: "red" }]],
        [1, [{ id: "r", type: "Rect", left: 100, top: 0, width: 50, height: 50, fill: "red" }]],
      ],
    });
    const snap = snapshotAt(playback, 0.5);
    expect((snap.r.left as number)).toBeCloseTo(50);
    const buf = await renderSnapshotToPng(snap, playback.filledFrames[0].tree, {
      contentWidth: 200,
      contentHeight: 100,
    });
    expect(buf.length).toBeGreaterThan(100);
  }, 15000);

  it("renders a Map placeholder without crashing", async () => {
    const filled = await fillFrame(
      [
        {
          type: "Map",
          source: "tokyo.pmtiles",
          left: 0,
          top: 0,
          width: 200,
          height: 150,
          latitude: 34.25,
          longitude: 133.08,
          zoom: 12,
        },
      ],
      0,
    );
    const buf = await renderFilledFrameToPng(filled, {
      contentWidth: 200,
      contentHeight: 150,
    });
    expect(buf.length).toBeGreaterThan(100);
  }, 15000);

  it("materializes a Clip instance from a clipDef when context is supplied", async () => {
    const { precomputeClipPlayback } = await import("../graphic/clip.js");
    const outerFrames = [
      [
        0,
        [
          {
            id: "w1",
            type: "Clip",
            clipId: "wave",
            startPosition: 0,
            left: 50,
            top: 50,
          },
        ],
      ],
    ] as ReadonlyArray<ReadonlyArray<unknown>>;
    const clipDef = {
      id: "wave",
      duration: 1,
      loop: true,
      contentWidth: 100,
      contentHeight: 100,
      frames: [
        [0, [{ id: "dot", type: "Rect", left: 10, top: 10, width: 30, height: 30, fill: "magenta" }]],
        [1, [{ id: "dot", type: "Rect", left: 60, top: 10, width: 30, height: 30, fill: "magenta" }]],
      ] as ReadonlyArray<ReadonlyArray<unknown>>,
    };
    const clipPlaybacks = new Map();
    clipPlaybacks.set("wave", await precomputeClipPlayback(clipDef));
    const clipDefs = new Map();
    clipDefs.set("wave", clipDef);

    const filled = await fillFrame(outerFrames[0][1] as unknown[], 0);
    const buf = await renderSnapshotToPng(filled.flat, filled.tree, {
      contentWidth: 200,
      contentHeight: 200,
      context: {
        outerT: 0.5, // mid-clip
        outerFrames,
        clipPlaybacks,
        clipDefs,
      },
    });
    expect(buf.length).toBeGreaterThan(100);
  }, 15000);

  it("respects percentage stamps against the graphic duration", async () => {
    const playback = await precomputeGraphicPlayback({
      duration: 2,
      frames: [
        ["0%", [{ id: "r", type: "Rect", left: 0, fill: "red" }]],
        ["100%", [{ id: "r", type: "Rect", left: 100, fill: "red" }]],
      ],
    });
    const snap = snapshotAt(playback, 1); // halfway
    expect(snap.r.left as number).toBeCloseTo(50);
  });
});

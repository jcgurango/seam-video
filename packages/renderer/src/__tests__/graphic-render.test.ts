import { describe, it, expect } from "vitest";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCanvas } from "canvas";
import { buildFlat } from "@seam/core";
import { fillFrame } from "../graphic/fill.js";
import {
  precomputeGraphicPlayback,
  snapshotAt,
  treeAt,
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

  it("renders a graphic Image from a filesystem path without hanging", async () => {
    // Regression: fabric/node's image loader HANGS forever on a bare absolute
    // path (the load promise never settles → the whole render silently drains
    // the event loop and exits). `resolveImageFlat` must hand it a file:// URL.
    // If that regresses, this test times out rather than passing.
    const dir = await mkdtemp(join(tmpdir(), "seam-img-"));
    const imgPath = join(dir, "dot.png");
    const c = createCanvas(8, 8);
    const cx = c.getContext("2d");
    cx.fillStyle = "magenta";
    cx.fillRect(0, 0, 8, 8);
    await writeFile(imgPath, c.toBuffer("image/png"));

    // Build the frame with buildFlat (pure, no image I/O) so the test setup
    // itself doesn't hit the fill-time load — the fix under test is the
    // render-time resolution in renderSnapshotToPng.
    const tree = [
      { type: "Image", id: "img", src: imgPath, width: 8, height: 8, left: 0, top: 0 },
    ];
    const flat: Record<string, Record<string, unknown>> = {};
    buildFlat(tree, "", flat);

    const buf = await renderSnapshotToPng(flat, tree, {
      contentWidth: 16,
      contentHeight: 16,
    });
    expect(buf.length).toBeGreaterThan(100);
    expect(buf[0]).toBe(0x89); // PNG magic
  }, 15000);

  it("structure follows the prev keyframe — a later-introduced object appears at its frame", async () => {
    const playback = await precomputeGraphicPlayback({
      duration: 2,
      frames: [
        [0, [{ id: "a", type: "Rect", left: 0, top: 0, width: 10, height: 10 }]],
        [
          1,
          [
            { id: "a", type: "Rect", left: 0, top: 0, width: 10, height: 10 },
            { id: "b", type: "Circle", left: 50, top: 50, radius: 5 },
          ],
        ],
      ],
    });
    const ids = (t: number) =>
      treeAt(playback, t).map((o) => (o as { id?: string }).id);
    // Before frame 1, the structure is just frame 0 (no "b" yet) — the bug was
    // that frame 0's tree was used for ALL times, so "b" never rendered.
    expect(ids(0)).toEqual(["a"]);
    expect(ids(0.5)).toEqual(["a"]);
    // Once frame 1 is reached, "b" is in the structure AND the snapshot.
    expect(ids(1)).toEqual(["a", "b"]);
    expect(snapshotAt(playback, 1).b).toBeDefined();
  });

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

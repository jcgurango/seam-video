import { describe, it, expect } from "vitest";
import type { SeamFile } from "@seam/core";
import { buildExportPlan, mapDocumentSources } from "../exportHelpers.js";
import { basename } from "../pathUtils.js";
import { createSeam } from "@seam/core";
import { map } from "@seam/extension-map";

// The Map extension contributes a node type with a media `source`.
const seam = createSeam([map]);

describe("mapDocumentSources", () => {
  const doc: SeamFile = {
    type: "composition",
    bin: [
      {
        id: "intro",
        children: [{ type: "clip", source: "bins/intro.mp4", in: 0, out: 2 }],
      },
    ],
    children: [
      { type: "clip", source: "media/a.mp4", in: 0, out: 5 },
      {
        type: "composition",
        children: [{ type: "audio", source: "media/voice.wav", in: 0, out: 3 }],
      },
      {
        type: "map",
        source: "media/world.pmtiles",
        duration: 4,
        start: 0,
        children: [
          { type: "static", source: "media/logo.png", duration: 2, start: 1 },
        ],
      },
    ],
  } as SeamFile;

  it("maps sources across children, nested comps, map children AND bin bodies", () => {
    const seen: string[] = [];
    const out = mapDocumentSources(seam, doc, (src) => {
      seen.push(src);
      return `X/${src}`;
    });
    expect(seen.sort()).toEqual([
      "bins/intro.mp4",
      "media/a.mp4",
      "media/logo.png",
      "media/voice.wav",
      "media/world.pmtiles",
    ]);
    expect(out.children?.[0]).toMatchObject({ source: "X/media/a.mp4" });
    const nested = out.children?.[1];
    expect(nested?.type === "composition" && nested.children?.[0]).toMatchObject({
      source: "X/media/voice.wav",
    });
    const map = out.children?.[2];
    expect(map).toMatchObject({ source: "X/media/world.pmtiles" });
    expect(map?.type === "map" && map.children?.[0]).toMatchObject({
      source: "X/media/logo.png",
    });
    expect(out.bin?.[0].children[0]).toMatchObject({ source: "X/bins/intro.mp4" });
    // Immutability: the input document is untouched.
    expect(doc.children?.[0]).toMatchObject({ source: "media/a.mp4" });
  });

  it("applies the import-style flatten + rename mapping", () => {
    const renameMap = new Map([["a.mp4", "a-1.mp4"]]);
    const out = mapDocumentSources(seam, doc, (src) => {
      if (/^(https?:|blob:|data:)/.test(src)) return src;
      const flat = basename(src);
      return renameMap.get(flat) ?? flat;
    });
    expect(out.children?.[0]).toMatchObject({ source: "a-1.mp4" });
    const map = out.children?.[2];
    expect(map?.type === "map" && map.children?.[0]).toMatchObject({ source: "logo.png" });
    expect(out.bin?.[0].children[0]).toMatchObject({ source: "intro.mp4" });
  });
});

describe("buildExportPlan", () => {
  it("flattens to basenames, renames collisions, and bundles bin-only clips", () => {
    const doc: SeamFile = {
      type: "composition",
      bin: [
        {
          id: "b",
          children: [{ type: "clip", source: "bins/only-in-bin.mp4", in: 0, out: 1 }],
        },
      ],
      children: [
        { type: "clip", source: "dirA/take.mp4", in: 0, out: 1 },
        { type: "clip", source: "dirB/take.mp4", in: 0, out: 1 },
      ],
    } as SeamFile;

    const plan = buildExportPlan(seam, doc);
    const names = plan.entries.map((e) => e.exportName).sort();
    expect(names).toEqual(["only-in-bin.mp4", "take-1.mp4", "take.mp4"]);
    // Both document references follow their (renamed) entries.
    expect(plan.document.children?.[0]).toMatchObject({ source: "take.mp4" });
    expect(plan.document.children?.[1]).toMatchObject({ source: "take-1.mp4" });
    expect(plan.document.bin?.[0].children[0]).toMatchObject({
      source: "only-in-bin.mp4",
    });
  });
});

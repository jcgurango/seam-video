import { describe, expect, it } from "vitest";
import type { Child, SeamFile } from "@seam/core";
import {
  binEntryAsComposition,
  buildCCPreviewDoc,
  buildCCSpliceChildren,
  resolveCCWords,
} from "../ccCutTool.js";

const root: SeamFile = { type: "composition", contentWidth: 1920, contentHeight: 1080, children: [] };

const phrase = (start: unknown, duration: number, words: [string, number, number][], extra = {}): Child =>
  ({
    type: "data",
    tags: ["transcription", "whisper"],
    data: {
      text: words.map((w) => w[0]).join(" "),
      duration: words[words.length - 1][2],
      words: words.map(([text, s, e]) => ({ text, start: s, end: e })),
    },
    start,
    duration,
    ...extra,
  }) as unknown as Child;

describe("resolveCCWords", () => {
  it("places each phrase's words where its data node resolves", () => {
    const entry = {
      id: "take",
      children: [
        { type: "clip", source: "a.mp4", id: "c", in: 10, out: 20 } as Child,
        // Second phrase first in the array: colour index follows array order.
        phrase("c@15", 2, [["three", 0, 1], ["four", 1, 2]]),
        phrase("c@11", 2, [["one", 0, 0.5], ["two", 1, 2]]),
      ],
    };
    expect(resolveCCWords(entry, root)).toEqual([
      { text: "one", start: 1, end: 1.5, transcriptionIndex: 1 },
      { text: "two", start: 2, end: 3, transcriptionIndex: 1 },
      { text: "three", start: 5, end: 6, transcriptionIndex: 0 },
      { text: "four", start: 6, end: 7, transcriptionIndex: 0 },
    ]);
  });

  it("scales words into the node's span and honours its offset", () => {
    // 2× clip: source 12..14 plays at [1, 2); the phrase lasts 1 output second
    // for 2 recorded seconds, and is nudged by +0.5.
    const entry = {
      id: "take",
      children: [
        { type: "clip", source: "a.mp4", id: "c", in: 10, out: 20, speed: 2 } as Child,
        phrase("c@12", 1, [["a", 0, 1], ["b", 1, 2]], { offset: 0.5 }),
      ],
    };
    expect(resolveCCWords(entry, root)).toEqual([
      { text: "a", start: 1.5, end: 2, transcriptionIndex: 0 },
      { text: "b", start: 2, end: 2.5, transcriptionIndex: 0 },
    ]);
  });

  it("ignores non-transcription data and returns [] when the entry can't resolve", () => {
    const marker = { type: "data", data: { words: [] }, tags: ["marker"], duration: 1 } as Child;
    expect(resolveCCWords({ id: "x", children: [marker] }, root)).toEqual([]);
    expect(
      resolveCCWords({ id: "x", children: [phrase("missing@1", 1, [["a", 0, 1]])] }, root),
    ).toEqual([]);
  });
});

describe("CC preview / splice documents", () => {
  const entry = { id: "take", children: [{ type: "clip", source: "a.mp4", in: 0, out: 10 } as Child] };

  it("wraps the bin entry's children, carrying the canvas size", () => {
    expect(binEntryAsComposition(entry, root)).toEqual({
      type: "composition",
      children: entry.children,
      contentWidth: 1920,
      contentHeight: 1080,
    });
  });

  it("previews the whole entry with no selection, one windowed copy per selection otherwise", () => {
    expect(buildCCPreviewDoc(entry, root, []).children).toEqual([
      { type: "composition", children: entry.children },
    ]);
    expect(
      buildCCPreviewDoc(entry, root, [
        { start: 1, end: 2 },
        { start: 5, end: 7 },
      ]).children,
    ).toEqual([
      { type: "composition", children: entry.children, in: 1, out: 2 },
      { type: "composition", children: entry.children, in: 5, out: 7 },
    ]);
  });

  it("splices bin references as a plain run (no start / offset)", () => {
    expect(buildCCSpliceChildren(entry, "take", [{ start: 1, end: 2 }])).toEqual([
      { type: "composition", binItem: "take", in: 1, out: 2 },
    ]);
  });
});

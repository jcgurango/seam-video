import { describe, it, expect } from "vitest";
import { createSeam, type Composition } from "@seam/core";
import { captions, captionsFromTranscript, cutWords, innerToGlobal } from "../index.js";

const seam = createSeam([captions]);

/** Resolve `comp` the way the editor's `context.resolve` does: on its own,
 *  inside a wrapper, with its window applied. */
const standalone = (comp: object) =>
  seam.resolveComposition({ type: "composition", children: [comp] } as unknown as Composition).children[0];

const SEGMENTS = [
  {
    start: 1,
    end: 2,
    text: "one two",
    words: [
      { start: 1, end: 1.4, text: "one" },
      { start: 1.5, end: 2, text: "two" },
    ],
  },
  { start: 4, end: 5, text: "three" },
  {
    start: 7,
    end: 8,
    text: "four five",
    words: [
      { start: 7, end: 7.5, text: "four" },
      { start: 7.5, end: 8, text: "five" },
    ],
  },
];

const body = () => [
  { type: "rect", duration: 10 },
  ...captionsFromTranscript(SEGMENTS, { kind: "inside", anchorBase: 0 }),
];

describe("cutWords", () => {
  it("lists every word in inner time; a caption without word timings is one word", () => {
    const words = cutWords(standalone({ type: "composition", children: body() }), 0);
    expect(words.map((w) => [w.text, w.start, w.end, w.cue])).toEqual([
      ["one", 1, 1.4, 0],
      ["two", 1.5, 2, 0],
      ["three", 4, 5, 1],
      ["four", 7, 7.5, 2],
      ["five", 7.5, 8, 2],
    ]);
  });

  it("a windowed composition offers only the words it still shows, still in inner time", () => {
    const comp = { type: "composition", in: 3, out: 7.5, children: body() };
    const words = cutWords(standalone(comp), 3);
    expect(words.map((w) => [w.text, w.start])).toEqual([
      ["three", 4],
      ["four", 7],
    ]);
  });

  it("captions a nested composition keeps to itself are not offered", () => {
    const comp = {
      type: "composition",
      children: [{ type: "composition", captions: "off", children: body() }],
    };
    expect(cutWords(standalone(comp), 0)).toEqual([]);
  });

  it("is empty for anything but a composition", () => {
    expect(cutWords(null, 0)).toEqual([]);
    expect(cutWords(standalone({ type: "rect", duration: 1 }), 0)).toEqual([]);
  });
});

describe("innerToGlobal", () => {
  it("maps a piece's window linearly onto where it plays", () => {
    expect(innerToGlobal(5, { in: 4, out: 8 }, { start: 10, end: 12 })).toBe(10.5);
    expect(innerToGlobal(4, { in: 4, out: 4 }, { start: 10, end: 12 })).toBe(10);
  });
});

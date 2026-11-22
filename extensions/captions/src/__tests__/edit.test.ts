import { describe, it, expect } from "vitest";
import { createSeam, resolveSpatial, type Child, type Composition, type SurfaceView } from "@seam/core";
import {
  captionAsText,
  captionLength,
  captions,
  captionsFromTranscript,
  collectCaptions,
  reauthoredCaptions,
  type CaptionNode,
} from "../index.js";

const seam = createSeam([captions]);
const resolve = (children: unknown[], root: object = {}) =>
  resolveSpatial(seam.resolveComposition({ type: "composition", ...root, children } as unknown as Composition), 1080, 1920);
const valid = (children: unknown[]) => {
  const r = seam.validate({ type: "composition", children });
  return r.success ? true : r.errors.join("\n");
};

const SEGMENTS = [
  {
    start: 2,
    end: 3.5,
    text: " It's gonna rain.",
    words: [
      { start: 2, end: 2.25, text: " It's" },
      { start: 2.25, end: 2.5, text: " gonna" },
      { start: 3, end: 3.5, text: " rain." },
    ],
  },
  { start: 5, end: 6, text: "Okay." },
];

describe("captionsFromTranscript", () => {
  it("inside a composition: placed by number in its inner time, words as children", () => {
    const out = captionsFromTranscript(SEGMENTS, { kind: "inside", anchorBase: 0 });
    expect(out).toEqual([
      {
        type: "caption",
        start: 2,
        duration: 1.5,
        children: [
          { type: "word", text: "It's", duration: 0.25 },
          { type: "word", text: "gonna", duration: 0.25 },
          { type: "word", text: "rain.", duration: 0.5, offset: 0.5 },
        ],
      },
      { type: "caption", start: 5, duration: 1, text: "Okay." },
    ]);
    expect(valid([{ type: "composition", children: [{ type: "rect", duration: 10 }, ...out] }])).toBe(true);
  });

  it("beside a clip: anchored to its source time, lengths in output seconds at its rate", () => {
    const out = captionsFromTranscript(SEGMENTS, { kind: "beside", id: "a", anchorBase: 10, rate: 2 });
    expect(out[0]).toMatchObject({ start: "a@12", duration: 0.75 });
    expect((out[0].children as unknown as { duration: number; offset?: number }[]).map((w) => [w.duration, w.offset])).toEqual([
      [0.125, undefined],
      [0.125, undefined],
      [0.25, 0.25],
    ]);
    expect(out[1]).toMatchObject({ start: "a@15", duration: 0.5, text: "Okay." });
    // They land on the footage: source second 12 of a 2× clip starting at in=10.
    const t = resolve([{ type: "clip", id: "a", source: "a.mp4", in: 10, out: 30, speed: 2 }, ...out]);
    expect(t.children[1]).toMatchObject({ timelineStart: 1, timelineEnd: 1.75 });
  });

  it("drops empty segments and blank words", () => {
    expect(
      captionsFromTranscript(
        [
          { start: 0, end: 0, text: "x" },
          { start: 0, end: 1, text: "   " },
          { start: 1, end: 2, text: "hi", words: [{ start: 1, end: 1.5, text: " " }, { start: 1.5, end: 2, text: "hi" }] },
        ],
        { kind: "inside", anchorBase: 0 },
      ),
    ).toEqual([{ type: "caption", start: 1, duration: 1, children: [{ type: "word", text: "hi", duration: 0.5, offset: 0.5 }] }]);
  });
});

describe("reauthoredCaptions", () => {
  // A composition showing inner seconds 1–4 of a body with one caption whose
  // words sit at 0–1, 1–2, 2–3, 3–4.
  const body = [
    { type: "rect", duration: 10 },
    {
      type: "caption",
      start: 0,
      speaker: "faye",
      children: ["one", "two", "three", "four"].map((text) => ({ type: "word", text, duration: 1 })),
    },
  ];
  const resolvedComp = (extra: object = {}) => resolve([{ type: "composition", in: 1, out: 4, children: body, ...extra }]).children[0];

  it("writes out what the composition shows, anchored to its source time", () => {
    const out = reauthoredCaptions(resolvedComp(), { id: "c", inTime: 1 });
    expect(out).toEqual([
      {
        type: "caption",
        start: "c@1",
        duration: 3,
        speaker: "faye",
        children: [
          { type: "word", text: "two", duration: 1 },
          { type: "word", text: "three", duration: 1 },
          { type: "word", text: "four", duration: 1 },
        ],
      },
    ]);
  });

  it("the written captions land exactly where the bubbled ones were", () => {
    const comp = { type: "composition", id: "c", in: 1, out: 4, children: body };
    const lead = { type: "rect", duration: 2 };
    const before = collectCaptions({ children: resolve([lead, comp]).children } as SurfaceView);
    const written = reauthoredCaptions(resolvedComp(), { id: "c", inTime: 1 });
    const after = collectCaptions({
      children: resolve([lead, { ...comp, captions: "off" }, ...written]).children,
    } as SurfaceView);
    const brief = (cs: typeof before) => cs.map((c) => [c.text, c.start, c.end, c.words.map((w) => [w.text, w.start, w.end])]);
    expect(brief(after)).toEqual(brief(before));
    expect(valid([lead, { ...comp, captions: "off" }, ...written])).toBe(true);
  });

  it("applies the surface's maxChars and the composition's speed", () => {
    const out = reauthoredCaptions(resolvedComp({ speed: 2 }), { id: "c", inTime: 1 }, { maxChars: 9 });
    expect(out.map((c) => [c.start, c.duration, (c.children as unknown as { text: string }[]).map((w) => w.text)])).toEqual([
      ["c@1", 1, ["two", "three"]],
      ["c@3", 0.5, ["four"]],
    ]);
  });

  it("nothing inside → nothing", () => {
    expect(reauthoredCaptions(resolve([{ type: "composition", children: [{ type: "rect", duration: 1 }] }]).children[0], { id: "c", inTime: 0 })).toEqual([]);
  });
});

describe("captionAsText", () => {
  it("keeps the slot and length and takes the look a surface would give it", () => {
    const caption: CaptionNode = {
      type: "caption",
      id: "k",
      start: "a@3",
      offset: 0.1,
      speaker: "faye",
      style: { fontStyle: "italic" },
      children: [
        { type: "word", text: "hello", duration: 0.5 },
        { type: "word", text: "there", duration: 0.5, offset: 0.25 },
      ] as unknown as Child[],
    };
    const text = captionAsText(caption, {
      fontSize: 50,
      color: "white",
      maxChars: 20,
      speakers: { faye: { color: "pink" } },
    });
    expect(text).toEqual({
      type: "text",
      text: "hello there",
      duration: 1.25,
      id: "k",
      start: "a@3",
      offset: 0.1,
      fontSize: 50,
      color: "pink",
      fontStyle: "italic",
    });
    expect(valid([{ type: "clip", id: "a", source: "a.mp4", in: 0, out: 9 }, text])).toBe(true);
  });

  it("an authored duration wins over the words' extent", () => {
    expect(captionLength({ type: "caption", duration: 4, children: [{ type: "word", text: "x", duration: 1 }] as unknown as Child[] })).toBe(4);
    expect(captionLength({ type: "caption", text: "x", duration: 2 })).toBe(2);
  });
});

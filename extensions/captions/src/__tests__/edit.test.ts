import { describe, it, expect } from "vitest";
import { createSeam, resolveSpatial, type Child, type Composition, type SurfaceView } from "@seam/core";
import {
  captionAsText,
  captionLength,
  captions,
  DEFAULT_CAPTION_STYLE,
  captionsFromTranscript,
  collectCaptions,
  reauthoredCaptions,
  mergeCaptions,
  repairWordTimings,
  resizeCaption,
  splitCaption,
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
        // No `duration`: a caption with words is as long as they are.
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
    expect(out[0]).toMatchObject({ start: "a@12" });
    expect(out[0].duration).toBeUndefined();
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
    ).toEqual([{ type: "caption", start: 1.5, children: [{ type: "word", text: "hi", duration: 0.5 }] }]);
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
    // Lengths are the words' own, in output seconds at 2×.
    expect(
      out.map((c) => [c.start, (c.children as unknown as { text: string; duration: number }[]).map((w) => [w.text, w.duration])]),
    ).toEqual([
      ["c@1", [["two", 0.5], ["three", 0.5]]],
      ["c@3", [["four", 0.5]]],
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
      ...DEFAULT_CAPTION_STYLE,
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

describe("repairWordTimings", () => {
  const brief = (ws: { text: string; start: number; end: number }[]) => ws.map((w) => [w.text, w.start, w.end]);

  it("a zero-length word takes half of the next word", () => {
    expect(
      brief(repairWordTimings([{ text: "a", start: 1, end: 1 }, { text: "b", start: 1, end: 2 }], 1, 2)),
    ).toEqual([["a", 1, 1.5], ["b", 1.5, 2]]);
  });

  it("the last word takes half of the previous one", () => {
    expect(
      brief(repairWordTimings([{ text: "a", start: 1, end: 2 }, { text: "b", start: 2, end: 2 }], 1, 2)),
    ).toEqual([["a", 1, 1.5], ["b", 1.5, 2]]);
  });

  it("a lone zero-length word takes the whole line; with no line length it is dropped", () => {
    expect(brief(repairWordTimings([{ text: "a", start: 3, end: 3 }], 3, 4))).toEqual([["a", 3, 4]]);
    expect(repairWordTimings([{ text: "a", start: 3, end: 3 }], 3, 3)).toEqual([]);
  });

  it("no word is lost when the transcript is generated", () => {
    const out = captionsFromTranscript(
      [{ start: 0, end: 2, text: "uh hello", words: [{ start: 0, end: 0, text: "uh" }, { start: 0, end: 2, text: "hello" }] }],
      { kind: "inside", anchorBase: 0 },
    );
    expect(out[0].children).toEqual([
      { type: "word", text: "uh", duration: 1 },
      { type: "word", text: "hello", duration: 1 },
    ]);
  });
});

describe("splitCaption / resizeCaption / mergeCaptions", () => {
  const word = (text: string, duration: number, offset?: number) => ({ type: "word", text, duration, ...(offset ? { offset } : {}) });
  // one 0–1, two 1–2, (pause) three 3–4
  const caption = {
    type: "caption",
    id: "k",
    start: 5,
    speaker: "faye",
    children: [word("one", 1), word("two", 1), word("three", 1, 1)],
  } as unknown as CaptionNode;
  const texts = (c: CaptionNode) => (c.children as unknown as { text: string }[]).map((w) => w.text);

  it("cuts at the nearest word boundary and says where the right half begins", () => {
    const cut = splitCaption(caption, 2.4)!; // inside the pause
    expect(cut.left).toMatchObject({ id: "k", start: 5, speaker: "faye" });
    expect(texts(cut.left)).toEqual(["one", "two"]);
    // No placement of its own: the editor puts it `at` seconds after the original's start.
    expect(cut.right).toEqual({ type: "caption", speaker: "faye", children: [word("three", 1)] });
    expect(cut.at).toBe(3);
    // Mid-word snaps to the closer side.
    expect(texts(splitCaption(caption, 1.2)!.left)).toEqual(["one"]);
    expect(splitCaption(caption, 1.2)!.at).toBe(1);
    expect(texts(splitCaption(caption, 1.8)!.left)).toEqual(["one", "two"]);
    // Before the first boundary still cuts at it (never an empty half).
    expect(texts(splitCaption(caption, 0)!.left)).toEqual(["one"]);
  });

  it("does not cut a caption with fewer than two words", () => {
    expect(splitCaption({ type: "caption", text: "hi", duration: 1 } as CaptionNode, 0.5)).toBeNull();
    expect(splitCaption({ type: "caption", children: [word("hi", 1)] } as unknown as CaptionNode, 0.5)).toBeNull();
  });

  it("an edge drag retimes the first / last word", () => {
    const right = resizeCaption(caption, "right", 0.5);
    expect((right.children as unknown as { duration: number }[]).map((w) => w.duration)).toEqual([1, 1, 1.5]);
    const left = resizeCaption(caption, "left", 0.25);
    expect((left.children as unknown as { duration: number }[]).map((w) => w.duration)).toEqual([0.75, 1, 1]);
    expect(resizeCaption({ type: "caption", text: "hi", duration: 1 } as CaptionNode, "right", 1).duration).toBe(2);
  });

  it("merge undoes a split", () => {
    const { left, right, at } = splitCaption(caption, 2.4)!;
    expect(
      mergeCaptions([{ node: right, start: 5 + at, end: 9 }, { node: left, start: 5, end: 7 }]),
    ).toEqual(caption);
  });

  it("merge joins captions that do not touch: the earliest keeps its place, the silence becomes a pause", () => {
    const merged = mergeCaptions([
      { node: { type: "caption", start: 10, text: "later", duration: 1 } as CaptionNode, start: 10, end: 11 },
      { node: { type: "caption", start: 2, id: "first", children: [word("early", 1)] } as unknown as CaptionNode, start: 2, end: 3 },
    ]);
    expect(merged).toEqual({
      type: "caption",
      start: 2,
      id: "first",
      children: [word("early", 1), word("later", 1, 7)],
    });
  });
});

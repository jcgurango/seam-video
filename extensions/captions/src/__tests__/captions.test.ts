import { describe, it, expect } from "vitest";
import { text } from "@seam/extension-text";
import { createSeam, resolveSpatial, type Composition } from "@seam/core";
import { captions, captionText, type ResolvedCaption } from "../index.js";

const seam = createSeam([text, captions]);
const doc = (children: unknown[], root: Record<string, unknown> = {}) => ({
  type: "composition",
  ...root,
  children,
});
const word = (text: string, duration: number, extra: object = {}) => ({ type: "word", text, duration, ...extra });
const ok = (d: unknown) => {
  const r = seam.validate(d);
  return r.success ? true : r.errors.join("\n");
};

describe("captions — schema", () => {
  it("accepts a caption of words, and a caption of plain text with a duration", () => {
    expect(ok(doc([{ type: "caption", speaker: "faye", children: [word("It's", 0.22), word("gonna", 0.18)] }]))).toBe(true);
    expect(ok(doc([{ type: "caption", text: "It's gonna rain later.", duration: 1.18 }]))).toBe(true);
  });

  it("a caption needs words or a duration; its children can only be words", () => {
    expect(seam.validate(doc([{ type: "caption", text: "hi" }])).success).toBe(false);
    expect(seam.validate(doc([{ type: "caption", children: [{ type: "rect", duration: 1 }] }])).success).toBe(false);
    expect(seam.validate(doc([{ type: "caption", children: [{ type: "caption", text: "x", duration: 1 }] }])).success).toBe(false);
  });

  it("a word needs text and a duration", () => {
    expect(seam.validate(doc([{ type: "caption", children: [{ type: "word", duration: 1 }] }])).success).toBe(false);
    expect(seam.validate(doc([{ type: "caption", children: [{ type: "word", text: "hi" }] }])).success).toBe(false);
  });

  it("captions and words have no visual fields", () => {
    for (const bad of [{ opacity: 0.5 }, { translation: 10 }, { size: 10 }, { contentWidth: 100 }]) {
      expect(seam.validate(doc([{ type: "caption", text: "x", duration: 1, ...bad }])).success, JSON.stringify(bad)).toBe(false);
    }
    expect(seam.validate(doc([{ type: "caption", children: [word("x", 1, { opacity: 1 })] }])).success).toBe(false);
  });

  it("they are placed like any node: id, start anchors, offset", () => {
    expect(
      ok(
        doc([
          { type: "clip", id: "a", source: "a.mp4", in: 0, out: 10 },
          { type: "caption", start: "a@2.5", offset: 0.1, children: [word("hello", 0.4), word("there", 0.3, { offset: 0.2 })] },
        ]),
      ),
    ).toBe(true);
  });

  it("a per-caption style override is a strict subset of the text style", () => {
    expect(ok(doc([{ type: "caption", text: "LIT", duration: 1, style: { fontSize: 65, fontStyle: "italic" } }]))).toBe(true);
    expect(seam.validate(doc([{ type: "caption", text: "x", duration: 1, style: { fontSize: -1 } }])).success).toBe(false);
    expect(seam.validate(doc([{ type: "caption", text: "x", duration: 1, style: { nope: 1 } }])).success).toBe(false);
    // The derivation rule and speakers belong to the surface, not a caption.
    expect(seam.validate(doc([{ type: "caption", text: "x", duration: 1, style: { maxChars: 10 } }])).success).toBe(false);
  });

  it("routing and style are composition fields — root included — and nowhere else", () => {
    const style = {
      fontFamily: "Liberation Sans",
      fontSize: 50,
      color: "white",
      fontWeight: "bold",
      strokeColor: "black",
      strokeWidth: 12,
      verticalAlign: "bottom",
      padding: [610, 100],
      maxChars: 32,
      speakers: { faye: { color: "pink" }, nikko: { color: "#89BFF8" } },
    };
    expect(ok(doc([{ type: "composition", captions: "off", children: [] }], { captions: "show", captionStyle: style }))).toBe(true);
    expect(seam.validate(doc([{ type: "composition", captions: "loud", children: [] }])).success).toBe(false);
    expect(seam.validate(doc([{ type: "rect", duration: 1, captions: "off" }])).success).toBe(false);
    expect(seam.validate(doc([], { captionStyle: { speakers: { faye: { maxChars: 3 } } } })).success).toBe(false);
  });

  it("without the extension, none of it validates", () => {
    const bare = createSeam();
    expect(bare.validate(doc([{ type: "caption", text: "x", duration: 1 }])).success).toBe(false);
    expect(bare.validate(doc([], { captions: "show" })).success).toBe(false);
  });
});

describe("captions — resolution", () => {
  const timeline = (children: unknown[], root: Record<string, unknown> = {}) =>
    resolveSpatial(seam.resolveComposition(doc(children, root) as unknown as Composition), 1080, 1920);

  it("a caption spans its words; words sit in caption-local time with their pauses", () => {
    const t = timeline([
      { type: "rect", duration: 2 },
      { type: "caption", speaker: "faye", children: [word("It's", 0.25), word("gonna", 0.25, { offset: 0.5 }), word("rain", 0.5)] },
    ]);
    const c = t.children[1] as ResolvedCaption;
    expect(c).toMatchObject({ type: "caption", extension: true, nonVisual: true, speaker: "faye", timelineStart: 2, timelineEnd: 3.5 });
    expect(c.children.map((w) => [(w as { text?: string }).text, w.timelineStart, w.timelineEnd])).toEqual([
      ["It's", 0, 0.25],
      ["gonna", 0.75, 1],
      ["rain", 1, 1.5],
    ]);
    expect(captionText(c)).toBe("It's gonna rain");
    expect(t.duration).toBe(3.5);
  });

  it("an authored duration wins over the words' extent", () => {
    const t = timeline([{ type: "caption", duration: 4, children: [word("hi", 1)] }, { type: "rect", duration: 1 }]);
    expect(t.children[0]).toMatchObject({ timelineStart: 0, timelineEnd: 4 });
    expect(t.children[1]).toMatchObject({ timelineStart: 4 });
  });

  it("a text-only caption keeps its text and style", () => {
    const t = timeline([{ type: "caption", text: "LIT", duration: 1, style: { fontSize: 65 } }]);
    const c = t.children[0] as ResolvedCaption;
    expect(captionText(c)).toBe("LIT");
    expect(c.style).toEqual({ fontSize: 65 });
  });

  it("anchors to footage by source time, like any run head", () => {
    const t = timeline([
      { type: "clip", id: "a", source: "a.mp4", in: 5, out: 15 },
      { type: "caption", start: "a@7", children: [word("hi", 1)] },
    ]);
    // Source second 7 of a clip starting at in=5 is output second 2.
    expect(t.children[1]).toMatchObject({ timelineStart: 2, timelineEnd: 3 });
  });

  it("routing and style ride on the resolved composition and on the root", () => {
    const t = timeline(
      [{ type: "composition", captions: "off", children: [{ type: "caption", text: "x", duration: 1 }] }],
      { captionStyle: { fontSize: 50 } },
    );
    expect(t.ext).toEqual({ captionStyle: { fontSize: 50 } });
    expect((t.children[0] as { ext?: unknown }).ext).toEqual({ captions: "off" });
  });

  it("has no visual presence: no spatial data on the caption or its words", () => {
    const t = timeline([{ type: "caption", children: [word("hi", 1)] }]);
    const c = t.children[0] as ResolvedCaption;
    for (const key of ["spatial", "spatialInput", "intrinsicWidth", "objectFit"]) {
      expect(key in c, key).toBe(false);
      expect(key in c.children[0], key).toBe(false);
    }
  });
});

import { describe, it, expect } from "vitest";
import { createSeam, resolveSpatial, type Composition, type SurfaceView } from "@seam/core";
import {
  activeCues,
  captionRouting,
  captions,
  DEFAULT_CAPTION_STYLE,
  collectCaptions,
  cueStyle,
  deriveCues,
  surfaceCues,
  toSrt,
  toVtt,
  type CaptionCue,
} from "../index.js";

const seam = createSeam([captions]);
const word = (text: string, duration: number, extra: object = {}) => ({ type: "word", text, duration, ...extra });
const caption = (words: [string, number][], extra: object = {}) => ({
  type: "caption",
  children: words.map(([t, d]) => word(t, d)),
  ...extra,
});

/** The root of a document as a surface. */
function rootSurface(children: unknown[], root: Record<string, unknown> = {}): SurfaceView {
  const t = resolveSpatial(
    seam.resolveComposition({ type: "composition", ...root, children } as unknown as Composition),
    1080,
    1920,
  );
  return { root: true, children: t.children, ...(t.ext ? { ext: t.ext } : {}) };
}
const brief = (cues: CaptionCue[]) => cues.map((c) => [c.text, c.start, c.end]);

describe("collectCaptions — bubbling", () => {
  it("a caption at the surface: its span and its words, in surface time", () => {
    const cues = collectCaptions(
      rootSurface([{ type: "rect", duration: 2 }, caption([["It's", 0.25], ["raining", 0.5]], { speaker: "faye" })]),
    );
    expect(brief(cues)).toEqual([["It's raining", 2, 2.75]]);
    expect(cues[0].speaker).toBe("faye");
    expect(cues[0].words).toEqual([
      { text: "It's", start: 2, end: 2.25 },
      { text: "raining", start: 2.25, end: 2.75 },
    ]);
  });

  it("bubbles up through nested compositions, mapped through their position and speed", () => {
    const cues = collectCaptions(
      rootSurface([
        { type: "rect", duration: 1 },
        {
          type: "composition",
          speed: 2,
          children: [{ type: "composition", children: [{ type: "rect", duration: 2 }, caption([["hi", 1], ["there", 1]])] }],
        },
      ]),
    );
    // Inner 2–4 at 2× starting at root second 1.
    expect(brief(cues)).toEqual([["hi there", 2, 3]]);
    expect(cues[0].words.map((w) => [w.start, w.end])).toEqual([[2, 2.5], [2.5, 3]]);
  });

  it("a composition window drops the words outside it; the caption re-forms from the survivors", () => {
    const cues = collectCaptions(
      rootSurface([
        {
          type: "composition",
          in: 1,
          out: 3,
          // words at 0–1, 1–2, 2–3, 3–4
          children: [caption([["one", 1], ["two", 1], ["three", 1], ["four", 1]])],
        },
      ]),
    );
    expect(brief(cues)).toEqual([["two three", 0, 2]]);
    expect(cues[0].words).toEqual([
      { text: "two", start: 0, end: 1 },
      { text: "three", start: 1, end: 2 },
    ]);
  });

  it("the same footage cut twice yields each piece's own words", () => {
    const body = [caption([["a", 1], ["b", 1], ["c", 1], ["d", 1]])];
    const cues = collectCaptions(
      rootSurface([
        { type: "composition", in: 0, out: 1, children: body },
        { type: "composition", in: 2, out: 4, children: body },
      ]),
    );
    expect(brief(cues)).toEqual([["a", 0, 1], ["c d", 1, 3]]);
  });

  it("a caption cut away entirely disappears; a text-only caption keeps its text while visible", () => {
    const cues = collectCaptions(
      rootSurface([
        {
          type: "composition",
          in: 2,
          children: [caption([["gone", 1]]), { type: "caption", text: "still here", duration: 3 }],
        },
      ]),
    );
    // "gone" (0–1) is before the window; the text caption (1–4) is cut to 2–4.
    expect(brief(cues)).toEqual([["still here", 0, 2]]);
  });

  it('"off" swallows a composition\'s captions; "show" keeps them for itself', () => {
    const inner = (routing: string) => ({ type: "composition", captions: routing, children: [caption([["x", 1]])] });
    expect(brief(collectCaptions(rootSurface([inner("pass")])))).toEqual([["x", 0, 1]]);
    expect(collectCaptions(rootSurface([inner("off")]))).toEqual([]);
    expect(collectCaptions(rootSurface([inner("show")]))).toEqual([]);
  });

  it("a nested surface collects its own, in its own inner time", () => {
    const root = rootSurface([
      { type: "rect", duration: 5 },
      { type: "composition", captions: "show", children: [{ type: "rect", duration: 1 }, caption([["mine", 1]])] },
    ]);
    const comp = root.children[1] as unknown as { children: SurfaceView["children"]; ext: Record<string, unknown> };
    const surface: SurfaceView = { root: false, children: comp.children, ext: comp.ext };
    expect(brief(surfaceCues(surface))).toEqual([["mine", 1, 2]]);
    expect(surfaceCues(root)).toEqual([]);
  });

  it("a looping composition repeats its captions each cycle", () => {
    const cues = collectCaptions(
      rootSurface([{ type: "composition", duration: 3, underflow: "loop", children: [caption([["again", 1]])] }]),
    );
    expect(brief(cues)).toEqual([["again", 0, 1], ["again", 1, 2], ["again", 2, 3]]);
  });

  it("captions anchored to footage by source time follow it", () => {
    const cues = collectCaptions(
      rootSurface([
        { type: "clip", id: "a", source: "a.mp4", in: 5, out: 15 },
        caption([["hello", 1]], { start: "a@7" }),
      ]),
    );
    expect(brief(cues)).toEqual([["hello", 2, 3]]);
  });
});

describe("routing", () => {
  it("the root shows unless it says off; a composition only when it says show", () => {
    expect(captionRouting({ root: true })).toBe("show");
    expect(captionRouting({ root: true, ext: { captions: "pass" } })).toBe("show");
    expect(captionRouting({ root: true, ext: { captions: "off" } })).toBe("off");
    expect(captionRouting({ root: false })).toBe("pass");
    expect(captionRouting({ root: false, ext: { captions: "show" } })).toBe("show");
  });

  it("a root that is off shows nothing", () => {
    expect(surfaceCues(rootSurface([caption([["x", 1]])], { captions: "off" }))).toEqual([]);
  });
});

describe("deriveCues — display phrases", () => {
  const cues = collectCaptions(
    rootSurface([
      caption([["It's", 0.2], ["gonna", 0.2], ["rain", 0.3], ["later", 0.3], ["today.", 0.5]]),
      caption([["Yes.", 0.5]]),
    ]),
  );

  it("without a maximum, captions are shown as authored", () => {
    expect(brief(deriveCues(cues, {}))).toEqual([["It's gonna rain later today.", 0, 1.5], ["Yes.", 1.5, 2]]);
  });

  it("a long caption splits at word boundaries; each phrase runs until the next begins", () => {
    const out = deriveCues(cues, { maxChars: 12 });
    expect(brief(out)).toEqual([
      ["It's gonna", 0, 0.4],
      ["rain later", 0.4, 1],
      ["today.", 1, 1.5],
      ["Yes.", 1.5, 2],
    ]);
    expect(out[1].words.map((w) => w.text)).toEqual(["rain", "later"]);
  });

  it("authored boundaries are hard: short neighbours are never merged", () => {
    expect(deriveCues(cues, { maxChars: 500 })).toHaveLength(2);
  });

  it("a word longer than the maximum stands alone; a text-only caption is never split", () => {
    const long = collectCaptions(
      rootSurface([caption([["a", 1], ["supercalifragilistic", 1], ["b", 1]]), { type: "caption", text: "one two three four", duration: 2 }]),
    );
    expect(brief(deriveCues(long, { maxChars: 5 }))).toEqual([
      ["a", 0, 1],
      ["supercalifragilistic", 1, 2],
      ["b", 2, 3],
      ["one two three four", 3, 5],
    ]);
  });

  it("the surface's maxChars drives what is on screen", () => {
    const surface = rootSurface([caption([["It's", 0.2], ["gonna", 0.2], ["rain", 0.3], ["later", 0.3]])], {
      captionStyle: { maxChars: 12 },
    });
    expect(activeCues(surface, 0.1).map((c) => c.text)).toEqual(["It's gonna"]);
    expect(activeCues(surface, 0.5).map((c) => c.text)).toEqual(["rain later"]);
    expect(activeCues(surface, 1)).toEqual([]); // the end is exclusive
    expect(captions.overlays![0].active(surface, 0.5)).toBe(true);
    expect(captions.overlays![0].active(surface, 5)).toBe(false);
  });
});

describe("cueStyle", () => {
  it("layers the surface's default, the speaker's override and the caption's own", () => {
    const style = {
      fontSize: 50,
      color: "white",
      maxChars: 20,
      speakers: { faye: { color: "pink", fontWeight: "bold" } },
    };
    // Everything sits on the built-in default.
    const D = DEFAULT_CAPTION_STYLE;
    expect(cueStyle(style, {})).toEqual({ ...D, fontSize: 50, color: "white" });
    expect(cueStyle(style, { speaker: "faye" })).toEqual({ ...D, fontSize: 50, color: "pink", fontWeight: "bold" });
    expect(cueStyle(style, { speaker: "faye", style: { fontSize: 65, color: "red" } })).toEqual({
      ...D,
      fontSize: 65,
      color: "red",
      fontWeight: "bold",
    });
    expect(cueStyle(style, { speaker: "nobody" })).toEqual({ ...D, fontSize: 50, color: "white" });
  });
});

describe("subtitle export", () => {
  const cues = collectCaptions(
    rootSurface([{ type: "rect", duration: 61.5 }, caption([["Hello", 0.5], ["there.", 0.75]]), caption([["Bye.", 1]])]),
  );

  it("SRT", () => {
    expect(toSrt(cues)).toBe(
      "1\n00:01:01,500 --> 00:01:02,750\nHello there.\n\n2\n00:01:02,750 --> 00:01:03,750\nBye.\n",
    );
  });

  it("WebVTT", () => {
    expect(toVtt(cues)).toBe(
      "WEBVTT\n\n00:01:01.500 --> 00:01:02.750\nHello there.\n\n00:01:02.750 --> 00:01:03.750\nBye.\n",
    );
  });
});

import { describe, expect, it } from "vitest";
import { resolveComposition } from "@seam/core";
import type { Child, SeamFile } from "@seam/core";
import { groupWords, separateByWord } from "../wordTool.js";

const clip = (fields: Record<string, unknown>): Child =>
  ({ type: "clip", source: "a.mp4", ...fields }) as unknown as Child;

const phrase = (fields: Record<string, unknown> = {}): Child =>
  ({
    type: "data",
    tags: ["transcription", "whisper"],
    data: {
      text: "hello big world",
      duration: 3,
      words: [
        { text: "hello", start: 0, end: 1 },
        { text: "big", start: 1, end: 1.5 },
        { text: "world", start: 2, end: 3 },
      ],
    },
    start: "c@12",
    duration: 3,
    ...fields,
  }) as unknown as Child;

const spans = (d: SeamFile) =>
  resolveComposition(d, { uncropped: true }).children.map((c) => [c.timelineStart, c.timelineEnd]);

describe("separateByWord", () => {
  it("replaces the phrase, in place, with one source-anchored data node per word", () => {
    const doc: SeamFile = {
      type: "composition",
      children: [clip({ id: "c", in: 10, out: 20 }), phrase(), clip({ in: 0, out: 1, start: 0 })],
    };
    const result = separateByWord(doc, [1]);
    if (!result.ok) throw new Error(result.error);
    expect(result.doc.children).toEqual([
      doc.children![0],
      { type: "data", data: "hello", tags: ["transcription", "word"], start: "c@12", duration: 1 },
      { type: "data", data: "big", tags: ["transcription", "word"], start: "c@13", duration: 0.5 },
      { type: "data", data: "world", tags: ["transcription", "word"], start: "c@14", duration: 1 },
      doc.children![2],
    ]);
    // Clip plays source 10 at t=0 → the words sit at 2, 3, 4.
    expect(spans(result.doc).slice(1, 4)).toEqual([
      [2, 3],
      [3, 3.5],
      [4, 5],
    ]);
  });

  it("scales word lengths to the phrase's output duration and carries its offset", () => {
    // A 2× clip: 3 s of source last 1.5 s.
    const doc: SeamFile = {
      type: "composition",
      children: [
        clip({ id: "c", in: 10, out: 20, speed: 2 }),
        phrase({ duration: 1.5, offset: 0.25 }),
      ],
    };
    const result = separateByWord(doc, [1]);
    if (!result.ok) throw new Error(result.error);
    expect(result.doc.children![3]).toEqual({
      type: "data",
      data: "world",
      tags: ["transcription", "word"],
      start: "c@14",
      offset: 0.25,
      duration: 0.5,
    });
    expect(spans(result.doc)[3]).toEqual([2.25, 2.75]);
  });

  it("rejects a phrase without a source-point start or a duration", () => {
    const docOf = (p: Child): SeamFile => ({
      type: "composition",
      children: [clip({ id: "c", in: 10, out: 20 }), p],
    });
    for (const bad of [
      phrase({ start: undefined }),
      phrase({ start: 4 }),
      phrase({ start: "c" }),
      phrase({ start: "c@50%" }),
      phrase({ duration: undefined }),
    ]) {
      expect(separateByWord(docOf(bad), [1])).toEqual({
        ok: false,
        error: "malformed start and duration",
      });
    }
  });

  it("rejects zero-length words and non-transcription selections", () => {
    const zero = phrase();
    (zero as unknown as { data: { words: { end: number }[] } }).data.words[1].end = 1;
    const doc: SeamFile = {
      type: "composition",
      children: [clip({ id: "c", in: 10, out: 20 }), zero],
    };
    expect(separateByWord(doc, [1])).toEqual({
      ok: false,
      error: 'Cannot group by word: "big" has zero length',
    });
    expect(separateByWord(doc, [0]).ok).toBe(false);
  });
});

describe("groupWords", () => {
  const word = (text: string, start: string, duration: number, extra = {}): Child =>
    ({ type: "data", data: text, tags: ["transcription", "word"], start, duration, ...extra }) as unknown as Child;

  it("merges words into one phrase with timings from the resolved timeline", () => {
    const doc: SeamFile = {
      type: "composition",
      children: [
        clip({ id: "c", in: 10, out: 20 }),
        word("hello", "c@12", 1),
        word("big", "c@13", 0.5, { offset: 0.25 }), // nudged: [3.25, 3.75)
        word("world", "c@14", 1),
        clip({ in: 0, out: 1, start: 0 }),
      ],
    };
    const result = groupWords(doc, [3, 1, 2]);
    if (!result.ok) throw new Error(result.error);
    expect(result.doc.children).toEqual([
      doc.children![0],
      {
        type: "data",
        data: {
          text: "hello big world",
          words: [
            { text: "hello", start: 0, end: 1 },
            { text: "big", start: 1.25, end: 1.75 },
            { text: "world", start: 2, end: 3 },
          ],
          duration: 3,
        },
        tags: ["transcription", "phrase"],
        start: "c@12",
        duration: 3,
      },
      doc.children![4],
    ]);
    expect(spans(result.doc)[1]).toEqual([2, 5]);
  });

  it("takes start + offset from the chronologically first word, whatever the array order", () => {
    const doc: SeamFile = {
      type: "composition",
      children: [
        clip({ id: "c", in: 10, out: 20 }),
        word("world", "c@14", 1),
        word("hello", "c@12", 1, { offset: -0.5 }),
      ],
    };
    const result = groupWords(doc, [1, 2]);
    if (!result.ok) throw new Error(result.error);
    const grouped = result.doc.children![1] as unknown as Record<string, unknown>;
    expect(grouped.start).toBe("c@12");
    expect(grouped.offset).toBe(-0.5);
    expect(grouped.duration).toBe(3.5);
    expect(result.doc.children).toHaveLength(2);
  });

  it("a node that followed a removed word inherits its placement (run semantics)", () => {
    const follower = clip({ in: 0, out: 1 });
    const doc: SeamFile = {
      type: "composition",
      children: [
        clip({ id: "c", in: 10, out: 20 }),
        word("hello", "c@12", 1),
        word("world", "c@14", 1),
        follower,
      ],
    };
    const result = groupWords(doc, [1, 2]);
    if (!result.ok) throw new Error(result.error);
    expect(result.doc.children![2]).toEqual({ ...follower, start: "c@14" });
    // …so it doesn't join the phrase's run.
    expect((result.doc.children![1] as { type: string }).type).toBe("data");
  });

  it("validates the selection", () => {
    const doc: SeamFile = {
      type: "composition",
      children: [
        clip({ id: "c", in: 10, out: 20 }),
        word("hello", "c@12", 1),
        word("free", "c", 1),
      ],
    };
    expect(groupWords(doc, [1]).ok).toBe(false);
    expect(groupWords(doc, [0, 1])).toEqual({ ok: false, error: "Select only word items to group." });
    expect(groupWords(doc, [1, 2])).toEqual({ ok: false, error: "malformed start and duration" });
  });

  it("round-trips with separateByWord", () => {
    const doc: SeamFile = {
      type: "composition",
      children: [clip({ id: "c", in: 10, out: 20 }), phrase()],
    };
    const sep = separateByWord(doc, [1]);
    if (!sep.ok) throw new Error(sep.error);
    const grp = groupWords(sep.doc, [1, 2, 3]);
    if (!grp.ok) throw new Error(grp.error);
    expect(spans(grp.doc)).toEqual(spans(doc));
    const again = separateByWord(grp.doc, [1]);
    if (!again.ok) throw new Error(again.error);
    expect(again.doc.children).toEqual(sep.doc.children);
  });
});

import { describe, expect, it } from "vitest";
import { createSeam, type Child, type EditorCommandContext, type SeamFile, type Transcript } from "@seam/core";
import { captions, DEFAULT_CAPTION_STYLE } from "@seam/extension-captions";
import { captionsEditor } from "@seam/extension-captions/editor";
import { text } from "@seam/extension-text";
import { createEditorTools, resolveStandalone } from "../extensionHost.js";
import { editContainer, getNodeAtPath, parsePath, removeNodesAtPaths, updateNodeAtPath } from "../nodePath.js";
import { layoutTree } from "../timelineTree.js";
import { flattenDropRegions, regionsAccepting } from "../dropRegions.js";
import { descendToContainer } from "../resolveLocal.js";
import { sliceAtPlayhead } from "../splitTool.js";
import { resizeChild } from "../resizeTool.js";

// The editor's side of the extension contract, exercised through the Captions
// extension's real commands: a context built the way App builds it, minus
// React.

const seam = createSeam([text, captions]);
const tools = createEditorTools(seam);

function context(document: SeamFile, selection: string[], transcripts: Transcript[] = []) {
  const state = { doc: document, selection, notices: [] as string[] };
  const ctx: EditorCommandContext = {
    seam,
    document,
    selection,
    node: (key) => (key === "" ? null : getNodeAtPath(document, parsePath(key)) ?? null),
    resolve: (key) => resolveStandalone(seam, document, key),
    edit: (next, opts) => {
      state.doc = next;
      if (opts?.select) state.selection = opts.select;
    },
    notify: (m) => state.notices.push(...m),
    tools,
    services: { transcribe: async () => transcripts },
  };
  return { ctx, state };
}
const command = (id: string) => captionsEditor.commands!.find((c) => c.id === id)!;
const doc = (children: unknown[], extra: object = {}): SeamFile => ({ type: "composition", ...extra, children }) as SeamFile;
const kids = (d: SeamFile) => d.children as (Child & Record<string, unknown>)[];
const SEG = [{ start: 1, end: 2, text: "hi there", words: [{ start: 1, end: 1.5, text: "hi" }, { start: 1.5, end: 2, text: "there" }] }];

describe("editor tools", () => {
  it("update, append, parent key and fresh ids", () => {
    const d = doc([{ type: "rect", id: "cc-1", duration: 1 }, { type: "composition", children: [{ type: "rect", duration: 1 }] }]);
    expect(kids(tools.updateNode(d, "children.0", (n) => ({ ...n, duration: 2 }) as Child))[0].duration).toBe(2);
    const appended = tools.appendChildren(d, "children.1", [{ type: "rect", duration: 3, start: 0 } as Child]);
    expect((kids(appended)[1].children as unknown[]).length).toBe(2);
    expect(tools.appendChildren(d, "", [{ type: "rect", duration: 3 } as Child]).children).toHaveLength(3);
    expect(tools.parentKey("children.1.children.0")).toBe("children.1");
    expect(tools.parentKey("children.1")).toBe("");
    expect(tools.freshId(d, "cc")).toBe("cc-2");
  });

  it("keepRanges reports the pieces by path key", () => {
    const d = doc([{ type: "composition", children: [{ type: "clip", source: "a.mp4", in: 0, out: 10 }] }]);
    const r = tools.keepRanges(d, "children.0", [{ start: 1, end: 2 }, { start: 5, end: 6 }]);
    expect(r).toMatchObject({ ok: true, pieces: ["children.0", "children.1"] });
  });

  it("resolveStandalone applies the node's own window and ignores its placement", () => {
    const d = doc([
      { type: "rect", duration: 1 },
      { type: "composition", start: "missing-sibling@1", in: 2, out: 5, children: [{ type: "rect", duration: 10 }] },
    ]);
    expect(resolveStandalone(seam, d, "children.1")).toMatchObject({ type: "composition", timelineStart: 0, timelineEnd: 3 });
    expect(resolveStandalone(seam, d, "children.9")).toBeNull();
  });
});

describe("Captions commands", () => {
  it("generate: enabled only for a root-level clip / audio / composition", () => {
    const d = doc([{ type: "rect", duration: 1 }, { type: "clip", source: "a.mp4", in: 0, out: 5 }]);
    expect(command("captions.generate").enabled!(context(d, ["children.0"]).ctx)).toBe(false);
    expect(command("captions.generate").enabled!(context(d, ["children.1"]).ctx)).toBe(true);
    expect(command("captions.generate").enabled!(context(d, []).ctx)).toBe(false);
  });

  it("generate: a clip gets captions beside it, anchored to its source time (and an id)", async () => {
    const d = doc([{ type: "clip", source: "a.mp4", in: 10, out: 20 }]);
    const { ctx, state } = context(d, ["children.0"], [{ key: "children.0", anchorBase: 10, rate: 1, segments: SEG }]);
    await command("captions.generate").run(ctx);
    const [clip, caption] = kids(state.doc);
    expect(clip.id).toBe("cc-1");
    expect(caption).toMatchObject({ type: "caption", start: "cc-1@11" });
    expect(seam.validate(state.doc).success).toBe(true);
  });

  it("generate: a composition gets captions INSIDE it, in its inner time", async () => {
    const d = doc([{ type: "composition", children: [{ type: "clip", source: "a.mp4", in: 0, out: 20 }] }]);
    const { ctx, state } = context(d, ["children.0"], [{ key: "children.0", anchorBase: 0, rate: 1, segments: SEG }]);
    await command("captions.generate").run(ctx);
    expect(kids(state.doc)).toHaveLength(1);
    const inner = kids(state.doc)[0].children as (Child & Record<string, unknown>)[];
    expect(inner[1]).toMatchObject({ type: "caption", start: 1 });
    expect(seam.validate(state.doc).success).toBe(true);
  });

  it("generate: an empty transcription says so and changes nothing", async () => {
    const d = doc([{ type: "clip", source: "a.mp4", in: 0, out: 5 }]);
    const { ctx, state } = context(d, ["children.0"], [{ key: "children.0", anchorBase: 0, rate: 1, segments: [] }]);
    await command("captions.generate").run(ctx);
    expect(state.doc).toBe(d);
    expect(state.notices.length).toBe(1);
  });

  const withCaptions = () =>
    doc([
      {
        type: "composition",
        in: 1,
        out: 4,
        children: [
          { type: "rect", duration: 10 },
          { type: "caption", start: 0, children: ["one", "two", "three", "four"].map((text) => ({ type: "word", text, duration: 1 })) },
        ],
      },
    ]);

  it("reauthor: switches the composition's captions off and writes them out beside it", () => {
    const d = withCaptions();
    const { ctx, state } = context(d, ["children.0"]);
    expect(command("captions.reauthor").enabled!(ctx)).toBe(true);
    command("captions.reauthor").run(ctx);
    const [comp, written] = kids(state.doc);
    expect(comp).toMatchObject({ id: "cc-1", captions: "off" });
    expect(written).toMatchObject({ type: "caption", start: "cc-1@1" });
    expect((written.children as { text: string }[]).map((w) => w.text)).toEqual(["two", "three", "four"]);
    expect(kids(state.doc)).toHaveLength(2);
    expect(seam.validate(state.doc).success).toBe(true);
    expect(state.selection).toEqual(["children.0"]);
  });

  it("reauthor: honours the root's maxChars, and reports when there is nothing to write", () => {
    const split = context(doc(withCaptions().children as unknown[], { captionStyle: { maxChars: 9 } }), ["children.0"]);
    command("captions.reauthor").run(split.ctx);
    expect(kids(split.state.doc)).toHaveLength(3);

    const empty = doc([{ type: "composition", children: [{ type: "rect", duration: 1 }] }]);
    const none = context(empty, ["children.0"]);
    command("captions.reauthor").run(none.ctx);
    expect(none.state.doc).toBe(empty);
    expect(none.state.notices.length).toBe(1);
  });

  it("to text: a root caption becomes a text node with the root's style, in its slot", () => {
    const d = doc(
      [{ type: "caption", start: 2, speaker: "faye", children: [{ type: "word", text: "hi", duration: 1 }] }],
      { captionStyle: { fontSize: 50, speakers: { faye: { color: "pink" } } } },
    );
    const { ctx, state } = context(d, ["children.0"]);
    expect(command("captions.toText").enabled!(ctx)).toBe(true);
    command("captions.toText").run(ctx);
    expect(kids(state.doc)[0]).toEqual({
      type: "text",
      text: "hi",
      duration: 1,
      start: 2,
      ...DEFAULT_CAPTION_STYLE,
      fontSize: 50,
      color: "pink",
    });
    expect(seam.validate(state.doc).success).toBe(true);
  });

  it("to text: not offered for a caption nested inside a composition", () => {
    const d = doc([{ type: "composition", children: [{ type: "caption", text: "x", duration: 1 }] }]);
    expect(command("captions.toText").enabled!(context(d, ["children.0.children.0"]).ctx)).toBe(false);
  });
});

describe("captions under the editor's own tools", () => {
  const word = (text: string, duration: number, offset?: number) => ({ type: "word", text, duration, ...(offset ? { offset } : {}) });
  // A caption at 2 s: one 2–3, two 3–4, (pause) three 5–6; then an unrelated rect.
  const d = () =>
    doc([
      { type: "rect", duration: 10 },
      { type: "caption", id: "k", start: 2, children: [word("one", 1), word("two", 1), word("three", 1, 1)] },
      { type: "rect", start: 8, duration: 1 },
    ]);
  const texts = (n: Child) => ((n as { children?: { text: string }[] }).children ?? []).map((w) => w.text);
  const spans = (x: SeamFile) => tools.childSpans(x, "")!.map((sp) => [sp.start, sp.end]);

  it("Slice cuts a caption at the nearest word boundary; the right half gets the anchor moved forward", () => {
    const next = sliceAtPlayhead(seam, d(), 4.3, new Set([1]))!;
    expect(kids(next).map((n) => n.type)).toEqual(["rect", "caption", "caption", "rect"]);
    expect(texts(kids(next)[1])).toEqual(["one", "two"]);
    expect(kids(next)[1]).toMatchObject({ id: "k", start: 2 });
    // Numeric start: the seconds are added (2 + two words + the pause).
    expect(kids(next)[2]).toEqual({ type: "caption", start: 5, children: [word("three", 1)] });
    // Nothing moved in time.
    expect(spans(next)).toEqual([[0, 10], [2, 4], [5, 6], [8, 9]]);
    expect(seam.validate(next).success).toBe(true);
  });

  it("Slice moves each kind of anchor the right way", () => {
    const words = [word("one", 1), word("two", 1), word("three", 1, 1)];
    const sliced = (clip: object, placement: object) => {
      const x = doc([{ type: "clip", id: "a", source: "a.mp4", in: 10, out: 30, ...clip }, { type: "caption", ...placement, children: words }]);
      const before = tools.childSpans(x, "")![1];
      // Cut inside the pause, wherever the caption sits.
      const next = sliceAtPlayhead(seam, x, before.start + 2.4, new Set([1]))!;
      const after = tools.childSpans(next, "")!;
      // The halves still cover exactly what the caption did.
      expect([after[1].start, after[2].end]).toEqual([before.start, before.end]);
      expect(after[2].start).toBeCloseTo(before.start + 3, 6);
      expect(seam.validate(next).success).toBe(true);
      const { start, offset } = kids(next)[2] as { start?: unknown; offset?: unknown };
      return { start, offset };
    };
    // Source-time anchor: the seconds move, at the clip's rate.
    expect(sliced({}, { start: "a@12" })).toEqual({ start: "a@15", offset: undefined });
    expect(sliced({ speed: 2 }, { start: "a@12" })).toEqual({ start: "a@18", offset: undefined });
    expect(sliced({}, { start: "a@12", offset: 0.5 })).toEqual({ start: "a@15", offset: 0.5 });
    // Percentage and bare-id anchors keep the anchor and take the shift as offset.
    expect(sliced({}, { start: "a@50%" })).toEqual({ start: "a@50%", offset: 3 });
    expect(sliced({}, { start: "a", offset: 1 })).toEqual({ start: "a", offset: 4 });
  });

  it("Slice on a caption that is a run member keeps the halves on that run", () => {
    const x = doc([{ type: "rect", duration: 2 }, { type: "caption", children: [word("one", 1), word("two", 1, 1)] }]);
    const next = sliceAtPlayhead(seam, x, 3.5, new Set([1]))!;
    expect(kids(next)[2]).toEqual({ type: "caption", offset: 1, children: [word("two", 1)] });
    expect(spans(next)).toEqual([[0, 2], [2, 3], [4, 5]]);
  });

  it("an edge drag on a caption retimes its last word", () => {
    const next = resizeChild(seam, d(), 1, "right", 0.5);
    expect((kids(next)[1].children as { duration: number }[]).map((w) => w.duration)).toEqual([1, 1, 1.5]);
    expect(kids(next)[1].duration).toBeUndefined();
  });

  it("Merge puts the pieces back, and joins captions that do not touch", () => {
    const sliced = sliceAtPlayhead(seam, d(), 4.3, new Set([1]))!;
    const { ctx, state } = context(sliced, ["children.2", "children.1"]);
    expect(command("captions.merge").enabled!(ctx)).toBe(true);
    command("captions.merge").run(ctx);
    expect(state.doc).toEqual(d());
    expect(state.selection).toEqual(["children.1"]);

    const apart = doc([
      { type: "rect", duration: 20 },
      { type: "caption", start: 10, text: "later", duration: 1 },
      { type: "caption", start: 2, children: [word("early", 1)] },
    ]);
    const m = context(apart, ["children.1", "children.2"]);
    command("captions.merge").run(m.ctx);
    expect(kids(m.state.doc)).toEqual([
      { type: "rect", duration: 20 },
      { type: "caption", start: 2, children: [word("early", 1), word("later", 1, 7)] },
    ]);
    expect(m.state.selection).toEqual(["children.1"]);
    expect(seam.validate(m.state.doc).success).toBe(true);
  });

  it("Merge is offered only for sibling captions", () => {
    expect(command("captions.merge").enabled!(context(d(), ["children.1"]).ctx)).toBe(false);
    expect(command("captions.merge").enabled!(context(d(), ["children.1", "children.2"]).ctx)).toBe(false);
  });
});

describe("a caption expands on the timeline into its words", () => {
  const word = (text: string, duration: number, offset?: number) => ({ type: "word", text, duration, ...(offset ? { offset } : {}) });
  const d = () =>
    doc([
      { type: "rect", duration: 10 },
      { type: "caption", start: 2, speaker: "faye", children: [word("one", 1), word("two", 1), word("three", 1, 1)] },
    ]);
  const resolvedRoot = (x: SeamFile) => seam.resolveComposition(x, { uncropped: true });
  const tree = (x: SeamFile, open: string[]) => layoutTree(seam, resolvedRoot(x).children, x, new Set(open), []);

  it("lays the words out as blocks in the caption's own time", () => {
    const caption = tree(d(), ["children.1"]).blocks[1];
    expect(caption.isContainer).toBe(true);
    expect(caption.isComposition).toBe(false);
    const group = caption.expansion!.group;
    expect(group.accepts).toEqual(["word"]);
    expect(group.blocks.map((b) => [b.addr, b.child.timelineStart, b.child.timelineEnd])).toEqual([
      ["children.1.children.0", 0, 1],
      ["children.1.children.1", 1, 2],
      ["children.1.children.2", 3, 4],
    ]);
    // Collapsed: just the caption block.
    expect(tree(d(), []).blocks[1].expansion).toBeUndefined();
  });

  it("the editor's tools edit a word in place", () => {
    const path = parsePath("children.1");
    // Edge drag on the second word.
    const resized = editContainer(d(), path, [], (sub) => resizeChild(seam, sub, 1, "right", 0.5));
    expect(kids(resized)[1]).toEqual({
      type: "caption",
      start: 2,
      speaker: "faye",
      children: [word("one", 1), word("two", 1.5), word("three", 1, 1)],
    });
    // A field edit (the Properties panel) and a delete.
    const renamed = updateNodeAtPath(d(), parsePath("children.1.children.0"), (n) => ({ ...n, text: "ONE" }) as Child);
    expect((kids(renamed)[1].children as { text: string }[])[0].text).toBe("ONE");
    const removed = removeNodesAtPaths(d(), [parsePath("children.1.children.1")]);
    expect((kids(removed)[1].children as { text: string }[]).map((w) => w.text)).toEqual(["one", "three"]);
    for (const x of [resized, renamed, removed]) expect(seam.validate(x).success).toBe(true);
  });

  it("the playhead maps into the caption's time", () => {
    const x = d();
    expect(descendToContainer(seam, resolvedRoot(x), x, parsePath("children.1"), 3.5)?.localTime).toBe(1.5);
  });

  it("only words drop into a caption, and words do not leave captions", () => {
    const regions = flattenDropRegions(tree(d(), ["children.1"]), 100, { width: 2000, height: 400 });
    const paths = (rs: typeof regions) => rs.map((r) => r.path.length);
    expect(paths(regions)).toEqual([0, 1]);
    expect(paths(regionsAccepting(regions, ["rect"], false))).toEqual([0]); // a rect: root only
    expect(paths(regionsAccepting(regions, null, false))).toEqual([0]); // a dragged-in file
    expect(paths(regionsAccepting(regions, ["word"], true))).toEqual([1]); // a word: captions only
  });
});

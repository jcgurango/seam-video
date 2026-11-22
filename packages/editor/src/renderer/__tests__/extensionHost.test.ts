import { describe, expect, it } from "vitest";
import { createSeam, type Child, type EditorCommandContext, type SeamFile, type Transcript } from "@seam/core";
import { captions } from "@seam/extension-captions";
import { captionsEditor } from "@seam/extension-captions/editor";
import { createEditorTools, resolveStandalone } from "../extensionHost.js";
import { getNodeAtPath, parsePath } from "../nodePath.js";

// The editor's side of the extension contract, exercised through the Captions
// extension's real commands: a context built the way App builds it, minus
// React.

const seam = createSeam([captions]);
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
    expect(caption).toMatchObject({ type: "caption", start: "cc-1@11", duration: 1 });
    expect(seam.validate(state.doc).success).toBe(true);
  });

  it("generate: a composition gets captions INSIDE it, in its inner time", async () => {
    const d = doc([{ type: "composition", children: [{ type: "clip", source: "a.mp4", in: 0, out: 20 }] }]);
    const { ctx, state } = context(d, ["children.0"], [{ key: "children.0", anchorBase: 0, rate: 1, segments: SEG }]);
    await command("captions.generate").run(ctx);
    expect(kids(state.doc)).toHaveLength(1);
    const inner = kids(state.doc)[0].children as (Child & Record<string, unknown>)[];
    expect(inner[1]).toMatchObject({ type: "caption", start: 1, duration: 1 });
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
    expect(written).toMatchObject({ type: "caption", start: "cc-1@1", duration: 3 });
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
    expect(kids(state.doc)[0]).toEqual({ type: "text", text: "hi", duration: 1, start: 2, fontSize: 50, color: "pink" });
    expect(seam.validate(state.doc).success).toBe(true);
  });

  it("to text: not offered for a caption nested inside a composition", () => {
    const d = doc([{ type: "composition", children: [{ type: "caption", text: "x", duration: 1 }] }]);
    expect(command("captions.toText").enabled!(context(d, ["children.0.children.0"]).ctx)).toBe(false);
  });
});

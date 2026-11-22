// `@seam/extension-captions/editor` — what Captions adds to the editor:
// toolbar commands, the CC cut view and the caption style section of the
// Properties panel.
//
// Plain objects over the editor extension API in `@seam/core`; the editor
// supplies the context each command runs in and mounts the view. This entry
// (alone in the package) depends on React, through the view component.

import type {
  Child,
  Composition,
  EditorCommand,
  EditorCommandContext,
  EditorExtension,
  EditorView,
} from "@seam/core";
import CCCutView from "./editor/CCCutView.js";
import CaptionStyleEditor from "./editor/CaptionStyleEditor.js";
import { captionAsText, captionsFromTranscript, mergeCaptions, reauthoredCaptions } from "./edit.js";
import type { CaptionNode, CaptionSurfaceStyle } from "./index.js";

const isRootChild = (key: string) => /^children\.\d+$/.test(key);

/** The style captions are shown with: the root's (the default surface). */
const rootStyle = (ctx: EditorCommandContext): CaptionSurfaceStyle =>
  ((ctx.document as { captionStyle?: CaptionSurfaceStyle }).captionStyle ?? {});

/** Transcribe the selection and write the result as captions: INSIDE a
 *  transcribed composition (so they travel with it when it is cut), BESIDE a
 *  transcribed clip or audio, anchored to its source time. */
const generate: EditorCommand = {
  id: "captions.generate",
  label: "CC",
  title: "Generate captions for the selected clip / audio / composition",
  enabled: (ctx) =>
    ctx.selection.some((key) => {
      if (!isRootChild(key)) return false;
      const type = ctx.node(key)?.type;
      return type === "clip" || type === "audio" || type === "composition";
    }),
  async run(ctx) {
    const transcripts = await ctx.services.transcribe();
    let doc = ctx.document;
    let made = 0;
    for (const t of transcripts) {
      const node = ctx.node(t.key);
      if (!node) continue;
      if (node.type === "composition") {
        const captions = captionsFromTranscript(t.segments, { kind: "inside", anchorBase: t.anchorBase });
        if (captions.length === 0) continue;
        doc = ctx.tools.appendChildren(doc, t.key, captions as unknown as Child[]);
        made += captions.length;
      } else {
        const id = (node as { id?: string }).id ?? ctx.tools.freshId(doc, "cc");
        const captions = captionsFromTranscript(t.segments, {
          kind: "beside",
          id,
          anchorBase: t.anchorBase,
          rate: t.rate,
        });
        if (captions.length === 0) continue;
        doc = ctx.tools.updateNode(doc, t.key, (n) => ({ ...n, id }) as Child);
        doc = ctx.tools.appendChildren(doc, ctx.tools.parentKey(t.key), captions as unknown as Child[]);
        made += captions.length;
      }
    }
    if (made > 0) ctx.edit(doc);
    else if (transcripts.length > 0) ctx.notify(["The transcription came back empty."]);
  },
};

/** Take over a composition's captions: stop them bubbling (`captions:
 *  "off"`) and write what it was showing out as caption nodes beside it, to
 *  edit by hand. Undo, or delete them and switch `captions` back, to return
 *  to the derived ones. */
const reauthor: EditorCommand = {
  id: "captions.reauthor",
  label: "CC✎",
  title: "Reauthor captions: stop this composition's captions bubbling and write them out beside it to edit",
  enabled: (ctx) => ctx.selection.length === 1 && ctx.node(ctx.selection[0])?.type === "composition",
  run(ctx) {
    const key = ctx.selection[0];
    const comp = ctx.node(key) as (Composition & { id?: string; captions?: string }) | null;
    const resolved = ctx.resolve(key);
    if (!comp || !resolved) return;
    if (comp.captions === "off") {
      ctx.notify(["This composition's captions are already off."]);
      return;
    }
    const id = comp.id ?? ctx.tools.freshId(ctx.document, "cc");
    const captions = reauthoredCaptions(resolved, { id, inTime: comp.in ?? 0 }, rootStyle(ctx));
    if (captions.length === 0) {
      ctx.notify(["There are no captions inside this composition."]);
      return;
    }
    let doc = ctx.tools.updateNode(ctx.document, key, (n) => ({ ...n, id, captions: "off" }) as unknown as Child);
    doc = ctx.tools.appendChildren(doc, ctx.tools.parentKey(key), captions as unknown as Child[]);
    ctx.edit(doc, { select: [key] });
  },
};

/** Replace the selected captions with `text` nodes that look the same — for
 *  the rare caption that has to be designed by hand. Only captions that sit
 *  directly in the root (the default surface) convert faithfully, so only
 *  those are offered. */
const toText: EditorCommand = {
  id: "captions.toText",
  label: "CC→T",
  title: "Convert the selected captions to text nodes",
  enabled: (ctx) =>
    ctx.selection.length > 0 &&
    ctx.selection.every((key) => isRootChild(key) && ctx.node(key)?.type === "caption"),
  run(ctx) {
    const style = rootStyle(ctx);
    let doc = ctx.document;
    for (const key of ctx.selection) {
      doc = ctx.tools.updateNode(doc, key, (n) => captionAsText(n as unknown as CaptionNode, style));
    }
    ctx.edit(doc, { select: [...ctx.selection] });
  },
};

/** Merge the selected captions (siblings; they need not touch) into one.
 *  The counterpart of Slice, which cuts a caption between words. */
const merge: EditorCommand = {
  id: "captions.merge",
  label: "CC+",
  title: "Merge the selected captions into one (the earliest keeps its place; words keep their timing)",
  enabled: (ctx) => {
    if (ctx.selection.length < 2) return false;
    const parent = ctx.tools.parentKey(ctx.selection[0]);
    return ctx.selection.every(
      (key) => ctx.tools.parentKey(key) === parent && ctx.node(key)?.type === "caption",
    );
  },
  run(ctx) {
    const parent = ctx.tools.parentKey(ctx.selection[0]);
    const spans = ctx.tools.childSpans(ctx.document, parent);
    if (!spans) {
      ctx.notify(["These captions could not be placed in time."]);
      return;
    }
    const indexOf = (key: string) => Number(key.slice(key.lastIndexOf(".") + 1));
    const picked = ctx.selection
      .map((key) => ({ key, index: indexOf(key), node: ctx.node(key) as unknown as CaptionNode }))
      .filter((p) => spans[p.index] != null)
      .map((p) => ({ ...p, ...spans[p.index] }));
    const merged = mergeCaptions(picked);
    if (!merged || picked.length < 2) return;
    const earliest = [...picked].sort((a, b) => a.start - b.start)[0];
    const others = picked.filter((p) => p !== earliest);
    let doc = ctx.tools.updateNode(ctx.document, earliest.key, () => merged as unknown as Child);
    doc = ctx.tools.removeNodes(doc, others.map((p) => p.key));
    // The merged caption's index after the others left.
    const index = earliest.index - others.filter((p) => p.index < earliest.index).length;
    ctx.edit(doc, { select: [`${parent === "" ? "" : `${parent}.`}children.${index}`] });
  },
};

/** Cut a composition by what is said in it: pick ranges of words to keep. */
const ccCut: EditorView = {
  id: "captions.cut",
  label: "CC✂",
  title: "CC cut: keep ranges of the selected composition, picked from the words spoken in it",
  enabled: (ctx) => ctx.selection.length === 1 && ctx.node(ctx.selection[0])?.type === "composition",
  component: CCCutView,
};

/** The Captions extension's editor side. */
export const captionsEditor: EditorExtension = {
  name: "captions",
  commands: [generate, reauthor, merge, toText],
  views: [ccCut],
  // The look of captions shown at a composition, with presets.
  properties: [{ field: "captionStyle", label: "Caption style", component: CaptionStyleEditor }],
};

export default captionsEditor;

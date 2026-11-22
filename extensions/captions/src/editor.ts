// `@seam/extension-captions/editor` — what Captions adds to the editor:
// toolbar commands. (The CC cut view and the caption lane come next.)
//
// Plain objects over the editor extension API in `@seam/core`; the editor
// supplies the context each command runs in.

import type { Child, Composition, EditorCommand, EditorCommandContext, EditorExtension } from "@seam/core";
import { captionAsText, captionsFromTranscript, reauthoredCaptions } from "./edit.js";
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

/** The Captions extension's editor side. */
export const captionsEditor: EditorExtension = {
  name: "captions",
  commands: [generate, reauthor, toText],
};

export default captionsEditor;

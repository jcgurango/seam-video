// CC Cut: extracts transcription words from a bin entry and resolves
// them into composition-time coordinates so the CC view can render a
// scannable word ribbon and let the user pick time ranges by clicking.

import { resolveComposition } from "@seam/core";
import type { Child, Composition, Data, SeamFile } from "@seam/core";
import type { BinEntry } from "./nodeBin.js";

/** Stable colours per transcription index, used to tell overlapping CC
 *  blocks apart visually. Cycles modulo length for >palette entries. */
export const CC_COLORS = [
  "#4a9eff",
  "#ff6b6b",
  "#51cf66",
  "#ffd43b",
  "#cc5de8",
  "#22b8cf",
  "#fd7e14",
  "#94d82d",
];

export interface CCWord {
  text: string;
  /** Composition-time start in seconds, relative to the bin entry's
   *  inner timeline origin. */
  start: number;
  /** Composition-time end in seconds. */
  end: number;
  /** Which transcription this word came from (= colour index). */
  transcriptionIndex: number;
}

export interface CCSelection {
  /** Composition-time start. */
  start: number;
  /** Composition-time end. */
  end: number;
}

interface TranscriptionRaw {
  /** Phrase-local seconds — 0 = phrase start. */
  start: number;
  end: number;
  text: string;
}

interface TranscriptionPayload {
  /** Intrinsic phrase length in seconds. The words are positioned
   *  within `[0, duration]`. */
  duration: number;
  words: TranscriptionRaw[];
}

function isTranscriptionData(node: Child): node is Data {
  if (node.type !== "data") return false;
  if (!node.tags?.includes("transcription")) return false;
  const d = node.data as { words?: unknown; duration?: unknown } | null;
  return (
    !!d &&
    Array.isArray((d as TranscriptionPayload).words) &&
    typeof (d as TranscriptionPayload).duration === "number"
  );
}

/** Wrap a bin entry as a composition so we can run the resolver against
 *  it. Carries forward the document's canvas dimensions so spatial
 *  resolution doesn't fail. */
export function binEntryAsComposition(
  entry: BinEntry,
  rootDoc: SeamFile,
): Composition {
  const comp: Composition = {
    type: "composition",
    children: entry.children,
  };
  if (rootDoc.contentWidth != null) comp.contentWidth = rootDoc.contentWidth;
  if (rootDoc.contentHeight != null) comp.contentHeight = rootDoc.contentHeight;
  return comp;
}

/** Resolve all transcription words inside a bin entry to composition-
 *  time coordinates. Returns words sorted by start. A phrase sits wherever
 *  its data node resolves (`start` anchor + `offset`, spanning `duration`);
 *  its words are phrase-relative and spread over that span. */
export function resolveCCWords(
  entry: BinEntry,
  rootDoc: SeamFile,
): CCWord[] {
  const comp = binEntryAsComposition(entry, rootDoc);
  let resolved;
  try {
    // `uncropped` keeps resolved children 1:1 with `entry.children`.
    resolved = resolveComposition(comp, { uncropped: true });
  } catch {
    return [];
  }

  const out: CCWord[] = [];
  // Array order, so the colour index is stable across runs.
  let transcriptionIndex = 0;
  (entry.children ?? []).forEach((node, i) => {
    if (!isTranscriptionData(node)) return;
    const index = transcriptionIndex++;
    const span = resolved.children[i];
    if (!span) return;

    const payload = node.data as TranscriptionPayload;
    // The rendered phrase span can differ from the recorded `data.duration`
    // (the words' own coordinate space). Scale word positions by that factor
    // so they land where they actually play.
    const compSpan = span.timelineEnd - span.timelineStart;
    const scale = payload.duration > 0 ? compSpan / payload.duration : 1;

    for (const w of payload.words) {
      out.push({
        text: w.text,
        start: span.timelineStart + w.start * scale,
        end: span.timelineStart + w.end * scale,
        transcriptionIndex: index,
      });
    }
  });

  out.sort((a, b) => a.start - b.start);
  return out;
}

/** Build the preview document the timeline + canvas show while in CC
 *  view. With selections, it's the bin entry's body repeated per
 *  selection with `in`/`out` set to the picked range. With none, it's
 *  the full bin entry so the user has something to scrub. */
export function buildCCPreviewDoc(
  entry: BinEntry,
  rootDoc: SeamFile,
  selections: CCSelection[],
): SeamFile {
  const innerWrap = (): Composition => ({
    type: "composition",
    children: entry.children,
  });

  if (selections.length === 0) {
    const root: SeamFile = {
      type: "composition",
      children: [innerWrap()],
    };
    if (rootDoc.contentWidth != null) root.contentWidth = rootDoc.contentWidth;
    if (rootDoc.contentHeight != null)
      root.contentHeight = rootDoc.contentHeight;
    return root;
  }

  const children: Child[] = selections.map((sel) => {
    const c = innerWrap();
    c.in = sel.start;
    c.out = sel.end;
    return c;
  });

  const root: SeamFile = { type: "composition", children };
  if (rootDoc.contentWidth != null) root.contentWidth = rootDoc.contentWidth;
  if (rootDoc.contentHeight != null) root.contentHeight = rootDoc.contentHeight;
  return root;
}

/** Build the bin-reference children that the user wants spliced into
 *  the higher-level composition on OK. Each selection becomes an empty
 *  composition with `binItem: binId` and `in`/`out` set to the
 *  selection's range — the compile pass resolves the body from the
 *  root bin at render time. */
export function buildCCSpliceChildren(
  _entry: BinEntry,
  binId: string,
  selections: CCSelection[],
): Child[] {
  return selections.map((sel) => {
    // A bin reference adopts the named entry's body at compile time, so it
    // carries no `children` of its own — only the slot's timing overrides.
    const c: Composition = {
      type: "composition",
      binItem: binId,
      in: sel.start,
      out: sel.end,
    };
    return c;
  });
}

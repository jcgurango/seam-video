// CC Cut: extracts transcription words from a bin entry and resolves
// them into composition-time coordinates so the CC view can render a
// scannable word ribbon and let the user pick time ranges by clicking.

import { resolveComposition } from "@seam/core";
import type {
  Child,
  Composition,
  Data,
  ResolvedChild,
  SeamFile,
} from "@seam/core";
import type { BinEntry } from "./nodeBin.js";
import { BIN_ITEM_METADATA_KEY } from "./nodeBin.js";

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

/** Map a source-time on the anchored child back to the bin entry's
 *  inner output timeline. Returns null when the resolved anchor isn't a
 *  source-bearing type. */
function sourceToCompositionTime(
  resolved: ResolvedChild,
  sourceTime: number,
): number | null {
  if (resolved.type === "clip" || resolved.type === "audio") {
    return (
      resolved.timelineStart + (sourceTime - resolved.sourceIn) / resolved.speed
    );
  }
  // Compositions can also be anchor targets — for those, source-time is
  // a point on the comp's inner (pre-window) timeline. We don't carry
  // `in` on the resolved comp, but the resolver's output→source formula
  // is `source = compIn + (output − timelineStart) * speed`, so reversed
  // here. Without `compIn` we approximate by treating the comp's inner
  // origin as 0; transcriptions are nearly always anchored to clips
  // anyway.
  if (resolved.type === "composition") {
    return resolved.timelineStart + sourceTime / resolved.speed;
  }
  return null;
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
  if (entry.attachments) comp.attachments = entry.attachments;
  if (rootDoc.contentWidth != null) comp.contentWidth = rootDoc.contentWidth;
  if (rootDoc.contentHeight != null) comp.contentHeight = rootDoc.contentHeight;
  return comp;
}

/** Resolve all transcription words inside a bin entry to composition-
 *  time coordinates. Returns words sorted by start. Words anchored to
 *  a non-existent / non-source child are skipped. */
export function resolveCCWords(
  entry: BinEntry,
  rootDoc: SeamFile,
): CCWord[] {
  const comp = binEntryAsComposition(entry, rootDoc);
  let resolved;
  try {
    resolved = resolveComposition(comp);
  } catch {
    return [];
  }

  // Build an id → resolved-child map covering both sequential children
  // and attachments (the resolver appends attachments to `children`).
  const idToResolved = new Map<string, ResolvedChild>();
  resolved.children.forEach((rc, i) => {
    const orig =
      i < comp.children.length
        ? comp.children[i]
        : (comp.attachments ?? [])[i - comp.children.length];
    const id = (orig as { id?: string } | undefined)?.id;
    if (id) idToResolved.set(id, rc);
  });

  // Gather transcriptions in a deterministic order (children first, then
  // attachments) so the colour index is stable across runs.
  const transcriptions: Data[] = [];
  (entry.children ?? []).forEach((c) => {
    if (isTranscriptionData(c)) transcriptions.push(c);
  });
  (entry.attachments ?? []).forEach((c) => {
    if (isTranscriptionData(c)) transcriptions.push(c);
  });

  const out: CCWord[] = [];
  transcriptions.forEach((t, transcriptionIndex) => {
    const anchorId = t.start?.anchor ?? t.end?.anchor;
    if (!anchorId) return;
    const resolvedAnchor = idToResolved.get(anchorId);
    if (!resolvedAnchor) return;

    // Phrase position on the composition timeline. Words are phrase-
    // relative, so we map both anchors to composition time once and
    // place each word inside that span.
    const phraseStartAnchor = (t.start as { anchorPoint?: number } | undefined)
      ?.anchorPoint;
    const phraseEndAnchor = (t.end as { anchorPoint?: number } | undefined)
      ?.anchorPoint;
    if (phraseStartAnchor == null || phraseEndAnchor == null) return;
    const phraseStartComp = sourceToCompositionTime(
      resolvedAnchor,
      phraseStartAnchor,
    );
    const phraseEndComp = sourceToCompositionTime(
      resolvedAnchor,
      phraseEndAnchor,
    );
    if (phraseStartComp == null || phraseEndComp == null) return;

    const payload = t.data as TranscriptionPayload;
    // If the clip plays at a non-unit speed, the rendered phrase span
    // differs from the recorded `data.duration`. Scale word positions
    // by that factor so they land where they actually play.
    const compSpan = phraseEndComp - phraseStartComp;
    const scale = payload.duration > 0 ? compSpan / payload.duration : 1;

    for (const w of payload.words) {
      out.push({
        text: w.text,
        start: phraseStartComp + w.start * scale,
        end: phraseStartComp + w.end * scale,
        transcriptionIndex,
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
  const innerWrap = (): Composition => {
    const c: Composition = { type: "composition", children: entry.children };
    if (entry.attachments) c.attachments = entry.attachments;
    return c;
  };

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
 *  the higher-level composition on OK. Each selection becomes a
 *  composition referencing `binId` with `in`/`out` set to the
 *  selection's range. Carries the bin entry's body so the on-disk file
 *  stays schema-valid until the compile pass re-splices. */
export function buildCCSpliceChildren(
  entry: BinEntry,
  binId: string,
  selections: CCSelection[],
): Child[] {
  return selections.map((sel) => {
    const c: Composition = {
      type: "composition",
      children: entry.children,
      in: sel.start,
      out: sel.end,
      metadata: { [BIN_ITEM_METADATA_KEY]: binId },
    };
    if (entry.attachments) c.attachments = entry.attachments;
    return c;
  });
}

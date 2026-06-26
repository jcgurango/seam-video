// Word tools: split a CC transcription data item into one data item per
// word, and (inversely) regroup adjusted word items back into a single
// phrase data item with freshly-derived timings.
//
// Pure transformations on a SeamFile — no React, no platform deps. Mirror
// the attach/compose tool convention: selection indices are block-indices
// into the resolved timeline (children first, then attachments).

import { resolveComposition } from "@seam/core";
import type { Child, Data, SeamFile, TimeAnchor } from "@seam/core";

/** One whisper word inside a transcription `data` payload. */
interface RawWord {
  text: string;
  /** Phrase-local seconds — 0 = phrase start. */
  start: number;
  end: number;
}

interface TranscriptionPayload {
  text?: string;
  duration?: number;
  words: RawWord[];
}

export type WordToolResult =
  | { ok: true; doc: SeamFile }
  | { ok: false; error: string };

const MALFORMED = "malformed start and end";

/** Resolve a selection block-index to the underlying authored child.
 *  `index ∈ [0, children.length)` → children[index];
 *  `index ∈ [children.length, total)` → attachments[index − children.length]. */
export function childAtBlockIndex(
  doc: SeamFile,
  index: number,
): Child | undefined {
  const docChildren = doc.children ?? [];
  const childCount = docChildren.length;
  if (index < childCount) return docChildren[index];
  return (doc.attachments ?? [])[index - childCount];
}

/** A transcription data item carrying a whisper `words` array — the shape
 *  "Separate by word" consumes. Used both for button gating and execution. */
export function isTranscriptionWords(child: Child | undefined): child is Data {
  if (!child || child.type !== "data") return false;
  if (!child.tags?.includes("transcription")) return false;
  const d = child.data as TranscriptionPayload | null;
  return !!d && Array.isArray(d.words);
}

/** A per-word data item produced by "Separate by word" — the shape
 *  "Group words" consumes. */
export function isWordItem(child: Child | undefined): child is Data {
  return (
    !!child &&
    child.type === "data" &&
    !!child.tags?.includes("word")
  );
}

function isSourceAnchor(a: TimeAnchor | undefined): a is TimeAnchor {
  return (
    !!a && a.timeSource === "source" && typeof a.anchorPoint === "number"
  );
}

/** Expand one transcription item into a per-word data item list. Returns
 *  null when start/end aren't both present source-mode anchors. */
function wordsFromData(node: Data): Data[] | null {
  const { start, end } = node;
  if (!isSourceAnchor(start) || !isSourceAnchor(end)) return null;
  const payload = node.data as TranscriptionPayload | null;
  if (!payload || !Array.isArray(payload.words)) return null;

  const startPoint = start.anchorPoint as number;
  const endPoint = end.anchorPoint as number;
  // Source-time span of the phrase. Each word's source in/out is the
  // phrase start plus the word's phrase-local offset. We re-express the
  // end relative to the original `end` anchor so its other fields (anchor
  // id, timeSource, offset) carry over verbatim.
  const span = endPoint - startPoint;

  return payload.words.map((w) => ({
    type: "data" as const,
    data: w.text,
    tags: ["transcription", "word"],
    start: { ...start, anchorPoint: startPoint + w.start },
    end: { ...end, anchorPoint: endPoint - span + w.end },
  }));
}

/**
 * Replace every selected transcription data item with one data item per
 * word, in place. Children stay children; attachments stay attachments.
 * Returns an error result (for an alert) when any selected item lacks the
 * required source-mode `start`/`end`.
 */
export function separateByWord(
  doc: SeamFile,
  selectedIndices: number[],
): WordToolResult {
  const expansions = new Map<number, Data[]>();
  for (const idx of selectedIndices) {
    const node = childAtBlockIndex(doc, idx);
    if (!isTranscriptionWords(node)) continue;
    // Whisper occasionally emits a word whose start == end (or worse). Such a
    // zero-length word would become a zero-length item the user can't see or
    // grab — bail and point at the offending word so they can fix the
    // transcription first.
    const payload = node.data as TranscriptionPayload;
    const zero = payload.words.find((w) => !(w.end > w.start));
    if (zero) {
      return {
        ok: false,
        error: `Cannot group by word: "${zero.text}" has zero length`,
      };
    }
    const words = wordsFromData(node);
    if (!words) return { ok: false, error: MALFORMED };
    expansions.set(idx, words);
  }
  if (expansions.size === 0) return { ok: false, error: MALFORMED };

  const docChildren = doc.children ?? [];
  const childCount = docChildren.length;
  const newChildren: Child[] = [];
  docChildren.forEach((c, i) => {
    const exp = expansions.get(i);
    if (exp) newChildren.push(...exp);
    else newChildren.push(c);
  });

  const atts = doc.attachments ?? [];
  const newAttachments: Child[] = [];
  atts.forEach((c, j) => {
    const exp = expansions.get(childCount + j);
    if (exp) newAttachments.push(...exp);
    else newAttachments.push(c);
  });

  if (atts.length > 0) {
    return {
      ok: true,
      doc: { ...doc, children: newChildren, attachments: newAttachments },
    };
  }
  return { ok: true, doc: { ...doc, children: newChildren } };
}

/**
 * Merge selected word data items back into a single phrase data item.
 *
 * Word positions may have been adjusted since the split, so timings are
 * re-derived from the *resolved* timeline rather than the source anchors:
 * the phrase's `start` anchor is taken verbatim from the chronologically
 * first word, its `end` anchor from the last, and each word's `start`/`end`
 * inside the payload is its timeline offset from the phrase start.
 */
export function groupWords(
  doc: SeamFile,
  selectedIndices: number[],
): WordToolResult {
  if (selectedIndices.length < 2) {
    return { ok: false, error: "Select at least two words to group." };
  }

  let resolved;
  try {
    resolved = resolveComposition(doc);
  } catch {
    return { ok: false, error: "Could not resolve the timeline." };
  }

  interface Item {
    idx: number;
    node: Data;
    tStart: number;
    tEnd: number;
  }
  const items: Item[] = [];
  for (const idx of selectedIndices) {
    const node = childAtBlockIndex(doc, idx);
    if (!isWordItem(node)) {
      return { ok: false, error: "Select only word items to group." };
    }
    if (!isSourceAnchor(node.start) || !isSourceAnchor(node.end)) {
      return { ok: false, error: MALFORMED };
    }
    const rc = resolved.children[idx];
    if (!rc) return { ok: false, error: MALFORMED };
    items.push({
      idx,
      node,
      tStart: rc.timelineStart,
      tEnd: rc.timelineEnd,
    });
  }

  // Chronological order by timeline start; the phrase end follows the word
  // that finishes last (which may differ from the last-starting word if the
  // user overlapped them).
  const byStart = [...items].sort((a, b) => a.tStart - b.tStart);
  const first = byStart[0];
  const last = items.reduce((m, it) => (it.tEnd > m.tEnd ? it : m), items[0]);

  const base = first.tStart;
  const words: RawWord[] = byStart.map((it) => ({
    text: String(it.node.data),
    start: it.tStart - base,
    end: it.tEnd - base,
  }));

  const grouped: Data = {
    type: "data",
    data: {
      text: words.map((w) => w.text).join(" "),
      words,
      duration: last.tEnd - base,
    },
    tags: ["transcription", "phrase"],
    start: first.node.start,
    end: last.node.end,
  };

  // Remove every selected word, then drop the grouped phrase into the slot
  // the earliest-selected word occupied (preserving children/attachment
  // membership). Inserting before the same index is removed lands it in
  // place.
  const docChildren = doc.children ?? [];
  const childCount = docChildren.length;
  const insertAt = Math.min(...selectedIndices);
  const insertInChildren = insertAt < childCount;
  const removeChild = new Set<number>();
  const removeAtt = new Set<number>();
  for (const idx of selectedIndices) {
    if (idx < childCount) removeChild.add(idx);
    else removeAtt.add(idx - childCount);
  }

  const newChildren: Child[] = [];
  docChildren.forEach((c, i) => {
    if (insertInChildren && i === insertAt) newChildren.push(grouped);
    if (!removeChild.has(i)) newChildren.push(c);
  });

  const atts = doc.attachments ?? [];
  const newAttachments: Child[] = [];
  atts.forEach((c, j) => {
    if (!insertInChildren && j === insertAt - childCount) {
      newAttachments.push(grouped);
    }
    if (!removeAtt.has(j)) newAttachments.push(c);
  });

  if (newAttachments.length > 0) {
    return {
      ok: true,
      doc: { ...doc, children: newChildren, attachments: newAttachments },
    };
  }
  const { attachments: _omit, ...rest } = doc;
  return { ok: true, doc: { ...rest, children: newChildren } };
}

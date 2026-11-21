// Word tools: split a CC transcription data item into one data item per
// word, and (inversely) regroup adjusted word items back into a single
// phrase data item with freshly-derived timings.
//
// A phrase / word item is a `data` node heading its own run: `start` is a
// source-point anchor on the transcribed node (`"<id>@<sec>"`, plus any
// `offset` the user gave it) and `duration` its output length.
//
// Pure transformations on a SeamFile — no React, no platform deps. Selection
// indices are root child indices (the resolved timeline is 1:1 with
// `doc.children`).

import { formatStart, parseStart, resolveComposition } from "@seam/core";
import type { Child, Data, SeamFile, Start } from "@seam/core";
import { removeFromRuns } from "./runEdit.js";

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

const MALFORMED = "malformed start and duration";

/** The authored root child at a selection index. */
export function childAtBlockIndex(
  doc: SeamFile,
  index: number,
): Child | undefined {
  return (doc.children ?? [])[index];
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

/** The anchored id + source second of a `"<id>@<sec>"` start, or null for
 *  any other form (unset, absolute, bare id, percent). */
function sourceStart(start: Start | undefined): { id: string; value: number } | null {
  if (typeof start !== "string") return null;
  let parsed;
  try {
    parsed = parseStart(start);
  } catch {
    return null;
  }
  if (parsed.kind !== "node" || parsed.point?.kind !== "source") return null;
  return { id: parsed.id, value: parsed.point.value };
}

/** Expand one transcription item into a per-word data item list. Returns
 *  null when it isn't a source-anchored item with a `duration`. */
function wordsFromData(node: Data): Data[] | null {
  const anchor = sourceStart(node.start);
  if (!anchor || node.duration == null) return null;
  const payload = node.data as TranscriptionPayload | null;
  if (!payload || !Array.isArray(payload.words)) return null;

  // Word times are phrase-local source seconds: each word anchors at the
  // phrase's source start plus its own. The node's `duration` is OUTPUT
  // seconds, so word lengths scale by the phrase's output/source ratio.
  const scale =
    payload.duration != null && payload.duration > 0
      ? node.duration / payload.duration
      : 1;

  return payload.words.map((w) => ({
    type: "data" as const,
    data: w.text,
    tags: ["transcription", "word"],
    start: formatStart({
      kind: "node",
      id: anchor.id,
      point: { kind: "source", value: anchor.value + w.start },
    }),
    ...(node.offset ? { offset: node.offset } : {}),
    duration: (w.end - w.start) * scale,
  }));
}

/**
 * Replace every selected transcription data item with one data item per
 * word, in place (each word heads its own run, like the phrase did).
 * Returns an error result (for an alert) when any selected item lacks the
 * required source-point `start` / `duration`.
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

  const newChildren: Child[] = [];
  (doc.children ?? []).forEach((c, i) => {
    const exp = expansions.get(i);
    if (exp) newChildren.push(...exp);
    else newChildren.push(c);
  });
  return { ok: true, doc: { ...doc, children: newChildren } };
}

/**
 * Merge selected word data items back into a single phrase data item.
 *
 * Word positions may have been adjusted since the split, so timings are
 * re-derived from the *resolved* timeline rather than the source anchors:
 * the phrase's placement (`start` + `offset`) is taken verbatim from the
 * chronologically first word, its `duration` runs to the end of the word
 * that finishes last, and each word's `start`/`end` inside the payload is
 * its timeline offset from the phrase start.
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
    // `uncropped` keeps resolved children 1:1 with `doc.children`.
    resolved = resolveComposition(doc, { uncropped: true });
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
    if (!sourceStart(node.start)) return { ok: false, error: MALFORMED };
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
    ...(first.node.offset ? { offset: first.node.offset } : {}),
    duration: last.tEnd - base,
  };

  // Remove every selected word, then drop the grouped phrase into the slot
  // the earliest-selected word occupied. Every word heads its own run, so
  // `removeFromRuns` hands a removed word's placement to any node that was
  // following it — which leaves the node at that slot a run head, and the
  // phrase (a head itself) can be spliced in front without joining or
  // splitting a run.
  const insertAt = Math.min(...selectedIndices);
  const newChildren = removeFromRuns(doc.children ?? [], new Set(selectedIndices));
  newChildren.splice(insertAt, 0, grouped);
  return { ok: true, doc: { ...doc, children: newChildren } };
}

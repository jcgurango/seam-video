// Turning things into caption nodes, and captions into other things — the
// pure half of the editor tools. No editor, no React: plain documents in,
// plain nodes out.

import type { Child, ResolvedChild, TranscriptSegment } from "@seam/core";
import { collectCaptions, cueStyle, deriveCues, type CaptionCue } from "./collect.js";
import {
  captionText,
  type CaptionNode,
  type CaptionStyle,
  type CaptionSurfaceStyle,
  type WordNode,
} from "./index.js";

/** Round to the microsecond: transcript arithmetic shouldn't leave
 *  0.30000000000000004 in a document. */
const tidy = (n: number): number => Math.round(n * 1e6) / 1e6;

type TimedWord = { text: string; start: number; end: number };

/**
 * Give every word a length. Whisper sometimes returns a word with none
 * (`end <= start`); it would never show, and its text would be lost. Such a
 * word takes half of the NEXT word's time (that word starts later by the
 * same amount), or half of the PREVIOUS one when there is no usable next.
 * If that leaves nothing to borrow from — a line of one word, or of only
 * zero-length words — the words share the whole line `[lineStart, lineEnd]`
 * evenly. A line with no length either yields no words.
 */
export function repairWordTimings(
  words: readonly TimedWord[],
  lineStart: number,
  lineEnd: number,
): TimedWord[] {
  const out = words.filter((w) => w.text.trim() !== "").map((w) => ({ ...w }));
  const has = (w: TimedWord | undefined): boolean => !!w && w.end - w.start > 1e-6;
  for (let i = 0; i < out.length; i++) {
    const w = out[i];
    if (has(w)) continue;
    const next = out[i + 1];
    const prev = out[i - 1];
    if (next && has(next)) {
      const mid = next.start + (next.end - next.start) / 2;
      w.start = Math.min(w.start, next.start);
      w.end = mid;
      next.start = mid;
    } else if (prev && has(prev)) {
      const mid = prev.start + (prev.end - prev.start) / 2;
      w.start = mid;
      w.end = prev.end;
      prev.end = mid;
    }
  }
  if (out.every(has)) return out;
  // Nothing to borrow from: share the line out evenly.
  const span = lineEnd - lineStart;
  if (!(span > 1e-6)) return out.filter(has);
  const each = span / out.length;
  return out.map((w, i) => ({ ...w, start: lineStart + i * each, end: lineStart + (i + 1) * each }));
}

/** Timed words → `word` children: each word's length, and the pause before
 *  it as its `offset`. `scale` converts the words' time into the caption's. */
function wordNodes(
  words: ReadonlyArray<TimedWord>,
  origin: number,
  scale: number,
): WordNode[] {
  const out: WordNode[] = [];
  let cursor = origin;
  for (const w of words) {
    const text = w.text.trim();
    const length = tidy((w.end - w.start) * scale);
    if (text === "" || length <= 0) continue;
    const gap = tidy((w.start - cursor) * scale);
    out.push({ type: "word", text, duration: length, ...(gap > 0 ? { offset: gap } : {}) });
    cursor = w.end;
  }
  return out;
}

/**
 * Captions for a transcribed node, one per segment — each placed on its own
 * (so the silences between lines stay exactly where the transcript put them).
 * A caption with words has NO `duration`: its length is its words'. Only a
 * line without word timings carries `text` + `duration`.
 *
 * - `inside`: the node is a composition and the captions go INTO it, placed
 *   by number in its inner time. That is what lets them travel through its
 *   window when it is cut.
 * - `beside`: the node is a clip / audio; the captions sit next to it,
 *   anchored to its source time (`"<id>@<sec>"`) so they follow it, with
 *   lengths converted to output seconds at its playback `rate`.
 */
export function captionsFromTranscript(
  segments: readonly TranscriptSegment[],
  placement:
    | { kind: "inside"; anchorBase: number }
    | { kind: "beside"; id: string; anchorBase: number; rate: number },
): CaptionNode[] {
  const scale = placement.kind === "beside" ? 1 / (placement.rate || 1) : 1;
  const out: CaptionNode[] = [];
  for (const seg of segments) {
    const text = seg.text.trim();
    if (text === "") continue;
    const timed = repairWordTimings(seg.words ?? [], seg.start, seg.end);
    // With words the caption starts at its first word (no leading pause
    // hidden inside it) and runs for as long as they do.
    const from = timed.length > 0 ? timed[0].start : seg.start;
    const words = wordNodes(timed, from, scale);
    const length = tidy((seg.end - seg.start) * scale);
    if (words.length === 0 && length <= 0) continue;
    const at = tidy(placement.anchorBase + from);
    out.push({
      type: "caption",
      start: placement.kind === "inside" ? at : `${placement.id}@${at}`,
      ...(words.length > 0 ? { children: words as unknown as Child[] } : { text, duration: length }),
    });
  }
  return out;
}

/**
 * The captions a composition would show, written out as nodes that sit BESIDE
 * it — the starting point for editing them by hand ("reauthor"). Each is
 * anchored to the composition's source time, so it follows the composition;
 * lengths are in output seconds.
 *
 * `resolved` is the composition resolved on its own (its window applied, so
 * its children are in window-relative time); `inTime` is where that window
 * starts in the composition's inner time (its `in`, default 0).
 */
export function reauthoredCaptions(
  resolved: ResolvedChild,
  target: { id: string; inTime: number },
  style: CaptionSurfaceStyle = {},
): CaptionNode[] {
  if (resolved.type !== "composition") return [];
  const speed = resolved.speed || 1;
  const cues = deriveCues(collectCaptions({ children: resolved.children }), style);
  return cues.map((cue) => nodeFromCue(cue, target, speed));
}

function nodeFromCue(cue: CaptionCue, target: { id: string; inTime: number }, speed: number): CaptionNode {
  const words = wordNodes(cue.words, cue.start, 1 / speed);
  return {
    type: "caption",
    start: `${target.id}@${tidy(target.inTime + cue.start)}`,
    ...(cue.speaker != null ? { speaker: cue.speaker } : {}),
    ...(cue.style != null ? { style: cue.style } : {}),
    // A caption's length is its words'; only a text-only one needs `duration`.
    ...(words.length > 0
      ? { children: words as unknown as Child[] }
      : { text: cue.text, duration: tidy((cue.end - cue.start) / speed) }),
  };
}

/** How long a caption lasts: its `duration`, else the extent of its words. */
export function captionLength(caption: CaptionNode): number {
  if (caption.duration != null) return caption.duration;
  let end = 0;
  for (const child of caption.children ?? []) {
    const w = child as unknown as { offset?: number; duration?: number };
    end += (w.offset ?? 0) + (w.duration ?? 0);
  }
  return tidy(end);
}

/**
 * A `text` node that looks like `caption` does at a surface with `style` —
 * for the rare caption that has to be designed by hand. It keeps the
 * caption's slot (`id`, `start`, `offset`) and length. The result is only
 * equivalent when the caption sits directly in the surface (a text node
 * inside a transformed composition is transformed with it; a caption isn't).
 */
export function captionAsText(caption: CaptionNode, style: CaptionSurfaceStyle = {}): Child {
  const look: CaptionStyle = cueStyle(style, caption);
  const { id, start, offset } = caption;
  return {
    type: "text",
    text: captionText(caption as { text?: string; children?: { type: string }[] }),
    duration: captionLength(caption),
    ...(id != null ? { id } : {}),
    ...(start !== undefined ? { start } : {}),
    ...(offset != null ? { offset } : {}),
    ...look,
  } as unknown as Child;
}

// ── Slice / resize / merge ──────────────────────────────────────────

type Word = { type: "word"; text: string; duration: number; offset?: number };
const wordsOf = (caption: { children?: readonly unknown[] }): Word[] =>
  ((caption.children ?? []) as Word[]).filter((c) => c.type === "word");

/** A word edited to nothing would vanish from the timeline. */
const MIN_WORD = 0.02;

/**
 * Slice a caption at `t` (seconds from its start) — at the NEAREST WORD
 * BOUNDARY, never through a word. `left` keeps the slot (`id`, `start`,
 * `offset`) and the words before the cut; `right` holds the rest and has no
 * placement — `at` says where it begins (its first word, in seconds from the
 * original's start), and the editor places it there on its own anchor.
 * Neither carries a `duration` (their words are their length). Null when
 * there is no boundary to cut at (fewer than two words).
 */
export function splitCaption(
  caption: CaptionNode,
  t: number,
): { left: CaptionNode; right: CaptionNode; at: number } | null {
  const words = wordsOf(caption);
  if (words.length < 2) return null;
  // Boundary k sits between word k-1 and word k: the pause [end, start].
  let cursor = 0;
  let best = -1;
  let bestDistance = Infinity;
  let at = 0;
  words.forEach((w, k) => {
    const gapStart = cursor;
    const gapEnd = cursor + (w.offset ?? 0);
    if (k > 0) {
      const distance = t < gapStart ? gapStart - t : t > gapEnd ? t - gapEnd : 0;
      if (distance < bestDistance) {
        bestDistance = distance;
        best = k;
        at = gapEnd;
      }
    }
    cursor = gapEnd + w.duration;
  });
  if (best < 1) return null;

  const { children: _children, duration: _duration, text: _text, ...rest } = caption;
  const { id: _id, start: _start, offset: _offset, ...shared } = rest;
  // The pause before the right half's first word is now its placement.
  const { offset: _pause, ...firstRight } = words[best];
  return {
    left: { ...rest, children: words.slice(0, best) as unknown as Child[] },
    right: { ...shared, children: [firstRight, ...words.slice(best + 1)] as unknown as Child[] },
    at: tidy(at),
  };
}

/**
 * Drag a caption's edge: the RIGHT edge changes its last word's length, the
 * LEFT edge its first word's (`delta` > 0 = that word gets shorter). With a
 * caption sliced down to one word this is retiming that word. A text-only
 * caption changes its `duration`. An authored `duration` beside words is
 * dropped — the words are the length.
 */
export function resizeCaption(caption: CaptionNode, side: "left" | "right", delta: number): CaptionNode {
  const words = wordsOf(caption);
  const change = side === "left" ? -delta : delta;
  if (words.length === 0) {
    return { ...caption, duration: Math.max(MIN_WORD, tidy((caption.duration ?? 0) + change)) };
  }
  const at = side === "left" ? 0 : words.length - 1;
  const next = words.map((w, i) =>
    i === at ? { ...w, duration: Math.max(MIN_WORD, tidy(w.duration + change)) } : w,
  );
  const { duration: _duration, ...rest } = caption;
  return { ...rest, children: next as unknown as Child[] };
}

/**
 * Merge captions into one. `captions` are siblings with where each STARTS
 * in their container's time; they need not touch. The earliest one's slot
 * (`id`, `start`, `offset`), speaker and style win; every word keeps the
 * moment it was said — the silence between two merged captions becomes the
 * pause (`offset`) before the first word of the later one. A text-only
 * caption joins as one word as long as it was.
 */
export function mergeCaptions(
  captions: ReadonlyArray<{ node: CaptionNode; start: number; end: number }>,
): CaptionNode | null {
  if (captions.length === 0) return null;
  const ordered = [...captions].sort((a, b) => a.start - b.start);
  const timed: Array<{ text: string; start: number; end: number }> = [];
  for (const { node, start, end } of ordered) {
    const words = wordsOf(node);
    if (words.length === 0) {
      const text = (node.text ?? "").trim();
      if (text !== "" && end > start) timed.push({ text, start, end });
      continue;
    }
    let cursor = start;
    for (const w of words) {
      const from = cursor + (w.offset ?? 0);
      timed.push({ text: w.text, start: from, end: from + w.duration });
      cursor = from + w.duration;
    }
  }
  if (timed.length === 0) return null;
  timed.sort((a, b) => a.start - b.start);
  const first = ordered[0];
  const { children: _children, duration: _duration, text: _text, ...slot } = first.node;
  return { ...slot, children: wordNodes(timed, first.start, 1) as unknown as Child[] };
}

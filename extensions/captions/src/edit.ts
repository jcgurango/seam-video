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

/** Timed words → `word` children: each word's length, and the pause before
 *  it as its `offset`. `scale` converts the words' time into the caption's. */
function wordNodes(
  words: ReadonlyArray<{ text: string; start: number; end: number }>,
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
 * Captions for a transcribed node, one per segment.
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
    const length = tidy((seg.end - seg.start) * scale);
    const text = seg.text.trim();
    if (length <= 0 || text === "") continue;
    const at = tidy(placement.anchorBase + seg.start);
    const words = wordNodes(seg.words ?? [], seg.start, scale);
    out.push({
      type: "caption",
      start: placement.kind === "inside" ? at : `${placement.id}@${at}`,
      // The phrase's own length, so trailing silence after the last word
      // still belongs to it.
      duration: length,
      ...(words.length > 0 ? { children: words as unknown as Child[] } : { text }),
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
    duration: tidy((cue.end - cue.start) / speed),
    ...(cue.speaker != null ? { speaker: cue.speaker } : {}),
    ...(cue.style != null ? { style: cue.style } : {}),
    ...(words.length > 0 ? { children: words as unknown as Child[] } : { text: cue.text }),
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

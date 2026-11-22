// The pure half of the CC cut: the words a composition speaks, as a flat
// list to pick ranges from. No editor, no React.

import type { ResolvedChild } from "@seam/core";
import { collectCaptions } from "./collect.js";

/** One pickable word, in the composition's INNER time (the space of its
 *  `in` / `out`, which is what `keepRanges` cuts in). */
export interface CutWord {
  text: string;
  start: number;
  end: number;
  /** Index of the caption it belongs to (in time order) — phrase grouping. */
  cue: number;
}

/**
 * Every word that bubbles up inside a composition, in time order.
 *
 * `resolved` is the composition resolved on its own (its window applied, so
 * its children are in window-relative inner time); `inTime` is where that
 * window starts in its inner time (its `in`, default 0). A caption with no
 * word timings counts as one word spanning it. Captions a nested composition
 * keeps to itself (`captions: "show"` / `"off"`) are not included.
 */
export function cutWords(resolved: ResolvedChild | null, inTime: number): CutWord[] {
  if (!resolved || resolved.type !== "composition") return [];
  const cues = collectCaptions({ children: resolved.children }).sort((a, b) => a.start - b.start);
  const out: CutWord[] = [];
  cues.forEach((cue, index) => {
    const words = cue.words.length > 0 ? cue.words : [{ text: cue.text, start: cue.start, end: cue.end }];
    for (const w of words) {
      if (!(w.end > w.start)) continue;
      out.push({ text: w.text, start: inTime + w.start, end: inTime + w.end, cue: index });
    }
  });
  return out.sort((a, b) => a.start - b.start);
}

/** Where inner time `t` of a composition plays, given one of its pieces (a
 *  window `[in, out]` shown over the global span `[start, end]`). */
export function innerToGlobal(
  t: number,
  piece: { in: number; out: number },
  span: { start: number; end: number },
): number {
  const length = piece.out - piece.in;
  if (!(length > 0)) return span.start;
  return span.start + ((t - piece.in) / length) * (span.end - span.start);
}

// Collecting captions — the "bubbling".
//
// A caption is not drawn where it sits. From a SURFACE (the root, or a
// composition whose `captions` is "show") we walk down its subtree and gather
// every caption that reaches it, with its time mapped into the surface's own
// inner time through every composition window, speed and loop on the way.
// The walk stops at any composition that is itself a surface ("show") or
// that swallows its captions ("off").
//
// Pure functions over the resolved tree: the overlay renderer, subtitle
// export and (later) the editor's caption lane and CC cut ribbon all read
// the same list.

import { walkResolved, type ResolvedChild, type SurfaceView } from "@seam/core";
import {
  captionText,
  type CaptionRouting,
  type CaptionStyle,
  type CaptionSurfaceStyle,
  type ResolvedCaption,
} from "./index.js";

/** One word of a cue, in the surface's inner time. */
export interface CueWord {
  text: string;
  start: number;
  end: number;
}

/** A caption as it reaches a surface: what is shown, and when. */
export interface CaptionCue {
  /** Surface inner time, seconds. Shown while `start <= t < end`. */
  start: number;
  end: number;
  text: string;
  speaker?: string;
  /** The source caption's own style override. */
  style?: CaptionStyle;
  /** The words that survive (empty for a text-only caption). */
  words: CueWord[];
  /** The caption node this came from. */
  caption: ResolvedCaption;
}

/** How a surface routes captions: the root shows them unless it says "off";
 *  a composition only when it says "show". */
export function captionRouting(surface: Pick<SurfaceView, "root" | "ext">): CaptionRouting {
  const authored = surface.ext?.captions as CaptionRouting | undefined;
  if (surface.root) return authored === "off" ? "off" : "show";
  return authored ?? "pass";
}

/** The style a surface holds (empty when it authors none). */
export function surfaceStyle(surface: Pick<SurfaceView, "ext">): CaptionSurfaceStyle {
  return (surface.ext?.captionStyle as CaptionSurfaceStyle | undefined) ?? {};
}

/** Every caption that bubbles up to `surface`, in tree order, timed in the
 *  surface's inner time. Captions whose words were all cut away by a
 *  composition window (and that carry no text of their own) are dropped. */
export function collectCaptions(surface: Pick<SurfaceView, "children">): CaptionCue[] {
  const cues: CaptionCue[] = [];
  walkResolved(surface.children as ResolvedChild[], (node, at) => {
    if (node.type === "composition") {
      // A nested surface draws its own; "off" swallows them.
      const routing = (node.ext?.captions as CaptionRouting | undefined) ?? "pass";
      return routing === "pass";
    }
    if (node.type !== "caption") return true;
    const caption = node as ResolvedCaption;
    const words: CueWord[] = [];
    for (const child of caption.children ?? []) {
      if (child.type !== "word") continue;
      words.push({
        text: (child as unknown as { text: string }).text,
        start: at.start + child.timelineStart / at.rate,
        end: at.start + child.timelineEnd / at.rate,
      });
    }
    const text = captionText(caption);
    if (text !== "") {
      cues.push({
        start: at.start,
        end: at.end,
        text,
        ...(caption.speaker != null ? { speaker: caption.speaker } : {}),
        ...(caption.style != null ? { style: caption.style } : {}),
        words,
        caption,
      });
    }
    return false; // a caption's words are not walked as nodes
  });
  return cues;
}

/**
 * Derive the phrases a surface displays from the captions that reached it.
 *
 * First version, deliberately conservative: an authored caption is a hard
 * boundary (captions are never merged); a caption longer than
 * `style.maxChars` is split at word boundaries into consecutive phrases,
 * each shown from its first word until the next phrase begins. A text-only
 * caption has no word timings, so it is never split.
 */
export function deriveCues(captions: readonly CaptionCue[], style: CaptionSurfaceStyle): CaptionCue[] {
  const max = style.maxChars;
  if (max == null) return [...captions];
  const out: CaptionCue[] = [];
  for (const cue of captions) {
    if (cue.text.length <= max || cue.words.length < 2) {
      out.push(cue);
      continue;
    }
    // Greedy: fill each phrase up to `max` characters (a single word longer
    // than that stands alone).
    const groups: CueWord[][] = [];
    let current: CueWord[] = [];
    let length = 0;
    for (const word of cue.words) {
      const next = current.length === 0 ? word.text.length : length + 1 + word.text.length;
      if (current.length > 0 && next > max) {
        groups.push(current);
        current = [word];
        length = word.text.length;
      } else {
        current.push(word);
        length = next;
      }
    }
    if (current.length > 0) groups.push(current);
    groups.forEach((words, i) => {
      out.push({
        ...cue,
        // The first phrase starts with the caption; each runs until the next.
        start: i === 0 ? cue.start : words[0].start,
        end: i === groups.length - 1 ? cue.end : groups[i + 1][0].start,
        text: words.map((w) => w.text).join(" "),
        words,
      });
    });
  }
  return out;
}

// Cues per surface, keyed by its children array (stable for a resolved
// timeline) and invalidated when the style object changes.
const cueCache = new WeakMap<object, { style: unknown; cues: CaptionCue[] }>();

/** The display phrases of a surface (collected + derived), cached. Empty when
 *  the surface does not show captions. */
export function surfaceCues(surface: SurfaceView): CaptionCue[] {
  if (captionRouting(surface) !== "show") return [];
  const style = surface.ext?.captionStyle;
  const hit = cueCache.get(surface.children);
  if (hit && hit.style === style) return hit.cues;
  const cues = deriveCues(collectCaptions(surface), surfaceStyle(surface));
  cueCache.set(surface.children, { style, cues });
  return cues;
}

/** The phrases on screen at the surface's inner time `t`, bottom first. */
export function activeCues(surface: SurfaceView, t: number): CaptionCue[] {
  return surfaceCues(surface).filter((cue) => t >= cue.start && t < cue.end);
}

/** The look of one cue at a surface: the surface's default, then its
 *  speaker's overrides, then the caption's own. */
export function cueStyle(style: CaptionSurfaceStyle, cue: Pick<CaptionCue, "speaker" | "style">): CaptionStyle {
  const { maxChars: _maxChars, speakers, ...base } = style;
  return {
    ...base,
    ...(cue.speaker != null ? speakers?.[cue.speaker] : undefined),
    ...cue.style,
  };
}

// ── Subtitle export ─────────────────────────────────────────────────

function stamp(seconds: number, separator: string): string {
  const ms = Math.max(0, Math.round(seconds * 1000));
  const pad = (n: number, width = 2) => String(n).padStart(width, "0");
  return `${pad(Math.floor(ms / 3600000))}:${pad(Math.floor(ms / 60000) % 60)}:${pad(
    Math.floor(ms / 1000) % 60,
  )}${separator}${pad(ms % 1000, 3)}`;
}

const byTime = (cues: readonly CaptionCue[]) => [...cues].sort((a, b) => a.start - b.start);

/** The cues as a SubRip (.srt) document. */
export function toSrt(cues: readonly CaptionCue[]): string {
  return byTime(cues)
    .map((cue, i) => `${i + 1}\n${stamp(cue.start, ",")} --> ${stamp(cue.end, ",")}\n${cue.text}\n`)
    .join("\n");
}

/** The cues as a WebVTT (.vtt) document. */
export function toVtt(cues: readonly CaptionCue[]): string {
  return (
    "WEBVTT\n\n" +
    byTime(cues)
      .map((cue) => `${stamp(cue.start, ".")} --> ${stamp(cue.end, ".")}\n${cue.text}\n`)
      .join("\n")
  );
}

import type { Keyframed } from "./animation/keyframes.js";
export type { Keyframe, Keyframed } from "./animation/keyframes.js";
export type { TimeExpr } from "./animation/time.js";

export type Overflow = "trim-end" | "trim-start" | "trim-center" | "stretch";
export type Underflow =
  | "extend-end"
  | "extend-start"
  | "extend-center"
  | "stretch";

export type Position = "absolute" | "relative";
export type ObjectFit = "center" | "fit" | "cover";

// ── Filters ────────────────────────────────────────────────────────

export interface AdjustFilter {
  type: "adjust";
  brightness?: Keyframed<number>;
  contrast?: Keyframed<number>;
  saturation?: Keyframed<number>;
  gamma?: Keyframed<number>;
}

export interface OpacityFilter {
  type: "opacity";
  value: Keyframed<number>;
}

export interface ColorBalanceFilter {
  type: "colorbalance";
  rs?: Keyframed<number>; gs?: Keyframed<number>; bs?: Keyframed<number>;
  rm?: Keyframed<number>; gm?: Keyframed<number>; bm?: Keyframed<number>;
  rh?: Keyframed<number>; gh?: Keyframed<number>; bh?: Keyframed<number>;
}

export interface ColorTemperatureFilter {
  type: "colortemperature";
  temperature?: Keyframed<number>;
}

export type Filter = AdjustFilter | OpacityFilter | ColorBalanceFilter | ColorTemperatureFilter;

/** A spatial dimension. Numbers are pixels; strings must be percentages
 *  like "50%" or "-25%". */
export type Dimension = number | string;

export interface SpatialFields {
  position?: Position;
  objectFit?: ObjectFit;
  top?: Keyframed<Dimension>;
  left?: Keyframed<Dimension>;
  right?: Keyframed<Dimension>;
  bottom?: Keyframed<Dimension>;
  width?: Keyframed<Dimension>;
  height?: Keyframed<Dimension>;
}

/**
 * A timing anchor references another child (by `id`) in the enclosing
 * composition's scope.
 *
 * When `anchor` is set, `timeSource` is required and selects the coordinate
 * space of `anchorPoint`:
 * - `"output"`: `anchorPoint` is a percentage string (e.g. "50%") into the
 *   anchor's *output* duration (0% = start, 100% = end).
 * - `"source"`: `anchorPoint` is a number of seconds in the anchor's *source*
 *   timeline — the pre-trim/pre-speed media time for clips, or the pre-window
 *   inner timeline for compositions. The resolver reverses the
 *   clip's in/out+speed (or the composition's windowing) to find the
 *   corresponding output time, so values can land outside the anchor's
 *   visible range (negative output times are legal).
 *
 * `offset` always shifts in *output* time — a number is absolute seconds,
 * a string like "25%" is that fraction of the *attachment's own natural
 * output duration* (so the offset is self-contained and doesn't depend on
 * the anchor or even require one).
 *
 * When `anchor` is omitted, `anchorPoint`/`timeSource` must also be omitted
 * and `offset` is relative to the composition's start.
 */
export interface TimeAnchor {
  anchor?: string;
  anchorPoint?: string | number;
  offset?: number | string;
  timeSource?: "output" | "source";
}

/** Free-form per-node bag for editor / tooling concerns that travel with
 *  the document but don't affect rendering. Values are arbitrary JSON. */
export type Metadata = Record<string, unknown>;

export interface ChildTimingFields extends SpatialFields {
  in?: number;
  out?: number;
  overflow?: Overflow;
  underflow?: Underflow;
  filters?: Filter[];
  /** Identifier for anchor references within the enclosing composition. */
  id?: string;
  /** Anchor for the child's timeline start (only meaningful in attachments). */
  start?: TimeAnchor;
  /** Anchor for the child's timeline end (only meaningful in attachments). */
  end?: TimeAnchor;
  metadata?: Metadata;
}

export interface Clip extends ChildTimingFields {
  type: "clip";
  source: string;
  in: number;
  out: number;
  speed?: number;
  duration?: number;
  /** Audio-channel gain multiplier. Default 1; 0 mutes; >1 amplifies. */
  volume?: Keyframed<number>;
}

/**
 * A frozen frame. Source can be an image (any single-frame format) or a
 * video — in the video case, `in` selects which timestamp to freeze on.
 * Visual only; no audio, no overflow/underflow (target span just shows
 * the same frame for `duration` seconds, like `text`).
 */
export interface Static extends SpatialFields {
  type: "static";
  source: string;
  duration: number;
  /** Video-source freeze timestamp in seconds (ignored for images).
   *  Defaults to 0. */
  in?: number;
  filters?: Filter[];
  id?: string;
  start?: TimeAnchor;
  end?: TimeAnchor;
  metadata?: Metadata;
}

export interface Empty {
  type: "empty";
  duration: number;
  id?: string;
  start?: TimeAnchor;
  end?: TimeAnchor;
  metadata?: Metadata;
}

/**
 * An audio-only clip. Shares clip's temporal vocabulary (`in`/`out`/`speed`/
 * `duration`/`overflow`/`underflow`) and id/anchor fields, but has no
 * spatial layout and no visual filters — audio filtering (gain/EQ/etc.) is
 * different in kind and will get its own schema later.
 */
export interface Audio {
  type: "audio";
  source: string;
  in: number;
  out: number;
  speed?: number;
  duration?: number;
  overflow?: Overflow;
  underflow?: Underflow;
  /** Audio-channel gain multiplier. Default 1; 0 mutes; >1 amplifies. */
  volume?: Keyframed<number>;
  id?: string;
  start?: TimeAnchor;
  end?: TimeAnchor;
  metadata?: Metadata;
}

/**
 * A free-form JSON payload that occupies a span of time on the timeline.
 * Renders nothing visual or audible; it's a parking spot for editor
 * concerns (markers, captions, decorators) that travel with the document.
 *
 * As a child it takes up `duration` seconds of sequential time (default 0).
 * As an attachment it can be pinned via `start`/`end`; if both are pinned
 * its on-timeline length is `end − start` regardless of `duration`.
 */
export interface Data {
  type: "data";
  data: unknown;
  duration?: number;
  /** Free-form classifier tags. Editor-side filtering / grouping fodder. */
  tags?: string[];
  id?: string;
  start?: TimeAnchor;
  end?: TimeAnchor;
  metadata?: Metadata;
}

/**
 * Background padding around inline text. A single number applies to all
 * four sides; `[v, h]` splits vertical/horizontal; `[t, r, b, l]` is the
 * full set in CSS shorthand order.
 */
export type TextPadding = number | [number, number] | [number, number, number, number];

/** Common style fields available on both the top-level `Text` node and
 *  on individual `TextRun`s in its `text` array. Layout-level fields
 *  (`textAlign`, `verticalAlign`, `lineHeight`, `contentWidth`,
 *  `contentHeight`) live only on the top-level node. */
export interface TextStyleFields {
  fontFamily?: string;
  fontSize?: Keyframed<number>;
  /** Any valid SVG `fill` value; defaults to black. */
  color?: Keyframed<string>;
  /** Any valid SVG `font-weight` (e.g. "bold", "700"). */
  fontWeight?: string;
  /** Any valid SVG fill string. Drawn as a rect behind the run, expanding
   *  per line on wrap (mirrors the way a span's background flows in HTML). */
  backgroundColor?: Keyframed<string>;
  backgroundPadding?: Keyframed<TextPadding>;
  /** Any valid SVG stroke value. */
  strokeColor?: Keyframed<string>;
  /** SVG stroke width in pixels. SVG centers strokes on path edges, so
   *  the visible outline thickness is roughly half this value. */
  strokeWidth?: Keyframed<number>;
}

/** A styled run inside a `Text` node's `text` array. Mirrors
 *  `TextStyleFields` plus the run's own `text` content. */
export interface TextRun extends TextStyleFields {
  text: string;
}

/**
 * A text node rendered by laying out (via `@chenglou/pretext`) and
 * emitting an inline SVG. Like html, sizing follows composition rules:
 * `contentWidth`/`contentHeight` are the SVG's intrinsic canvas, and
 * `SpatialFields` place that canvas on the parent.
 *
 * `text` can be a plain string or an array of strings / styled runs
 * for inline formatting (bold parts, per-run highlights, etc.).
 */
export interface Text extends SpatialFields, TextStyleFields {
  type: "text";
  text: string | (string | TextRun)[];
  /** Optional override for line height in pixels; defaults to 1.2 ×
   *  `fontSize`. */
  lineHeight?: Keyframed<number>;
  textAlign?: "left" | "center" | "right";
  verticalAlign?: "top" | "center" | "bottom";
  /** Inset on the inner layout box. Same shape as `backgroundPadding`
   *  (number / `[v,h]` / `[t,r,b,l]`). Useful for keeping
   *  background/stroke from clipping the content edges. */
  padding?: TextPadding;
  contentWidth?: number;
  contentHeight?: number;
  /** Display duration. Required for sequential / single-anchor
   *  attachment use; optional only when both `start` and `end` are
   *  pinned (the anchor span dictates the target). */
  duration?: number;
  filters?: Filter[];
  id?: string;
  start?: TimeAnchor;
  end?: TimeAnchor;
  metadata?: Metadata;
}

/**
 * Reusable composition body addressable by `id`. Referenced from any
 * descendant composition via `binItem: "<id>"`. Holds only the body
 * (`children` + optional `attachments`) — instance-level fields
 * (spatial / timing / filters / metadata) live on each reference, so
 * swapping a bin entry can't accidentally overwrite a reference's
 * authored properties.
 */
export interface BinEntry {
  id: string;
  children: Child[];
  attachments?: Child[];
}

export interface Composition extends ChildTimingFields {
  type: "composition";
  children: Child[];
  /**
   * Anchored children rendered on top of `children`. Each attachment's
   * `start`/`end` may reference child IDs. Attachments render in array
   * order, last on top.
   */
  attachments?: Child[];
  /**
   * Bin entries scoped to this composition's subtree. Descendant
   * compositions with `binItem: "<id>"` resolve to the nearest
   * enclosing bin entry with that id — this composition's own entries
   * win over any inherited from ancestors.
   */
  bin?: BinEntry[];
  /**
   * Names a bin entry whose body this composition adopts at compile
   * time. The reference's own `children`/`attachments` are ignored in
   * favour of the bin entry's; all other fields stay as-authored.
   */
  binItem?: string;
  /**
   * JavaScript source — body of an anonymous function `(currentNode) => Composition`.
   * Runs at compile time against this composition (with bins already
   * resolved); the return value replaces this composition in the
   * rendered tree.
   */
  script?: string;
  /** Any valid SVG/CSS fill value. Painted across the composition's
   *  container rect under all children. */
  backgroundColor?: string;
  contentWidth?: number;
  contentHeight?: number;
}

export type Child = Clip | Audio | Static | Empty | Data | Text | Composition;
export type SeamFile = Composition;

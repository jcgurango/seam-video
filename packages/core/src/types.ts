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
  brightness?: number;
  contrast?: number;
  saturation?: number;
  gamma?: number;
}

export interface OpacityFilter {
  type: "opacity";
  value: number;
}

export interface ColorBalanceFilter {
  type: "colorbalance";
  rs?: number; gs?: number; bs?: number;
  rm?: number; gm?: number; bm?: number;
  rh?: number; gh?: number; bh?: number;
}

export interface ColorTemperatureFilter {
  type: "colortemperature";
  temperature?: number;
}

export type Filter = AdjustFilter | OpacityFilter | ColorBalanceFilter | ColorTemperatureFilter;

export interface SpatialFields {
  position?: Position;
  objectFit?: ObjectFit;
  top?: string;
  left?: string;
  right?: string;
  bottom?: string;
  width?: string;
  height?: string;
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
}

export interface Clip extends ChildTimingFields {
  type: "clip";
  source: string;
  in: number;
  out: number;
  speed?: number;
  duration?: number;
  /** Audio-channel gain multiplier. Default 1; 0 mutes; >1 amplifies. */
  volume?: number;
}

export interface Empty {
  type: "empty";
  duration: number;
  id?: string;
  start?: TimeAnchor;
  end?: TimeAnchor;
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
  volume?: number;
  id?: string;
  start?: TimeAnchor;
  end?: TimeAnchor;
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
}

/**
 * A static HTML snippet rasterized to an image (via satori) and rendered
 * for `duration` seconds. Restricted to satori-compatible markup — a
 * layout/text subset, not arbitrary HTML.
 *
 * Sizing mirrors compositions: `contentWidth`/`contentHeight` are the
 * intrinsic SVG canvas dims (what satori renders into), with canvas-dim
 * fallback when omitted; `SpatialFields` (top/left/right/bottom/width/
 * height/position/objectFit) place the rasterized image on the parent.
 */
export interface Html extends SpatialFields {
  type: "html";
  source: string;
  /** Natural duration in seconds. Required for sequential or
   *  single-anchor attachment use; optional only when both `start` and
   *  `end` are pinned (the anchor span dictates the target). */
  duration?: number;
  contentWidth?: number;
  contentHeight?: number;
  filters?: Filter[];
  id?: string;
  start?: TimeAnchor;
  end?: TimeAnchor;
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
  contentWidth?: number;
  contentHeight?: number;
}

export type Child = Clip | Audio | Empty | Data | Html | Composition;
export type SeamFile = Composition;

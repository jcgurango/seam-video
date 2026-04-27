export type Justify = "start" | "end" | "center" | "space-between";
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

export interface CompositionLayout {
  justify: Justify;
  gap: number;
}

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
  flex?: number;
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
}

export interface Empty {
  type: "empty";
  duration: number;
  flex?: number;
  id?: string;
  start?: TimeAnchor;
  end?: TimeAnchor;
}

/**
 * An audio-only clip. Shares clip's temporal vocabulary (`in`/`out`/`speed`/
 * `duration`/`flex`/`overflow`/`underflow`) and id/anchor fields, but has no
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
  flex?: number;
  overflow?: Overflow;
  underflow?: Underflow;
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
  refs?: Record<string, Child>;
  duration?: number;
  unitDuration?: number;
  layout?: CompositionLayout;
  contentWidth?: number;
  contentHeight?: number;
}

/**
 * A reference to a child defined in an enclosing composition's `refs` dict.
 * The ref's own `in`/`out`/`flex`/spatial fields window and position the
 * *resolved* duration of the definition. Lookup walks the enclosing scope
 * chain and takes the shallowest match (inner composition wins).
 */
export interface RefChild extends ChildTimingFields {
  type: "ref";
  source: string; // the ref's name (the key in some ancestor's `refs` dict)
}

export type Child = Clip | Audio | Empty | Composition | RefChild;
export type SeamFile = Composition;

import type { Keyframed } from "./animation/keyframes.js";
export type { Keyframe, Keyframed } from "./animation/keyframes.js";
export type { TimeExpr } from "./animation/time.js";

export type Overflow = "trim-end" | "trim-start" | "trim-center" | "stretch";
export type Underflow =
  | "extend-end"
  | "extend-start"
  | "extend-center"
  | "stretch";

export type ObjectFit = "center" | "fit" | "cover";

/** A length expression: pixel number, percentage string, or a combined
 *  "<n>% +/- <n>" form. Percent reference and pixel default vary by the
 *  property using it — see `resolveLength` in layout/units.ts. */
export type Length = number | string;

/** Two-axis length input. A bare number or string applies to both axes
 *  (treated as a scalar shorthand by `origin`/`translation`/`size`). */
export type Point2D = Length | { x?: Length; y?: Length };

// ── Filters ────────────────────────────────────────────────────────

// Filters are NOT animatable — params are plain numbers. (Opacity, the one
// filter anyone keyframed, is now the first-class `opacity` field on
// SpatialFields.)
export interface AdjustFilter {
  type: "adjust";
  brightness?: number;
  contrast?: number;
  saturation?: number;
  gamma?: number;
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

export type Filter = AdjustFilter | ColorBalanceFilter | ColorTemperatureFilter;

export interface SpatialFields {
  objectFit?: ObjectFit;
  /** Point on the item that lines up with `translation` in the parent.
   *  Per-axis: percent (0..100%) selects a position along the item's
   *  size, pixel offset adds to it. Default `"50%"` = item center. */
  origin?: Keyframed<Point2D>;
  /** Point in the parent where this item's `origin` lands. Per-axis:
   *  percent (0..100%) selects a position along the parent's content
   *  size, pixel offset adds to it. Default `0` = parent center. */
  translation?: Keyframed<Point2D>;
  /** Final pixel size of this item. Per-axis: percent (0..100%) is
   *  a fraction of the post-objectFit "natural" size, pixel offset
   *  adds to it. Default `"100%"` = natural (fit/cover/center) box. */
  size?: Keyframed<Point2D>;
  /** Rotation in degrees, clockwise, about the item's `origin` point.
   *  Default `0` (no rotation). Animatable. */
  rotation?: Keyframed<number>;
  /** Opacity multiplier, 0 (transparent) to 1 (opaque). Default 1. Animatable
   *  (ejected from filters). Mirrors how `volume` rides through resolution as
   *  a Keyframed value sampled per-frame by renderers. */
  opacity?: Keyframed<number>;
}

/** Per-edge inset, in the text-padding shorthand shape but `Length`-valued:
 *  `L` (all edges) | `[v, h]` | `[t, r, b, l]`. `%` resolves against the
 *  content box's matching axis (left/right → width, top/bottom → height). */
export type Inset =
  | Length
  | [Length, Length]
  | [Length, Length, Length, Length];

/**
 * How a cropped window maps within the content box's placement.
 * `origin`/`translation`/`size` always place the *content box*; this only
 * affects the window:
 * - `"window"` (default): the window stays in place — just a clip, no
 *   reposition or resize.
 * - `"center"`: the window is centered within the content box's placement.
 * - `"fit"`: the window is scaled (aspect-preserving) to fit the content box,
 *   centered (letterboxed) — like objectFit `fit`.
 * - `"cover"`: the window is scaled (aspect-preserving) to cover the content
 *   box, cropping the overflow — like objectFit `cover`.
 */
export type InsetMode = "window" | "center" | "fit" | "cover";

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
  /** Crossfade overlap in seconds with the previous sequential sibling.
   *  The element starts this many seconds before the previous one ends and
   *  cross-dissolves over the overlap, shortening the composition by the
   *  same amount. Ignored on the first child and on attachments. */
  transition?: number;
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
  /** Crossfade overlap (s) with the previous sequential sibling — see
   *  {@link ChildTimingFields.transition}. */
  transition?: number;
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
  /** Crossfade overlap (s) with the previous sequential sibling — see
   *  {@link ChildTimingFields.transition}. */
  transition?: number;
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
  /** CSS `font-style` ("italic" / "oblique" / "normal"). */
  fontStyle?: string;
  /** A single text-decoration line, drawn manually (canvas has no native
   *  text-decoration). */
  textDecoration?: "none" | "underline" | "overline" | "line-through";
  /** Vertical glyph stretch as a percentage string ("100%" = natural
   *  height). Applied as a per-glyph vertical scale about the baseline;
   *  horizontal advance is unchanged. */
  letterHeight?: string;
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
  /** Intrinsic SVG canvas width. Same shape as composition's
   *  `contentWidth` — number = pixels, percentage = fraction of the
   *  parent container. Animatable; defaults to `"100%"` of the parent. */
  contentWidth?: Keyframed<Length>;
  contentHeight?: Keyframed<Length>;
  /** Display duration. Required for sequential / single-anchor
   *  attachment use; optional only when both `start` and `end` are
   *  pinned (the anchor span dictates the target). */
  duration?: number;
  filters?: Filter[];
  id?: string;
  start?: TimeAnchor;
  end?: TimeAnchor;
  /** Crossfade overlap (s) with the previous sequential sibling — see
   *  {@link ChildTimingFields.transition}. */
  transition?: number;
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
   * Per-edge inset (crop) of the composition's content box — composition-only.
   * Clips the children without rescaling and shrinks the comp's output extent
   * to the visible window; `origin`/`translation`/`rotation` then place that
   * window. Animatable. See {@link Inset}.
   */
  inset?: Keyframed<Inset>;
  /** How the `inset` window maps within the content box's placement. Default
   *  `"window"` (clip in place). See {@link InsetMode}. */
  insetMode?: InsetMode;
  /**
   * Playback rate of the inner window (the `[in, out]` slice of the inner
   * timeline, defaulting to the whole thing). >1 plays faster, shortening
   * the output. Mutually exclusive with `duration`. Mirrors clip `speed`.
   */
  speed?: number;
  /**
   * Explicit output duration of the inner window, in output seconds. The
   * window plays at the derived rate `windowSpan / duration`. Mutually
   * exclusive with `speed`. Mirrors clip `duration`.
   */
  duration?: number;
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
  /**
   * Lexically-scoped string-substitution macros. Anywhere a `"$$NAME"`
   * string appears in this composition's subtree, the expander
   * substitutes the value here (or in an enclosing composition's
   * `macros`, nearest-enclosing wins). Values can be any JSON.
   * Expansion runs as the first step of `compileSeamFile`, BEFORE bin
   * / script resolution. The field is stripped from the compiled
   * output.
   */
  macros?: Record<string, unknown>;
  /** Any valid SVG/CSS fill value. Painted across the composition's
   *  container rect under all children. */
  backgroundColor?: string;
  /** Uniform volume multiplier (0..4) applied to every audio-bearing
   *  descendant (clips / audio / nested compositions). Animatable, sampled
   *  in the composition's output time. Mirrors clip `volume`. */
  volume?: Keyframed<number>;
  /** Inner canvas width. Number = pixels; percentage = fraction of the
   *  parent container's content width; defaults to `"100%"` of the parent.
   *  Animatable. The root composition must use a static pixel number (no
   *  parent reference to resolve against). */
  contentWidth?: Keyframed<Length>;
  /** Inner canvas height. Same shape as `contentWidth`. */
  contentHeight?: Keyframed<Length>;
}

// ── Graphic (animated 2D layer) ────────────────────────────────────

export type AngleDirection = "shortest" | "cw" | "ccw";

/** Common fields on every inner graphic object. `id` is the stable
 *  cross-frame correspondence key the animation engine uses to pair
 *  objects between keyframes; without it pairing falls back to
 *  positional-index within the parent container. */
export interface GraphicObjectBase {
  id?: string;
  /** Easing name (linear / ease / ease-in / ease-out / ease-in-out)
   *  overriding the frame-level default for this object only. */
  easing?: string;
  /** Winding count for the `angle` property: 1 = one extra full turn,
   *  -1 = one in the opposite direction, etc. */
  revolutions?: number;
  /** Direction of rotation for the inter-frame angle delta. */
  angleDirection?: AngleDirection;
}

/** Fabric-style transform fields shared by most graphic objects.
 *  All plain numbers — the Length system stops at the graphic boundary;
 *  inner-object props are passed verbatim to fabric. */
export interface FabricTransform {
  left?: number;
  top?: number;
  width?: number;
  height?: number;
  scaleX?: number;
  scaleY?: number;
  angle?: number;
  opacity?: number;
  flipX?: boolean;
  flipY?: boolean;
  originX?: "left" | "center" | "right";
  originY?: "top" | "center" | "bottom";
  fill?: string;
  stroke?: string;
  strokeWidth?: number;
  visible?: boolean;
}

export interface GraphicRect extends GraphicObjectBase, FabricTransform {
  type: "Rect";
  rx?: number;
  ry?: number;
  [key: string]: unknown;
}

export interface GraphicCircle extends GraphicObjectBase, FabricTransform {
  type: "Circle";
  radius?: number;
  [key: string]: unknown;
}

/** Fabric Path: SVG-string or its parsed-array form. */
export type FabricPathSegment = (string | number)[];
export interface GraphicPath extends GraphicObjectBase, FabricTransform {
  type: "Path";
  path?: string | FabricPathSegment[];
  [key: string]: unknown;
}

export interface GraphicPolygon extends GraphicObjectBase, FabricTransform {
  type: "Polygon";
  points?: { x: number; y: number }[];
  [key: string]: unknown;
}

export interface GraphicTextbox extends GraphicObjectBase, FabricTransform {
  type: "Textbox";
  text?: string;
  fontFamily?: string;
  fontSize?: number;
  fontWeight?: string | number;
  fontStyle?: string;
  textAlign?: "left" | "center" | "right" | "justify";
  lineHeight?: number;
  [key: string]: unknown;
}

export interface GraphicImage extends GraphicObjectBase, FabricTransform {
  type: "Image";
  /** Host-resolved asset id (cache lookup in editor / file path at render). */
  src?: string;
  [key: string]: unknown;
}

/** Reference to a `ClipDef` on the enclosing Graphic. */
export interface GraphicClipInstance extends GraphicObjectBase, FabricTransform {
  type: "Clip";
  clipId: string;
  /** Local-time the clip starts playing from when this keyframe is reached.
   *  Subsequent frames without their own `startPosition` let the playhead
   *  continue from where it was. */
  startPosition?: number;
  /** -1 = infinite; otherwise number of additional plays after the first.
   *  When the playhead reaches the clip's duration it wraps to 0 up to
   *  `repeat` times, then holds at the end. */
  repeat?: number;
  [key: string]: unknown;
}

/** A fabric object anchored to a Map: its (0,0) projects to screen space,
 *  then the object draws there offset by its own left/top. */
export interface MapPathObject {
  /** Fraction (0..1) along the path. Default: the path's `progress`
   *  (progress unset ⇒ 1, the path's end). */
  position?: number;
  object: GraphicObject;
}

/** A fabric object anchored to a geo coordinate on a Map. */
export interface MapObject {
  latitude: number;
  longitude: number;
  object: GraphicObject;
}

/** Geo polyline drawn over a Map. */
export interface MapPath {
  color: string;
  /** [[lng, lat], ...] — at least two points. */
  points: [number, number][];
  /** 0..1 fraction of the line to draw (the rest is transparent). */
  progress?: number;
  /** Stroke width in display pixels. Default 4. */
  lineWidth?: number;
  /** Per-path easing override for color/progress/lineWidth interpolation. */
  easing?: string;
  /** Objects anchored along the path (default at the reveal head). */
  objects?: MapPathObject[];
}

export interface GraphicMap extends GraphicObjectBase, FabricTransform {
  type: "Map";
  /** pmtiles path; host-resolved (file:// for renderer, OPFS for web). */
  source: string;
  latitude?: number;
  longitude?: number;
  zoom?: number;
  /** Opacity (0..1) of the basemap layers only — tiles (fills/lines/labels),
   *  not embedded objects/paths. Distinct from `opacity`; animated across
   *  graphic frames like latitude/longitude/zoom. */
  mapOpacity?: number;
  paths?: MapPath[];
  /** Objects anchored to geo coordinates on the map. */
  objects?: MapObject[];
  [key: string]: unknown;
}

export interface GraphicGroup extends GraphicObjectBase, FabricTransform {
  type: "Group";
  objects?: GraphicObject[];
  [key: string]: unknown;
}

export type GraphicObject =
  | GraphicRect
  | GraphicCircle
  | GraphicPath
  | GraphicPolygon
  | GraphicTextbox
  | GraphicImage
  | GraphicClipInstance
  | GraphicMap
  | GraphicGroup;

/** A keyframe in a graphic's timeline. Stamp is a Length so authors can
 *  use percentages of the graphic's duration. */
export type GraphicFrame =
  | [Length, GraphicObject[]]
  | [Length, GraphicObject[], string];

/** A reusable clip-graphic exposed by the parent Graphic and referenced
 *  from {type:"Clip", clipId} instances inside keyframes. Same shape as
 *  the outer Graphic but with a mandatory `id` and no spatial/anchor
 *  fields (those live on each Clip instance). */
export interface GraphicClipDef {
  id: string;
  type: "graphic";
  duration?: Length;
  loop?: boolean;
  contentWidth?: Length;
  contentHeight?: Length;
  frames: GraphicFrame[];
}

export interface Graphic extends ChildTimingFields {
  type: "graphic";
  /** Total animation duration. Defaults to the last keyframe's stamp.
   *  Length so it can be `"100%"` of the parent composition's duration. */
  duration?: Length;
  /** When true, the timeline wraps with ghost keyframes at the seam so
   *  the last frame's state animates back into the first. */
  loop?: boolean;
  /** Animation design space dimensions. Authored coordinates inside
   *  keyframe objects resolve against these. Animatable; defaults to
   *  `"100%"` of the parent container. */
  contentWidth?: Keyframed<Length>;
  contentHeight?: Keyframed<Length>;
  clips?: GraphicClipDef[];
  frames: GraphicFrame[];
  in?: number;
  out?: number;
  overflow?: Overflow;
  underflow?: Underflow;
  filters?: Filter[];
}

export type Child =
  | Clip
  | Audio
  | Static
  | Empty
  | Data
  | Text
  | Graphic
  | Composition;
export type SeamFile = Composition;

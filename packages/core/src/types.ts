import type { Keyframed } from "./animation/keyframes.js";
export type { Keyframe, Keyframed } from "./animation/keyframes.js";
export type { TimeExpr } from "./animation/time.js";

export type Overflow = "trim-end" | "trim-start" | "trim-center" | "stretch";
/** How a node fills a target span longer than its natural duration (only
 *  attachments with both ends anchored ever have one). `loop` replays the
 *  content from its start — a clip/audio's `[in, out]` at its own speed, a
 *  composition's inner window — until the span is filled (the last cycle is
 *  cut short); the node's own keyframes still run over the whole span. */
export type Underflow =
  | "extend-end"
  | "extend-start"
  | "extend-center"
  | "stretch"
  | "loop";

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
  /** When true, the compositor skips this filter entirely (UI on/off toggle). */
  bypass?: boolean;
  brightness?: number;
  contrast?: number;
  saturation?: number;
  gamma?: number;
}

export interface ColorBalanceFilter {
  type: "colorbalance";
  bypass?: boolean;
  rs?: number; gs?: number; bs?: number;
  rm?: number; gm?: number; bm?: number;
  rh?: number; gh?: number; bh?: number;
}

export interface ColorTemperatureFilter {
  type: "colortemperature";
  bypass?: boolean;
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
  /** Rounded-corner mask on the node's final rect (any node). Bare number =
   *  px; `%` resolves against the SHORTER side of the rect, so `"50%"` turns a
   *  square into a circle and a rectangle into a pill. Default 0. Animatable. */
  cornerRadius?: Keyframed<Length>;
  /** Geo / path anchor — only meaningful on a `map`'s attachments: the node's
   *  `origin` lands at the pin's projected point and `translation` becomes a
   *  pixel offset from there. Ignored elsewhere. Animatable (see {@link Pin}). */
  pin?: Keyframed<Pin>;
}

/**
 * Where a map attachment is anchored: a geographic coordinate, or a fraction
 * along one of the map's `paths` (by index or path `id`). `position` defaults
 * to that path's current `progress`, so the node rides the head of the
 * reveal. Keyframes interpolate lat/lng (geo→geo) or `position` (same path →
 * same path); a change of kind or path snaps at the keyframe.
 */
export type Pin =
  | { latitude: number; longitude: number }
  | { path: number | string; position?: number };

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
 * Corner-pin distortion of a composition's content canvas. Each entry is
 * where that corner of the canvas lands, in content-canvas coordinates:
 * `x*` resolve against `contentWidth`, `y*` against `contentHeight`.
 * Corners run clockwise from the top-left — `0` top-left, `1` top-right,
 * `2` bottom-right, `3` bottom-left. Every entry is optional and defaults to
 * the corner's natural position (`x0: "0%", y0: "0%", x1: "100%", y1: "0%",
 * x2: "100%", y2: "100%", x3: "0%", y3: "100%"`); a bare pixel number is an
 * offset from that default (so `x1: -20` pulls the top-right corner 20px in,
 * like `translation`'s bare numbers offset from center). Keyframes animate
 * the whole set as one value. The warp is a projective (perspective-correct)
 * map of the composited content and does NOT change the node's layout rect.
 */
export interface Distort {
  x0?: Length;
  y0?: Length;
  x1?: Length;
  y1?: Length;
  x2?: Length;
  y2?: Length;
  x3?: Length;
  y3?: Length;
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
  /** Crossfade overlap in seconds with the previous sequential sibling.
   *  The element starts this many seconds before the previous one ends and
   *  cross-dissolves over the overlap, shortening the composition by the
   *  same amount. Ignored on the first child and on attachments. */
  transition?: number;
  metadata?: Metadata;
}

/** Pre-transform source rotation, clockwise degrees. */
export type Orientation = 0 | 90 | 180 | 270;

export interface Clip extends ChildTimingFields {
  type: "clip";
  source: string;
  in: number;
  out: number;
  speed?: number;
  duration?: number;
  /** Pre-transform source orientation (clockwise degrees). Baked into the
   *  decoded pixels before the spatial transform, composing with any rotation
   *  the container metadata declares. Not animatable. */
  orientation?: Orientation;
  /** Audio-channel gain. Default 1; 0 mutes; >1 amplifies. A linear multiplier
   *  (0..4) or a decibel string like `"25dB"` / `"-25.5dB"` (uncapped). */
  volume?: Keyframed<number | string>;
  /** Length-preserving audio pitch shift in semitones (fractional ok,
   *  ± = up/down, clamped ±48). Independent of `speed` (which shifts pitch
   *  naturally); adds with enclosing compositions' `pitch`. Not animatable. */
  pitch?: number;
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
  /** Audio-channel gain. Default 1; 0 mutes; >1 amplifies. A linear multiplier
   *  (0..4) or a decibel string like `"25dB"` / `"-25.5dB"` (uncapped). */
  volume?: Keyframed<number | string>;
  /** Length-preserving pitch shift in semitones — see {@link Clip.pitch}. */
  pitch?: number;
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

/**
 * Fields shared by every composition, whether it's a normal body or a
 * `binItem` reference. The discriminant — `children`/`attachments` vs
 * `binItem` — lives on the two concrete variants below; everything else
 * (spatial / timing / filters / bin scope / script / inset / volume / …)
 * applies to both, because a bin reference still carries its own
 * instance-level overrides.
 */
export interface BaseComposition extends ChildTimingFields {
  type: "composition";
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
   * Corner-pin (perspective) distortion of the composited content —
   * composition-only. Pins the four corners of the content canvas to
   * authored points; percentages resolve against `contentWidth`/
   * `contentHeight`. Purely visual: the layout rect is unchanged (the
   * warped content may spill outside it). Animatable as a whole set.
   * See {@link Distort}.
   */
  distort?: Keyframed<Distort>;
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
   * Bin entries scoped to this composition's subtree. Descendant
   * compositions with `binItem: "<id>"` resolve to the nearest
   * enclosing bin entry with that id — this composition's own entries
   * win over any inherited from ancestors.
   */
  bin?: BinEntry[];
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
  /** Uniform volume applied to every audio-bearing descendant (clips / audio /
   *  nested compositions). Animatable, sampled in the composition's output
   *  time. Mirrors clip `volume`: a linear multiplier (0..4) or a decibel
   *  string like `"25dB"` / `"-25.5dB"` (uncapped). */
  volume?: Keyframed<number | string>;
  /** Length-preserving pitch shift in semitones applied to every
   *  audio-bearing descendant; adds through nesting and with each clip's
   *  own `pitch`. Not animatable. */
  pitch?: number;
  /** Inner canvas width. Number = pixels; percentage = fraction of the
   *  parent container's content width; defaults to `"100%"` of the parent.
   *  Animatable. The root composition must use a static pixel number (no
   *  parent reference to resolve against). */
  contentWidth?: Keyframed<Length>;
  /** Inner canvas height. Same shape as `contentWidth`. */
  contentHeight?: Keyframed<Length>;
}

/**
 * A normal composition: its own `children` body plus optional anchored
 * `attachments`. Never a bin reference (`binItem?: never` makes the two
 * variants narrow cleanly on `binItem`).
 */
export interface BasicComposition extends BaseComposition {
  /**
   * Sequential body. Optional — an empty composition can leave it off;
   * the compile pass normalizes it to `[]`, so post-compile consumers
   * always see an array.
   */
  children?: Child[];
  /**
   * Anchored children rendered on top of `children`. Each attachment's
   * `start`/`end` may reference child IDs. Attachments render in array
   * order, last on top.
   */
  attachments?: Child[];
  /**
   * A normal composition is never a bin reference. The field is omitted
   * entirely (rather than typed `never`) so the ubiquitous immutable
   * `{ ...comp, children }` spreads still type-check; narrow with
   * `"binItem" in comp` to reach a {@link BinItemComposition}. Authoring a
   * literal with both `binItem` and `children` is still rejected (excess
   * property on this variant, `never` children on the other).
   */
}

/**
 * A bin reference: adopts the named bin entry's body at compile time, so
 * it carries no `children`/`attachments` of its own — only instance-level
 * overrides (from {@link BaseComposition}). Compile splices the entry's
 * body in and strips `binItem`, so this shape never reaches the resolved
 * tree.
 */
export interface BinItemComposition extends BaseComposition {
  /** Names a bin entry whose body this composition adopts at compile
   *  time. Resolved lexically (nearest-enclosing wins). */
  binItem: string;
  children?: never;
  attachments?: never;
}

export type Composition = BasicComposition | BinItemComposition;

// ── Shapes ─────────────────────────────────────────────────────────

/** Fill / stroke shared by `rect` and `circle`. The stroke is drawn INSIDE the
 *  node's box (border-box), so `size` is always the outer extent. */
export interface ShapeFields {
  /** Any CSS colour. Default `"black"`; `"none"` / `"transparent"` skips it. */
  fill?: Keyframed<string>;
  /** Stroke colour; drawn only when `strokeWidth` > 0. */
  stroke?: Keyframed<string>;
  /** Stroke width in px, inside the box. Default 0. */
  strokeWidth?: Keyframed<number>;
}

/**
 * A solid rectangle. No intrinsic media size: its natural box is the parent,
 * so `size` IS the rectangle (bare number = px). Corners round via the
 * universal `cornerRadius`.
 */
export interface Rect extends SpatialFields, ShapeFields {
  type: "rect";
  /** Required unless both `start` and `end` anchors are set. */
  duration?: number;
  filters?: Filter[];
  id?: string;
  start?: TimeAnchor;
  end?: TimeAnchor;
  transition?: number;
  metadata?: Metadata;
}

/** The ellipse inscribed in the node's box (equal `size` → a circle). */
export interface Circle extends SpatialFields, ShapeFields {
  type: "circle";
  duration?: number;
  filters?: Filter[];
  id?: string;
  start?: TimeAnchor;
  end?: TimeAnchor;
  transition?: number;
  metadata?: Metadata;
}

// ── Map ────────────────────────────────────────────────────────────

/** Geo polyline drawn over a map. */
export interface MapPath {
  /** Referenced by `pin: { path: "<id>" }`; else pins address by index. */
  id?: string;
  color: Keyframed<string>;
  /** [[lng, lat], ...] — at least two points. Not animatable. */
  points: [number, number][];
  /** 0..1 fraction of the line drawn. Default 1. Animatable. */
  progress?: Keyframed<number>;
  /** Stroke width in display pixels. Default 4. Animatable. */
  lineWidth?: Keyframed<number>;
}

/**
 * A basemap rasterized from a pmtiles archive with an animatable camera,
 * geo `paths`, and ordinary nodes composited over it as `attachments`
 * (placed geographically via `pin`). The inner canvas (`contentWidth` /
 * `contentHeight`, default 100% of the parent) is both the raster size and the
 * layout space the attachments resolve against.
 */
export interface MapNode extends SpatialFields {
  type: "map";
  /** pmtiles archive — host-resolved like clip/static `source`. */
  source: string;
  duration: number;
  latitude?: Keyframed<number>;
  longitude?: Keyframed<number>;
  /** maplibre-512 convention; interpolates in scale space (linear in 2^-zoom). */
  zoom?: Keyframed<number>;
  /** Basemap-only opacity (tiles); paths/attachments unaffected. */
  mapOpacity?: Keyframed<number>;
  theme?: "light" | "dark";
  paths?: MapPath[];
  /** Resolved like a composition's attachments (time 0 = map start). */
  attachments?: Child[];
  contentWidth?: Keyframed<Length>;
  contentHeight?: Keyframed<Length>;
  filters?: Filter[];
  id?: string;
  start?: TimeAnchor;
  end?: TimeAnchor;
  transition?: number;
  metadata?: Metadata;
}

export type Child =
  | Clip
  | Audio
  | Static
  | Empty
  | Data
  | Text
  | Rect
  | Circle
  | MapNode
  | Composition;
export type SeamFile = Composition;

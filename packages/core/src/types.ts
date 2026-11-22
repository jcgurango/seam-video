import type { Keyframed } from "./animation/keyframes.js";
export type { Keyframe, Keyframed } from "./animation/keyframes.js";
export type { TimeExpr } from "./animation/time.js";
import type { Start } from "./layout/anchor.js";
export type { Start } from "./layout/anchor.js";

export type Overflow = "trim-end" | "trim-start" | "trim-center" | "stretch";
/** How a node fills a `duration` longer than its natural length (`[in, out]`
 *  at `speed`). Default `stretch` (derive the rate). `loop` replays the
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

/** Fields extensions contribute to every visual node. Empty in core — an
 *  extension package adds its fields by declaration merging:
 *  `declare module "@seam/core" { interface VisualExtensionFields { … } }`,
 *  so documents built in TypeScript are typed for exactly the extensions the
 *  program imports. */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface VisualExtensionFields {}

export interface SpatialFields extends VisualExtensionFields {
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
  /** Opacity multiplier, 0 (transparent) to 1 (opaque). Default 1. Animatable.
   *  Mirrors how `volume` rides through resolution as
   *  a Keyframed value sampled per-frame by renderers. */
  opacity?: Keyframed<number>;
  /** Rounded-corner mask on the node's final rect (any node). Bare number =
   *  px; `%` resolves against the SHORTER side of the rect, so `"50%"` turns a
   *  square into a circle and a rectangle into a pill. Default 0. Animatable. */
  cornerRadius?: Keyframed<Length>;
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

/** Placement fields every node carries. A node lands at
 *  `(start ?? end of the previous node, 0 for the first) + offset`. */
export interface PlacementFields {
  /** Identifier sibling `start` anchors reference (no `@`, not numeric). */
  id?: string;
  /** Heads a new run: a bare number (absolute seconds in the container) or
   *  an anchor string — `"id"`, `"id@50%"`, `"id@10"`. See `layout/anchor.ts`. */
  start?: Start;
  /** Seconds added to the position. On a run member: the gap after the
   *  previous node; negative overlaps it and cross-fades. On a run head: a
   *  plain shift off the anchor. */
  offset?: number;
}

/** Free-form per-node bag for editor / tooling concerns that travel with
 *  the document but don't affect rendering. Values are arbitrary JSON. */
export type Metadata = Record<string, unknown>;

export interface ChildTimingFields extends SpatialFields, PlacementFields {
  in?: number;
  out?: number;
  overflow?: Overflow;
  underflow?: Underflow;
  metadata?: Metadata;
}

/** Pre-transform source rotation, clockwise degrees. */
export type Orientation = 0 | 90 | 180 | 270;

export interface Clip extends ChildTimingFields {
  type: "clip";
  source: string;
  in: number;
  /** Source end. Optional when `duration` is set: defaults to `in + duration`
   *  (speed 1). Readers use `clipOut()`. `out < in` plays the span in
   *  REVERSE (from `in` back to `out`). */
  out?: number;
  speed?: number;
  /** Output length. Negative = reverse playback (`{in: 5, duration: -3}`
   *  shows source 5 → 2); the length is `|duration|`. See `clipPlayRange()`. */
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
export interface Static extends SpatialFields, PlacementFields {
  type: "static";
  source: string;
  duration: number;
  /** Video-source freeze timestamp in seconds (ignored for images).
   *  Defaults to 0. */
  in?: number;
  metadata?: Metadata;
}

/**
 * An audio-only clip. Shares clip's temporal vocabulary (`in`/`out`/`speed`/
 * `duration`/`overflow`/`underflow`) and id/anchor fields, but has no
 * spatial layout and no visual extension fields — audio filtering (gain/EQ/etc.) is
 * different in kind and will get its own schema later.
 */
export interface Audio extends PlacementFields {
  type: "audio";
  source: string;
  in: number;
  /** Source end. Optional when `duration` is set: defaults to `in + duration`
   *  (speed 1). Readers use `clipOut()`. `out < in` = reverse — see
   *  {@link Clip.out}. */
  out?: number;
  speed?: number;
  /** Output length; negative = reverse — see {@link Clip.duration}. */
  duration?: number;
  overflow?: Overflow;
  underflow?: Underflow;
  /** Audio-channel gain. Default 1; 0 mutes; >1 amplifies. A linear multiplier
   *  (0..4) or a decibel string like `"25dB"` / `"-25.5dB"` (uncapped). */
  volume?: Keyframed<number | string>;
  /** Length-preserving pitch shift in semitones — see {@link Clip.pitch}. */
  pitch?: number;
  metadata?: Metadata;
}

/**
 * A free-form JSON payload that occupies a span of time on the timeline.
 * Renders nothing visual or audible; it's a parking spot for editor
 * concerns (markers, captions, decorators) that travel with the document.
 *
 * It takes up `duration` seconds (default 0) — also the way to pad a
 * composition's tail with silence, since nothing else extends it.
 */
export interface Data extends PlacementFields {
  type: "data";
  data: unknown;
  duration?: number;
  /** Free-form classifier tags. Editor-side filtering / grouping fodder. */
  tags?: string[];
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
export interface Text extends SpatialFields, TextStyleFields, PlacementFields {
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
  /** Display duration. */
  duration: number;
  metadata?: Metadata;
}

/**
 * Reusable composition body addressable by `id`. Referenced from any
 * descendant composition via `binItem: "<id>"`. Holds only the body
 * (`children`) — instance-level fields
 * (spatial / timing / extension fields / metadata) live on each reference, so
 * swapping a bin entry can't accidentally overwrite a reference's
 * authored properties.
 */
export interface BinEntry {
  id: string;
  children: Child[];
}

/**
 * Fields shared by every composition, whether it's a normal body or a
 * `binItem` reference. The discriminant — `children` vs
 * `binItem` — lives on the two concrete variants below; everything else
 * (spatial / timing / extension fields / bin scope / script / inset / volume / …)
 * applies to both, because a bin reference still carries its own
 * instance-level overrides.
 */
export interface BaseComposition extends ChildTimingFields, CompositionExtensionFields {
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
   * the output. Mirrors clip `speed`.
   */
  speed?: number;
  /**
   * Output duration in seconds. `overflow`/`underflow` say how the inner
   * window (at `speed`) fills it; the default `stretch` derives the rate
   * `windowSpan / duration`. Mirrors clip `duration`.
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
 * A normal composition with its own `children`. Never a bin reference.
 */
export interface BasicComposition extends BaseComposition {
  /**
   * The body. Array order is z-order (later = on top); time comes from the
   * run / `start` rules (see {@link PlacementFields}). The composition's
   * natural duration is the latest end among its children. Optional — the
   * compile pass normalizes it to `[]`.
   *
   * `binItem` is omitted entirely (rather than typed `never`) so the
   * ubiquitous immutable `{ ...comp, children }` spreads still type-check;
   * narrow with `"binItem" in comp` to reach a {@link BinItemComposition}.
   */
  children?: Child[];
}

/**
 * A bin reference: adopts the named bin entry's body at compile time, so
 * it carries no `children` of its own — only instance-level overrides (from
 * {@link BaseComposition}). Compile splices the entry's body in and strips
 * `binItem`, so this shape never reaches the resolved tree.
 */
export interface BinItemComposition extends BaseComposition {
  /** Names a bin entry whose body this composition adopts at compile
   *  time. Resolved lexically (nearest-enclosing wins). */
  binItem: string;
  children?: never;
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
export interface Rect extends SpatialFields, ShapeFields, PlacementFields {
  type: "rect";
  duration: number;
  metadata?: Metadata;
}

/** The ellipse inscribed in the node's box (equal `size` → a circle). */
export interface Circle extends SpatialFields, ShapeFields, PlacementFields {
  type: "circle";
  duration: number;
  metadata?: Metadata;
}

// ── Extension node types ───────────────────────────────────────────

/** What core gives every extension-contributed node type (see
 *  `NodeTypeDef`): it shows for `duration`, has an inner canvas, the spatial
 *  and placement fields, and — when it is a container — `children`. */
export interface ExtensionNodeBase<T extends string = string>
  extends SpatialFields, PlacementFields {
  type: T;
  duration: number;
  /** Container types only: placed like a composition's children (time 0 =
   *  the node's start), but they never extend the node. */
  children?: Child[];
  contentWidth?: Keyframed<Length>;
  contentHeight?: Keyframed<Length>;
  metadata?: Metadata;
}

/** What core gives an extension node type that is NOT visual
 *  (`NodeTypeDef.visual: false` — a caption, a word): placement, metadata, a
 *  `duration` (optional when the type takes its span from its children) and,
 *  for a container, `children`. No spatial fields. */
export interface NonVisualExtensionNodeBase<T extends string = string> extends PlacementFields {
  type: T;
  duration?: number;
  children?: Child[];
  metadata?: Metadata;
}

/** Fields extensions contribute to compositions only (the root included).
 *  Empty in core — merged into by extension packages, like
 *  {@link VisualExtensionFields}. */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface CompositionExtensionFields {}

/** Authored extension node types by `type`. Empty in core — an extension
 *  package adds its node by declaration merging:
 *  `declare module "@seam/core" { interface ExtensionNodeTypes { map: MapNode } }`. */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface ExtensionNodeTypes {}

/** Every extension node type the program knows (`never` without any). */
export type ExtensionChild = ExtensionNodeTypes[keyof ExtensionNodeTypes];

export type Child =
  | Clip
  | Audio
  | Static
  | Data
  | Text
  | Rect
  | Circle
  | Composition
  | ExtensionChild;
export type SeamFile = Composition;

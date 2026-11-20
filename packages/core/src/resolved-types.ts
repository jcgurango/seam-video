import type {
  Keyframed,
  Length,
  ObjectFit,
  Point2D,
  Inset,
  InsetMode,
  Distort,
  Filter,
  Orientation,
  Pin,
  TextPadding,
  TextRun,
  TextStyleFields,
} from "./types.js";

export type { ObjectFit };

export interface SpatialRect {
  x: number;
  y: number;
  width: number;
  height: number;
  /** Rotation in degrees, clockwise, about the origin point. Present only
   *  when the node authored a `rotation` (so non-rotated rects stay a plain
   *  `{x,y,width,height}` — keeps existing equality checks intact). */
  rotation?: number;
  /** Origin point in item-local px (post-`size`), the pivot for `rotation`.
   *  Pivot in parent space = `(x + originX, y + originY)`. Present only
   *  alongside `rotation`. */
  originX?: number;
  originY?: number;
  /** Visible source sub-rect when the node is `inset` (cropped), as fractions
   *  of the content box: `{u0,v0,u1,v1}` ∈ [0,1]. The renderer samples this
   *  sub-rect of the content into the (already inset-shrunk) `width`×`height`.
   *  Absent when there's no inset — non-inset rects stay plain so existing
   *  equality checks hold. */
  sourceRect?: { u0: number; v0: number; u1: number; v1: number };
}

/** Authored spatial input retained on a resolved node when any of its
 *  fields are keyframed — the renderer re-evaluates them per frame.
 *  Static (non-animated) nodes bake the rect into `spatial` and drop
 *  `spatialInput` from the resolved tree. */
export interface SpatialInput {
  objectFit?: ObjectFit;
  origin?: Keyframed<Point2D>;
  translation?: Keyframed<Point2D>;
  size?: Keyframed<Point2D>;
  rotation?: Keyframed<number>;
  inset?: Keyframed<Inset>;
  insetMode?: InsetMode;
}

/** Loop marker (`underflow: "loop"`): the node spans `[timelineStart,
 *  timelineEnd]` but its content — a clip/audio's `[sourceIn, sourceOut]` at
 *  `speed`, a composition's inner window (`duration` × `speed`) — is ONE
 *  cycle, replayed from its start every `period` node-local output seconds.
 *  `phase` is how far into a cycle the node is at `timelineStart` (non-zero
 *  only after a window crop). Content time at node-local `t` is
 *  `(t + phase) mod period` — see `loopLocalTime`. The node's own keyframes
 *  (opacity, spatial, volume, …) still run over the full span. */
export interface ResolvedLoop {
  period: number;
  phase: number;
}

export interface ResolvedClip {
  type: "clip";
  source: string;
  sourceIn: number;
  sourceOut: number;
  timelineStart: number;
  timelineEnd: number;
  speed: number;
  /** Plays `sourceOut → sourceIn` (authored `out < in` / negative
   *  `duration`). `sourceIn < sourceOut` and `speed > 0` always hold; map
   *  time through `clipSourceTime()` rather than `sourceIn + t·speed`. */
  reverse?: true;
  /** Present when the clip loops its `[sourceIn, sourceOut]` cycle. */
  loop?: ResolvedLoop;
  /** Pre-transform source orientation (clockwise degrees). Renderers bake it
   *  into the decoded frame (composing with container-metadata rotation)
   *  before the spatial transform. Absent means 0. */
  orientation?: Orientation;
  /** Effective crossfade (s) with the previous node of its run, clamped to
   *  what fits. Present (>0) only on a run member with a negative `offset`.
   *  Renderers fade this element in over its first `transition` seconds. */
  transition?: number;
  /** Effective crossfade overlap (s) with the *next* sibling — the previous
   *  side of that overlap. Audio renderers fade this element out over its
   *  last `transitionOut` seconds (video relies on the next element fading
   *  in over it). */
  transitionOut?: number;
  /** Audio gain multiplier; absent means unity (1). */
  volume?: Keyframed<number | string>;
  /** Length-preserving pitch shift in semitones; absent means 0. Adds with
   *  enclosing compositions' `pitch`. */
  pitch?: number;
  filters?: Filter[];
  /** Opacity multiplier (0..1); absent means opaque. Sampled per-frame by
   *  renderers, like `volume`. */
  opacity?: Keyframed<number>;
  /** Rounded-corner mask (authored `Keyframed<Length>`); absent = square.
   *  Sampled per-frame against the shorter side of the final rect. */
  cornerRadius?: Keyframed<Length>;
  /** Geo / path anchor — read only when this node is a map attachment. */
  pin?: Keyframed<Pin>;
  spatial?: SpatialRect;
  objectFit?: ObjectFit;
  spatialInput?: SpatialInput;
  /** Intrinsic media size baked by the spatial pass when known — kept
   *  for renderers that need it after the per-frame re-eval. Optional
   *  because not every consumer has probed media yet. */
  intrinsicWidth?: number;
  intrinsicHeight?: number;
  /** Post-objectFit "natural" rect in parent space — the value of
   *  `size: "100%"` for this node. Renderers re-eval against this when
   *  spatialInput is animated. */
  naturalWidth?: number;
  naturalHeight?: number;
}

export interface ResolvedStatic {
  type: "static";
  source: string;
  sourceTime: number;
  timelineStart: number;
  timelineEnd: number;
  /** Crossfade overlap (s) with the previous sibling — see ResolvedClip. */
  transition?: number;
  /** Crossfade overlap (s) with the next sibling — see ResolvedClip. */
  transitionOut?: number;
  filters?: Filter[];
  /** Opacity multiplier (0..1); absent means opaque. Sampled per-frame by
   *  renderers, like `volume`. */
  opacity?: Keyframed<number>;
  /** Rounded-corner mask (authored `Keyframed<Length>`); absent = square.
   *  Sampled per-frame against the shorter side of the final rect. */
  cornerRadius?: Keyframed<Length>;
  /** Geo / path anchor — read only when this node is a map attachment. */
  pin?: Keyframed<Pin>;
  spatial?: SpatialRect;
  objectFit?: ObjectFit;
  spatialInput?: SpatialInput;
  intrinsicWidth?: number;
  intrinsicHeight?: number;
  naturalWidth?: number;
  naturalHeight?: number;
}

export interface ResolvedAudio {
  type: "audio";
  source: string;
  sourceIn: number;
  sourceOut: number;
  timelineStart: number;
  timelineEnd: number;
  speed: number;
  /** Plays `sourceOut → sourceIn` — see {@link ResolvedClip.reverse}. */
  reverse?: true;
  /** Present when the node loops its `[sourceIn, sourceOut]` cycle. */
  loop?: ResolvedLoop;
  /** Crossfade overlap (s) with the previous sibling — see ResolvedClip. */
  transition?: number;
  /** Crossfade overlap (s) with the next sibling — see ResolvedClip. */
  transitionOut?: number;
  volume?: Keyframed<number | string>;
  /** Length-preserving pitch shift in semitones — see ResolvedClip. */
  pitch?: number;
}

export interface ResolvedData {
  type: "data";
  data: unknown;
  tags?: string[];
  timelineStart: number;
  timelineEnd: number;
}

export interface ResolvedText extends TextStyleFields {
  type: "text";
  runs: TextRun[];
  /** Crossfade overlap (s) with the previous sibling — see ResolvedClip. */
  transition?: number;
  /** Crossfade overlap (s) with the next sibling — see ResolvedClip. */
  transitionOut?: number;
  lineHeight?: Keyframed<number>;
  textAlign?: "left" | "center" | "right";
  verticalAlign?: "top" | "center" | "bottom";
  padding?: TextPadding;
  /** Intrinsic SVG canvas, the AUTHORED `Keyframed<Length>` preserved
   *  through the spatial pass so per-frame consumers can sample it against
   *  live parent dims (default `"100%"`). The baked t=0 pixel value lives
   *  in `intrinsicWidth`/`intrinsicHeight` for static consumers. */
  contentWidth?: Keyframed<Length>;
  contentHeight?: Keyframed<Length>;
  timelineStart: number;
  timelineEnd: number;
  filters?: Filter[];
  /** Opacity multiplier (0..1); absent means opaque. Sampled per-frame by
   *  renderers, like `volume`. */
  opacity?: Keyframed<number>;
  /** Rounded-corner mask (authored `Keyframed<Length>`); absent = square.
   *  Sampled per-frame against the shorter side of the final rect. */
  cornerRadius?: Keyframed<Length>;
  /** Geo / path anchor — read only when this node is a map attachment. */
  pin?: Keyframed<Pin>;
  spatial?: SpatialRect;
  objectFit?: ObjectFit;
  spatialInput?: SpatialInput;
  intrinsicWidth?: number;
  intrinsicHeight?: number;
  naturalWidth?: number;
  naturalHeight?: number;
}

export interface ResolvedComposition {
  type: "composition";
  timelineStart: number;
  timelineEnd: number;
  /** Output length of ONE pass over the inner window (`duration × speed` =
   *  the inner span the children live in). Equals `timelineEnd −
   *  timelineStart` unless the composition loops, where it is the loop
   *  period and the node span is a whole number of cycles or more. */
  duration: number;
  speed: number;
  /** Present when the composition replays its inner window (one cycle =
   *  `duration` output seconds) across its span. */
  loop?: ResolvedLoop;
  /** Crossfade overlap (s) with the previous sibling — see ResolvedClip. */
  transition?: number;
  /** Crossfade overlap (s) with the next sibling — see ResolvedClip. */
  transitionOut?: number;
  children: ResolvedChild[];
  filters?: Filter[];
  /** Opacity multiplier (0..1); absent means opaque. Sampled per-frame by
   *  renderers, like `volume`. */
  opacity?: Keyframed<number>;
  /** Rounded-corner mask (authored `Keyframed<Length>`); absent = square.
   *  Sampled per-frame against the shorter side of the final rect. */
  cornerRadius?: Keyframed<Length>;
  /** Geo / path anchor — read only when this node is a map attachment. */
  pin?: Keyframed<Pin>;
  spatial?: SpatialRect;
  objectFit?: ObjectFit;
  spatialInput?: SpatialInput;
  backgroundColor?: string;
  /** Corner-pin distortion of the composited content — the AUTHORED
   *  `Keyframed<Distort>` preserved through resolution. Sampled per-frame by
   *  the compositor in the comp's output time against the live inner canvas
   *  (`contentWidth`/`contentHeight`), like `opacity`. Purely visual: it does
   *  not alter `spatial`. */
  distort?: Keyframed<Distort>;
  /** Uniform volume multiplier applied to every audio-bearing descendant.
   *  Sampled per-frame by the audio mixers in the comp's output time. */
  volume?: Keyframed<number | string>;
  /** Length-preserving pitch shift (semitones) applied to every audio-bearing
   *  descendant; adds through nesting and with each clip's own `pitch`. */
  pitch?: number;
  /** Inner canvas dim — the AUTHORED `Keyframed<Length>` preserved through
   *  the spatial pass (default `"100%"` of the parent) so per-frame
   *  consumers sample it against live parent dims. The baked t=0 pixel
   *  value lives in `intrinsicWidth`/`intrinsicHeight`. */
  contentWidth?: Keyframed<Length>;
  contentHeight?: Keyframed<Length>;
  intrinsicWidth?: number;
  intrinsicHeight?: number;
  naturalWidth?: number;
  naturalHeight?: number;
}

/** Fields shared by the two shape leaves. */
interface ResolvedShapeBase {
  timelineStart: number;
  timelineEnd: number;
  /** Crossfade overlap (s) with the previous sibling — see ResolvedClip. */
  transition?: number;
  /** Crossfade overlap (s) with the next sibling — see ResolvedClip. */
  transitionOut?: number;
  fill?: Keyframed<string>;
  stroke?: Keyframed<string>;
  strokeWidth?: Keyframed<number>;
  filters?: Filter[];
  opacity?: Keyframed<number>;
  cornerRadius?: Keyframed<Length>;
  pin?: Keyframed<Pin>;
  spatial?: SpatialRect;
  objectFit?: ObjectFit;
  spatialInput?: SpatialInput;
  intrinsicWidth?: number;
  intrinsicHeight?: number;
  naturalWidth?: number;
  naturalHeight?: number;
}

export interface ResolvedRect extends ResolvedShapeBase {
  type: "rect";
}

export interface ResolvedCircle extends ResolvedShapeBase {
  type: "circle";
}

export interface ResolvedMapPath {
  id?: string;
  color: Keyframed<string>;
  points: [number, number][];
  progress?: Keyframed<number>;
  lineWidth?: Keyframed<number>;
}

/** A map after resolution. Its `children` are its resolved children, in
 *  map-local time (0 = the map's start, speed 1), laid out against the map's
 *  inner canvas; a child's `pin` overrides its translation at render time. */
export interface ResolvedMap {
  type: "map";
  source: string;
  timelineStart: number;
  timelineEnd: number;
  transition?: number;
  transitionOut?: number;
  latitude?: Keyframed<number>;
  longitude?: Keyframed<number>;
  zoom?: Keyframed<number>;
  mapOpacity?: Keyframed<number>;
  theme?: "light" | "dark";
  paths?: ResolvedMapPath[];
  children: ResolvedChild[];
  /** Inner canvas — the AUTHORED `Keyframed<Length>` preserved (default
   *  `"100%"` of the parent); the t=0 bake lives in `intrinsicWidth/Height`. */
  contentWidth?: Keyframed<Length>;
  contentHeight?: Keyframed<Length>;
  filters?: Filter[];
  opacity?: Keyframed<number>;
  cornerRadius?: Keyframed<Length>;
  pin?: Keyframed<Pin>;
  spatial?: SpatialRect;
  objectFit?: ObjectFit;
  spatialInput?: SpatialInput;
  intrinsicWidth?: number;
  intrinsicHeight?: number;
  naturalWidth?: number;
  naturalHeight?: number;
}

export type ResolvedChild =
  | ResolvedClip
  | ResolvedAudio
  | ResolvedStatic
  | ResolvedData
  | ResolvedText
  | ResolvedRect
  | ResolvedCircle
  | ResolvedMap
  | ResolvedComposition;

export interface ResolvedTimeline {
  duration: number;
  width?: number;
  height?: number;
  objectFit?: ObjectFit;
  backgroundColor?: string;
  /** Root-composition volume multiplier — scales every audio-bearing
   *  descendant. Sampled in output time against the timeline duration. */
  volume?: Keyframed<number | string>;
  /** Root-composition pitch shift (semitones) — adds onto every
   *  audio-bearing descendant's net pitch. */
  pitch?: number;
  /** Root inner canvas dim. Carries the authored value pre-spatial;
   *  `resolveSpatial` collapses it to a pixel number (and rejects percentage
   *  strings AND keyframes on the root, since there's no parent reference and
   *  the root defines the output canvas). Consumers run post-spatial and may
   *  treat it as `number`. */
  contentWidth?: Keyframed<Length>;
  contentHeight?: Keyframed<Length>;
  children: ResolvedChild[];
}

import type {
  Keyframed,
  Length,
  ObjectFit,
  Point2D,
  Inset,
  InsetMode,
  Filter,
  GraphicClipDef,
  GraphicFrame,
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

export interface ResolvedClip {
  type: "clip";
  source: string;
  sourceIn: number;
  sourceOut: number;
  timelineStart: number;
  timelineEnd: number;
  speed: number;
  /** Effective crossfade overlap (s) with the previous sequential sibling,
   *  clamped to what fits. Present (>0) only on a non-first child that set
   *  `transition`. Renderers fade this element in over its first
   *  `transition` seconds. */
  transition?: number;
  /** Effective crossfade overlap (s) with the *next* sibling — the previous
   *  side of that overlap. Audio renderers fade this element out over its
   *  last `transitionOut` seconds (video relies on the next element fading
   *  in over it). */
  transitionOut?: number;
  /** Audio gain multiplier; absent means unity (1). */
  volume?: Keyframed<number>;
  filters?: Filter[];
  /** Opacity multiplier (0..1); absent means opaque. Sampled per-frame by
   *  renderers, like `volume`. */
  opacity?: Keyframed<number>;
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
  spatial?: SpatialRect;
  objectFit?: ObjectFit;
  spatialInput?: SpatialInput;
  intrinsicWidth?: number;
  intrinsicHeight?: number;
  naturalWidth?: number;
  naturalHeight?: number;
}

export interface ResolvedEmpty {
  type: "empty";
  timelineStart: number;
  timelineEnd: number;
}

export interface ResolvedAudio {
  type: "audio";
  source: string;
  sourceIn: number;
  sourceOut: number;
  timelineStart: number;
  timelineEnd: number;
  speed: number;
  /** Crossfade overlap (s) with the previous sibling — see ResolvedClip. */
  transition?: number;
  /** Crossfade overlap (s) with the next sibling — see ResolvedClip. */
  transitionOut?: number;
  volume?: Keyframed<number>;
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
  /** Intrinsic SVG width. Authored as a `Length` (number or percentage);
   *  the spatial pass collapses to a pixel number. Consumers run
   *  post-spatial and may treat it as `number`. */
  contentWidth: Length;
  contentHeight: Length;
  timelineStart: number;
  timelineEnd: number;
  filters?: Filter[];
  /** Opacity multiplier (0..1); absent means opaque. Sampled per-frame by
   *  renderers, like `volume`. */
  opacity?: Keyframed<number>;
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
  duration: number;
  speed: number;
  /** Crossfade overlap (s) with the previous sibling — see ResolvedClip. */
  transition?: number;
  /** Crossfade overlap (s) with the next sibling — see ResolvedClip. */
  transitionOut?: number;
  children: ResolvedChild[];
  filters?: Filter[];
  /** Opacity multiplier (0..1); absent means opaque. Sampled per-frame by
   *  renderers, like `volume`. */
  opacity?: Keyframed<number>;
  spatial?: SpatialRect;
  objectFit?: ObjectFit;
  spatialInput?: SpatialInput;
  backgroundColor?: string;
  /** Inner canvas dim. Carries the authored `Length` (number or
   *  percentage string) pre-spatial pass; the spatial pass collapses to
   *  a pixel number. Consumers run post-spatial and may treat it as
   *  `number`. */
  contentWidth?: Length;
  contentHeight?: Length;
  intrinsicWidth?: number;
  intrinsicHeight?: number;
  naturalWidth?: number;
  naturalHeight?: number;
}

/** Animated 2D layer after layout resolution. The animation engine
 *  (env-specific) consumes `frames` + `clips` directly — there's no
 *  per-keyframe baking at layout time; spatial-only fields here describe
 *  the graphic's placement in the parent composition. */
export interface ResolvedGraphic {
  type: "graphic";
  duration?: Length;
  loop?: boolean;
  /** Crossfade overlap (s) with the previous sibling — see ResolvedClip. */
  transition?: number;
  /** Crossfade overlap (s) with the next sibling — see ResolvedClip. */
  transitionOut?: number;
  /** Animation design space. Renderers resolve authored Length values
   *  inside keyframes against this rect. */
  contentWidth?: Length;
  contentHeight?: Length;
  clips?: GraphicClipDef[];
  frames: GraphicFrame[];
  timelineStart: number;
  timelineEnd: number;
  spatial?: SpatialRect;
  spatialInput?: SpatialInput;
  objectFit?: ObjectFit;
  intrinsicWidth?: number;
  intrinsicHeight?: number;
  naturalWidth?: number;
  naturalHeight?: number;
  filters?: Filter[];
  /** Opacity multiplier (0..1); absent means opaque. Sampled per-frame by
   *  renderers, like `volume`. */
  opacity?: Keyframed<number>;
}

export type ResolvedChild =
  | ResolvedClip
  | ResolvedAudio
  | ResolvedStatic
  | ResolvedEmpty
  | ResolvedData
  | ResolvedText
  | ResolvedGraphic
  | ResolvedComposition;

export interface ResolvedTimeline {
  duration: number;
  width?: number;
  height?: number;
  objectFit?: ObjectFit;
  backgroundColor?: string;
  /** Root inner canvas dim. Authored `Length`; `resolveSpatial` collapses
   *  to a pixel number (and rejects percentage strings on the root, since
   *  there's no parent reference). */
  contentWidth?: Length;
  contentHeight?: Length;
  children: ResolvedChild[];
}

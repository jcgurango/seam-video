import type {
  Keyframed,
  Length,
  ObjectFit,
  Point2D,
  Filter,
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
}

export interface ResolvedClip {
  type: "clip";
  source: string;
  sourceIn: number;
  sourceOut: number;
  timelineStart: number;
  timelineEnd: number;
  speed: number;
  /** Audio gain multiplier; absent means unity (1). */
  volume?: Keyframed<number>;
  filters?: Filter[];
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
  filters?: Filter[];
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
  children: ResolvedChild[];
  filters?: Filter[];
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

export type ResolvedChild =
  | ResolvedClip
  | ResolvedAudio
  | ResolvedStatic
  | ResolvedEmpty
  | ResolvedData
  | ResolvedText
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

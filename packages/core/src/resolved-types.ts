import type {
  Dimension,
  Keyframed,
  ObjectFit,
  Position,
  Filter,
  TextPadding,
  TextRun,
  TextStyleFields,
} from "./types.js";

export type { ObjectFit, Position };

export interface SpatialRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface SpatialInput {
  position?: Position;
  objectFit?: ObjectFit;
  top?: Keyframed<Dimension>;
  left?: Keyframed<Dimension>;
  right?: Keyframed<Dimension>;
  bottom?: Keyframed<Dimension>;
  width?: Keyframed<Dimension>;
  height?: Keyframed<Dimension>;
}

export interface SpatialAnchor {
  left?: number;
  right?: number;
  top?: number;
  bottom?: number;
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
  position?: Position;
  anchor?: SpatialAnchor;
  spatialInput?: SpatialInput;
}

export interface ResolvedStatic {
  type: "static";
  source: string;
  /** Source-time freeze offset (seconds). 0 for images; the user's `in`
   *  value for video freeze-frames. */
  sourceTime: number;
  timelineStart: number;
  timelineEnd: number;
  filters?: Filter[];
  spatial?: SpatialRect;
  objectFit?: ObjectFit;
  position?: Position;
  anchor?: SpatialAnchor;
  spatialInput?: SpatialInput;
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
  /** Audio gain multiplier; absent means unity (1). */
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
  /** Always normalised to an array of runs by the resolver. Plain
   *  strings authored at the doc level are wrapped into single-text
   *  runs; mixed arrays have their bare strings wrapped the same way. */
  runs: TextRun[];
  lineHeight?: Keyframed<number>;
  textAlign?: "left" | "center" | "right";
  verticalAlign?: "top" | "center" | "bottom";
  padding?: TextPadding;
  /** Intrinsic SVG width — filled by the spatial pass. */
  contentWidth: number;
  /** Intrinsic SVG height — filled by the spatial pass. */
  contentHeight: number;
  timelineStart: number;
  timelineEnd: number;
  filters?: Filter[];
  spatial?: SpatialRect;
  objectFit?: ObjectFit;
  position?: Position;
  anchor?: SpatialAnchor;
  spatialInput?: SpatialInput;
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
  position?: Position;
  anchor?: SpatialAnchor;
  spatialInput?: SpatialInput;
  contentWidth?: number;
  contentHeight?: number;
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
  contentWidth?: number;
  contentHeight?: number;
  children: ResolvedChild[];
}

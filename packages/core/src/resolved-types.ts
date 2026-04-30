import type { ObjectFit, Position, Filter } from "./types.js";

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
  top?: string;
  left?: string;
  right?: string;
  bottom?: string;
  width?: string;
  height?: string;
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
  volume?: number;
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
  volume?: number;
}

export interface ResolvedData {
  type: "data";
  data: unknown;
  tags?: string[];
  timelineStart: number;
  timelineEnd: number;
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
  | ResolvedEmpty
  | ResolvedData
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

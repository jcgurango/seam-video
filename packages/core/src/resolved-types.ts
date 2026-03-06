import type { ObjectFit, Position } from "./types.js";

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

export interface ResolvedComposition {
  type: "composition";
  timelineStart: number;
  timelineEnd: number;
  duration: number;
  speed: number;
  children: ResolvedChild[];
  spatial?: SpatialRect;
  objectFit?: ObjectFit;
  position?: Position;
  anchor?: SpatialAnchor;
  spatialInput?: SpatialInput;
  contentWidth?: number;
  contentHeight?: number;
}

export interface ResolvedOverlay {
  type: "overlay";
  timelineStart: number;
  timelineEnd: number;
  duration: number;
  speed: number;
  children: ResolvedChild[];
  spatial?: SpatialRect;
  objectFit?: ObjectFit;
  position?: Position;
  anchor?: SpatialAnchor;
  spatialInput?: SpatialInput;
  contentWidth?: number;
  contentHeight?: number;
}

export type ResolvedChild = ResolvedClip | ResolvedEmpty | ResolvedComposition | ResolvedOverlay;

export interface ResolvedTimeline {
  duration: number;
  width?: number;
  height?: number;
  objectFit?: ObjectFit;
  contentWidth?: number;
  contentHeight?: number;
  children: ResolvedChild[];
}

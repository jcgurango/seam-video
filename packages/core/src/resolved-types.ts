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
  id?: string;
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
  id?: string;
}

export interface ResolvedComposition {
  type: "composition";
  timelineStart: number;
  timelineEnd: number;
  duration: number;
  speed: number;
  children: ResolvedChild[];
  id?: string;
  /**
   * The inner-timeline offset at which this composition's cropped `children`
   * begin — i.e. `child.in ?? 0` after any overflow/underflow trimming. Used
   * by attachments anchoring to this composition in `timeSource: "source"`
   * mode, so anchorPoint is interpreted in the pre-window inner timeline.
   */
  sourceWindowStart?: number;
  filters?: Filter[];
  spatial?: SpatialRect;
  objectFit?: ObjectFit;
  position?: Position;
  anchor?: SpatialAnchor;
  spatialInput?: SpatialInput;
  contentWidth?: number;
  contentHeight?: number;
}

export type ResolvedChild = ResolvedClip | ResolvedEmpty | ResolvedComposition;

export interface ResolvedTimeline {
  duration: number;
  width?: number;
  height?: number;
  objectFit?: ObjectFit;
  contentWidth?: number;
  contentHeight?: number;
  children: ResolvedChild[];
}

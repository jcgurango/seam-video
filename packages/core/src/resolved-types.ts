export interface ResolvedClip {
  type: "clip";
  source: string;
  sourceIn: number;
  sourceOut: number;
  timelineStart: number;
  timelineEnd: number;
  speed: number;
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
}

export interface ResolvedOverlay {
  type: "overlay";
  timelineStart: number;
  timelineEnd: number;
  duration: number;
  speed: number;
  children: ResolvedChild[];
}

export type ResolvedChild = ResolvedClip | ResolvedEmpty | ResolvedComposition | ResolvedOverlay;

export interface ResolvedTimeline {
  duration: number;
  children: ResolvedChild[];
}

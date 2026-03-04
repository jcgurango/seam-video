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

export type ResolvedChild = ResolvedClip | ResolvedEmpty;

export interface ResolvedTimeline {
  duration: number;
  children: ResolvedChild[];
}

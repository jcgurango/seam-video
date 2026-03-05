export type Justify = "start" | "end" | "center" | "space-between";
export type Overflow = "trim-end" | "trim-start" | "trim-center" | "stretch";
export type Underflow =
  | "extend-end"
  | "extend-start"
  | "extend-center"
  | "stretch";

export interface CompositionLayout {
  justify: Justify;
  gap: number;
}

export interface ChildTimingFields {
  in?: number;
  out?: number;
  flex?: number;
  overflow?: Overflow;
  underflow?: Underflow;
}

export interface Clip extends ChildTimingFields {
  type: "clip";
  source: string;
  in: number;
  out: number;
}

export interface Empty {
  type: "empty";
  duration: number;
  flex?: number;
}

export interface Composition extends ChildTimingFields {
  type: "composition";
  children: Child[];
  duration?: number;
  unitDuration?: number;
  layout?: CompositionLayout;
}

export type AlignItems = "start" | "end" | "center";

export interface Overlay extends ChildTimingFields {
  type: "overlay";
  children: Child[];
  duration?: number;
  alignItems: AlignItems;
}

export type Child = Clip | Empty | Composition | Overlay;
export type SeamFile = Composition;

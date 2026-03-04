export type Justify = "start" | "end" | "center" | "space-between";
export type Overflow = "trim-end" | "trim-start" | "trim-center" | "stretch";
export type Underflow =
  | "extend-end"
  | "extend-start"
  | "extend-center"
  | "stretch";

export interface Layout {
  duration?: number;
  justify: Justify;
  gap: number;
}

export interface Clip {
  type: "clip";
  source: string;
  in: number;
  out: number;
  flex?: number;
  overflow: Overflow;
  underflow?: Underflow;
}

export interface Empty {
  type: "empty";
  duration: number;
  flex?: number;
}

export interface Composition {
  type: "composition";
  children: Child[];
  layout?: Layout;
  in?: number;
  out?: number;
  flex?: number;
  overflow: Overflow;
  underflow?: Underflow;
}

export type Child = Clip | Empty | Composition;
export type SeamFile = Composition;

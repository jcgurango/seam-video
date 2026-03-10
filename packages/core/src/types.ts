export type Justify = "start" | "end" | "center" | "space-between";
export type Overflow = "trim-end" | "trim-start" | "trim-center" | "stretch";
export type Underflow =
  | "extend-end"
  | "extend-start"
  | "extend-center"
  | "stretch";

export type Position = "absolute" | "relative";
export type ObjectFit = "center" | "fit" | "cover";

// ── Filters ────────────────────────────────────────────────────────

export interface AdjustFilter {
  type: "adjust";
  brightness?: number;
  contrast?: number;
  saturation?: number;
  gamma?: number;
}

export interface OpacityFilter {
  type: "opacity";
  value: number;
}

export interface ColorBalanceFilter {
  type: "colorbalance";
  rs?: number; gs?: number; bs?: number;
  rm?: number; gm?: number; bm?: number;
  rh?: number; gh?: number; bh?: number;
}

export interface ColorTemperatureFilter {
  type: "colortemperature";
  temperature?: number;
}

export type Filter = AdjustFilter | OpacityFilter | ColorBalanceFilter | ColorTemperatureFilter;

export interface CompositionLayout {
  justify: Justify;
  gap: number;
}

export interface SpatialFields {
  position?: Position;
  objectFit?: ObjectFit;
  top?: string;
  left?: string;
  right?: string;
  bottom?: string;
  width?: string;
  height?: string;
}

export interface ChildTimingFields extends SpatialFields {
  in?: number;
  out?: number;
  flex?: number;
  overflow?: Overflow;
  underflow?: Underflow;
  filters?: Filter[];
}

export interface Clip extends ChildTimingFields {
  type: "clip";
  source: string;
  in: number;
  out: number;
  speed?: number;
  duration?: number;
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
  contentWidth?: number;
  contentHeight?: number;
}

export type AlignItems = "start" | "end" | "center";

export interface Overlay extends ChildTimingFields {
  type: "overlay";
  children: Child[];
  duration?: number;
  alignItems: AlignItems;
  contentWidth?: number;
  contentHeight?: number;
}

export type Child = Clip | Empty | Composition | Overlay;
export type SeamFile = Composition;

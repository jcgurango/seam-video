// Property catalog + pure edit helpers behind the Properties panel.
//
// The panel edits the AUTHORED node(s) at the selected path keys. Everything
// here is React-free so it can be unit-tested: which properties a node type
// exposes (and in what order / group), what their omitted-key defaults are
// (shown as placeholders), how a multi-selection intersects them and detects
// "mixed" values, how a `Length` splits into its percent + pixel parts (the
// panel shows both inputs side by side), and how an edit is written back to
// every selected node immutably.
//
// Extension-contributed fields (`seam.fields` — e.g. the Adjustments
// extension's brightness / saturation / …) are appended to every visual
// node's catalog and to the root's: `catalogFor` / `sharedProps` / `rootProps`
// take the Seam instance for that. A field with a range gets a slider.
//
// Deliberately NOT here: `children` (the timeline owns them) and the structured bags
// (`pin`, `paths`, `data`, `metadata`, `bin`, `script`, `macros`) — those
// stay in the JSON panel for now. (`inset` and `distort` have their own
// kinds: four edge lengths / four corner points.)

import {
  VISUAL_NODE_TYPES,
  isKeyframed,
  parseLength,
  type Child,
  type Distort,
  type Inset,
  type Keyframe,
  type Keyframed,
  type Length,
  type Point2D,
  type SeamFile,
  type TimeExpr,
} from "@seam/core";
import { getNodeAtPath, parsePath, updateNodeAtPath, type NodePath } from "./nodePath.js";
import type { Seam } from "@seam/core";

export type PropKind =
  /** A plain number (seconds, px, degrees, …). */
  | "number"
  /** `Length`: percent + pixel offset, edited as two inputs. */
  | "length"
  /** `Point2D`: an X and a Y `Length` (a scalar applies to both). */
  | "point"
  /** Any CSS colour string. */
  | "color"
  /** Single-line string. */
  | "string"
  /** Multi-line string. */
  | "text"
  /** One of `options`. */
  | "enum"
  /** `Inset`: per-edge `Length`s (top / right / bottom / left), authored in
   *  the padding shorthand. */
  | "inset"
  /** `Distort`: an X and a Y `Length` per corner. */
  | "distort"
  /** Number OR string: a numeric-looking entry is stored as a number,
   *  anything else as typed (clip `volume` accepts `"-6dB"`, `start` an
   *  anchor like `"intro@50%"`). */
  | "scalar";

export type PropGroup =
  | "Timing"
  | "Media"
  | "Layout"
  | "Appearance"
  | "Text"
  | "Map"
  | "Audio"
  /** A group named by an extension (`FieldSpec.group`); shown after the
   *  core groups, in first-appearance order. */
  | (string & {});

export interface PropDef {
  key: string;
  label: string;
  group: PropGroup;
  kind: PropKind;
  /** Keyframeable per the schema (`keyframed(...)`). */
  animatable?: boolean;
  /** Placeholder shown when the key is omitted — the effective default,
   *  spelled the way an author would write it (`"50%"`, `0`, `"black"`) or a
   *  short description when it isn't a literal (`"inherit"`, `"natural"`). */
  placeholder?: string;
  /** For `length` / `point`: the percent substituted when the author gives
   *  a bare pixel number (`resolveLength`'s `percentDefault`). Shown as the
   *  percent input's placeholder. */
  percentDefault?: number;
  /** Unit hint rendered after a number input. */
  unit?: string;
  /** `number` only: the span of a slider shown beside the number input.
   *  Typed values may fall outside it (the schema has the last word). */
  range?: { min: number; max: number; step: number };
  /** `number` only: the value an omitted key evaluates to — where the
   *  slider rests, and the first keyframe's value when animating from unset. */
  default?: number;
  options?: readonly string[];
  /** Short help shown as the row's tooltip. */
  hint?: string;
}

// ── Catalog ────────────────────────────────────────────────────────

const timing = (
  partial: Partial<PropDef> & Pick<PropDef, "key" | "label" | "kind">,
): PropDef => ({ group: "Timing", ...partial });

const ID: PropDef = timing({
  key: "id",
  label: "ID",
  kind: "string",
  hint: "Anchor target name within the enclosing composition.",
});
const START: PropDef = timing({
  key: "start",
  label: "Start",
  kind: "scalar",
  placeholder: "after previous",
  hint: "Heads a new run: absolute seconds, or an anchor — \"id\", \"id@50%\" (fraction of its span), \"id@10\" (its source second 10). Empty = continue after the previous node.",
});
const OFFSET: PropDef = timing({
  key: "offset",
  label: "Offset",
  kind: "number",
  unit: "s",
  placeholder: "0",
  hint: "Seconds added to the position. After a previous node: positive = gap, negative = overlap + crossfade. With Start: a plain shift.",
});
/** Where the node sits in its container — every child type has these. */
const PLACEMENT: PropDef[] = [START, OFFSET, ID];
const OVERFLOW: PropDef = timing({
  key: "overflow",
  label: "Overflow",
  kind: "enum",
  options: ["trim-end", "trim-start", "trim-center", "stretch"],
  placeholder: "stretch",
  hint: "How content longer than Duration is fitted.",
});
const UNDERFLOW: PropDef = timing({
  key: "underflow",
  label: "Underflow",
  kind: "enum",
  options: ["extend-end", "extend-start", "extend-center", "stretch", "loop"],
  placeholder: "stretch",
  hint: "How content shorter than Duration fills it.",
});
const IN_OUT: PropDef[] = [
  timing({ key: "in", label: "In", kind: "number", unit: "s" }),
  timing({
    key: "out",
    label: "Out",
    kind: "number",
    unit: "s",
    placeholder: "in + duration",
    hint: "Source end. Omit it when Duration is set: out = in + duration. Out before In plays the span in reverse.",
  }),
];
const SPEED: PropDef = timing({
  key: "speed",
  label: "Speed",
  kind: "number",
  unit: "×",
  placeholder: "1",
  hint: "With Duration, needs a non-stretch Overflow / Underflow (stretch derives the rate from Duration).",
});
const DURATION_REQ: PropDef = timing({ key: "duration", label: "Duration", kind: "number", unit: "s" });
const DURATION_OPT: PropDef = timing({
  key: "duration",
  label: "Duration",
  kind: "number",
  unit: "s",
  placeholder: "natural",
  hint: "Output length. Overflow / Underflow say how the content fills it (default: stretch, the rate derives from it).",
});
const DURATION_CLIP: PropDef = {
  ...DURATION_OPT,
  hint: "Output length; negative plays the span in reverse. Overflow / Underflow say how the content fills it (default: stretch, the rate derives from it).",
};

const SOURCE: PropDef = { key: "source", label: "Source", group: "Media", kind: "string" };

const SPATIAL: PropDef[] = [
  {
    key: "objectFit",
    label: "Object fit",
    group: "Layout",
    kind: "enum",
    options: ["fit", "cover", "center"],
    placeholder: "inherit",
  },
  {
    key: "origin",
    label: "Origin",
    group: "Layout",
    kind: "point",
    animatable: true,
    placeholder: "50%",
    percentDefault: 50,
    hint: "Point on the item (percent of its own size) that lands at Translation.",
  },
  {
    key: "translation",
    label: "Translation",
    group: "Layout",
    kind: "point",
    animatable: true,
    placeholder: "0",
    percentDefault: 50,
    hint: "Point in the parent (percent of its content size) where Origin lands. 0 = center.",
  },
  {
    key: "size",
    label: "Size",
    group: "Layout",
    kind: "point",
    animatable: true,
    placeholder: "100%",
    percentDefault: 0,
    hint: "Percent of the post-objectFit natural size; bare number = px.",
  },
  {
    key: "rotation",
    label: "Rotation",
    group: "Layout",
    kind: "number",
    animatable: true,
    unit: "°",
    placeholder: "0",
  },
  {
    key: "opacity",
    label: "Opacity",
    group: "Appearance",
    kind: "number",
    animatable: true,
    placeholder: "1",
  },
  {
    key: "cornerRadius",
    label: "Corner radius",
    group: "Appearance",
    kind: "length",
    animatable: true,
    placeholder: "0",
    percentDefault: 0,
    hint: "Percent of the shorter side (50% = circle / pill).",
  },
];

const CONTENT_DIMS: PropDef[] = [
  {
    key: "contentWidth",
    label: "Content width",
    group: "Layout",
    kind: "length",
    animatable: true,
    placeholder: "100%",
    percentDefault: 0,
    hint: "Inner canvas; percent of the parent. The root must be a pixel number.",
  },
  {
    key: "contentHeight",
    label: "Content height",
    group: "Layout",
    kind: "length",
    animatable: true,
    placeholder: "100%",
    percentDefault: 0,
  },
];

const VOLUME: PropDef = {
  key: "volume",
  label: "Volume",
  group: "Audio",
  kind: "scalar",
  animatable: true,
  placeholder: "1",
  hint: "Linear gain (0..4) or decibels like \"-6dB\".",
};
const PITCH: PropDef = {
  key: "pitch",
  label: "Pitch",
  group: "Audio",
  kind: "number",
  unit: "st",
  placeholder: "0",
  hint: "Length-preserving shift in semitones (±48).",
};

const COLOR_ENUMS = {
  fontStyle: ["normal", "italic", "oblique"],
  textDecoration: ["none", "underline", "overline", "line-through"],
  textAlign: ["left", "center", "right"],
  verticalAlign: ["top", "center", "bottom"],
} as const;

const TEXT_PROPS: PropDef[] = [
  { key: "text", label: "Text", group: "Text", kind: "text" },
  { key: "fontFamily", label: "Font", group: "Text", kind: "string", placeholder: "Liberation Sans" },
  {
    key: "fontSize",
    label: "Font size",
    group: "Text",
    kind: "number",
    animatable: true,
    unit: "px",
    placeholder: "16",
  },
  { key: "color", label: "Color", group: "Text", kind: "color", animatable: true, placeholder: "black" },
  { key: "fontWeight", label: "Weight", group: "Text", kind: "string", placeholder: "normal" },
  {
    key: "fontStyle",
    label: "Style",
    group: "Text",
    kind: "enum",
    options: COLOR_ENUMS.fontStyle,
    placeholder: "normal",
  },
  {
    key: "textDecoration",
    label: "Decoration",
    group: "Text",
    kind: "enum",
    options: COLOR_ENUMS.textDecoration,
    placeholder: "none",
  },
  {
    key: "letterHeight",
    label: "Letter height",
    group: "Text",
    kind: "string",
    placeholder: "100%",
    hint: "Vertical glyph stretch about the baseline.",
  },
  {
    key: "lineHeight",
    label: "Line height",
    group: "Text",
    kind: "number",
    animatable: true,
    unit: "px",
    placeholder: "1.2 × font size",
  },
  {
    key: "textAlign",
    label: "Align",
    group: "Text",
    kind: "enum",
    options: COLOR_ENUMS.textAlign,
    placeholder: "center",
  },
  {
    key: "verticalAlign",
    label: "Vertical align",
    group: "Text",
    kind: "enum",
    options: COLOR_ENUMS.verticalAlign,
    placeholder: "top",
  },
  { key: "padding", label: "Padding", group: "Text", kind: "number", unit: "px", placeholder: "0" },
  {
    key: "backgroundColor",
    label: "Background",
    group: "Text",
    kind: "color",
    animatable: true,
    placeholder: "none",
  },
  {
    key: "strokeColor",
    label: "Stroke",
    group: "Text",
    kind: "color",
    animatable: true,
    placeholder: "black",
  },
  {
    key: "strokeWidth",
    label: "Stroke width",
    group: "Text",
    kind: "number",
    animatable: true,
    unit: "px",
    placeholder: "0",
  },
];

const SHAPE_PROPS: PropDef[] = [
  { key: "fill", label: "Fill", group: "Appearance", kind: "color", animatable: true, placeholder: "black" },
  { key: "stroke", label: "Stroke", group: "Appearance", kind: "color", animatable: true, placeholder: "none" },
  {
    key: "strokeWidth",
    label: "Stroke width",
    group: "Appearance",
    kind: "number",
    animatable: true,
    unit: "px",
    placeholder: "0",
    hint: "Drawn inside the box.",
  },
];

const MAP_PROPS: PropDef[] = [
  { key: "latitude", label: "Latitude", group: "Map", kind: "number", animatable: true, placeholder: "0" },
  { key: "longitude", label: "Longitude", group: "Map", kind: "number", animatable: true, placeholder: "0" },
  {
    key: "zoom",
    label: "Zoom",
    group: "Map",
    kind: "number",
    animatable: true,
    placeholder: "1",
    hint: "maplibre-512 zoom; tweens in scale space.",
  },
  {
    key: "mapOpacity",
    label: "Basemap opacity",
    group: "Map",
    kind: "number",
    animatable: true,
    placeholder: "1",
  },
  { key: "theme", label: "Theme", group: "Map", kind: "enum", options: ["light", "dark"], placeholder: "light" },
];

const COMPOSITION_PROPS: PropDef[] = [
  ...IN_OUT.map((d) => ({ ...d, placeholder: d.key === "in" ? "0" : "whole timeline" })),
  SPEED,
  DURATION_OPT,
  OVERFLOW,
  UNDERFLOW,
  ...PLACEMENT,
  ...SPATIAL,
  ...CONTENT_DIMS,
  {
    key: "inset",
    label: "Inset",
    group: "Layout",
    kind: "inset",
    animatable: true,
    hint: "Per-edge crop of the content box. Percent of the box's width (left / right) or height (top / bottom).",
  },
  {
    key: "insetMode",
    label: "Inset mode",
    group: "Layout",
    kind: "enum",
    options: ["window", "center", "fit", "cover"],
    placeholder: "window",
  },
  {
    key: "distort",
    label: "Distort",
    group: "Layout",
    kind: "distort",
    animatable: true,
    hint: "Corner pin: where each corner of the inner canvas lands. Percent of the inner canvas; a bare number is a px offset from the corner.",
  },
  {
    key: "backgroundColor",
    label: "Background",
    group: "Appearance",
    kind: "color",
    placeholder: "none",
  },
  VOLUME,
  PITCH,
];

const CATALOG: Record<Child["type"], PropDef[]> = {
  clip: [
    SOURCE,
    ...IN_OUT,
    SPEED,
    DURATION_CLIP,
    OVERFLOW,
    UNDERFLOW,
    ...PLACEMENT,
    {
      key: "orientation",
      label: "Orientation",
      group: "Media",
      kind: "enum",
      options: ["0", "90", "180", "270"],
      placeholder: "0",
      hint: "Pre-transform source rotation (clockwise degrees).",
    },
    ...SPATIAL,
    VOLUME,
    PITCH,
  ],
  audio: [SOURCE, ...IN_OUT, SPEED, DURATION_CLIP, OVERFLOW, UNDERFLOW, ...PLACEMENT, VOLUME, PITCH],
  static: [
    SOURCE,
    DURATION_REQ,
    timing({
      key: "in",
      label: "Freeze at",
      kind: "number",
      unit: "s",
      placeholder: "0",
      hint: "Video sources only: the timestamp to freeze on.",
    }),
    ...PLACEMENT,
    ...SPATIAL,
  ],
  data: [
    timing({ key: "duration", label: "Duration", kind: "number", unit: "s", placeholder: "0" }),
    ...PLACEMENT,
  ],
  text: [DURATION_REQ, ...PLACEMENT, ...TEXT_PROPS, ...SPATIAL, ...CONTENT_DIMS],
  rect: [DURATION_REQ, ...PLACEMENT, ...SHAPE_PROPS, ...SPATIAL],
  circle: [DURATION_REQ, ...PLACEMENT, ...SHAPE_PROPS, ...SPATIAL],
  map: [SOURCE, DURATION_REQ, ...PLACEMENT, ...MAP_PROPS, ...SPATIAL, ...CONTENT_DIMS],
  composition: COMPOSITION_PROPS,
};

/** The root composition (no selection): it has no parent, so none of the
 *  placement / timing fields apply — it defines the output canvas (static
 *  pixel dims; `%` and keyframes are rejected there) and the global mix. */
export const ROOT_PROPS: PropDef[] = [
  {
    key: "contentWidth",
    label: "Canvas width",
    group: "Layout",
    kind: "number",
    unit: "px",
    placeholder: "1080",
    hint: "Output width. The root must be a static pixel number.",
  },
  {
    key: "contentHeight",
    label: "Canvas height",
    group: "Layout",
    kind: "number",
    unit: "px",
    placeholder: "1920",
    hint: "Output height. The root must be a static pixel number.",
  },
  {
    key: "objectFit",
    label: "Object fit",
    group: "Layout",
    kind: "enum",
    options: ["fit", "cover", "center"],
    placeholder: "fit",
    hint: "Default fit for every descendant that doesn't set its own.",
  },
  {
    key: "backgroundColor",
    label: "Background",
    group: "Appearance",
    kind: "color",
    placeholder: "black",
  },
  VOLUME,
  PITCH,
];

/** Display order of groups in the panel. */
export const GROUP_ORDER: PropGroup[] = [
  "Timing",
  "Media",
  "Layout",
  "Appearance",
  "Text",
  "Map",
  "Audio",
];

const extensionPropsCache = new WeakMap<Seam, PropDef[]>();

/** The Properties rows for the fields the installed extensions contribute to
 *  visual nodes — derived from the same `FieldSpec` that drives validation
 *  and rendering, so an extension declares a field once. */
export function extensionProps(seam: Seam): PropDef[] {
  let defs = extensionPropsCache.get(seam);
  if (!defs) {
    defs = seam.fields
      .filter((f) => f.nodes === "visual")
      .map((f): PropDef => {
        const lo = f.softMin ?? f.min;
        const hi = f.softMax ?? f.max;
        return {
          key: f.key,
          label: f.label ?? f.key,
          group: f.group ?? "Extensions",
          kind: "number",
          animatable: f.animatable === true,
          placeholder: String(f.default),
          default: f.default,
          ...(f.unit ? { unit: f.unit } : {}),
          ...(lo != null && hi != null
            ? { range: { min: lo, max: hi, step: f.step ?? (hi - lo) / 100 } }
            : {}),
        };
      });
    extensionPropsCache.set(seam, defs);
  }
  return defs;
}

const VISUAL_TYPES: ReadonlySet<string> = new Set(VISUAL_NODE_TYPES);

/** A node type's properties: core's, then (on visual nodes) the installed
 *  extensions'. */
export function catalogFor(seam: Seam, type: Child["type"]): PropDef[] {
  const core = CATALOG[type] ?? [];
  if (!VISUAL_TYPES.has(type)) return core;
  const ext = extensionProps(seam);
  return ext.length ? [...core, ...ext] : core;
}

/** The root composition's properties (no selection): its own parentless
 *  catalog plus the extension fields, which apply to the whole output there. */
export function rootProps(seam: Seam): PropDef[] {
  const ext = extensionProps(seam);
  return ext.length ? [...ROOT_PROPS, ...ext] : ROOT_PROPS;
}

/** Properties every node in `nodes` exposes, in the first node's catalog
 *  order. Two types sharing a key must agree on its kind (they do — the
 *  catalog reuses one definition per key — but a mismatch is dropped rather
 *  than shown wrong). */
export function sharedProps(seam: Seam, nodes: Child[]): PropDef[] {
  if (nodes.length === 0) return [];
  const [first, ...rest] = nodes;
  const others = rest.map((n) => new Map(catalogFor(seam, n.type).map((d) => [d.key, d])));
  return catalogFor(seam, first.type).filter((def) =>
    others.every((m) => {
      const o = m.get(def.key);
      return o != null && o.kind === def.kind;
    }),
  );
}

export interface SelectionSummary {
  count: number;
  /** Distinct types with counts, most frequent first. */
  types: { type: Child["type"]; count: number }[];
}

export function summarizeSelection(nodes: Child[]): SelectionSummary {
  const counts = new Map<Child["type"], number>();
  for (const n of nodes) counts.set(n.type, (counts.get(n.type) ?? 0) + 1);
  const types = [...counts.entries()]
    .map(([type, count]) => ({ type, count }))
    .sort((a, b) => b.count - a.count || a.type.localeCompare(b.type));
  return { count: nodes.length, types };
}

/** Resolve the selection's path keys to authored nodes (dropping any that
 *  don't resolve, e.g. a stale key after an undo). An EMPTY selection
 *  targets the root composition itself (path `[]`, key `""`). */
export function selectedNodes(
  doc: SeamFile,
  selection: string[],
): { path: NodePath; key: string; node: Child }[] {
  if (selection.length === 0) return [{ path: [], key: "", node: doc as Child }];
  const out: { path: NodePath; key: string; node: Child }[] = [];
  for (const key of selection) {
    const path = parsePath(key);
    const node = getNodeAtPath(doc, path);
    if (node) out.push({ path, key, node });
  }
  return out;
}

// ── Values across a multi-selection ────────────────────────────────

export type PropState<T = unknown> =
  | { kind: "same"; value: T | undefined }
  | { kind: "mixed" };

const deepEqual = (a: unknown, b: unknown): boolean =>
  a === b || JSON.stringify(a) === JSON.stringify(b);

/** The shared value of `key` across `nodes`: `same` (possibly `undefined`
 *  when every node omits it) or `mixed`. Keyframe arrays compare whole. */
export function propState<T = unknown>(nodes: Child[], key: string): PropState<T> {
  if (nodes.length === 0) return { kind: "same", value: undefined };
  const first = (nodes[0] as unknown as Record<string, unknown>)[key];
  for (const n of nodes.slice(1)) {
    if (!deepEqual((n as unknown as Record<string, unknown>)[key], first)) {
      return { kind: "mixed" };
    }
  }
  return { kind: "same", value: first as T | undefined };
}

// ── Length: percent + pixel parts ───────────────────────────────────

export interface LengthParts {
  /** 0..100, or null when the author gave a bare number (percent omitted). */
  percent: number | null;
  /** Pixel offset, or null when the value is percent-only. */
  px: number | null;
}

/** Split an authored `Length` (or `TimeExpr` — same grammar) into the two
 *  inputs' values. `undefined` → both empty. An unparsable string → both
 *  empty too (the JSON panel is the escape hatch). */
export function splitLength(value: Length | undefined): LengthParts {
  if (value == null) return { percent: null, px: null };
  try {
    const { percent, pixels } = parseLength(value);
    if (percent == null) return { percent: null, px: pixels };
    return { percent, px: pixels === 0 ? null : pixels };
  } catch {
    return { percent: null, px: null };
  }
}

const trimNum = (n: number): string => {
  const r = Math.round(n * 10000) / 10000;
  return String(r);
};

/** Compose the authored form from the two inputs. Both empty → `undefined`
 *  (key omitted → default). Percent only → `"p%"`; px only → a number;
 *  both → `"p% + n"` / `"p% - n"`. */
export function joinLength(parts: LengthParts): Length | undefined {
  const { percent, px } = parts;
  if (percent == null && px == null) return undefined;
  if (percent == null) return px as number;
  if (px == null || px === 0) return `${trimNum(percent)}%`;
  return `${trimNum(percent)}% ${px < 0 ? "-" : "+"} ${trimNum(Math.abs(px))}`;
}

export type Axis = "x" | "y";

/** One axis of a `Point2D` (a scalar applies to both axes). */
export function pointAxis(value: Point2D | undefined, axis: Axis): Length | undefined {
  if (value == null) return undefined;
  if (typeof value === "object") return value[axis];
  return value;
}

/** Replace one axis of a `Point2D`, keeping the other axis as authored.
 *  Collapses back to a scalar when both axes end up equal, and to
 *  `undefined` when both are unset. */
export function withPointAxis(
  value: Point2D | undefined,
  axis: Axis,
  next: Length | undefined,
): Point2D | undefined {
  const other: Axis = axis === "x" ? "y" : "x";
  const otherVal = pointAxis(value, other);
  if (next == null && otherVal == null) return undefined;
  if (next != null && otherVal != null && next === otherVal) return next;
  return {
    ...(axis === "x" ? { x: next } : { y: next }),
    ...(otherVal != null ? { [other]: otherVal } : {}),
  } as Point2D;
}

// ── Inset / distort ────────────────────────────────────────────────

export const INSET_EDGES = ["top", "right", "bottom", "left"] as const;

/** An `Inset` shorthand (`L` | `[v, h]` | `[t, r, b, l]`) as its four edges,
 *  top / right / bottom / left. `undefined` → all unset. */
export function insetEdges(value: Inset | undefined): (Length | undefined)[] {
  if (value == null) return [undefined, undefined, undefined, undefined];
  if (!Array.isArray(value)) return [value, value, value, value];
  if (value.length === 2) return [value[0], value[1], value[0], value[1]];
  return [...value];
}

/** Replace one edge and re-collapse to the shortest shorthand. Unset edges of
 *  a partly-set inset are `0`; all unset → `undefined`. */
export function withInsetEdge(
  value: Inset | undefined,
  edge: number,
  next: Length | undefined,
): Inset | undefined {
  const edges = insetEdges(value);
  edges[edge] = next;
  if (edges.every((e) => e == null)) return undefined;
  const [t, r, b, l] = edges.map((e) => e ?? 0);
  if (t === r && t === b && t === l) return t;
  if (t === b && r === l) return [t, r];
  return [t, r, b, l];
}

/** Corners clockwise from top-left, with the percent each coordinate sits at
 *  when unset (its own corner). */
export const DISTORT_CORNERS = [
  { label: "Top left", x: "x0", y: "y0", homeX: 0, homeY: 0 },
  { label: "Top right", x: "x1", y: "y1", homeX: 100, homeY: 0 },
  { label: "Bottom right", x: "x2", y: "y2", homeX: 100, homeY: 100 },
  { label: "Bottom left", x: "x3", y: "y3", homeX: 0, homeY: 100 },
] as const;

/** Set / unset one coordinate of a `Distort`. All unset → `undefined`. */
export function withDistortCoord(
  value: Distort | undefined,
  key: keyof Distort,
  next: Length | undefined,
): Distort | undefined {
  const out: Distort = { ...(value ?? {}) };
  if (next == null) delete out[key];
  else out[key] = next;
  return Object.keys(out).length === 0 ? undefined : out;
}

// ── Keyframes ──────────────────────────────────────────────────────

export type AnyKeyframe = Keyframe<unknown>;

/** Static → animated: a single keyframe at 0 holding the current value (or
 *  `fallback`, the effective default, when the key was omitted). Already
 *  animated values pass through. */
export function toAnimated(value: unknown, fallback: unknown): AnyKeyframe[] {
  if (isKeyframed(value as Keyframed<unknown>)) return value as AnyKeyframe[];
  const v = value === undefined ? fallback : value;
  return [[0, v]];
}

/** Animated → static: the first keyframe's value (authored order). Static
 *  values pass through. */
export function toStatic(value: unknown): unknown {
  if (!isKeyframed(value as Keyframed<unknown>)) return value;
  const kfs = value as AnyKeyframe[];
  return kfs.length > 0 ? kfs[0][1] : undefined;
}

export interface KeyframePatch {
  time?: TimeExpr;
  value?: unknown;
  /** `null` clears the easing (back to linear). */
  easing?: string | null;
}

export function patchKeyframe(kfs: AnyKeyframe[], index: number, patch: KeyframePatch): AnyKeyframe[] {
  const kf = kfs[index];
  if (!kf) return kfs;
  const time = patch.time !== undefined ? patch.time : kf[0];
  const value = "value" in patch ? patch.value : kf[1];
  const easing = patch.easing === undefined ? kf[2] : patch.easing ?? undefined;
  const next: AnyKeyframe = easing != null && easing !== "" && easing !== "linear"
    ? [time, value, easing]
    : [time, value];
  const out = [...kfs];
  out[index] = next;
  return out;
}

/** Append a keyframe. Time defaults to the last keyframe's numeric time + 1s
 *  (or `"100%"` after a percent time); value defaults to the last value. */
export function addKeyframe(kfs: AnyKeyframe[], time?: TimeExpr, value?: unknown): AnyKeyframe[] {
  const last = kfs[kfs.length - 1];
  let t: TimeExpr = 0;
  if (time !== undefined) t = time;
  else if (last) {
    const parts = splitLength(last[0]);
    t = parts.percent != null ? "100%" : (parts.px ?? 0) + 1;
  }
  const v = value !== undefined ? value : last ? last[1] : undefined;
  return [...kfs, [t, v]];
}

export function removeKeyframe(kfs: AnyKeyframe[], index: number): AnyKeyframe[] {
  return kfs.filter((_, i) => i !== index);
}

// ── Write-back ─────────────────────────────────────────────────────

export interface EditResult {
  doc: SeamFile;
  /** Schema errors when the edit produced an invalid document (the original
   *  `doc` is returned unchanged in that case). */
  errors: string[] | null;
}

/** Apply `update` to property `key` of every node at `paths`. `update`
 *  receives the node's current authored value and returns the next one —
 *  `undefined` deletes the key (back to the default). The whole document is
 *  validated once afterwards; an invalid result is rejected with its errors
 *  rather than committed. */
export function applyPropertyEdit(
  seam: Seam,
  doc: SeamFile,
  paths: NodePath[],
  key: string,
  update: (current: unknown, node: Child) => unknown,
): EditResult {
  let next = doc;
  for (const path of paths) {
    next = updateNodeAtPath(next, path, (node) => {
      const rec = node as unknown as Record<string, unknown>;
      const value = update(rec[key], node);
      if (value === undefined) {
        if (!(key in rec)) return node;
        const { [key]: _drop, ...rest } = rec;
        return rest as unknown as Child;
      }
      if (deepEqual(rec[key], value)) return node;
      return { ...rec, [key]: value } as unknown as Child;
    });
  }
  if (next === doc) return { doc, errors: null };
  const v = seam.validate(next);
  if (!v.success) return { doc, errors: v.errors };
  return { doc: next, errors: null };
}

/** Parse a number input's text: empty → `undefined`, otherwise a finite
 *  number or `null` when it isn't one. */
export function parseNumberInput(text: string): number | null | undefined {
  const s = text.trim();
  if (s === "") return undefined;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/** Text shown in a number input for an authored value. */
export function formatNumber(v: unknown): string {
  if (typeof v === "number") return trimNum(v);
  if (v == null) return "";
  return String(v);
}

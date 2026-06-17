import { z } from "zod";

export const ObjectFitSchema = z.enum(["center", "fit", "cover"]);

// ── Animation primitives ───────────────────────────────────────────

const PercentStringSchema = z.string().regex(
  /^-?\d+(?:\.\d+)?%$/,
  "Must be a percentage string (e.g. '50%', '-25%')"
);

// A length expression: a pixel number, a "<n>%" percentage, or a
// combined "<n>% +/- <n>" form. Property-specific defaults handle the
// "no percent given" case in `resolveLength`.
const LengthStringSchema = z.string().regex(
  /^-?\d+(?:\.\d+)?%(?:\s*[+-]\s*-?\d+(?:\.\d+)?)?$/,
  "Must be a number, '<n>%', or '<n>% +/- <n>'"
);
export const LengthSchema = z.union([z.number(), LengthStringSchema]);

// Two-axis input: bare Length (applies to both axes) or object form.
export const Point2DSchema = z.union([
  LengthSchema,
  z.object({
    x: LengthSchema.optional(),
    y: LengthSchema.optional(),
  }).strict(),
]);

// A keyframe time expression: either bare seconds, "<n>%" of node duration,
// or "<n>% + <n>" / "<n>% - <n>" combined.
const TimeExprStringSchema = z.string().regex(
  /^-?\d+(?:\.\d+)?%(?:\s+[+-]\s+-?\d+(?:\.\d+)?)?$/,
  "Must be a number, '<n>%', or '<n>% + <n>' / '<n>% - <n>'"
);
const TimeExprSchema = z.union([z.number(), TimeExprStringSchema]);

const EasingSchema = z.string();

/** Wraps a value schema so it accepts either the static value directly or
 *  an array of `[time, value, easing?]` keyframe tuples. The discriminator
 *  is structural: an array whose first element is itself a tuple is read
 *  as keyframes; anything else falls through to the static schema. */
export function keyframed<T extends z.ZodTypeAny>(staticSchema: T): z.ZodType<any> {
  const kfTuple = z.union([
    z.tuple([TimeExprSchema, staticSchema]),
    z.tuple([TimeExprSchema, staticSchema, EasingSchema]),
  ]);
  return z.union([staticSchema, z.array(kfTuple).min(1)]);
}

// ── Filters ────────────────────────────────────────────────────────

// Filters are NOT animatable — params are plain numbers. (Opacity, the one
// filter anyone ever keyframed, is now the first-class `opacity` field in
// SpatialFieldsSchema below.)
export const AdjustFilterSchema = z.object({
  type: z.literal("adjust"),
  brightness: z.number().min(-1).max(1).default(0),
  contrast: z.number().min(-1000).max(1000).default(1),
  saturation: z.number().min(0).max(3).default(1),
  gamma: z.number().min(0.1).max(10).default(1),
});

export const ColorBalanceFilterSchema = z.object({
  type: z.literal("colorbalance"),
  rs: z.number().min(-1).max(1).default(0),
  gs: z.number().min(-1).max(1).default(0),
  bs: z.number().min(-1).max(1).default(0),
  rm: z.number().min(-1).max(1).default(0),
  gm: z.number().min(-1).max(1).default(0),
  bm: z.number().min(-1).max(1).default(0),
  rh: z.number().min(-1).max(1).default(0),
  gh: z.number().min(-1).max(1).default(0),
  bh: z.number().min(-1).max(1).default(0),
});

export const ColorTemperatureFilterSchema = z.object({
  type: z.literal("colortemperature"),
  temperature: z.number().min(1000).max(40000).default(6500),
});

export const FilterSchema = z.discriminatedUnion("type", [
  AdjustFilterSchema,
  ColorBalanceFilterSchema,
  ColorTemperatureFilterSchema,
]);

export const FiltersArraySchema = z.array(FilterSchema).optional();

export const TimeAnchorSchema = z.object({
  anchor: z.string().min(1).optional(),
  anchorPoint: z.union([PercentStringSchema, z.number()]).optional(),
  offset: z.union([z.number(), PercentStringSchema]).optional(),
  timeSource: z.enum(["output", "source"]).optional(),
}).refine(
  (data) => !(data.anchor == null && data.anchorPoint != null),
  { message: "'anchorPoint' requires an 'anchor'" }
).refine(
  (data) => !(data.anchor == null && data.timeSource != null),
  { message: "'timeSource' requires an 'anchor'" }
).refine(
  (data) => !(data.anchor != null && data.timeSource == null),
  { message: "'timeSource' is required when 'anchor' is provided" }
).refine(
  (data) => {
    if (data.anchorPoint == null) return true;
    const isSource = data.timeSource === "source";
    if (isSource) return typeof data.anchorPoint === "number";
    return typeof data.anchorPoint === "string";
  },
  {
    message:
      "anchorPoint must be a number (seconds) when timeSource is 'source', or a percentage string (e.g. '50%') otherwise",
  }
);

const AnchorFieldsSchema = {
  id: z.string().min(1).optional(),
  start: TimeAnchorSchema.optional(),
  end: TimeAnchorSchema.optional(),
};

// Free-form per-node bag for editor / tooling concerns that travel with
// the document but don't affect rendering. Values are arbitrary JSON.
const MetadataFieldsSchema = {
  metadata: z.record(z.string(), z.unknown()).optional(),
};

// Per-edge inset (crop) of a composition's content box — composition-only, so
// the windowing render cost is something the author opts into by wrapping
// content in a composition. Uses the text-padding shorthand shape —
// `L` | `[v, h]` | `[t, r, b, l]` — but each edge is a `Length` (so `%`/px/
// combos work) rather than a plain number. `%` resolves against the content
// box's matching axis (left/right → width, top/bottom → height). Clips the
// content without rescaling and shrinks the comp's output extent to the
// visible window; `origin`/`translation`/`rotation` then place that window.
// Animatable. See the [Inset] section of FILE-FORMAT.md.
const InsetSchema = z.union([
  LengthSchema,
  z.tuple([LengthSchema, LengthSchema]),
  z.tuple([LengthSchema, LengthSchema, LengthSchema, LengthSchema]),
]);

const SpatialFieldsSchema = {
  objectFit: ObjectFitSchema.optional(),
  origin: keyframed(Point2DSchema).optional(),
  translation: keyframed(Point2DSchema).optional(),
  size: keyframed(Point2DSchema).optional(),
  rotation: keyframed(z.number()).optional(),
  // First-class opacity (ejected from filters); animatable like volume.
  // 0 = transparent, 1 = opaque. Absent = fully opaque.
  opacity: keyframed(z.number().min(0).max(1)).optional(),
};

/** Crossfade overlap (seconds) with the previous sequential sibling.
 *  Only meaningful for producing elements used as sequential `children`;
 *  ignored on the first child and on attachments. */
const TransitionFieldSchema = {
  transition: z.number().nonnegative().optional(),
};

export const OverflowSchema = z.enum([
  "trim-end",
  "trim-start",
  "trim-center",
  "stretch",
]);

export const UnderflowSchema = z.enum([
  "extend-end",
  "extend-start",
  "extend-center",
  "stretch",
]);

export const ClipSchema = z.object({
  type: z.literal("clip"),
  source: z.string().min(1),
  in: z.number().nonnegative(),
  out: z.number().positive(),
  speed: z.number().positive().optional(),
  duration: z.number().positive().optional(),
  volume: keyframed(z.number().nonnegative().max(4)).optional(),
  overflow: OverflowSchema.optional(),
  underflow: UnderflowSchema.optional(),
  filters: FiltersArraySchema,
  ...SpatialFieldsSchema,
  ...TransitionFieldSchema,
  ...AnchorFieldsSchema,
  ...MetadataFieldsSchema,
}).strict().refine(
  (data) => !(data.speed != null && data.duration != null),
  { message: "Cannot specify both 'speed' and 'duration' on a clip" }
);

export const StaticSchema = z.object({
  type: z.literal("static"),
  source: z.string().min(1),
  duration: z.number().positive(),
  /** For video sources: the source timestamp (seconds) to freeze on.
   *  Ignored for images (which have no timeline). Defaults to 0. */
  in: z.number().nonnegative().optional(),
  filters: FiltersArraySchema,
  ...SpatialFieldsSchema,
  ...TransitionFieldSchema,
  ...AnchorFieldsSchema,
  ...MetadataFieldsSchema,
}).strict();

export const EmptySchema = z.object({
  type: z.literal("empty"),
  duration: z.number().positive(),
  ...AnchorFieldsSchema,
  ...MetadataFieldsSchema,
}).strict();

export const AudioSchema = z.object({
  type: z.literal("audio"),
  source: z.string().min(1),
  in: z.number().nonnegative(),
  out: z.number().positive(),
  speed: z.number().positive().optional(),
  duration: z.number().positive().optional(),
  volume: keyframed(z.number().nonnegative().max(4)).optional(),
  overflow: OverflowSchema.optional(),
  underflow: UnderflowSchema.optional(),
  ...TransitionFieldSchema,
  ...AnchorFieldsSchema,
  ...MetadataFieldsSchema,
})
  // Strict: audio has no spatial fields and no `filters` (visual). Extra
  // keys are a schema error rather than being silently dropped, so users
  // get a clear signal when they put visual props on an audio node.
  .strict()
  .refine(
    (data) => !(data.speed != null && data.duration != null),
    { message: "Cannot specify both 'speed' and 'duration' on audio" }
  );

export const DataSchema = z.object({
  type: z.literal("data"),
  data: z.unknown(),
  duration: z.number().nonnegative().optional(),
  tags: z.array(z.string()).optional(),
  ...AnchorFieldsSchema,
  ...MetadataFieldsSchema,
}).strict();

// Padding can be a single number (all sides), `[v, h]`, or `[t, r, b, l]`.
const TextPaddingSchema = z.union([
  z.number().nonnegative(),
  z.tuple([z.number().nonnegative(), z.number().nonnegative()]),
  z.tuple([
    z.number().nonnegative(),
    z.number().nonnegative(),
    z.number().nonnegative(),
    z.number().nonnegative(),
  ]),
]);

// Common style fields shared between the top-level Text node and inline
// runs. Layout-level fields (textAlign, verticalAlign, lineHeight,
// contentWidth, contentHeight) live only on the top-level node.
const TextStyleFieldsSchema = {
  fontFamily: z.string().min(1).optional(),
  fontSize: keyframed(z.number().positive()).optional(),
  color: keyframed(z.string()).optional(),
  fontWeight: z.string().optional(),
  // CSS `font-style` ("italic" / "oblique" / "normal"). Plain string like
  // fontWeight — passed straight into the canvas font shorthand.
  fontStyle: z.string().optional(),
  // Single text-decoration line. Canvas has no native support, so the
  // layout/draw passes render the rule manually.
  textDecoration: z
    .enum(["none", "underline", "overline", "line-through"])
    .optional(),
  // Vertical glyph stretch as a percentage string ("100%" = natural
  // height). Not a CSS property — applied as a per-glyph vertical scale
  // about the baseline; horizontal advance (and thus line-breaking) is
  // unaffected. A string keeps the percentage unambiguous (no "1.5 vs 150").
  letterHeight: PercentStringSchema.optional(),
  backgroundColor: keyframed(z.string()).optional(),
  backgroundPadding: keyframed(TextPaddingSchema).optional(),
  strokeColor: keyframed(z.string()).optional(),
  strokeWidth: keyframed(z.number().nonnegative()).optional(),
};

const TextRunSchema = z.object({
  text: z.string(),
  ...TextStyleFieldsSchema,
}).strict();

export const TextSchema = z.object({
  type: z.literal("text"),
  text: z.union([z.string(), z.array(z.union([z.string(), TextRunSchema]))]),
  lineHeight: keyframed(z.number().nonnegative()).optional(),
  textAlign: z.enum(["left", "center", "right"]).optional(),
  verticalAlign: z.enum(["top", "center", "bottom"]).optional(),
  padding: TextPaddingSchema.optional(),
  contentWidth: LengthSchema.optional(),
  contentHeight: LengthSchema.optional(),
  duration: z.number().positive().optional(),
  filters: FiltersArraySchema,
  ...TextStyleFieldsSchema,
  ...SpatialFieldsSchema,
  ...TransitionFieldSchema,
  ...AnchorFieldsSchema,
  ...MetadataFieldsSchema,
}).strict().refine(
  (data) =>
    data.duration != null || (data.start != null && data.end != null),
  {
    message:
      "'duration' is required unless both 'start' and 'end' anchors are set",
  }
);

// ── Graphic (animated 2D layer) ────────────────────────────────────
//
// A graphic is a self-contained 2D animation: a list of keyframes, each
// holding a snapshot of fabric-style objects (Rect, Circle, Path, Polygon,
// Text, Image, Group, Clip-instance, Map). The renderer/preview run the
// pure interp engine in `animation/interp.ts` against these snapshots.
//
// Inner-object schemas are intentionally permissive (`passthrough`): fabric
// has a long tail of optional props (cornerStyle, strokeLineCap, ...) we
// don't want to enumerate, and the animation engine treats unknown props
// as discrete (no interpolation) by default. The well-known animation
// props are typed explicitly so authoring tools have something to validate.

// Animation direction for the `angle` property when revolutions != 0.
const AngleDirectionSchema = z.enum(["shortest", "cw", "ccw"]);

// Fields every inner object can carry. id is the stable cross-frame
// correspondence key; revolutions/angleDirection drive winding for `angle`;
// easing overrides the frame-level default for this object only (and, like
// the frame default, governs the tween *arriving at* this keyframe).
const GraphicObjectBaseSchema = {
  id: z.string().min(1).optional(),
  easing: EasingSchema.optional(),
  revolutions: z.number().optional(),
  angleDirection: AngleDirectionSchema.optional(),
};

// Common fabric transform props. Plain numbers — the seam Length system
// stops at the graphic boundary; inner objects are fabric's domain.
const FabricTransformSchema = {
  left: z.number().optional(),
  top: z.number().optional(),
  width: z.number().optional(),
  height: z.number().optional(),
  scaleX: z.number().optional(),
  scaleY: z.number().optional(),
  angle: z.number().optional(),
  opacity: z.number().min(0).max(1).optional(),
  flipX: z.boolean().optional(),
  flipY: z.boolean().optional(),
  originX: z.enum(["left", "center", "right"]).optional(),
  originY: z.enum(["top", "center", "bottom"]).optional(),
  fill: z.string().optional(),
  stroke: z.string().optional(),
  strokeWidth: z.number().nonnegative().optional(),
  visible: z.boolean().optional(),
};

const Point2DCoordSchema = z.object({ x: z.number(), y: z.number() }).strict();

export const RectSchema = z.object({
  type: z.literal("Rect"),
  ...GraphicObjectBaseSchema,
  ...FabricTransformSchema,
  rx: z.number().optional(),
  ry: z.number().optional(),
}).passthrough();

export const CircleSchema = z.object({
  type: z.literal("Circle"),
  ...GraphicObjectBaseSchema,
  ...FabricTransformSchema,
  radius: z.number().nonnegative().optional(),
}).passthrough();

export const PathSchema = z.object({
  type: z.literal("Path"),
  ...GraphicObjectBaseSchema,
  ...FabricTransformSchema,
  // SVG path string or fabric's parsed-array form. Animation engine matches
  // structures between frames and falls back to discrete on mismatch.
  path: z.union([z.string(), z.array(z.array(z.union([z.string(), z.number()])))]).optional(),
}).passthrough();

export const PolygonSchema = z.object({
  type: z.literal("Polygon"),
  ...GraphicObjectBaseSchema,
  ...FabricTransformSchema,
  points: z.array(Point2DCoordSchema).optional(),
}).passthrough();

export const GraphicTextSchema = z.object({
  type: z.literal("Textbox"),
  ...GraphicObjectBaseSchema,
  ...FabricTransformSchema,
  text: z.string().optional(),
  fontFamily: z.string().optional(),
  fontSize: z.number().positive().optional(),
  fontWeight: z.union([z.string(), z.number()]).optional(),
  fontStyle: z.string().optional(),
  textAlign: z.enum(["left", "center", "right", "justify"]).optional(),
  lineHeight: z.number().positive().optional(),
}).passthrough();

export const GraphicImageSchema = z.object({
  type: z.literal("Image"),
  ...GraphicObjectBaseSchema,
  ...FabricTransformSchema,
  // Logical id resolved by the host (cache lookup); same convention as
  // existing `source` fields elsewhere in the schema.
  src: z.string().min(1).optional(),
}).passthrough();

// Inner clip-instance: references a ClipDef on the parent Graphic by id.
// Has its own sub-timeline (startPosition + repeat) per the spec we
// designed in the motion editor.
export const GraphicClipInstanceSchema = z.object({
  type: z.literal("Clip"),
  ...GraphicObjectBaseSchema,
  ...FabricTransformSchema,
  clipId: z.string().min(1),
  startPosition: z.number().optional(),
  // -1 = infinite; otherwise count of additional plays after the first.
  repeat: z.number().int().optional(),
}).passthrough();

// Geo polyline rendered on a Map. progress fades the gradient; lineWidth
// stays in display pixels (no Length: maplibre interprets in px directly).
export const MapPathSchema = z.object({
  color: z.string(),
  points: z.array(z.tuple([z.number(), z.number()])).min(2),
  progress: z.number().min(0).max(1).optional(),
  lineWidth: z.number().positive().optional(),
  easing: EasingSchema.optional(),
}).strict();

export const MapElementSchema = z.object({
  type: z.literal("Map"),
  ...GraphicObjectBaseSchema,
  ...FabricTransformSchema,
  // pmtiles file path — host-resolved (file:// for renderer/electron,
  // OPFS for web).
  source: z.string().min(1),
  latitude: z.number().min(-90).max(90).optional(),
  longitude: z.number().min(-180).max(180).optional(),
  zoom: z.number().nonnegative().optional(),
  paths: z.array(MapPathSchema).optional(),
}).passthrough();

// Recursive group of graphic objects. fabric semantics: child coordinates
// are group-local (relative to group center).
export const GraphicGroupSchema: z.ZodType<any> = z.lazy(() =>
  z.object({
    type: z.literal("Group"),
    ...GraphicObjectBaseSchema,
    ...FabricTransformSchema,
    objects: z.array(GraphicObjectSchema).optional(),
  }).passthrough()
);

// Recursive due to Group containing more GraphicObjects, so this is a
// union rather than a discriminated union (Zod's discriminated form
// doesn't accept lazy-resolved options).
export const GraphicObjectSchema: z.ZodType<any> = z.lazy(() =>
  z.union([
    RectSchema,
    CircleSchema,
    PathSchema,
    PolygonSchema,
    GraphicTextSchema,
    GraphicImageSchema,
    GraphicClipInstanceSchema,
    MapElementSchema,
    GraphicGroupSchema,
  ])
);

// A keyframe: [stamp, objects, easing?]. Stamp is a Length so authors can
// write "50%" of the graphic's duration. Easing is the default for the tween
// *arriving at* this keyframe (matching core's keyframe sampler + every other
// animated value); per-object `easing` overrides it.
export const GraphicFrameSchema = z.union([
  z.tuple([LengthSchema, z.array(GraphicObjectSchema)]),
  z.tuple([LengthSchema, z.array(GraphicObjectSchema), EasingSchema]),
]);

// A reusable clip definition the parent Graphic exposes by id, referenced
// from a {type:"Clip", clipId} instance in any keyframe.
export const GraphicClipDefSchema = z.object({
  id: z.string().min(1),
  type: z.literal("graphic"),
  duration: LengthSchema.optional(),
  loop: z.boolean().optional(),
  contentWidth: LengthSchema.optional(),
  contentHeight: LengthSchema.optional(),
  frames: z.array(GraphicFrameSchema).min(1),
}).strict();

export const GraphicSchema = z.object({
  type: z.literal("graphic"),
  duration: LengthSchema.optional(),
  loop: z.boolean().optional(),
  contentWidth: LengthSchema.optional(),
  contentHeight: LengthSchema.optional(),
  clips: z.array(GraphicClipDefSchema).optional(),
  frames: z.array(GraphicFrameSchema).min(1),
  in: z.number().nonnegative().optional(),
  out: z.number().positive().optional(),
  overflow: OverflowSchema.optional(),
  underflow: UnderflowSchema.optional(),
  filters: FiltersArraySchema,
  ...SpatialFieldsSchema,
  ...TransitionFieldSchema,
  ...AnchorFieldsSchema,
  ...MetadataFieldsSchema,
}).strict();

const ChildSchema: z.ZodType<any> = z.lazy(() =>
  z.union([
    ClipSchema,
    AudioSchema,
    StaticSchema,
    EmptySchema,
    DataSchema,
    TextSchema,
    GraphicSchema,
    CompositionSchema,
  ])
);

/** A reusable composition body, addressed by `id` and referenced from
 *  any descendant composition via `binItem: "<id>"`. Bin entries don't
 *  carry instance-level fields (spatial / timing / filters / metadata);
 *  those live on each reference, so swapping a bin entry can't reach
 *  out and overwrite a reference's authored properties. */
export const BinEntrySchema: z.ZodType<any> = z.lazy(() =>
  z.object({
    id: z.string().min(1),
    children: z.array(ChildSchema).optional().default([]),
    attachments: z.array(ChildSchema).optional(),
  }).strict()
);

export const CompositionSchema: z.ZodType<any> = z.lazy(() =>
  z.object({
    type: z.literal("composition"),
    children: z.array(ChildSchema).optional().default([]),
    attachments: z.array(ChildSchema).optional(),
    /** Bin entries scoped to this composition's subtree. A descendant
     *  composition with `binItem: "<id>"` resolves to the nearest
     *  enclosing bin entry with that id (this composition's own
     *  entries win over any inherited from ancestors). */
    bin: z.array(BinEntrySchema).optional(),
    /** Names a bin entry whose body this composition adopts at compile
     *  time. The reference's own `children`/`attachments` are ignored
     *  in favour of the bin entry's. */
    binItem: z.string().min(1).optional(),
    /** JavaScript source — body of an anonymous function that takes
     *  `currentNode` (this composition, with bins already resolved) and
     *  must `return` a composition. Runs at compile time; the output
     *  replaces this composition in the rendered tree. */
    script: z.string().optional(),
    /** Lexically-scoped string-substitution macros. Anywhere a `"$$NAME"`
     *  string appears in this composition's subtree, the expander
     *  substitutes the value here (or in an enclosing composition's
     *  `macros`, nearest-enclosing wins). Values can be any JSON.
     *  Expansion runs as the first step of `compileSeamFile`, BEFORE
     *  bin / script resolution. The field is stripped from the
     *  compiled output. */
    macros: z.record(z.unknown()).optional(),
    in: z.number().nonnegative().optional(),
    out: z.number().positive().optional(),
    /** Playback rate of the inner window; mirrors clip `speed`. */
    speed: z.number().positive().optional(),
    /** Explicit output duration of the inner window; mirrors clip
     *  `duration`. Mutually exclusive with `speed`. */
    duration: z.number().positive().optional(),
    overflow: OverflowSchema.optional(),
    underflow: UnderflowSchema.optional(),
    filters: FiltersArraySchema,
    /** Any valid SVG/CSS fill value (e.g. "#000", "rgba(...)", "red").
     *  Painted across the composition's container rect under the children. */
    backgroundColor: z.string().optional(),
    contentWidth: LengthSchema.optional(),
    contentHeight: LengthSchema.optional(),
    // Per-edge inset / crop — composition-only. See InsetSchema above.
    inset: keyframed(InsetSchema).optional(),
    // How the inset window maps within the content box's placement.
    insetMode: z.enum(["window", "center", "fit", "cover"]).optional(),
    ...SpatialFieldsSchema,
    ...TransitionFieldSchema,
    ...AnchorFieldsSchema,
    ...MetadataFieldsSchema,
  }).strict().refine(
    (data) => !(data.speed != null && data.duration != null),
    { message: "Cannot specify both 'speed' and 'duration' on a composition" }
  )
);

export const SeamFileSchema = CompositionSchema;

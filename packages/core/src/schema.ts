import { z } from "zod";

export const PositionSchema = z.enum(["absolute", "relative"]);
export const ObjectFitSchema = z.enum(["center", "fit", "cover"]);

// ── Filters ────────────────────────────────────────────────────────

export const AdjustFilterSchema = z.object({
  type: z.literal("adjust"),
  brightness: z.number().min(-1).max(1).default(0),
  contrast: z.number().min(-1000).max(1000).default(1),
  saturation: z.number().min(0).max(3).default(1),
  gamma: z.number().min(0.1).max(10).default(1),
});

export const OpacityFilterSchema = z.object({
  type: z.literal("opacity"),
  value: z.number().min(0).max(1),
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
  OpacityFilterSchema,
  ColorBalanceFilterSchema,
  ColorTemperatureFilterSchema,
]);

export const FiltersArraySchema = z.array(FilterSchema).optional();
export const DimensionStringSchema = z.string().regex(
  /^-?\d+(?:\.\d+)?(?:px|%)?$/,
  "Must be a CSS dimension string (e.g. '10px', '50%', '100')"
);

const PercentStringSchema = z.string().regex(
  /^-?\d+(?:\.\d+)?%$/,
  "Must be a percentage string (e.g. '50%', '-25%')"
);

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

const SpatialFieldsSchema = {
  position: PositionSchema.optional(),
  objectFit: ObjectFitSchema.optional(),
  top: DimensionStringSchema.optional(),
  left: DimensionStringSchema.optional(),
  right: DimensionStringSchema.optional(),
  bottom: DimensionStringSchema.optional(),
  width: DimensionStringSchema.optional(),
  height: DimensionStringSchema.optional(),
};

export const JustifySchema = z.enum([
  "start",
  "end",
  "center",
  "space-between",
]);

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

export const LayoutSchema = z.object({
  justify: JustifySchema.default("start"),
  gap: z.number().nonnegative().default(0),
});

export const ClipSchema = z.object({
  type: z.literal("clip"),
  source: z.string().min(1),
  in: z.number().nonnegative(),
  out: z.number().positive(),
  speed: z.number().positive().optional(),
  duration: z.number().positive().optional(),
  flex: z.number().positive().optional(),
  overflow: OverflowSchema.optional(),
  underflow: UnderflowSchema.optional(),
  filters: FiltersArraySchema,
  ...SpatialFieldsSchema,
  ...AnchorFieldsSchema,
}).refine(
  (data) => !(data.speed != null && data.duration != null),
  { message: "Cannot specify both 'speed' and 'duration' on a clip" }
);

export const EmptySchema = z.object({
  type: z.literal("empty"),
  duration: z.number().positive(),
  flex: z.number().positive().optional(),
  ...AnchorFieldsSchema,
});

export const RefChildSchema = z.object({
  type: z.literal("ref"),
  source: z.string().min(1),
  in: z.number().nonnegative().optional(),
  out: z.number().positive().optional(),
  flex: z.number().positive().optional(),
  overflow: OverflowSchema.optional(),
  underflow: UnderflowSchema.optional(),
  filters: FiltersArraySchema,
  ...SpatialFieldsSchema,
  ...AnchorFieldsSchema,
});

const ChildSchema: z.ZodType<any> = z.lazy(() =>
  z.union([
    ClipSchema,
    EmptySchema,
    CompositionSchema,
    RefChildSchema,
  ])
);

export const CompositionSchema: z.ZodType<any> = z.lazy(() =>
  z.object({
    type: z.literal("composition"),
    children: z.array(ChildSchema).min(1),
    attachments: z.array(ChildSchema).optional(),
    refs: z.record(z.string(), ChildSchema).optional(),
    duration: z.number().positive().optional(),
    unitDuration: z.number().positive().optional(),
    layout: LayoutSchema.optional(),
    in: z.number().nonnegative().optional(),
    out: z.number().positive().optional(),
    flex: z.number().positive().optional(),
    overflow: OverflowSchema.optional(),
    underflow: UnderflowSchema.optional(),
    filters: FiltersArraySchema,
    contentWidth: z.number().positive().optional(),
    contentHeight: z.number().positive().optional(),
    ...SpatialFieldsSchema,
    ...AnchorFieldsSchema,
  }).refine(
    (data) => !(data.duration != null && data.unitDuration != null),
    { message: "Cannot specify both 'duration' and 'unitDuration'" }
  )
);

export const SeamFileSchema = CompositionSchema;

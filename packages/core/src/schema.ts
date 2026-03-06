import { z } from "zod";

export const PositionSchema = z.enum(["absolute", "relative"]);
export const ObjectFitSchema = z.enum(["center", "fit", "cover"]);
export const DimensionStringSchema = z.string().regex(
  /^-?\d+(?:\.\d+)?(?:px|%)?$/,
  "Must be a CSS dimension string (e.g. '10px', '50%', '100')"
);

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
  ...SpatialFieldsSchema,
}).refine(
  (data) => !(data.speed != null && data.duration != null),
  { message: "Cannot specify both 'speed' and 'duration' on a clip" }
);

export const EmptySchema = z.object({
  type: z.literal("empty"),
  duration: z.number().positive(),
  flex: z.number().positive().optional(),
});

export const AlignItemsSchema = z.enum(["start", "end", "center"]);

export const OverlaySchema: z.ZodType<any> = z.lazy(() =>
  z.object({
    type: z.literal("overlay"),
    children: z.array(ChildSchema).min(1),
    duration: z.number().positive().optional(),
    alignItems: AlignItemsSchema.default("start"),
    in: z.number().nonnegative().optional(),
    out: z.number().positive().optional(),
    flex: z.number().positive().optional(),
    overflow: OverflowSchema.optional(),
    underflow: UnderflowSchema.optional(),
    contentWidth: z.number().positive().optional(),
    contentHeight: z.number().positive().optional(),
    ...SpatialFieldsSchema,
  })
);

const ChildSchema: z.ZodType<any> = z.lazy(() =>
  z.union([ClipSchema, EmptySchema, CompositionSchema, OverlaySchema])
);

export const CompositionSchema: z.ZodType<any> = z.lazy(() =>
  z.object({
    type: z.literal("composition"),
    children: z.array(ChildSchema).min(1),
    duration: z.number().positive().optional(),
    unitDuration: z.number().positive().optional(),
    layout: LayoutSchema.optional(),
    in: z.number().nonnegative().optional(),
    out: z.number().positive().optional(),
    flex: z.number().positive().optional(),
    overflow: OverflowSchema.optional(),
    underflow: UnderflowSchema.optional(),
    contentWidth: z.number().positive().optional(),
    contentHeight: z.number().positive().optional(),
    ...SpatialFieldsSchema,
  }).refine(
    (data) => !(data.duration != null && data.unitDuration != null),
    { message: "Cannot specify both 'duration' and 'unitDuration'" }
  )
);

export const SeamFileSchema = CompositionSchema;

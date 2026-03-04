import { z } from "zod";

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
  duration: z.number().positive().optional(),
  justify: JustifySchema.default("start"),
  gap: z.number().nonnegative().default(0),
});

export const ClipSchema = z.object({
  type: z.literal("clip"),
  source: z.string().min(1),
  in: z.number().nonnegative(),
  out: z.number().positive(),
  flex: z.number().positive().optional(),
  overflow: OverflowSchema.default("trim-end"),
  underflow: UnderflowSchema.optional(),
});

export const EmptySchema = z.object({
  type: z.literal("empty"),
  duration: z.number().positive(),
  flex: z.number().positive().optional(),
});

const ChildSchema: z.ZodType<any> = z.lazy(() =>
  z.union([ClipSchema, EmptySchema, CompositionSchema])
);

export const CompositionSchema: z.ZodType<any> = z.lazy(() =>
  z.object({
    type: z.literal("composition"),
    children: z.array(ChildSchema).min(1),
    layout: LayoutSchema.optional(),
    in: z.number().nonnegative().optional(),
    out: z.number().positive().optional(),
    flex: z.number().positive().optional(),
    overflow: OverflowSchema.default("trim-end"),
    underflow: UnderflowSchema.optional(),
  })
);

export const SeamFileSchema = CompositionSchema;

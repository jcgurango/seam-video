import { z } from "zod";
import type { FieldSpec, Registry, RegisteredNodeType, SchemaHelpers } from "./registry.js";

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

/** A volume value: either a linear gain multiplier (0..4, 1 = unity) or a
 *  decibel string like `"25dB"` / `"-25.5dB"` (case-insensitive, optional
 *  sign). dB is converted to linear gain at sample time and is **not** capped
 *  — `"25dB"` ≈ 17.8× — so authors can boost past the linear cap when they
 *  reach for dB explicitly. */
const VolumeValueSchema = z.union([
  z.number().nonnegative().max(4),
  z.string().regex(/^[+-]?\d+(?:\.\d+)?\s*dB$/i, {
    message: 'Volume string must be a decibel value like "25dB" or "-25.5dB".',
  }),
]);

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

// ── Timing: `id`, `start`, `offset` ────────────────────────────────
//
// Every node in a `children` array is placed at
//   (start ?? end of the previous node, 0 for the first) + offset
// so a node WITHOUT `start` continues the previous node's *run*, and a node
// WITH `start` heads a new one. See `layout/anchor.ts` for the grammar.

/** Node id, referenced by sibling `start` anchors. Must not contain `@` (the
 *  anchor-point separator) and must not read as a number (a numeric `start`
 *  is an absolute position). */
export const NodeIdSchema = z.string().min(1).refine(
  (s) => !s.includes("@") && !NUMERIC_RE.test(s.trim()) && s.trim() === s,
  { message: "An id cannot contain '@', be a number, or have surrounding whitespace" },
);

const NUMERIC_RE = /^-?\d+(?:\.\d+)?$/;

/** `start`: a bare number (absolute seconds in the container), or an anchor
 *  string — `"id"` (start of `id`), `"id@50%"` (that fraction of `id`'s output
 *  span), `"id@10"` (source-time second 10 of `id`). */
export const StartSchema = z.union([
  z.number(),
  z.string().regex(
    /^[^@\s](?:[^@]*[^@\s])?(?:@-?\d+(?:\.\d+)?%?)?$/,
    "Must be a number, 'id', 'id@<n>%' or 'id@<seconds>'",
  ).refine((s) => !NUMERIC_RE.test(s.trim()), {
    message: "A numeric start must be a number, not a string",
  }),
]);

const AnchorFieldsSchema = {
  id: NodeIdSchema.optional(),
  start: StartSchema.optional(),
  /** Seconds added to the node's position. On a run member (no `start`) it
   *  is the gap after the previous node; negative overlaps it and
   *  cross-fades. On a run head it shifts off the anchor (no fade). */
  offset: z.number().optional(),
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

// Corner-pin distortion — composition-only. Eight optional `Length`s, one
// per corner coordinate, clockwise from the top-left (`x0,y0` → `x3,y3`).
// `%` resolves against the content canvas (`x*` → contentWidth, `y*` →
// contentHeight); a bare number offsets the corner from its natural spot.
// Animatable as one value (not per coordinate). Does not move the layout
// box — a purely visual projective warp of the composited content.
const DistortSchema = z.object({
  x0: LengthSchema.optional(),
  y0: LengthSchema.optional(),
  x1: LengthSchema.optional(),
  y1: LengthSchema.optional(),
  x2: LengthSchema.optional(),
  y2: LengthSchema.optional(),
  x3: LengthSchema.optional(),
  y3: LengthSchema.optional(),
}).strict();

const SpatialFieldsSchema = {
  objectFit: ObjectFitSchema.optional(),
  fitSelf: ObjectFitSchema.optional(),
  origin: keyframed(Point2DSchema).optional(),
  translation: keyframed(Point2DSchema).optional(),
  size: keyframed(Point2DSchema).optional(),
  rotation: keyframed(z.number()).optional(),
  // First-class opacity; animatable like volume.
  // 0 = transparent, 1 = opaque. Absent = fully opaque.
  opacity: keyframed(z.number().min(0).max(1)).optional(),
  // Rounded-corner mask applied to the node's final rect (any node — a clip,
  // image, text, composition or shape). A bare number is pixels; a `%`
  // resolves against the SHORTER side of the rect, so `"50%"` turns a square
  // into a circle and a rectangle into a pill. Animatable.
  cornerRadius: keyframed(LengthSchema).optional(),
};

/** Pre-transform source orientation (clockwise degrees). Bakes into the
 *  decoded pixels before the spatial transform — to the compositor the clip
 *  looks as if it had arrived already rotated by this amount. Composes with
 *  any rotation the container metadata declares. Not animatable. */
export const OrientationSchema = z.union([
  z.literal(0),
  z.literal(90),
  z.literal(180),
  z.literal(270),
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
  "loop",
]);

/** `duration` on clip/audio: any non-zero number (negative = reverse). */
const nonZero = z.number().refine((n) => n !== 0, { message: "Must be non-zero" });
/** A clip/audio's `[in, out]` must have length (either direction). */
const spanNonEmpty = (data: { in: number; out?: number }) =>
  data.out == null || data.out !== data.in;

const SCHEMA_HELPERS: SchemaHelpers = { keyframed, length: LengthSchema };

/** Zod schema for one contributed field, built from its declaration. */
function fieldSchema(spec: FieldSpec): z.ZodTypeAny {
  let value: z.ZodTypeAny;
  switch (spec.type) {
    case "number": {
      let num = z.number();
      if (spec.min != null) num = spec.exclusiveMin ? num.gt(spec.min) : num.min(spec.min);
      if (spec.max != null) num = num.max(spec.max);
      value = num;
      break;
    }
    case "string":
      value = spec.pattern != null ? z.string().regex(new RegExp(spec.pattern)) : z.string().min(1);
      break;
    case "enum":
      value = z.enum(spec.options as [string, ...string[]]);
      break;
    case "color":
      value = z.string();
      break;
    case "boolean":
      value = z.boolean();
      break;
    case "length":
      value = LengthSchema;
      break;
    case "custom":
      // The extension wraps keyframes itself (its value may not be tweenable
      // the default way).
      return optionalUnless(spec.required, spec.schema(z, SCHEMA_HELPERS));
  }
  return optionalUnless(spec.required, spec.animatable ? keyframed(value) : value);
}

function optionalUnless(required: boolean | undefined, schema: z.ZodTypeAny): z.ZodTypeAny {
  return required ? schema : schema.optional();
}

/**
 * Build the document schema for one extension set. Core's node schemas are
 * `.strict()`, so a field no installed extension contributes is a validation
 * error — a document can't silently lose a render-affecting property.
 *
 * Extension fields are spliced into every visual node's shape by `visual()`,
 * which refuses a key core already defines (a registration-time error, thrown
 * when the instance is created).
 */
export function buildSeamFileSchema(registry: Registry): z.ZodType<any> {
  const visualExt: Record<string, z.ZodTypeAny> = {};
  // Fields for every visual node, and fields for compositions only.
  const compositionExt: Record<string, z.ZodTypeAny> = {};
  for (const f of registry.fields) {
    (f.nodes === "composition" ? compositionExt : visualExt)[f.key] = fieldSchema(f);
  }
  const nodeSchemaByType = new Map<string, z.ZodTypeAny>();
  /** Splice the composition-only extension fields into the composition's
   *  shape, refusing a key it already has. */
  const withCompositionFields = <S extends z.ZodRawShape>(shape: S): S => {
    for (const key of Object.keys(compositionExt)) {
      if (key in shape || key in visualExt) {
        const owner = registry.fields.find((f) => f.key === key)!.extension;
        throw new Error(
          `Extension "${owner}": field "${key}" collides with a field of "composition"`,
        );
      }
    }
    return { ...shape, ...compositionExt } as S;
  };
  const visual = <S extends z.ZodRawShape>(type: string, shape: S): S => {
    for (const key of Object.keys(visualExt)) {
      if (key in shape) {
        const owner = registry.fields.find((f) => f.key === key)!.extension;
        throw new Error(
          `Extension "${owner}": field "${key}" collides with a core field of "${type}"`,
        );
      }
    }
    return { ...shape, ...visualExt } as S;
  };

  const ClipSchema = z.object(visual("clip", {
    type: z.literal("clip"),
    source: z.string().min(1),
    /** May be negative, mirroring how `out` may exceed the file's end: the
     *  span `[in, out]` defines the clip's duration, not what the file can
     *  supply. A distilled doc uses this to keep timeline layout stable when
     *  a source is trimmed — content before the new file start is simply
     *  never sampled (it was invisible behind a composition window). */
    in: z.number(),
    /** Optional when `duration` is given: `out` then defaults to
     *  `in + duration` (speed 1). `out < in` plays the span in reverse. */
    out: z.number().optional(),
    speed: z.number().positive().optional(),
    /** Output length; negative = reverse playback (length is `|duration|`). */
    duration: nonZero.optional(),
    orientation: OrientationSchema.optional(),
    volume: keyframed(VolumeValueSchema).optional(),
    /** Length-preserving audio pitch shift in semitones (fractional ok,
     *  ± = up/down). Independent of `speed` (which shifts pitch naturally);
     *  adds with enclosing compositions' `pitch`. Not animatable. */
    pitch: z.number().gte(-48).lte(48).optional(),
    overflow: OverflowSchema.optional(),
    underflow: UnderflowSchema.optional(),
    ...SpatialFieldsSchema,
    ...AnchorFieldsSchema,
    ...MetadataFieldsSchema,
  })).strict().refine(
    (data) =>
      !(data.speed != null && data.duration != null) ||
      (data.overflow != null && data.overflow !== "stretch") ||
      (data.underflow != null && data.underflow !== "stretch"),
    { message: "'speed' and 'duration' together need a non-stretch 'overflow'/'underflow' (stretch derives the speed from 'duration')" }
  ).refine(
    (data) => data.out != null || data.duration != null,
    { message: "A clip needs 'out' or 'duration' (out defaults to in + duration)" }
  ).refine(spanNonEmpty, { message: "A clip's 'out' must differ from 'in'", path: ["out"] });

  const StaticSchema = z.object(visual("static", {
    type: z.literal("static"),
    source: z.string().min(1),
    duration: z.number().positive(),
    /** For video sources: the source timestamp (seconds) to freeze on.
     *  Ignored for images (which have no timeline). Defaults to 0. */
    in: z.number().nonnegative().optional(),
    ...SpatialFieldsSchema,
    ...AnchorFieldsSchema,
    ...MetadataFieldsSchema,
  })).strict();

  const AudioSchema = z.object({
    type: z.literal("audio"),
    source: z.string().min(1),
    in: z.number().nonnegative(),
    /** Optional when `duration` is given — see clip `out` (`out < in` =
     *  reverse). */
    out: z.number().nonnegative().optional(),
    speed: z.number().positive().optional(),
    /** Negative = reverse — see clip `duration`. */
    duration: nonZero.optional(),
    volume: keyframed(VolumeValueSchema).optional(),
    /** Length-preserving pitch shift in semitones — see clip `pitch`. */
    pitch: z.number().gte(-48).lte(48).optional(),
    overflow: OverflowSchema.optional(),
    underflow: UnderflowSchema.optional(),
    ...AnchorFieldsSchema,
    ...MetadataFieldsSchema,
  })
    // Strict: audio has no spatial fields and no visual extension fields. Extra
    // keys are a schema error rather than being silently dropped, so users
    // get a clear signal when they put visual props on an audio node.
    .strict()
    .refine(
      (data) =>
      !(data.speed != null && data.duration != null) ||
      (data.overflow != null && data.overflow !== "stretch") ||
      (data.underflow != null && data.underflow !== "stretch"),
    { message: "'speed' and 'duration' together need a non-stretch 'overflow'/'underflow' (stretch derives the speed from 'duration')" }
    )
    .refine(
      (data) => data.out != null || data.duration != null,
      { message: "Audio needs 'out' or 'duration' (out defaults to in + duration)" }
    )
    .refine(spanNonEmpty, { message: "Audio 'out' must differ from 'in'", path: ["out"] })
    .refine(
      (data) => data.out != null || data.duration == null || data.in + data.duration >= 0,
      { message: "Audio 'in + duration' must not be negative" }
    );

  const DataSchema = z.object({
    type: z.literal("data"),
    data: z.unknown(),
    duration: z.number().nonnegative().optional(),
    tags: z.array(z.string()).optional(),
    ...AnchorFieldsSchema,
    ...MetadataFieldsSchema,
  }).strict();

  // ── Shapes ─────────────────────────────────────────────────────────
  //
  // `rect` and `circle` are first-class nodes placed by the ordinary spatial
  // model (`origin` / `translation` / `size` / `rotation` …). They have no
  // intrinsic media size: their natural box is the parent, so `size` is the
  // shape's pixel size (a bare number = literal px, `%` = of the parent). Fill
  // and stroke are animatable colours; the stroke is drawn INSIDE the box
  // (border-box), so `size` is always the outer extent. A `rect`'s corners round
  // via the universal `cornerRadius`; a `circle` is the ellipse inscribed in its
  // box (equal `size` → a circle).

  const ShapeFieldsSchema = {
    // Any CSS colour. Default "black". "none" / "transparent" skips the fill.
    fill: keyframed(z.string()).optional(),
    // Stroke colour; drawn only when `strokeWidth` > 0.
    stroke: keyframed(z.string()).optional(),
    // Stroke width in pixels, inside the box.
    strokeWidth: keyframed(z.number().nonnegative()).optional(),
  };

  const RectSchema = z.object(visual("rect", {
    type: z.literal("rect"),
    duration: z.number().positive(),
    ...ShapeFieldsSchema,
    ...SpatialFieldsSchema,
    ...AnchorFieldsSchema,
    ...MetadataFieldsSchema,
  })).strict();

  const CircleSchema = z.object(visual("circle", {
    type: z.literal("circle"),
    duration: z.number().positive(),
    ...ShapeFieldsSchema,
    ...SpatialFieldsSchema,
    ...AnchorFieldsSchema,
    ...MetadataFieldsSchema,
  })).strict();

  // ── Extension node types ──
  //
  // Every contributed node type gets the same frame from core — `duration`,
  // an inner canvas, the spatial / placement / metadata fields, `children`
  // when it is a container — around its own declared fields.
  const extensionNode = (def: RegisteredNodeType): z.ZodTypeAny => {
    const isVisual = def.visual !== false;
    const own: Record<string, z.ZodTypeAny> = {};
    for (const f of def.fields ?? []) own[f.key] = fieldSchema(f);
    const frameKeys = new Set([
      "type",
      "duration",
      "children",
      ...Object.keys(AnchorFieldsSchema),
      ...Object.keys(MetadataFieldsSchema),
      ...(isVisual
        ? [
            "contentWidth",
            "contentHeight",
            ...Object.keys(SpatialFieldsSchema),
            ...Object.keys(visualExt),
          ]
        : []),
    ]);
    // Checked now (not inside the lazy schema) so a bad definition fails at
    // `createSeam`.
    for (const key of Object.keys(own)) {
      if (frameKeys.has(key)) {
        throw new Error(
          `Extension "${def.extension}": "${def.type}.${key}" collides with a field every node already has`,
        );
      }
    }
    const spanFromChildren = def.span === "children";
    return z.lazy(() => {
      // A container takes any node, or only the types it names.
      const childSchema: z.ZodTypeAny = Array.isArray(def.children)
        ? unionOf(def.children.map((t) => nodeSchemaByType.get(t)!))
        : ChildSchema;
      const duration = z.number().positive();
      const node = z.object({
        type: z.literal(def.type),
        duration: spanFromChildren ? duration.optional() : duration,
        ...(def.children ? { children: z.array(childSchema).optional() } : {}),
        ...AnchorFieldsSchema,
        ...MetadataFieldsSchema,
        ...(isVisual
          ? {
              contentWidth: keyframed(LengthSchema).optional(),
              contentHeight: keyframed(LengthSchema).optional(),
              ...SpatialFieldsSchema,
              ...visualExt,
            }
          : {}),
        ...own,
      }).strict();
      // Its length comes from `duration` or, failing that, from its children.
      const spanned = spanFromChildren
        ? node.refine(
            (n) => n.duration != null || (Array.isArray(n.children) && n.children.length > 0),
            { message: `A ${def.type} needs 'duration' or children` },
          )
        : node;
      // The type's own cross-field check.
      const check = def.validate;
      return check
        ? spanned.superRefine((n, ctx) => {
            const message = check(n as Record<string, unknown>);
            if (message) ctx.addIssue({ code: z.ZodIssueCode.custom, message });
          })
        : spanned;
    });
  };
  const unionOf = (schemas: z.ZodTypeAny[]): z.ZodTypeAny =>
    schemas.length === 1
      ? schemas[0]
      : z.union(schemas as unknown as [z.ZodTypeAny, z.ZodTypeAny, ...z.ZodTypeAny[]]);
  const extensionNodeEntries = [...registry.nodeTypes.values()].map(
    (def) => [def.type, extensionNode(def)] as const,
  );
  const extensionNodeSchemas = extensionNodeEntries.map(([, schema]) => schema);

  const ChildSchema: z.ZodType<any> = z.lazy(() =>
    z.union([
      ClipSchema,
      AudioSchema,
      StaticSchema,
      DataSchema,
      RectSchema,
      CircleSchema,
      CompositionSchema,
      ...extensionNodeSchemas,
    ] as unknown as [z.ZodTypeAny, z.ZodTypeAny, ...z.ZodTypeAny[]])
  );

  /** A reusable composition body, addressed by `id` and referenced from
   *  any descendant composition via `binItem: "<id>"`. Bin entries don't
   *  carry instance-level fields (spatial / timing / extension fields / metadata);
   *  those live on each reference, so swapping a bin entry can't reach
   *  out and overwrite a reference's authored properties. */
  const BinEntrySchema: z.ZodType<any> = z.lazy(() =>
    z.object({
      id: z.string().min(1),
      children: z.array(ChildSchema).optional().default([]),
    }).strict()
  );

  const CompositionSchema: z.ZodType<any> = z.lazy(() =>
    z.object(visual("composition", withCompositionFields({
      type: z.literal("composition"),
      children: z.array(ChildSchema).optional(),
      /** Bin entries scoped to this composition's subtree. A descendant
       *  composition with `binItem: "<id>"` resolves to the nearest
       *  enclosing bin entry with that id (this composition's own
       *  entries win over any inherited from ancestors). */
      bin: z.array(BinEntrySchema).optional(),
      /** Names a bin entry whose body this composition adopts at compile
       *  time. A reference carries no `children` of its own. */
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
      /** Output duration; `overflow`/`underflow` say how the inner window
       *  fills it (default stretch = derived rate). Mirrors clip `duration`. */
      duration: z.number().positive().optional(),
      overflow: OverflowSchema.optional(),
      underflow: UnderflowSchema.optional(),
      /** Any valid SVG/CSS fill value (e.g. "#000", "rgba(...)", "red").
       *  Painted across the composition's container rect under the children. */
      backgroundColor: z.string().optional(),
      /** Uniform volume multiplier (0..4) applied to every audio-bearing
       *  descendant (clips / audio / nested compositions). Animatable, sampled
       *  in the composition's output time. Mirrors clip `volume`. */
      volume: keyframed(VolumeValueSchema).optional(),
      /** Length-preserving pitch shift in semitones applied to every
       *  audio-bearing descendant; adds through nesting and with each clip's
       *  own `pitch`. Not animatable. */
      pitch: z.number().gte(-48).lte(48).optional(),
      contentWidth: keyframed(LengthSchema).optional(),
      contentHeight: keyframed(LengthSchema).optional(),
      // Per-edge inset / crop — composition-only. See InsetSchema above.
      inset: keyframed(InsetSchema).optional(),
      // How the inset window maps within the content box's placement.
      insetMode: z.enum(["window", "center", "fit", "cover"]).optional(),
      // Corner-pin (perspective) distortion — composition-only. See DistortSchema.
      distort: keyframed(DistortSchema).optional(),
      ...SpatialFieldsSchema,
        ...AnchorFieldsSchema,
      ...MetadataFieldsSchema,
    }))).strict().refine(
      (data) =>
      !(data.speed != null && data.duration != null) ||
      (data.overflow != null && data.overflow !== "stretch") ||
      (data.underflow != null && data.underflow !== "stretch"),
    { message: "'speed' and 'duration' together need a non-stretch 'overflow'/'underflow' (stretch derives the speed from 'duration')" }
    ).refine(
      (data) =>
        data.binItem == null || data.children == null,
      {
        message:
          "A 'binItem' reference cannot carry its own 'children' — it adopts the bin entry's body",
      }
    )
  );

  // Every node schema by `type`, for containers that restrict their children
  // (read lazily, at parse time).
  nodeSchemaByType.set("clip", ClipSchema);
  nodeSchemaByType.set("audio", AudioSchema);
  nodeSchemaByType.set("static", StaticSchema);
  nodeSchemaByType.set("data", DataSchema);
  nodeSchemaByType.set("rect", RectSchema);
  nodeSchemaByType.set("circle", CircleSchema);
  nodeSchemaByType.set("composition", CompositionSchema);
  for (const [type, schema] of extensionNodeEntries) nodeSchemaByType.set(type, schema);

  // Evaluate the lazy composition schema once, so a contributed field that
  // collides with one of its keys fails at `createSeam`, not at first use.
  CompositionSchema.safeParse({ type: "composition" });

  return CompositionSchema;
}

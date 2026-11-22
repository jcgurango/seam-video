import { z } from "zod";
import type { Registry, RegisteredField } from "./registry.js";

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

// Where a node's `origin` lands when it is a child of a `map`: either a
// geographic coordinate or a fraction along one of the map's `paths` (by index
// or path `id`; `position` defaults to that path's current `progress`, so the
// node rides the head of the reveal). Ignored outside a map. Keyframes
// interpolate lat/lng (geo→geo) or `position` (same path→same path); a change
// of kind or path snaps at the keyframe.
const PinSchema = z.union([
  z.object({
    latitude: z.number().min(-90).max(90),
    longitude: z.number().min(-180).max(180),
  }).strict(),
  z.object({
    path: z.union([z.number().int().nonnegative(), z.string().min(1)]),
    position: z.number().min(0).max(1).optional(),
  }).strict(),
]);

const SpatialFieldsSchema = {
  objectFit: ObjectFitSchema.optional(),
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
  // Geo / path anchor — only meaningful on a `map`'s children. See PinSchema.
  pin: keyframed(PinSchema).optional(),
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

/** Zod schema for one contributed field. */
function fieldSchema(spec: RegisteredField): z.ZodTypeAny {
  let num = z.number();
  if (spec.min != null) num = num.min(spec.min);
  if (spec.max != null) num = num.max(spec.max);
  return (spec.animatable ? keyframed(num) : num).optional();
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
  for (const f of registry.fields) {
    if (f.nodes === "visual") visualExt[f.key] = fieldSchema(f);
  }
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

  const TextSchema = z.object(visual("text", {
    type: z.literal("text"),
    text: z.union([z.string(), z.array(z.union([z.string(), TextRunSchema]))]),
    lineHeight: keyframed(z.number().nonnegative()).optional(),
    textAlign: z.enum(["left", "center", "right"]).optional(),
    verticalAlign: z.enum(["top", "center", "bottom"]).optional(),
    padding: TextPaddingSchema.optional(),
    contentWidth: keyframed(LengthSchema).optional(),
    contentHeight: keyframed(LengthSchema).optional(),
    duration: z.number().positive(),
    ...TextStyleFieldsSchema,
    ...SpatialFieldsSchema,
    ...AnchorFieldsSchema,
    ...MetadataFieldsSchema,
  })).strict();

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

  // ── Map ────────────────────────────────────────────────────────────
  //
  // A basemap rasterized from a pmtiles archive (see @seam/map), used like a
  // `static` with a camera: `latitude` / `longitude` / `zoom` / `mapOpacity`
  // are animatable, `paths` draw geo polylines over it, and `children` are
  // ordinary nodes (any type) composited over the map — a node carrying a `pin`
  // has its `origin` placed at the pin's projected point (its `translation`
  // then acts as a pixel offset from there). The map's inner canvas
  // (`contentWidth`/`contentHeight`, default 100% of the parent) is both the
  // raster size and the layout space its children resolve against.

  const MapPathSchema = z.object({
    // Referenced by a `pin: { path: "<id>" }`; else pins address paths by index.
    id: z.string().min(1).optional(),
    color: keyframed(z.string()),
    // [[lng, lat], ...] — at least two points. Not animatable.
    points: z.array(z.tuple([z.number(), z.number()])).min(2),
    // 0..1 fraction of the line drawn (the rest is hidden). Default 1.
    progress: keyframed(z.number().min(0).max(1)).optional(),
    // Stroke width in display pixels. Default 4.
    lineWidth: keyframed(z.number().positive()).optional(),
  }).strict();

  const MapSchema: z.ZodType<any> = z.lazy(() =>
    z.object(visual("map", {
      type: z.literal("map"),
      // pmtiles archive — host-resolved like clip/static `source`.
      source: z.string().min(1),
      duration: z.number().positive(),
      latitude: keyframed(z.number().min(-90).max(90)).optional(),
      longitude: keyframed(z.number().min(-180).max(180)).optional(),
      // maplibre-512 convention. Interpolates in scale space (linear in 2^-zoom).
      zoom: keyframed(z.number().nonnegative()).optional(),
      // Opacity of the basemap layers only (tiles: fills/lines/labels) — paths
      // and children are unaffected. Distinct from the node's `opacity`.
      mapOpacity: keyframed(z.number().min(0).max(1)).optional(),
      theme: z.enum(["light", "dark"]).optional(),
      paths: z.array(MapPathSchema).optional(),
      /** Nodes composited over the map, placed exactly like a composition's
       *  children (runs + `start` anchors; time 0 is the map's start) but they
       *  never extend the map — its `duration` is authoritative. A `pin` places
       *  a node geographically. */
      children: z.array(ChildSchema).optional(),
      contentWidth: keyframed(LengthSchema).optional(),
      contentHeight: keyframed(LengthSchema).optional(),
      ...SpatialFieldsSchema,
        ...AnchorFieldsSchema,
      ...MetadataFieldsSchema,
    })).strict()
  );

  const ChildSchema: z.ZodType<any> = z.lazy(() =>
    z.union([
      ClipSchema,
      AudioSchema,
      StaticSchema,
      DataSchema,
      TextSchema,
      RectSchema,
      CircleSchema,
      MapSchema,
      CompositionSchema,
    ])
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
    z.object(visual("composition", {
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
    })).strict().refine(
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

  return CompositionSchema;
}

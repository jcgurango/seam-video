# The .seam File Format

A `.seam` file is a JSON document that describes a video edit. Instead of traditional timelines with absolute timecodes, seam treats video as flowing art: you define clips by their source ranges, arrange them in sequences, and everything shifts automatically when you add, remove, or reorder.

All time values are in **seconds**. Fractional values are fine (`0.5`, `1.75`, etc.).

## Quick Start

The simplest possible `.seam` file is a single clip:

```json
{
  "type": "composition",
  "children": [
    { "type": "clip", "source": "intro.mp4", "in": 0, "out": 10 }
  ]
}
```

This plays the first 10 seconds of `intro.mp4`. Every `.seam` file is a composition at the root, with at least one child.

Here's a slightly richer example — two clips with a half-second gap between them:

```json
{
  "type": "composition",
  "children": [
    { "type": "clip", "source": "intro.mp4", "in": 0, "out": 5 },
    { "type": "empty", "duration": 0.5 },
    { "type": "clip", "source": "interview.mp4", "in": 12, "out": 30 }
  ]
}
```

This plays seconds 0-5 of `intro.mp4`, then half a second of silence/black, then seconds 12-30 of `interview.mp4`. Total duration: 23.5 seconds. Insert a new clip anywhere and everything after it shifts forward automatically.

## Node Types

There are five types of nodes: **clip**, **empty**, **composition**, **overlay**, and **ref**.

### Clip

A clip references a segment of a source media file.

```json
{ "type": "clip", "source": "footage.mp4", "in": 5, "out": 15 }
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `type` | `"clip"` | yes | Must be `"clip"` |
| `source` | string | yes | Path to the media file |
| `in` | number | yes | Start point in the source file (seconds, >= 0) |
| `out` | number | yes | End point in the source file (seconds, > 0) |
| `speed` | number | no | Playback speed multiplier (e.g. `2` for 2x speed). Mutually exclusive with `duration` |
| `duration` | number | no | Explicit duration in seconds — stretches the clip to fit. Mutually exclusive with `speed` |
| `flex` | number | no | Proportional sizing weight (see [Flex](#flex)) |
| `overflow` | string | no | Strategy when clip must be shortened (default: `"trim-end"`) |
| `underflow` | string | no | Strategy when clip must be lengthened |
| `position` | string | no | `"relative"` or `"absolute"` (see [Spatial Layout](#spatial-layout)) |
| `objectFit` | string | no | `"center"`, `"fit"`, or `"cover"` (see [Spatial Layout](#spatial-layout)) |
| `top`, `left`, `right`, `bottom`, `width`, `height` | string | no | Box properties (see [Spatial Layout](#spatial-layout)) |
| `filters` | array | no | Visual effects applied in order (see [Filters](#filters)) |
| `id` | string | no | Identifier within the enclosing composition; referenceable by [attachments](#attachments) |
| `start`, `end` | object | no | Time anchors; only meaningful on [attachments](#attachments) |

The **natural duration** of a clip is `out - in`. The `in` and `out` values are timecodes into the source file, not positions on the output timeline.

Setting `speed` or `duration` changes the natural duration:

- `speed: 2` plays the clip at 2x speed, halving its natural duration to `(out - in) / 2`
- `duration: 20` stretches the clip to exactly 20 seconds, implying `speed = (out - in) / 20`

These compound with flex and overflow/underflow. If a clip has `speed: 2` and the layout system assigns a different target (via flex), overflow/underflow applies on top of the base speed.

### Empty

An empty node is a gap — silence and black for a given duration.

```json
{ "type": "empty", "duration": 2 }
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `type` | `"empty"` | yes | Must be `"empty"` |
| `duration` | number | yes | Length of the gap in seconds (> 0) |
| `flex` | number | no | Proportional sizing weight (see [Flex](#flex)) |
| `id` | string | no | Identifier; referenceable by [attachments](#attachments) |
| `start`, `end` | object | no | Time anchors; only meaningful on [attachments](#attachments) |

### Composition

A composition is a container that holds other nodes in sequence. The root of every `.seam` file is a composition, and compositions can be nested.

```json
{
  "type": "composition",
  "children": [
    { "type": "clip", "source": "a.mp4", "in": 0, "out": 5 },
    { "type": "clip", "source": "b.mp4", "in": 0, "out": 5 }
  ]
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `type` | `"composition"` | yes | Must be `"composition"` |
| `children` | array | yes | One or more child nodes (clips, empties, compositions, overlays, or refs) |
| `attachments` | array | no | Anchored overlay children (see [Attachments](#attachments)) |
| `refs` | object | no | Reusable child definitions keyed by name (see [Refs](#refs)) |
| `duration` | number | no | Fixes the total container duration in seconds (mutually exclusive with `unitDuration`) |
| `unitDuration` | number | no | Duration per unit of flex (see [unitDuration](#unitduration)); mutually exclusive with `duration` |
| `layout` | object | no | Controls spacing and alignment (see [Layout](#layout)) |
| `in` | number | no | Window start into this composition's inner timeline (seconds, >= 0) |
| `out` | number | no | Window end into this composition's inner timeline (seconds, > 0) |
| `flex` | number | no | Proportional sizing weight (see [Flex](#flex)) |
| `overflow` | string | no | Strategy when composition must be shortened (default: `"trim-end"`) |
| `underflow` | string | no | Strategy when composition must be lengthened |
| `contentWidth` | number | no | Intrinsic width in pixels (default: canvas width). See [Content Dimensions](#content-dimensions) |
| `contentHeight` | number | no | Intrinsic height in pixels (default: canvas height). See [Content Dimensions](#content-dimensions) |
| `filters` | array | no | Visual effects applied in order (see [Filters](#filters)) |
| `id` | string | no | Identifier; referenceable by [attachments](#attachments) |
| `start`, `end` | object | no | Time anchors; only meaningful on [attachments](#attachments) |

#### Nested Compositions and Windowing

When a composition is used as a child of another composition, you can use `in` and `out` to select a sub-window of its inner timeline. The composition is fully resolved first, then only the portion between `in` and `out` is visible.

```json
{
  "type": "composition",
  "children": [
    {
      "type": "composition",
      "children": [
        { "type": "clip", "source": "a.mp4", "in": 0, "out": 3 },
        { "type": "clip", "source": "b.mp4", "in": 0, "out": 3 }
      ],
      "in": 1,
      "out": 5
    }
  ]
}
```

The inner composition has two 3-second clips (6 seconds total). Setting `in: 1, out: 5` takes a 4-second window: it skips the first second of clip A and the last second of clip B.

If `in` and `out` are omitted, the full inner timeline is used.

### Overlay

An overlay stacks its children visually — all playing at the same time, layered on top of each other. The first child is the base layer, and each subsequent child is drawn on top.

```json
{
  "type": "overlay",
  "children": [
    { "type": "clip", "source": "background.mp4", "in": 0, "out": 10 },
    { "type": "clip", "source": "foreground.mp4", "in": 0, "out": 5 }
  ]
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `type` | `"overlay"` | yes | Must be `"overlay"` |
| `children` | array | yes | One or more child nodes, stacked bottom to top |
| `refs` | object | no | Reusable child definitions keyed by name (see [Refs](#refs)) |
| `duration` | number | no | Total duration (defaults to the longest child's natural duration) |
| `alignItems` | string | no | Where shorter children sit within the overlay's duration (default: `"start"`) |
| `in` | number | no | Window start when used as a child (seconds, >= 0) |
| `out` | number | no | Window end when used as a child (seconds, > 0) |
| `flex` | number | no | Proportional sizing weight (see [Flex](#flex)) |
| `overflow` | string | no | Strategy when overlay must be shortened |
| `underflow` | string | no | Strategy when overlay must be lengthened |
| `contentWidth` | number | no | Intrinsic width in pixels (default: canvas width). See [Content Dimensions](#content-dimensions) |
| `contentHeight` | number | no | Intrinsic height in pixels (default: canvas height). See [Content Dimensions](#content-dimensions) |
| `filters` | array | no | Visual effects applied in order (see [Filters](#filters)) |
| `id` | string | no | Identifier; referenceable by [attachments](#attachments) |
| `start`, `end` | object | no | Time anchors; only meaningful on [attachments](#attachments) |

#### alignItems

When children have different durations, `alignItems` controls where the shorter children are placed in time:

| Value | Effect |
|-------|--------|
| `"start"` | Shorter children start at the beginning |
| `"end"` | Shorter children end at the overlay's end |
| `"center"` | Shorter children are centered |

```json
{
  "type": "overlay",
  "alignItems": "center",
  "children": [
    { "type": "clip", "source": "background.mp4", "in": 0, "out": 10 },
    { "type": "clip", "source": "title.mp4", "in": 0, "out": 4 }
  ]
}
```

The background plays for 10 seconds. The title appears centered at seconds 3-7.

#### Overflow in overlays

If `duration` is set shorter than a child, that child is overflowed. The default overflow strategy depends on `alignItems`: `"start"` uses `"trim-end"`, `"end"` uses `"trim-start"`, `"center"` uses `"trim-center"`. You can override this per-child with the `overflow` field.

#### Flex in overlays

In an overlay, `flex` works as a boolean: any `flex` value greater than 0 forces the child to match the overlay's duration (triggering overflow or underflow as needed). Unlike compositions, relative flex values don't matter — `flex: 1` and `flex: 2` have the same effect.

### Ref

A ref is a placeholder that stands in for a definition stored in some enclosing composition or overlay's `refs` dict. See [Refs](#refs) for the full model.

```json
{ "type": "ref", "source": "title_card" }
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `type` | `"ref"` | yes | Must be `"ref"` |
| `source` | string | yes | Name of the definition in an enclosing `refs` dict |
| `in`, `out` | number | no | Window into the resolved definition (same semantics as on a composition child) |
| `flex`, `overflow`, `underflow` | — | no | Standard timing modifiers applied to the resolved definition |
| `filters`, `position`, `objectFit`, `top`, `left`, `right`, `bottom`, `width`, `height` | — | no | Standard spatial/filter modifiers |
| `id` | string | no | Identifier; referenceable by [attachments](#attachments) |
| `start`, `end` | object | no | Time anchors; only meaningful on [attachments](#attachments) |

## Layout

The `layout` field on a composition controls spacing and alignment of its children.

```json
{
  "type": "composition",
  "duration": 20,
  "layout": { "gap": 1, "justify": "center" },
  "children": [...]
}
```

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `gap` | number | `0` | Silence inserted between each pair of adjacent children (seconds) |
| `justify` | string | `"start"` | How children are positioned within the container |

Without a `duration` or `unitDuration`, the composition's duration is simply the sum of its children's natural durations (plus any gaps).

### Justify

When a container has a fixed `duration` that's longer than its children need, `justify` controls where the children are placed. This works like CSS `justify-content` but on the time axis.

| Value | Effect |
|-------|--------|
| `"start"` | Children packed at the beginning, trailing silence at the end |
| `"end"` | Children packed at the end, leading silence at the start |
| `"center"` | Children centered, equal silence before and after |
| `"space-between"` | First child at t=0, last child at the end, space distributed evenly between |

Example — centering 10 seconds of content in a 20-second container:

```json
{
  "type": "composition",
  "duration": 20,
  "layout": { "justify": "center" },
  "children": [
    { "type": "clip", "source": "a.mp4", "in": 0, "out": 10 }
  ]
}
```

The clip plays at the 5-second mark, with 5 seconds of black before and after.

### Gap

`gap` inserts silence between every pair of adjacent children:

```json
{
  "type": "composition",
  "layout": { "gap": 0.5 },
  "children": [
    { "type": "clip", "source": "a.mp4", "in": 0, "out": 5 },
    { "type": "clip", "source": "b.mp4", "in": 0, "out": 5 },
    { "type": "clip", "source": "c.mp4", "in": 0, "out": 5 }
  ]
}
```

Total duration: 16 seconds (5 + 0.5 + 5 + 0.5 + 5). The gap only appears between children, not at the start or end.

## Flex

`flex` lets children claim proportional shares of the available time, like CSS `flex-grow` on the time axis.

When any child in a composition has a `flex` value, the flex system activates:

1. The **budget** is calculated: `container duration - total gaps - sum of non-flex children's natural durations`
2. Each flex child receives `(its flex / total flex) * budget` as its target duration
3. Non-flex children keep their natural duration

```json
{
  "type": "composition",
  "duration": 30,
  "children": [
    { "type": "clip", "source": "intro.mp4", "in": 0, "out": 5 },
    { "type": "clip", "source": "a.mp4", "in": 0, "out": 10, "flex": 1 },
    { "type": "clip", "source": "b.mp4", "in": 0, "out": 10, "flex": 2 }
  ]
}
```

The intro clip takes 5 seconds (no flex). The remaining 25 seconds are split: clip A gets ~8.33s (`1/3 * 25`), clip B gets ~16.67s (`2/3 * 25`). Since both clips are naturally 10 seconds, clip A will be shortened (overflow) and clip B will be lengthened (underflow) to match.

## unitDuration

`unitDuration` provides a rhythm-based alternative to `duration`. Instead of specifying the total container duration, you specify how long one "unit" of flex is. Each child defaults to `flex: 1`, so every child gets `unitDuration` seconds unless it has a different `flex` value.

```json
{
  "type": "composition",
  "unitDuration": 5,
  "children": [
    { "type": "clip", "source": "a.mp4", "in": 0, "out": 10 },
    { "type": "clip", "source": "b.mp4", "in": 0, "out": 10 },
    { "type": "clip", "source": "c.mp4", "in": 0, "out": 10 }
  ]
}
```

Each clip gets 5 seconds. Total duration: 15 seconds. All three clips are naturally 10 seconds, so they'll be trimmed to 5 seconds each (using overflow, default `"trim-end"`).

With `flex`, children can claim multiple units:

```json
{
  "type": "composition",
  "unitDuration": 5,
  "children": [
    { "type": "clip", "source": "a.mp4", "in": 0, "out": 10 },
    { "type": "clip", "source": "b.mp4", "in": 0, "out": 20, "flex": 2 },
    { "type": "clip", "source": "c.mp4", "in": 0, "out": 10 }
  ]
}
```

Clip A gets 5s (flex 1), clip B gets 10s (flex 2), clip C gets 5s (flex 1). Total: 20 seconds.

Container duration is calculated as `unitDuration * totalFlex + totalGap`. You cannot specify both `duration` and `unitDuration` on the same composition.

## Overflow & Underflow

When a clip or composition needs to be shorter or longer than its natural duration (due to flex or other layout constraints), overflow and underflow strategies control what happens.

### Overflow (making things shorter)

Applied when the target duration is less than the natural duration. Default: `"trim-end"` for clips and compositions. In overlays, the default depends on `alignItems` (see [Overlay](#overlay)).

| Strategy | Effect |
|----------|--------|
| `"trim-end"` | Keeps the beginning, cuts from the end |
| `"trim-start"` | Keeps the end, cuts from the beginning |
| `"trim-center"` | Cuts equal amounts from both ends |
| `"stretch"` | Keeps the full range but plays faster |

```json
{ "type": "clip", "source": "a.mp4", "in": 0, "out": 10, "flex": 1, "overflow": "stretch" }
```

If this clip's flex allocation is 5 seconds, `"stretch"` plays the full 0-10s range at 2x speed instead of trimming.

### Underflow (making things longer)

Applied when the target duration is greater than the natural duration. No default — if omitted, the clip keeps its natural duration and leftover space is silence.

| Strategy | Effect |
|----------|--------|
| `"extend-end"` | Extends the source range past the original `out` point |
| `"extend-start"` | Extends the source range before the original `in` point |
| `"extend-center"` | Extends equally in both directions |
| `"stretch"` | Keeps the original range but plays slower |

```json
{ "type": "clip", "source": "a.mp4", "in": 5, "out": 10, "flex": 1, "underflow": "stretch" }
```

If this clip's flex allocation is 10 seconds, `"stretch"` plays the 5-10s range at 0.5x speed.

## Refs

Refs let you define a piece of content once and reference it from multiple places. A composition or overlay can declare a `refs` dict, and any descendant can use a `ref` node to insert a resolved copy of the named definition.

```json
{
  "type": "composition",
  "refs": {
    "sting": { "type": "clip", "source": "sting.mp4", "in": 0, "out": 1.5 }
  },
  "children": [
    { "type": "clip", "source": "scene1.mp4", "in": 0, "out": 8 },
    { "type": "ref", "source": "sting" },
    { "type": "clip", "source": "scene2.mp4", "in": 0, "out": 12 },
    { "type": "ref", "source": "sting" }
  ]
}
```

Both refs resolve to the same 1.5-second clip. Editing `refs.sting` updates every usage.

### Scoping

Ref lookup walks the enclosing scope chain outward from the usage site. The **shallowest** matching `refs` dict wins, so an inner composition can shadow an outer name. Nested refs inside a definition resolve in the scope where the definition was *authored*, not where the enclosing ref is used — this keeps a deep composition from accidentally shadowing a name the definition expected.

### Windowing a ref

A ref node accepts the same timing and spatial modifiers as other children (`in`, `out`, `flex`, `overflow`, `underflow`, filters, box properties). Those window and position the *resolved duration* of the definition rather than any source-level fields.

```json
{
  "type": "composition",
  "refs": {
    "full_interview": {
      "type": "composition",
      "children": [
        { "type": "clip", "source": "camA.mp4", "in": 0, "out": 60 },
        { "type": "clip", "source": "camB.mp4", "in": 0, "out": 60 }
      ]
    }
  },
  "children": [
    { "type": "ref", "source": "full_interview", "in": 30, "out": 60 }
  ]
}
```

The definition resolves to a 120-second timeline; the ref windows seconds 30-60 of it.

### Cycles

A ref cannot (transitively) reference itself. The resolver throws if it detects a cycle or an unknown name.

## Attachments

Attachments are overlay children of a composition whose timeline position is expressed relative to other nodes by `id`, not by sequential layout. They render on top of `children` in array order (last on top).

```json
{
  "type": "composition",
  "children": [
    { "id": "intro", "type": "clip", "source": "intro.mp4", "in": 0, "out": 10 },
    { "type": "clip", "source": "body.mp4", "in": 0, "out": 30 }
  ],
  "attachments": [
    {
      "type": "clip",
      "source": "lower_third.mp4",
      "in": 0,
      "out": 3,
      "start": { "anchor": "intro", "timeSource": "output", "anchorPoint": "100%", "offset": -3 }
    }
  ]
}
```

The `intro` clip runs from 0 to 10 seconds. The attachment starts 3 seconds before the end of `intro` (at t=7) and plays for its natural 3 seconds.

### IDs

Any child can set an `id`. IDs must be unique within a composition (including across `children` and `attachments`). IDs live in a separate namespace from `refs` names.

### Time anchors

Both `start` and `end` on an attachment are objects shaped like:

| Field | Type | Description |
|-------|------|-------------|
| `anchor` | string | `id` of another node in the same composition. Optional. |
| `timeSource` | `"output"` \| `"source"` | Coordinate space for `anchorPoint`. **Required when `anchor` is set; forbidden when it isn't.** See [timeSource](#timesource). |
| `anchorPoint` | string \| number | Position within the anchor. In `"output"` mode: a percentage string (e.g. `"50%"`). In `"source"` mode: a number of seconds. Defaults to `"0%"` / `0` when `anchor` is set. Requires `anchor`. |
| `offset` | number \| string | Shift from the resolved anchor point, always in *output* time. A number is absolute seconds. A string like `"25%"` is that fraction of the anchor's output length. When no `anchor` is given, `offset` is absolute seconds measured from the composition's start, and the `%` form is not allowed. |

The anchor's resolved duration is its `timelineEnd - timelineStart` on the output timeline (after all flex/overflow resolution).

#### timeSource

`timeSource` controls what coordinate space `anchorPoint` lives in. It must be provided whenever `anchor` is — there is no default, so the coordinate space is always explicit at the authoring site.

- **`"output"`**: `anchorPoint` is a percentage string measuring into the anchor's output span — `"0%"` is `timelineStart`, `"100%"` is `timelineEnd`.
- **`"source"`**: `anchorPoint` is a number of seconds in the anchor's *source* timeline. For a clip, that's the raw media-file time, ignoring `in`/`out`/`speed` trimming. For a composition or overlay, it's the pre-window inner timeline (before any `in`/`out`). The resolver inverts the anchor's source→output mapping to find the corresponding output time:

  ```
  output_time = anchor.timelineStart
              + (anchorPoint − anchor.sourceBase) / anchor.outputSpeed
  ```

  where `sourceBase` is the clip's `sourceIn` (or the composition's windowed-in). The result can land *before* `timelineStart` or *after* `timelineEnd` — negative or past-end values are legal and useful for things like "start an overlay 2 seconds into the original footage, even if the first second of the clip was trimmed."

Example — if `myclip` has `in: 2, out: 4` (speed 1) and therefore occupies output `[0, 2]`, then `{ anchor: "myclip", timeSource: "source", anchorPoint: 1 }` resolves to output `-1` (source second 1 is 1 second before the clip's sourceIn).

`offset` is always output-time regardless of `timeSource`.

### How start and end interact

| Given | Effect |
|-------|--------|
| Neither `start` nor `end` | The attachment starts at t=0 of the composition and plays for its natural duration. |
| `start` only | The attachment starts at the resolved start time and plays for its natural duration. |
| `end` only | The attachment ends at the resolved end time; its start is back-computed from natural duration. |
| Both `start` and `end` | Timeline duration is `end - start`. The attachment is forced to fit: clips adjust their speed to span the window; compositions and overlays stretch (equivalent to `overflow: "stretch", underflow: "stretch"`). |

If `end` resolves before `start`, the resolver throws.

### Cross-attachment anchors

Attachments are resolved in array order. Each attachment's `id`, once resolved, is added to the id map, so a later attachment can anchor to an earlier one.

```json
{
  "attachments": [
    { "id": "a", "type": "clip", "source": "x.mp4", "in": 0, "out": 2, "start": { "offset": 5 } },
    { "type": "clip", "source": "y.mp4", "in": 0, "out": 1, "start": { "anchor": "a", "timeSource": "output", "anchorPoint": "100%" } }
  ]
}
```

`a` starts at t=5 (from composition origin), running to t=7. The second attachment begins at t=7.

### Over-constrained cases

When both anchors are given, the attachment's own `duration`, `speed`, `in`/`out` window, and flex strategies are overridden as needed to make the clip span the anchored window. If you want a different interaction (e.g. "start here and stop at the clip's natural end regardless of where `end` anchors"), drop the conflicting side.

## Filters

Filters apply visual effects to clips, compositions, and overlays. They are specified as an ordered array — each filter is applied in sequence.

```json
{
  "type": "clip",
  "source": "footage.mp4",
  "in": 0, "out": 10,
  "filters": [
    { "type": "adjust", "brightness": 0.2, "contrast": 1.1 },
    { "type": "opacity", "value": 0.8 }
  ]
}
```

### Filter Types

#### adjust

Color and tone adjustments. Maps to FFmpeg's `eq` filter.

| Field | Type | Default | Range | Description |
|-------|------|---------|-------|-------------|
| `brightness` | number | `0` | -1 to 1 | Brightness adjustment (additive) |
| `contrast` | number | `1` | -1000 to 1000 | Contrast multiplier |
| `saturation` | number | `1` | 0 to 3 | Saturation multiplier (0 = grayscale) |
| `gamma` | number | `1` | 0.1 to 10 | Gamma correction |

#### opacity

Sets the opacity of the node. Maps to FFmpeg's `colorchannelmixer` alpha channel.

| Field | Type | Range | Description |
|-------|------|-------|-------------|
| `value` | number | 0 to 1 | Opacity (0 = fully transparent, 1 = fully opaque) |

#### colorbalance

Adjusts color balance for shadows, midtones, and highlights independently. Maps to FFmpeg's `colorbalance` filter.

| Field | Type | Default | Range | Description |
|-------|------|---------|-------|-------------|
| `rs`, `gs`, `bs` | number | `0` | -1 to 1 | Shadow red/green/blue adjustment |
| `rm`, `gm`, `bm` | number | `0` | -1 to 1 | Midtone red/green/blue adjustment |
| `rh`, `gh`, `bh` | number | `0` | -1 to 1 | Highlight red/green/blue adjustment |

#### colortemperature

Shifts the color temperature. Maps to FFmpeg's `colortemperature` filter.

| Field | Type | Default | Range | Description |
|-------|------|---------|-------|-------------|
| `temperature` | number | `6500` | 1000 to 40000 | Color temperature in Kelvin (lower = warmer/orange, higher = cooler/blue) |

### Filters on Compositions and Overlays

Filters can also be applied to compositions and overlays, affecting all children as a group:

```json
{
  "type": "overlay",
  "filters": [{ "type": "adjust", "saturation": 0 }],
  "children": [
    { "type": "clip", "source": "bg.mp4", "in": 0, "out": 10 },
    { "type": "clip", "source": "fg.mp4", "in": 0, "out": 5 }
  ]
}
```

## Spatial Layout

Nodes can be positioned and sized within their parent container using box properties.

### Box Properties

| Field | Type | Description |
|-------|------|-------------|
| `position` | `"relative"` \| `"absolute"` | Placement mode (default: `"relative"`) |
| `objectFit` | `"center"` \| `"fit"` \| `"cover"` | How children are scaled within this container (default: `"fit"`) |
| `top` | string | Offset from top edge |
| `left` | string | Offset from left edge |
| `right` | string | Offset from right edge |
| `bottom` | string | Offset from bottom edge |
| `width` | string | Explicit width |
| `height` | string | Explicit height |

All spatial fields are optional. When no spatial properties are present, the default `objectFit` (`"fit"`) still applies — clips are scaled to fit the canvas preserving aspect ratio.

### Units

Dimension values are CSS-like strings:

- `"10px"` — pixels
- `"50%"` — percentage of parent dimension
- `"100"` — bare number, treated as pixels

Negative values are allowed (e.g. `"-10px"`).

### objectFit

`objectFit` is a **container-to-children policy**. It determines how children are scaled within the container:

| Value | Effect |
|-------|--------|
| `"center"` | Children displayed at native size, centered |
| `"fit"` | Children scaled to fit within container, preserving aspect ratio (default) |
| `"cover"` | Children scaled to cover container, preserving aspect ratio (may crop) |

The default is `"fit"`, which applies at every level — even with no spatial properties at all, clips are scaled to fit the canvas. A child can specify its own `objectFit`, but that only affects *its own children*, not its own sizing within the parent.

Compositions and overlays have intrinsic dimensions equal to the canvas size (1920x1080 by default), which can be overridden with `contentWidth`/`contentHeight`. See [Content Dimensions](#content-dimensions).

### Position

| Value | Effect |
|-------|--------|
| `"relative"` | Offsets from the objectFit-derived centered position (default) |
| `"absolute"` | Positions from the container's top-left origin |

### Box Model

The box properties follow CSS-like rules:

- `width` + `left` → placed at left offset, explicit width
- `width` + `right` → placed at right offset, explicit width
- `left` + `right` (no width) → width computed from parent minus offsets
- Same rules apply for the vertical axis (`height`, `top`, `bottom`)

### Content Dimensions

By default, compositions and overlays have intrinsic dimensions equal to the canvas (1920x1080). `contentWidth` and `contentHeight` override this, defining the container's internal coordinate space.

When a container has custom content dimensions, two things happen:

1. **The parent's objectFit sizes the container** using the content dimensions as intrinsic size — just like it sizes a video clip using the video's native resolution.
2. **Children are positioned in the content coordinate space**, which is then scaled to the container's display size.

```json
{
  "type": "composition",
  "children": [
    {
      "type": "overlay",
      "contentWidth": 800,
      "contentHeight": 600,
      "children": [
        { "type": "clip", "source": "game.mp4", "in": 0, "out": 60 }
      ]
    }
  ]
}
```

The overlay has an 800x600 coordinate space. The parent's default `"fit"` scales it to fit the 1920x1080 canvas: `min(1920/800, 1080/600) = 1.8`, giving a 1440x1080 display area centered horizontally with 240px of black on each side. The clip inside is fit within 800x600.

To stretch a container (breaking its aspect ratio), give it explicit `width` + `height` that don't match the content aspect ratio. The content space maps to the forced display size.

### Edge Anchoring

When you specify a single edge (`right`, `bottom`, etc.), objectFit-scaled content aligns to that edge instead of centering. This lets you control which part of a video is visible after scaling.

| Edges specified | Alignment |
|----------------|-----------|
| `right` only | Content pinned to right edge |
| `left` only | Content pinned to left edge |
| Both or neither | Content centered (default) |
| `top` only | Content pinned to top edge |
| `bottom` only | Content pinned to bottom edge |

This interacts with all objectFit modes:

- **`"fit"`**: determines where the letterbox padding goes (e.g. `right: "0px"` puts all padding on the left)
- **`"cover"`**: determines which part of the video is kept (e.g. `top: "0px"` crops from the bottom)
- **`"center"`**: determines where the native-size content sits in the container

```json
{
  "type": "composition",
  "objectFit": "cover",
  "children": [
    {
      "type": "clip",
      "source": "tall-video.mp4",
      "in": 0, "out": 10,
      "top": "0px"
    }
  ]
}
```

The video is scaled to cover the canvas, and the `top: "0px"` anchor keeps the top of the video visible, cropping from the bottom.

### Crop via objectFit

`objectFit: "cover"` scales to fill the container, then crops overflow. A 4:3 video in a 16:9 canvas will be zoomed in and cropped on the sides:

```json
{
  "type": "composition",
  "objectFit": "cover",
  "children": [
    { "type": "clip", "source": "4x3-footage.mp4", "in": 0, "out": 10 }
  ]
}
```

With the default `"fit"`, the same clip would be letterboxed (black bars on the sides). With `"center"`, it would be displayed at native resolution.

### Picture-in-Picture Example

```json
{
  "type": "overlay",
  "children": [
    { "type": "clip", "source": "main.mp4", "in": 0, "out": 30 },
    {
      "type": "clip",
      "source": "camera.mp4",
      "in": 0,
      "out": 30,
      "position": "absolute",
      "right": "20px",
      "bottom": "20px",
      "width": "25%",
      "height": "25%"
    }
  ]
}
```

The main video fills the frame. The camera feed is placed in the bottom-right corner at 25% size.

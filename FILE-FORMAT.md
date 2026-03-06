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

There are four types of nodes: **clip**, **empty**, **composition**, and **overlay**.

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
| `children` | array | yes | One or more child nodes (clips, empties, compositions, or overlays) |
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
| `duration` | number | no | Total duration (defaults to the longest child's natural duration) |
| `alignItems` | string | no | Where shorter children sit within the overlay's duration (default: `"start"`) |
| `in` | number | no | Window start when used as a child (seconds, >= 0) |
| `out` | number | no | Window end when used as a child (seconds, > 0) |
| `flex` | number | no | Proportional sizing weight (see [Flex](#flex)) |
| `overflow` | string | no | Strategy when overlay must be shortened |
| `underflow` | string | no | Strategy when overlay must be lengthened |
| `contentWidth` | number | no | Intrinsic width in pixels (default: canvas width). See [Content Dimensions](#content-dimensions) |
| `contentHeight` | number | no | Intrinsic height in pixels (default: canvas height). See [Content Dimensions](#content-dimensions) |

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

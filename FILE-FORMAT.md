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

There are three types of nodes: **clip**, **empty**, and **composition**.

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
| `flex` | number | no | Proportional sizing weight (see [Flex](#flex)) |
| `overflow` | string | no | Strategy when clip must be shortened (default: `"trim-end"`) |
| `underflow` | string | no | Strategy when clip must be lengthened |

The **natural duration** of a clip is `out - in`. The `in` and `out` values are timecodes into the source file, not positions on the output timeline.

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
| `children` | array | yes | One or more child nodes (clips, empties, or compositions) |
| `layout` | object | no | Controls duration, spacing, and alignment (see [Layout](#layout)) |
| `in` | number | no | Window start into this composition's inner timeline (seconds, >= 0) |
| `out` | number | no | Window end into this composition's inner timeline (seconds, > 0) |
| `flex` | number | no | Proportional sizing weight (see [Flex](#flex)) |
| `overflow` | string | no | Strategy when composition must be shortened (default: `"trim-end"`) |
| `underflow` | string | no | Strategy when composition must be lengthened |

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

## Layout

The `layout` field on a composition controls how its children are arranged within a fixed duration.

```json
{
  "type": "composition",
  "layout": { "duration": 20, "gap": 1, "justify": "center" },
  "children": [...]
}
```

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `duration` | number | sum of children | Fixes the total container duration in seconds |
| `gap` | number | `0` | Silence inserted between each pair of adjacent children (seconds) |
| `justify` | string | `"start"` | How children are positioned within the container |

Without a `layout`, the composition's duration is simply the sum of its children's natural durations.

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
  "layout": { "duration": 20, "justify": "center" },
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
  "layout": { "duration": 30 },
  "children": [
    { "type": "clip", "source": "intro.mp4", "in": 0, "out": 5 },
    { "type": "clip", "source": "a.mp4", "in": 0, "out": 10, "flex": 1 },
    { "type": "clip", "source": "b.mp4", "in": 0, "out": 10, "flex": 2 }
  ]
}
```

The intro clip takes 5 seconds (no flex). The remaining 25 seconds are split: clip A gets ~8.33s (`1/3 * 25`), clip B gets ~16.67s (`2/3 * 25`). Since both clips are naturally 10 seconds, clip A will be shortened (overflow) and clip B will be lengthened (underflow) to match.

## Overflow & Underflow

When a clip or composition needs to be shorter or longer than its natural duration (due to flex or other layout constraints), overflow and underflow strategies control what happens.

### Overflow (making things shorter)

Applied when the target duration is less than the natural duration. Default: `"trim-end"`.

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

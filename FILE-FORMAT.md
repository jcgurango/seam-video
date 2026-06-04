# The .seam File Format

A `.seam` file is a JSON document that describes a video edit. Instead of traditional timelines with absolute timecodes, seam treats video as flowing art: you define clips by their source ranges, arrange them in sequences, and everything shifts automatically when you add, remove, or reorder. It's a lightweight format that defines common video edits as operations that try to preserve authorial intent rather than flatting everything down to absolute timecodes and durations.

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

There are seven node types: **clip**, **audio**, **static**, **empty**, **data**, **text**, and **composition**.

### Clip

A clip references a segment of a source video file.

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
| `volume` | number | no | Audio gain multiplier (default `1`). `0` mutes; values up to `4` are accepted for amplification. |
| `overflow` | string | no | Strategy when the clip is over-constrained shorter than its natural duration (only fires for [attachments](#attachments) with both ends pinned) |
| `underflow` | string | no | Strategy when the clip is over-constrained longer than its natural duration (only fires for attachments with both ends pinned) |
| `position` | string | no | `"relative"` or `"absolute"` (see [Spatial Layout](#spatial-layout)) |
| `objectFit` | string | no | `"center"`, `"fit"`, or `"cover"` (see [Spatial Layout](#spatial-layout)) |
| `top`, `left`, `right`, `bottom`, `width`, `height` | string | no | Box properties (see [Spatial Layout](#spatial-layout)) |
| `filters` | array | no | Visual effects applied in order (see [Filters](#filters)) |
| `id` | string | no | Identifier within the enclosing composition; referenceable by [attachments](#attachments) |
| `start`, `end` | object | no | Time anchors; only meaningful on [attachments](#attachments) |
| `metadata` | object | no | Free-form bag of arbitrary JSON keyed by string. Preserved through resolution; doesn't affect rendering (see [Metadata](#metadata)) |

The **natural duration** of a clip is `(out - in) / speed`. The `in` and `out` values are timecodes into the source file, not positions on the output timeline.

Setting `speed` or `duration` changes the natural duration:

- `speed: 2` plays the clip at 2x speed, halving its natural duration to `(out - in) / 2`
- `duration: 20` stretches the clip to exactly 20 seconds, implying `speed = (out - in) / 20`

### Audio

An audio-only clip. Same temporal vocabulary as a clip, but no spatial fields and no visual filters.

```json
{ "type": "audio", "source": "voiceover.mp3", "in": 0, "out": 12 }
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `type` | `"audio"` | yes | Must be `"audio"` |
| `source` | string | yes | Path to the audio file |
| `in`, `out` | number | yes | Source-time window (same shape as on a clip) |
| `speed`, `duration`, `overflow`, `underflow` | — | no | Same shape as on a clip |
| `volume` | number | no | Audio gain multiplier (default `1`). Same shape as on a clip. |
| `id`, `start`, `end` | — | no | [Attachment](#attachments)/anchor fields |
| `metadata` | object | no | See [Metadata](#metadata) |

Visual props (`filters`, `position`, `objectFit`, box dimensions) are rejected by the schema — `audio` doesn't render to a quad.

### Static

A frozen frame held for `duration` seconds. The `source` can be an image file (PNG/JPG/WebP/etc.) or a video file — in the video case `in` picks the source timestamp to freeze on. Visual only; no audio. Like `text`, there's no temporal source to overflow or underflow against, so `overflow`/`underflow` don't apply and the frame is held regardless of `target`.

```json
{ "type": "static", "source": "logo.png", "duration": 5 }
```

```json
{ "type": "static", "source": "clip.mp4", "duration": 5, "in": 4 }
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `type` | `"static"` | yes | Must be `"static"` |
| `source` | string | yes | Path to the image or video file |
| `duration` | number | yes | How long the frame is shown for (> 0) |
| `in` | number | no | For video sources: the source timestamp to freeze on (seconds). Ignored for images. Defaults to `0` |
| `filters` | array | no | See [Filters](#filters) |
| `position`, `objectFit`, `top`, `left`, `right`, `bottom`, `width`, `height` | — | no | See [Spatial Layout](#spatial-layout) |
| `id`, `start`, `end` | — | no | [Attachment](#attachments)/anchor fields |
| `metadata` | object | no | See [Metadata](#metadata) |

### Empty

A gap — silence and black for a given duration.

```json
{ "type": "empty", "duration": 2 }
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `type` | `"empty"` | yes | Must be `"empty"` |
| `duration` | number | yes | Length of the gap in seconds (> 0) |
| `id` | string | no | Identifier; referenceable by [attachments](#attachments) |
| `start`, `end` | object | no | Time anchors; only meaningful on [attachments](#attachments) |
| `metadata` | object | no | See [Metadata](#metadata) |

### Data

A free-form JSON payload that occupies a span of time. Renders nothing — it's a parking spot for editor concerns (markers, cues, captions, decorators) that need to travel with the document but have no audiovisual representation in the file format itself.

```json
{ "type": "data", "data": { "any": "json_data_is_valid" }, "duration": 10 }
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `type` | `"data"` | yes | Must be `"data"` |
| `data` | any JSON | yes | Arbitrary payload — preserved unchanged through resolution |
| `duration` | number | no | Length of the slot in seconds (>= 0). Defaults to `0`, useful for point-in-time markers |
| `tags` | string[] | no | Free-form classifier tags. Editor-side filtering / grouping fodder; preserved through resolution |
| `id` | string | no | Identifier; referenceable by [attachments](#attachments) |
| `start`, `end` | object | no | Time anchors; only meaningful on [attachments](#attachments) |
| `metadata` | object | no | See [Metadata](#metadata) |

As a child, a `data` node takes up `duration` seconds of sequential time. As an attachment, its on-timeline length is whatever the anchors imply: with both `start` and `end` pinned, `end − start` wins regardless of `duration`. With only `start` (and no `end`/`duration`) it acts as an instantaneous marker.

```json
{
  "type": "data",
  "data": { "kind": "cue", "label": "punchline" },
  "start": { "anchor": "intro", "timeSource": "output", "anchorPoint": "100%", "offset": -3 }
}
```

The renderer and preview skip `data` nodes — they don't draw, don't make sound, and don't produce ffmpeg input.

### Text

A text node renders styled text as inline SVG. Layout (line breaking, alignment) happens at resolve time via [`@chenglou/pretext`](https://github.com/chenglou/pretext); the SVG is then rasterized and composited like any other visual node.

```json
{ "type": "text", "text": "Hello, world!", "fontSize": 64, "duration": 3 }
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `type` | `"text"` | yes | Must be `"text"` |
| `text` | string \| array | yes | Plain string, or an array of strings/`TextRun` objects for inline formatting (see below) |
| `duration` | number | no¹ | Display duration in seconds (> 0) |
| `fontFamily` | string | no | Font family. Default `"sans-serif"` |
| `fontSize` | number | no | Font size in pixels. Default `16` |
| `color` | string | no | Any SVG `fill` value. Default `"black"` |
| `fontWeight` | string | no | Any SVG `font-weight` (e.g. `"bold"`, `"700"`) |
| `backgroundColor` | string | no | SVG fill for a rect drawn behind each run. Wraps with the run when text breaks across lines |
| `backgroundPadding` | number \| `[v,h]` \| `[t,r,b,l]` | no | Pixel padding around the background rect |
| `strokeColor` | string | no | Any SVG stroke value |
| `strokeWidth` | number | no | Stroke width in pixels. SVG centers strokes on path edges, so the visible outline is roughly half this value |
| `lineHeight` | number | no | Line height in pixels. Default `1.2 × fontSize` |
| `textAlign` | `"left"` \| `"center"` \| `"right"` | no | Horizontal alignment within the inner box. Default `"center"` |
| `verticalAlign` | `"top"` \| `"center"` \| `"bottom"` | no | Vertical alignment within the inner box. Default `"top"` |
| `padding` | number \| `[v,h]` \| `[t,r,b,l]` | no | Inset on the inner layout box. Same shape as `backgroundPadding`; useful for keeping background/stroke from clipping the SVG edges |
| `contentWidth` | number | no | Intrinsic SVG width in pixels (default: parent display width). Acts like a composition's `contentWidth` for sizing |
| `contentHeight` | number | no | Intrinsic SVG height in pixels (default: parent display height) |
| `filters` | array | no | Visual effects applied in order (see [Filters](#filters)) |
| `position`, `objectFit`, `top`, `left`, `right`, `bottom`, `width`, `height` | — | no | Spatial properties (see [Spatial Layout](#spatial-layout)) |
| `id` | string | no | Identifier; referenceable by [attachments](#attachments) |
| `start`, `end` | object | no | Time anchors; only meaningful on [attachments](#attachments) |
| `metadata` | object | no | See [Metadata](#metadata) |

¹ `duration` is required unless both `start` and `end` are pinned (the anchor span dictates the timeline span).

#### Inline runs

When `text` is an array, each entry is either a plain string (which inherits the node-level styles) or a `TextRun` object that overrides any of the style fields above (`fontFamily`, `fontSize`, `color`, `fontWeight`, `backgroundColor`, `backgroundPadding`, `strokeColor`, `strokeWidth`):

```json
{
  "type": "text",
  "fontSize": 48,
  "color": "white",
  "text": [
    "Hello, ",
    { "text": "world", "color": "yellow", "fontWeight": "bold", "backgroundColor": "#222", "backgroundPadding": [4, 8] },
    "!"
  ],
  "duration": 4
}
```

Style fields on a run override the node-level fallback for that fragment only. Layout-level fields (`textAlign`, `verticalAlign`, `lineHeight`, `padding`, `contentWidth`, `contentHeight`) live only on the top-level node.

#### Sizing

Text mirrors composition sizing: `contentWidth`/`contentHeight` define the SVG's intrinsic canvas (defaulting to the parent display size), then [Spatial Layout](#spatial-layout) places that canvas on the parent. Line wrapping uses the inner box (`contentWidth − padding.left − padding.right`).

Both backends share Pretext for layout. The editor preview measures + draws on `OffscreenCanvas`; the FFmpeg CLI path does the same on `@napi-rs/canvas` (Skia) by polyfilling `OffscreenCanvas` server-side, then writes one PNG per static text node and a numbered sequence per animated text node, which ffmpeg pulls in via `overlay`. Glyph metrics are very close but not pixel-identical between the two engines; line breaks land in the same places for typical Latin/CJK content.

### Composition

A container that holds other nodes in sequence. The root of every `.seam` file is a composition, and compositions can be nested.

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
| `children` | array | no | Child nodes (clip, audio, static, empty, data, text, composition) played sequentially. Optional; defaults to `[]` for bin-reference and script compositions whose body comes from elsewhere |
| `attachments` | array | no | Anchored children rendered on top of `children` (see [Attachments](#attachments)) |
| `bin` | array | no | Reusable bodies addressable by id. See [Bin & Scripts](#bin--scripts) |
| `binItem` | string | no | Names a bin entry whose body this composition adopts at compile time. See [Bin & Scripts](#bin--scripts) |
| `script` | string | no | JavaScript source. The compile pass runs it against this composition; the return value replaces it in the rendered tree. See [Bin & Scripts](#bin--scripts) |
| `in` | number | no | Window start into this composition's inner timeline (seconds, >= 0) |
| `out` | number | no | Window end into this composition's inner timeline (seconds, > 0) |
| `overflow` | string | no | Strategy when the composition is over-constrained shorter than its natural duration (only fires for [attachments](#attachments) with both ends pinned) |
| `underflow` | string | no | Strategy when the composition is over-constrained longer than its natural duration (only fires for attachments with both ends pinned) |
| `contentWidth` | number | no | Intrinsic width in pixels (default: canvas width). See [Content Dimensions](#content-dimensions) |
| `contentHeight` | number | no | Intrinsic height in pixels (default: canvas height). See [Content Dimensions](#content-dimensions) |
| `filters` | array | no | Visual effects applied in order (see [Filters](#filters)) |
| `backgroundColor` | string | no | Any valid SVG/CSS fill value (e.g. `"#000"`, `"rgba(255,0,0,0.5)"`, `"red"`). Painted across the composition's container rect under all children |
| `position`, `objectFit`, `top`, `left`, `right`, `bottom`, `width`, `height` | — | no | Spatial properties (see [Spatial Layout](#spatial-layout)) |
| `id` | string | no | Identifier; referenceable by [attachments](#attachments) |
| `start`, `end` | object | no | Time anchors; only meaningful on [attachments](#attachments) |
| `metadata` | object | no | See [Metadata](#metadata) |

A composition's natural duration is the sum of its children's natural durations. There's no `duration` field, no flex, no justify, no gap — those are higher-order layout concerns that belong in the editor, not the spec. The resolved duration is whatever the children add up to (or `out − in` if a window is set).

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

To stack content visually — multiple things playing at the same time — use a composition's [`attachments`](#attachments) array. Each attachment is a child whose position on the timeline is anchored by id to another node rather than appended sequentially.

## Overflow & Underflow

Sequential children always play at their natural duration, so overflow/underflow are no-ops there. They kick in for [attachments](#attachments) whose `start` *and* `end` are both pinned: `end − start` defines a target span that may not match the attachment's natural duration, and the strategy decides how to make it fit.

The default for both overflow and underflow on attachments is `"stretch"` — speed adjusts so the attachment exactly spans the anchored window. Setting an explicit strategy on the node itself (a `clip`, `audio`, or nested `composition`) overrides that default.

### Overflow (target shorter than natural)

| Strategy | Effect |
|----------|--------|
| `"trim-end"` | Keeps the beginning, cuts from the end |
| `"trim-start"` | Keeps the end, cuts from the beginning |
| `"trim-center"` | Cuts equal amounts from both ends |
| `"stretch"` | Keeps the full source range but plays faster (default) |

### Underflow (target longer than natural)

| Strategy | Effect |
|----------|--------|
| `"extend-end"` | Extends the source range past the original `out` point |
| `"extend-start"` | Extends the source range before the original `in` point |
| `"extend-center"` | Extends equally in both directions |
| `"stretch"` | Keeps the original range but plays slower (default) |

```json
{
  "type": "clip",
  "source": "b.mp4",
  "in": 0, "out": 6,
  "overflow": "trim-end",
  "start": { "anchor": "target", "timeSource": "output", "anchorPoint": "0%" },
  "end":   { "anchor": "target", "timeSource": "output", "anchorPoint": "30%" }
}
```

A 6-second source pinned to a 3-second window. With `overflow: "trim-end"`, the resolver keeps the first 3 seconds at speed 1 instead of speeding the whole thing up.

## Attachments

Attachments are a composition's stacked/overlapping children — they render on top of `children`, positioned by anchoring to other nodes via `id` instead of by sequential layout. Within `attachments`, array order sets z-order (last on top).

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

Any child can set an `id`. IDs must be unique within a composition (including across `children` and `attachments`).

### Time anchors

Both `start` and `end` on an attachment are objects shaped like:

| Field | Type | Description |
|-------|------|-------------|
| `anchor` | string | `id` of another node in the same composition. Optional. |
| `timeSource` | `"output"` \| `"source"` | Coordinate space for `anchorPoint`. **Required when `anchor` is set; forbidden when it isn't.** See [timeSource](#timesource). |
| `anchorPoint` | string \| number | Position within the anchor. In `"output"` mode: a percentage string (e.g. `"50%"`). In `"source"` mode: a number of seconds. Defaults to `"0%"` / `0` when `anchor` is set. Requires `anchor`. |
| `offset` | number \| string | Shift in *output* time. A number is absolute seconds. A string like `"25%"` is that fraction of the *attachment's own natural duration* — independent of the anchor (and valid even when no anchor is given). When `anchor` is omitted, `offset` is measured from the composition's start. |

The anchor's resolved duration is its `timelineEnd - timelineStart` on the output timeline.

#### timeSource

`timeSource` controls what coordinate space `anchorPoint` lives in. It must be provided whenever `anchor` is — there is no default, so the coordinate space is always explicit at the authoring site.

- **`"output"`**: `anchorPoint` is a percentage string measuring into the anchor's output span — `"0%"` is `timelineStart`, `"100%"` is `timelineEnd`.
- **`"source"`**: `anchorPoint` is a number of seconds in the anchor's *source* timeline. For a clip, that's the raw media-file time, ignoring `in`/`out`/`speed` trimming. For a composition, it's the pre-window inner timeline (before any `in`/`out`). The resolver inverts the anchor's source→output mapping to find the corresponding output time:

  ```
  output_time = anchor.timelineStart
              + (anchorPoint − anchor.sourceBase) / anchor.outputSpeed
  ```

  where `sourceBase` is the clip's `sourceIn` (or the composition's windowed-in). The result can land *before* `timelineStart` or *after* `timelineEnd` — negative or past-end values are legal and useful for things like "start a caption 2 seconds into the original footage, even if the first second of the clip was trimmed."

Example — if `myclip` has `in: 2, out: 4` (speed 1) and therefore occupies output `[0, 2]`, then `{ anchor: "myclip", timeSource: "source", anchorPoint: 1 }` resolves to output `-1` (source second 1 is 1 second before the clip's sourceIn).

`offset` is always output-time regardless of `timeSource`.

### How start and end interact

| Given | Effect |
|-------|--------|
| Neither `start` nor `end` | The attachment starts at t=0 of the composition and plays for its natural duration. |
| `start` only | The attachment starts at the resolved start time and plays for its natural duration. |
| `end` only | The attachment ends at the resolved end time; its start is back-computed from natural duration. |
| Both `start` and `end` | Timeline duration is `end - start`. The attachment's [overflow/underflow](#overflow--underflow) strategy decides how it fits — default `"stretch"`. |

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

## Bin & Scripts

Compositions can carry a reusable-content **bin** and a **script** that transforms the composition at compile time.

A separate **compile pass** resolves these before the resolver runs. Both the renderer and the preview run it automatically; if you're authoring tools that consume `.seam` files, run `compileSeamFile(doc)` first.

### Bin entries

```json
{
  "type": "composition",
  "bin": [
    {
      "id": "intro",
      "children": [
        { "type": "clip", "source": "title.mp4", "in": 0, "out": 3 }
      ]
    }
  ],
  "children": [
    { "type": "composition", "binItem": "intro" },
    { "type": "clip", "source": "body.mp4", "in": 0, "out": 30 }
  ]
}
```

A bin entry is `{ id, children, attachments? }` — strictly a reusable body, not a full composition. Instance-level fields (spatial, in/out, filters, metadata) live on each `binItem` reference, so swapping a bin entry can't reach out and overwrite a reference's authored properties.

A composition with `binItem: "<id>"` adopts the named bin entry's `children` and `attachments` at compile time. The reference's own `children`/`attachments` are ignored.

#### Scope

Bin entries are **lexically scoped**: a `binItem` reference resolves against the nearest enclosing composition whose `bin` array contains a matching id. A child composition's `bin` shadows ancestors' entries with the same id. References that walk past the document root without finding a match are left unresolved and the compile pass reports an error.

### Scripts

```json
{
  "type": "composition",
  "script": "currentNode.children.reverse(); return currentNode;",
  "children": [
    { "type": "clip", "source": "a.mp4", "in": 0, "out": 2 },
    { "type": "clip", "source": "b.mp4", "in": 0, "out": 2 }
  ]
}
```

`script` is the body of an anonymous function `(currentNode) => Composition`. At compile time the script receives the composition itself (with bins already resolved and descendants already compiled) and its return value replaces the composition in the rendered tree. The authored `children` / `attachments` stay on the original doc — they're the script's input.

The execution environment is a plain `new Function(...)` with `window` and `document` shadowed to `undefined`. This is a footgun-reducer, not a sandbox: never load untrusted scripts.

A script's output is itself compiled (bins inside the output resolve against the *parent's* scope, since the script-bearing composition is being replaced wholesale).

## Metadata

Every node type accepts an optional `metadata` field — an object with arbitrary string keys whose values can be any JSON. Metadata travels with the document and is preserved through resolution, but the renderer and preview ignore it entirely: it doesn't change layout, timing, or pixels.

```json
{
  "type": "clip",
  "source": "intro.mp4",
  "in": 0, "out": 10,
  "metadata": {
    "color": "#ff8800",
    "notes": "needs color grade",
    "review": { "by": "alice", "status": "approved" }
  }
}
```

Use it for editor concerns that should round-trip through saves — review state, color tags on timeline blocks, plugin-specific annotations, etc. Unlike a [`data`](#data) node, metadata isn't a timeline citizen: it lives on the node it's attached to, doesn't occupy a span, and isn't reachable as an anchor target.

## Filters

Filters apply visual effects to clips and compositions. They are specified as an ordered array — each filter is applied in sequence.

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

### Filters on Compositions

Filters can also be applied to compositions, affecting all children as a group:

```json
{
  "type": "composition",
  "filters": [{ "type": "adjust", "saturation": 0 }],
  "children": [
    { "type": "clip", "source": "a.mp4", "in": 0, "out": 10 },
    { "type": "clip", "source": "b.mp4", "in": 0, "out": 5 }
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
| `top` | number \| string | Offset from top edge |
| `left` | number \| string | Offset from left edge |
| `right` | number \| string | Offset from right edge |
| `bottom` | number \| string | Offset from bottom edge |
| `width` | number \| string | Explicit width |
| `height` | number \| string | Explicit height |

All spatial fields are optional. When no spatial properties are present, the default `objectFit` (`"fit"`) still applies — clips are scaled to fit the canvas preserving aspect ratio.

### Units

Dimension values are either a number or a percentage string:

- `10` — pixels (numbers are always pixels — no `"10px"` strings)
- `"50%"` — percentage of the parent dimension along that axis

Negative values are allowed (e.g. `-10` or `"-25%"`).

### objectFit

`objectFit` is a **container-to-children policy**. It determines how children are scaled within the container:

| Value | Effect |
|-------|--------|
| `"center"` | Children displayed at native size, centered |
| `"fit"` | Children scaled to fit within container, preserving aspect ratio (default) |
| `"cover"` | Children scaled to cover container, preserving aspect ratio (may crop) |

The default is `"fit"`, which applies at every level — even with no spatial properties at all, clips are scaled to fit the canvas. A child can specify its own `objectFit`, but that only affects *its own children*, not its own sizing within the parent.

Compositions have intrinsic dimensions equal to the canvas size (1920x1080 by default), which can be overridden with `contentWidth`/`contentHeight`. See [Content Dimensions](#content-dimensions).

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

By default, compositions have intrinsic dimensions equal to the canvas (1920x1080). `contentWidth` and `contentHeight` override this, defining the container's internal coordinate space.

When a container has custom content dimensions, two things happen:

1. **The parent's objectFit sizes the container** using the content dimensions as intrinsic size — just like it sizes a video clip using the video's native resolution.
2. **Children are positioned in the content coordinate space**, which is then scaled to the container's display size.

```json
{
  "type": "composition",
  "children": [
    {
      "type": "composition",
      "contentWidth": 800,
      "contentHeight": 600,
      "children": [
        { "type": "clip", "source": "game.mp4", "in": 0, "out": 60 }
      ]
    }
  ]
}
```

The inner composition has an 800x600 coordinate space. The parent's default `"fit"` scales it to fit the 1920x1080 canvas: `min(1920/800, 1080/600) = 1.8`, giving a 1440x1080 display area centered horizontally with 240px of black on each side. The clip inside is fit within 800x600.

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

- **`"fit"`**: determines where the letterbox padding goes (e.g. `right: 0` puts all padding on the left)
- **`"cover"`**: determines which part of the video is kept (e.g. `top: 0` crops from the bottom)
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
      "top": 0
    }
  ]
}
```

The video is scaled to cover the canvas, and the `top: 0` anchor keeps the top of the video visible, cropping from the bottom.

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
  "type": "composition",
  "children": [
    { "id": "main", "type": "clip", "source": "main.mp4", "in": 0, "out": 30 }
  ],
  "attachments": [
    {
      "type": "clip",
      "source": "camera.mp4",
      "in": 0,
      "out": 30,
      "start": { "anchor": "main", "timeSource": "output", "anchorPoint": "0%" },
      "position": "absolute",
      "right": 20,
      "bottom": 20,
      "width": "25%",
      "height": "25%"
    }
  ]
}
```

The main video fills the frame. The camera feed is placed in the bottom-right corner at 25% size.

## Animation

Most numeric / colour / dimension fields can be animated by replacing the static value with a list of keyframe tuples:

```json
[ [time, value], [time, value, easing], ... ]
```

- `time` — when this keyframe lands, in the node's local timeline:
  - bare number: seconds since the node became active (e.g. `0.5`)
  - `"50%"`: percentage of the node's duration
  - `"50% + 10"` / `"50% - 1.5"`: percentage plus/minus a constant offset (whitespace required around the operator)
- `value` — the field's static type (number, colour string, padding tuple, etc.)
- `easing` *(optional)* — applied on the segment leading into this keyframe. CSS-style: `linear` (default), `ease`, `ease-in`, `ease-out`, `ease-in-out`, or `cubic-bezier(a, b, c, d)`

A node-local time of `0` is when the node first becomes active; `100%` is when it ends. Out-of-range times clamp to the nearest keyframe (no extrapolation).

```json
{
  "type": "clip",
  "source": "v.mp4",
  "in": 0, "out": 5,
  "volume": [[0, 0], ["50%", 1, "ease-in"], ["100%", 0, "ease-out"]],
  "left": [[0, 0], [2, 200]],
  "filters": [
    { "type": "opacity", "value": [[0, 0], [1, 1, "ease-in-out"]] }
  ]
}
```

### What can be animated

| Node | Fields |
|------|--------|
| **Clip** | `volume`, `top`, `left`, `right`, `bottom`, `width`, `height` |
| **Audio** | `volume` |
| **Composition** | `top`, `left`, `right`, `bottom`, `width`, `height` |
| **Text** (and per-run inside `text` array) | `fontSize`, `color`, `backgroundColor`, `backgroundPadding`, `strokeColor`, `strokeWidth`, `lineHeight`, `top`, `left`, `right`, `bottom`, `width`, `height` |
| **Filters** | every numeric value: `adjust.{brightness,contrast,saturation,gamma}`, `opacity.value`, `colorbalance.{rs,gs,bs,rm,gm,bm,rh,gh,bh}`, `colortemperature.temperature` |

### Renderer support

The CLI ffmpeg path supports every animatable field:

| Field | How it's rendered |
|---|---|
| Text styles (incl. per-run) | Pre-rasterized to a PNG sequence at output fps |
| Spatial edges (`top`/`left`/…) | `scale=eval=frame` and `overlay=eval=frame` driven by piecewise-linear expressions baked from the keyframes (one sample per output frame). When spatial is animated, `objectFit` is bypassed — the sampled rect is the on-screen rect, and the source stretches to it. |
| Volume | `volume=eval=frame` with the keyframes baked into a piecewise-linear expression in `t` (clip-local seconds). |
| Filter parameters | `eq` (adjust) uses `eval=frame` + per-parameter expressions. `colorchannelmixer` (opacity), `colorbalance`, and `colortemperature` use `sendcmd` to deliver one stepwise update per output frame to a labelled filter instance. |

Easings (linear, ease, ease-in/out, cubic-bezier) are folded into the baked samples by the same engine the editor preview uses, so the curve shape matches.

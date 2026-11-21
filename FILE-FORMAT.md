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
    { "type": "clip", "source": "interview.mp4", "in": 12, "out": 30, "offset": 0.5 }
  ]
}
```

This plays seconds 0-5 of `intro.mp4`, then half a second of silence/black, then seconds 12-30 of `interview.mp4`. Total duration: 23.5 seconds. Insert a new clip anywhere and everything after it shifts forward automatically.

## Node Types

There are nine node types: **clip**, **audio**, **static**, **data**, **text**, **rect**, **circle**, **map**, and **composition**. Every one of them can be a child of a composition and carries the same three [placement](#placement) fields: `id`, `start`, `offset`.

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
| `out` | number | yes¹ | End point in the source file (seconds, > 0) |
| `speed` | number | no | Playback speed multiplier (e.g. `2` for 2x speed) |
| `duration` | number | no | Output length in seconds. `overflow`/`underflow` decide how `[in, out]` fills it — by default the clip stretches to fit (see [Overflow & Underflow](#overflow--underflow)) |
| `orientation` | `0` \| `90` \| `180` \| `270` | no | Pre-transform source rotation (clockwise degrees, default `0`). Baked into the decoded frame before the spatial transform — to the compositor the clip looks as if it arrived already rotated by this amount (a `90`/`270` orientation swaps its width/height). Composes with any rotation declared in the file's container metadata. Not animatable; distinct from the spatial `rotation` field below. |
| `volume` | number | no | Audio gain multiplier (default `1`). `0` mutes; values up to `4` are accepted for amplification. |
| `pitch` | number | no | Length-preserving pitch shift in semitones (default `0`; fractional ok, clamped ±48). Independent of `speed`; adds with enclosing compositions' `pitch`. Not animatable (see [Pitch](#pitch)) |
| `overflow` | string | no | Strategy when `duration` is shorter than the clip's natural duration (default `"stretch"`) |
| `underflow` | string | no | Strategy when `duration` is longer than the clip's natural duration (default `"stretch"`) |
| `objectFit` | string | no | `"center"`, `"fit"`, or `"cover"` (see [Spatial Layout](#spatial-layout)) |
| `origin`, `translation`, `size` | `Length` \| `{x?, y?}` | no | Spatial layout (see [Spatial Layout](#spatial-layout)) |
| `rotation` | number | no | Degrees clockwise about `origin` (see [Spatial Layout](#spatial-layout)) |
| `opacity` | number \| keyframes | no | Opacity multiplier `0`–`1` (default `1`); animatable (see [Opacity](#opacity)) |
| `filters` | array | no | Visual effects applied in order (see [Filters](#filters)) |
| `id` | string | no | Identifier within the enclosing composition; other nodes' `start` can anchor to it (see [Placement](#placement)) |
| `start` | number \| string | no | Heads a new run at an absolute time or an anchor (see [Placement](#placement)) |
| `offset` | number | no | Seconds added to the position: a gap, a crossfade overlap, or a shift (see [Placement](#placement)) |
| `metadata` | object | no | Free-form bag of arbitrary JSON keyed by string. Preserved through resolution; doesn't affect rendering (see [Metadata](#metadata)) |

¹ `out` may be omitted when `duration` is set: it defaults to `in + duration`.

The **natural duration** of a clip is `(out - in) / speed`. The `in` and `out` values are timecodes into the source file, not positions on the output timeline.

- `speed: 2` plays the clip at 2x speed, halving its natural duration to `(out - in) / 2`
- `duration: 20` makes the clip occupy exactly 20 seconds. With the default `"stretch"` strategies that implies `speed = (out - in) / 20`, so `speed` and `duration` can't both be set — unless a non-stretch `overflow`/`underflow` is chosen, in which case the clip plays at `speed` and is trimmed, extended or looped to fill `duration`

### Audio

An audio-only clip. Same temporal vocabulary as a clip, but no spatial fields and no visual filters.

```json
{ "type": "audio", "source": "voiceover.mp3", "in": 0, "out": 12 }
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `type` | `"audio"` | yes | Must be `"audio"` |
| `source` | string | yes | Path to the audio file |
| `in`, `out` | number | yes | Source-time window (same shape as on a clip; `out` optional with `duration`) |
| `speed`, `duration`, `overflow`, `underflow` | — | no | Same shape as on a clip |
| `volume` | number | no | Audio gain multiplier (default `1`). Same shape as on a clip. |
| `pitch` | number | no | Length-preserving pitch shift in semitones. Same shape as on a clip (see [Pitch](#pitch)) |
| `id`, `start`, `offset` | — | no | [Placement](#placement) fields |
| `metadata` | object | no | See [Metadata](#metadata) |

Visual props (`filters`, `opacity`, `objectFit`, `origin`, `translation`, `size`, `rotation`) are rejected by the schema — `audio` doesn't render to a quad.

### Static

A frozen frame held for `duration` seconds. The `source` can be an image file (PNG/JPG/WebP/etc.) or a video file — in the video case `in` picks the source timestamp to freeze on. Visual only; no audio. Like `text`, there's no temporal source to overflow or underflow against, so `overflow`/`underflow` don't apply.

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
| `objectFit`, `origin`, `translation`, `size`, `rotation` | — | no | See [Spatial Layout](#spatial-layout) |
| `opacity` | number \| keyframes | no | Opacity multiplier `0`–`1` (default `1`); animatable (see [Opacity](#opacity)) |
| `id`, `start`, `offset` | — | no | [Placement](#placement) fields |
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
| `id`, `start`, `offset` | — | no | [Placement](#placement) fields |
| `metadata` | object | no | See [Metadata](#metadata) |

A `data` node takes up `duration` seconds like any other node, so it can be anchored anywhere as a marker:

```json
{
  "type": "composition",
  "children": [
    { "id": "intro", "type": "clip", "source": "intro.mp4", "in": 0, "out": 10 },
    { "type": "data", "data": { "kind": "cue", "label": "punchline" }, "start": "intro@100%", "offset": -3 }
  ]
}
```

It is also the **spacer**. A gap *between* two nodes is just an `offset` on the second one, but nothing except a node can extend a composition past its last child — so trailing silence/black is a `data` node with a `duration`:

```json
{
  "type": "composition",
  "children": [
    { "type": "clip", "source": "outro.mp4", "in": 0, "out": 5 },
    { "type": "data", "data": null, "duration": 2 }
  ]
}
```

The renderer and preview skip `data` nodes — they don't draw and don't make sound.

### Text

A text node renders styled text as inline SVG. Layout (line breaking, alignment) happens at resolve time via [`@chenglou/pretext`](https://github.com/chenglou/pretext); the SVG is then rasterized and composited like any other visual node.

```json
{ "type": "text", "text": "Hello, world!", "fontSize": 64, "duration": 3 }
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `type` | `"text"` | yes | Must be `"text"` |
| `text` | string \| array | yes | Plain string, or an array of strings/`TextRun` objects for inline formatting (see below). `\n` inserts a hard line break |
| `duration` | number | yes | Display duration in seconds (> 0) |
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
| `contentWidth`, `contentHeight` | `Length` | no | Intrinsic SVG canvas dims (default: parent's content dim). Percentages resolve against the parent (see [Content Dimensions](#content-dimensions)) |
| `filters` | array | no | Visual effects applied in order (see [Filters](#filters)) |
| `objectFit`, `origin`, `translation`, `size`, `rotation` | — | no | Spatial properties (see [Spatial Layout](#spatial-layout)) |
| `opacity` | number \| keyframes | no | Opacity multiplier `0`–`1` (default `1`); animatable (see [Opacity](#opacity)) |
| `id`, `start`, `offset` | — | no | [Placement](#placement) fields |
| `metadata` | object | no | See [Metadata](#metadata) |

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

#### Hard breaks

`\n` inside a run's `text` forces a line break — the layout breaks at every newline regardless of how much horizontal space is left, and a run of runs / text fragments can span multiple lines. Consecutive `\n`s emit blank lines that still consume one `lineHeight` of vertical space. All other whitespace (spaces, tabs, carriage returns) is collapsed normally.

```json
{ "type": "text", "text": "line one\nline two\n\nafter a blank", "duration": 3 }
```

Inline runs participate the same way — `[ "foo\n", { "text": "bar", "color": "red" } ]` puts a styled "bar" on its own line.

#### Sizing

Text mirrors composition sizing: `contentWidth`/`contentHeight` define the SVG's intrinsic canvas (defaulting to the parent display size; percentages resolve against the parent), then [Spatial Layout](#spatial-layout) places that canvas on the parent. Line wrapping uses the inner box (`contentWidth − padding.left − padding.right`). `\n` in the source text still forces a break inside that inner box.

Both the editor preview and the headless renderer share Pretext for layout. The preview measures + draws on `OffscreenCanvas`; the renderer does the same on `@napi-rs/canvas` (Skia) by polyfilling `OffscreenCanvas` server-side. Glyph metrics are very close but not pixel-identical between the two engines; line breaks land in the same places for typical Latin/CJK content.

### Rect and Circle

Solid shapes. They have no intrinsic size — their natural box is the parent — so `size` *is* the shape: a bare number is pixels, a percentage is of the parent. A `circle` is the ellipse inscribed in its box.

```json
{ "type": "rect", "duration": 3, "fill": "tomato", "size": { "x": 400, "y": 120 }, "cornerRadius": 24 }
```

```json
{ "type": "circle", "duration": 3, "fill": "none", "stroke": "white", "strokeWidth": 8, "size": 240 }
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `type` | `"rect"` \| `"circle"` | yes | |
| `duration` | number | yes | Display duration in seconds (> 0) |
| `fill` | string \| keyframes | no | Any CSS colour. Default `"black"`; `"none"` / `"transparent"` skips the fill |
| `stroke` | string \| keyframes | no | Stroke colour; drawn only when `strokeWidth` > 0 |
| `strokeWidth` | number \| keyframes | no | Stroke width in pixels, drawn **inside** the box |
| `filters` | array | no | See [Filters](#filters) |
| `objectFit`, `origin`, `translation`, `size`, `rotation`, `cornerRadius` | — | no | See [Spatial Layout](#spatial-layout) |
| `opacity` | number \| keyframes | no | See [Opacity](#opacity) |
| `id`, `start`, `offset` | — | no | [Placement](#placement) fields |
| `metadata` | object | no | See [Metadata](#metadata) |

### Map

A basemap rasterized from a pmtiles archive, used like a `static` with a camera.

```json
{
  "type": "map",
  "source": "world.pmtiles",
  "duration": 6,
  "latitude": 14.6, "longitude": 121.0,
  "zoom": [[0, 4], ["100%", 11, "ease-in-out"]],
  "paths": [
    { "id": "route", "color": "#ff5533", "points": [[120.98, 14.6], [121.05, 14.65]], "progress": [[0, 0], ["100%", 1]] }
  ],
  "children": [
    { "type": "circle", "duration": 6, "fill": "#ff5533", "size": 24, "pin": { "path": "route" } },
    { "type": "text", "text": "Manila", "duration": 3, "start": 1, "pin": { "latitude": 14.6, "longitude": 120.98 }, "translation": { "x": 0, "y": -30 } }
  ]
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `type` | `"map"` | yes | Must be `"map"` |
| `source` | string | yes | Path to the pmtiles archive |
| `duration` | number | yes | How long the map is shown (> 0) |
| `latitude`, `longitude`, `zoom` | number \| keyframes | no | Camera. `zoom` tweens in scale space |
| `mapOpacity` | number \| keyframes | no | Opacity of the basemap tiles only — paths and children are unaffected |
| `theme` | `"light"` \| `"dark"` | no | Basemap style. Default `"light"` |
| `paths` | array | no | Geo polylines: `{ id?, color, points: [[lng, lat], …], progress?, lineWidth? }`. `color`, `progress` (0–1 of the line drawn) and `lineWidth` are animatable |
| `children` | array | no | Nodes composited over the map (see below) |
| `contentWidth`, `contentHeight` | `Length` | no | Inner canvas: the raster size and the layout space of `children` (default: 100% of the parent) |
| `filters` | array | no | See [Filters](#filters) |
| `objectFit`, `origin`, `translation`, `size`, `rotation`, `cornerRadius` | — | no | See [Spatial Layout](#spatial-layout) |
| `opacity` | number \| keyframes | no | See [Opacity](#opacity) |
| `id`, `start`, `offset` | — | no | [Placement](#placement) fields |
| `metadata` | object | no | See [Metadata](#metadata) |

A map's `children` are ordinary nodes of any type, placed exactly like a composition's children ([runs, `start`, `offset`](#placement); time 0 is the map's start). Two differences:

- They **never extend the map** — its authored `duration` is authoritative.
- A child may carry a **`pin`** that places it geographically: `{ "latitude", "longitude" }`, or `{ "path": index | id, "position"? }` for a point along a path (`position` defaults to the path's live `progress`, so the node rides the reveal head). The node's `origin` lands on the projected point and `translation` becomes a pixel offset from it. `pin` is animatable.

Since every child without a `start` continues the previous child's run, overlays that should all begin with the map need `"start": 0` (the first child starts at 0 implicitly).

### Composition

A container that places other nodes on its own timeline. The root of every `.seam` file is a composition, and compositions can be nested.

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
| `children` | array | no | Child nodes of any type. Each plays after the previous one unless it sets `start`; array order is z-order, later on top (see [Placement](#placement)). Optional; defaults to `[]` for bin-reference and script compositions whose body comes from elsewhere |
| `bin` | array | no | Reusable bodies addressable by id. See [Bin & Scripts](#bin--scripts) |
| `binItem` | string | no | Names a bin entry whose body this composition adopts at compile time. See [Bin & Scripts](#bin--scripts) |
| `script` | string | no | JavaScript source. The compile pass runs it against this composition; the return value replaces it in the rendered tree. See [Bin & Scripts](#bin--scripts) |
| `in` | number | no | Window start into this composition's inner timeline (seconds, >= 0) |
| `out` | number | no | Window end into this composition's inner timeline (seconds, > 0) |
| `speed` | number | no | Playback rate of the inner window (the `[in, out]` slice); `>1` plays faster, shortening the output. Mirrors clip `speed` |
| `duration` | number | no | Output length. `overflow`/`underflow` decide how the inner window fills it — by default it stretches (derived rate `windowSpan / duration`). Mirrors clip `duration` |
| `overflow` | string | no | Strategy when `duration` is shorter than the composition's natural duration (default `"stretch"`) |
| `underflow` | string | no | Strategy when `duration` is longer than the composition's natural duration (default `"stretch"`) |
| `volume` | number \| keyframes | no | Uniform gain applied to every audio-bearing descendant; multiplies through nesting and with each clip's own `volume`. Animatable, sampled in the composition's output time |
| `pitch` | number | no | Length-preserving pitch shift in semitones applied to every audio-bearing descendant; adds through nesting and with each clip's own `pitch`. Not animatable (see [Pitch](#pitch)) |
| `contentWidth` | `Length` | no | Inner canvas width (default: parent's content width). Percentages resolve against the parent; the **root composition** must use a pixel number. See [Content Dimensions](#content-dimensions) |
| `contentHeight` | `Length` | no | Inner canvas height. Same shape as `contentWidth` |
| `filters` | array | no | Visual effects applied in order (see [Filters](#filters)) |
| `backgroundColor` | string | no | Any valid SVG/CSS fill value (e.g. `"#000"`, `"rgba(255,0,0,0.5)"`, `"red"`). Painted across the composition's container rect under all children |
| `objectFit`, `origin`, `translation`, `size`, `rotation` | — | no | Spatial properties (see [Spatial Layout](#spatial-layout)) |
| `opacity` | number \| keyframes | no | Opacity multiplier `0`–`1` (default `1`); animatable (see [Opacity](#opacity)) |
| `inset` | `Length` \| `[v,h]` \| `[t,r,b,l]` \| keyframes | no | Per-edge crop of the content box; animatable. **Composition-only** (see [Inset](#inset)) |
| `insetMode` | string | no | `"window"` (default) \| `"center"` \| `"fit"` \| `"cover"` — how the cropped window maps within the placed content box (see [Inset](#inset)) |
| `distort` | object \| keyframes | no | Corner-pin (perspective) warp of the composited content: `{ x0, y0, x1, y1, x2, y2, x3, y3 }`, each a `Length` against `contentWidth`/`contentHeight`, clockwise from top-left; every corner optional. Purely visual — the layout box is unchanged. Animatable as one value. **Composition-only** (see [Distort](#distort)) |
| `id` | string | no | Identifier within the enclosing composition; other nodes' `start` can anchor to it (see [Placement](#placement)) |
| `start` | number \| string | no | Heads a new run at an absolute time or an anchor (see [Placement](#placement)) |
| `offset` | number | no | Seconds added to the position: a gap, a crossfade overlap, or a shift (see [Placement](#placement)) |
| `metadata` | object | no | See [Metadata](#metadata) |

A composition's inner timeline runs from 0 to the **latest end of any child** — for a plain sequence that's the sum of the children's durations. Anything placed before 0 is cropped (a child wholly before 0 is dropped). `speed` and `duration` rescale the inner window exactly like a clip's — `duration: 10` plays the window at `windowSpan / 10`. There's no flex, no justify — those are higher-order layout concerns that belong in the editor, not the spec. The natural output length is the windowed span (`out − in`, defaulting to the whole inner timeline) divided by `speed`.

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

To stack content visually — multiple things playing at the same time — give a child a `start`. It then heads its own run instead of following the previous child (see [Placement](#placement)).

## Placement

Every node in a `children` array lands at

```
(start ?? end of the previous node, 0 for the first) + offset
```

A node **without** `start` continues the previous node's **run** — it plays right after it. A node **with** `start` heads a new run, positioned independently of whatever precedes it in the array. The first child is always a run head (implicitly at 0). Array order only decides **z-order**: later nodes draw on top.

```json
{
  "type": "composition",
  "children": [
    { "id": "intro", "type": "clip", "source": "intro.mp4", "in": 0, "out": 10 },
    { "type": "clip", "source": "body.mp4", "in": 0, "out": 30 },
    { "type": "clip", "source": "lower_third.mp4", "in": 0, "out": 3, "start": "intro@100%", "offset": -3 },
    { "type": "text", "text": "Thanks for watching", "duration": 2 }
  ]
}
```

`intro` runs from 0 to 10 and `body` follows it (10–40): one run. The lower third heads a second run, 3 seconds before the end of `intro` (t=7), drawn on top; the text continues *that* run, so it shows at t=10 for 2 seconds. The composition lasts 40 seconds — the latest end.

### IDs

Any node can set an `id`. IDs must be unique within their `children` array, can't contain `@`, and can't look like a number.

### start

| Form | Meaning |
|------|---------|
| `5` (a number) | Absolute seconds on the container's timeline |
| `"id"` | The start of sibling `id` |
| `"id@50%"` | That fraction of `id`'s output span — `0%` is its start, `100%` its end |
| `"id@10"` | Second 10 of `id`'s **source** timeline |

Anchors reference siblings in the same `children` array, anywhere in it — forward references are fine, cycles throw. There is no arithmetic in the expression: to shift off an anchor, use `offset`.

**Source-time anchors** (`"id@10"`) measure in the target's own media time. For a clip or audio that's the raw file time, before `in`/`out`/`speed`; for a composition it's the inner timeline before any `in`/`out` window (for everything else, plain seconds from its start). The resolver inverts the target's source→output mapping:

```
output_time = target.start + (seconds − target.sourceIn) / target.speed
```

The result can land before the target starts or after it ends — useful for "start a caption 2 seconds into the original footage, even if the first second of the clip was trimmed". If `myclip` has `in: 2, out: 4` and occupies output `[0, 2]`, then `"myclip@3"` resolves to output `1`.

### offset

`offset` is a number of seconds added to the node's position. What it means depends on where the node sits:

| On | `offset > 0` | `offset < 0` |
|----|--------------|--------------|
| A run member (no `start`) | A gap after the previous node | Overlaps the previous node and **crossfades** with it (see [Crossfades](#crossfades)) |
| A run head (has `start`, or is the first child) | A plain shift later | A plain shift earlier |

Nodes after it in the same run shift along with it.

### Cropping and duration

A container's duration is the latest end of any child; a gap in the middle is black/silent. Time before 0 doesn't exist: a node that starts before 0 loses its head, and a node that ends before 0 is dropped. To leave room at the *end*, add a [`data`](#data) spacer.

A node placed with neither `start` nor a previous node (the first child) starts at 0. An overlay meant to start with the composition therefore needs an explicit `"start": 0` unless it is the first child — without it, it would play *after* the node before it.

### Crossfades

A negative `offset` on a run member starts it that many seconds before the previous node ends and cross-dissolves over the overlap, so the run shortens by the same amount:

```json
{
  "type": "composition",
  "children": [
    { "type": "clip", "source": "a.mp4", "in": 0, "out": 5 },
    { "type": "clip", "source": "b.mp4", "in": 0, "out": 5, "offset": -1 }
  ]
}
```

Clip A (5s) + Clip B (5s, `offset: -1`) → a **9s** composition: B starts at t=4 and the two crossfade over `[4, 5]`.

- Only a **run member** crossfades. A negative `offset` on a run head (a node with `start`, or the first child) just moves it — no fade.
- The fade length is **clamped** to the shorter of the two neighbours.
- It **chains**: each node fades against whichever node precedes it in the run.
- `data` nodes never fade (they produce nothing).
- Crossfade only — there's no transition *type* yet (no wipes/pushes).
- **Video** dissolves by fading the incoming element in over the outgoing one (the outgoing one is simply occluded as the incoming ramps up). **Audio** ramps both sides (incoming up, outgoing down) since audio sums. The fade is linear and matches between the live preview and the exported render.

## Overflow & Underflow

A `clip`, `audio` or `composition` normally occupies its natural duration. Setting `duration` gives it a different output length, and `overflow`/`underflow` decide how the content (`[in, out]` at `speed`) fills it. Both default to `"stretch"`: the playback rate adjusts so the content exactly spans `duration`.

### Overflow (duration shorter than natural)

| Strategy | Effect |
|----------|--------|
| `"trim-end"` | Keeps the beginning, cuts from the end |
| `"trim-start"` | Keeps the end, cuts from the beginning |
| `"trim-center"` | Cuts equal amounts from both ends |
| `"stretch"` | Keeps the full source range but plays faster (default) |

### Underflow (duration longer than natural)

| Strategy | Effect |
|----------|--------|
| `"extend-end"` | Extends the source range past the original `out` point |
| `"extend-start"` | Extends the source range before the original `in` point |
| `"extend-center"` | Extends equally in both directions |
| `"stretch"` | Keeps the original range but plays slower (default) |
| `"loop"` | Replays the content from its start until `duration` is filled; the last cycle is cut short |

```json
{ "type": "clip", "source": "b.mp4", "in": 0, "out": 6, "duration": 3, "overflow": "trim-end" }
```

A 6-second source in a 3-second slot. With `overflow: "trim-end"`, the resolver keeps the first 3 seconds at speed 1 instead of speeding the whole thing up.

With a non-stretch strategy the rate is no longer derived from `duration`, so `speed` may be set alongside it:

```json
{ "type": "clip", "source": "loop.mp4", "in": 0.5, "out": 1.5, "duration": 10, "underflow": "loop" }
```

One second of source shown ten times. Looping a composition replays its inner window the same way. The node's own keyframes (`opacity`, `volume`, spatial fields, …) run across the whole 10 seconds — only the content time loops.

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

A bin entry is `{ id, children }` — strictly a reusable body, not a full composition. Instance-level fields (spatial, in/out, filters, metadata) live on each `binItem` reference, so swapping a bin entry can't reach out and overwrite a reference's authored properties.

A composition with `binItem: "<id>"` adopts the named bin entry's `children` at compile time. The reference's own `children` are ignored.

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

`script` is the body of an anonymous function `(currentNode) => Composition`. At compile time the script receives the composition itself (with bins already resolved and descendants already compiled) and its return value replaces the composition in the rendered tree. The authored `children` stay on the original doc — they're the script's input.

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

Filters apply visual effects to clips, static, text, shapes, maps, and compositions. They are specified as an array on the node.

**Array order does not determine application order.** Filters of the same type are *combined* (multiple `adjust` filters add their brightness and multiply their contrast/saturation/gamma; `colorbalance` offsets add; `colortemperature` scales multiply), and the combined result is applied in a fixed pipeline order:

```
adjust → colorbalance → colortemperature
```

regardless of where each filter sits in the array. So `[colortemperature, adjust]` and `[adjust, colortemperature]` render identically. (A future revision may add true per-filter ordering; today the array is a set, not a sequence.)

**Filters are not animatable** — every parameter is a static number. (The one effect anyone ever keyframed was opacity, which is now the first-class [`opacity`](#opacity) field instead.) To vary a look over time, animate `opacity` or author distinct compositions.

Every filter accepts an optional **`bypass`** boolean. When `true`, the compositor skips that filter entirely — it stays in the array (keeping its parameters) but contributes nothing to the render. This is the on/off toggle an editor UI would use; leaving the entry in place means flipping it back on restores the exact settings.

```json
{
  "type": "clip",
  "source": "footage.mp4",
  "in": 0, "out": 10,
  "opacity": 0.8,
  "filters": [
    { "type": "adjust", "brightness": 0.2, "contrast": 1.1 }
  ]
}
```

### Filter Types

#### adjust

Color and tone adjustments: brightness, contrast, saturation, and gamma.

| Field | Type | Default | Range | Description |
|-------|------|---------|-------|-------------|
| `brightness` | number | `0` | -1 to 1 | Brightness adjustment (additive) |
| `contrast` | number | `1` | -1000 to 1000 | Contrast multiplier |
| `saturation` | number | `1` | 0 to 3 | Saturation multiplier (0 = grayscale) |
| `gamma` | number | `1` | 0.1 to 10 | Gamma correction |

#### colorbalance

Adjusts color balance for shadows, midtones, and highlights independently.

| Field | Type | Default | Range | Description |
|-------|------|---------|-------|-------------|
| `rs`, `gs`, `bs` | number | `0` | -1 to 1 | Shadow red/green/blue adjustment |
| `rm`, `gm`, `bm` | number | `0` | -1 to 1 | Midtone red/green/blue adjustment |
| `rh`, `gh`, `bh` | number | `0` | -1 to 1 | Highlight red/green/blue adjustment |

#### colortemperature

Shifts the color temperature.

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

## Opacity

`opacity` is a first-class field on every visual node (`clip`, `static`, `text`, `rect`, `circle`, `map`, `composition` — not `audio`). It's a multiplier from `0` (fully transparent) to `1` (fully opaque); the default (absent) is fully opaque. Unlike filters, **`opacity` is animatable** — it follows the keyframe-tuple syntax (see [Animation](#animation)):

```json
{ "type": "clip", "source": "v.mp4", "in": 0, "out": 5,
  "opacity": [[0, 0], [1, 1, "ease-in-out"]] }
```

On a composition, `opacity` applies to the whole group as a unit (the children composite first, then the group fades), so overlapping children don't double-expose through each other. (Earlier formats expressed this as an `{ "type": "opacity", "value": … }` filter; that filter no longer exists.)

## Pitch

`pitch` is a **length-preserving** audio pitch shift in semitones, available on the audio-bearing nodes (`clip`, `audio`, `composition`). Fractional values are fine, the schema clamps to ±48, and — unlike `volume` — it is **not animatable**:

```json
{ "type": "audio", "source": "voice.mp3", "in": 0, "out": 10, "pitch": -3 }
```

- **Independent of `speed`.** `speed` changes duration *and* pitch together (varispeed); `pitch` changes pitch alone. They compose: `"speed": 2, "pitch": -12` plays double-time at the original register.
- **On a composition**, `pitch` applies to every audio-bearing descendant, and semitones **add** through nesting — a clip with `pitch: 5` inside a composition with `pitch: 7` shifts +12 total.
- Implemented as a granular (dual delay-line) shifter using the **same audio graph in the live preview and the headless render**, so the two sound identical. Expect a subtle granular character on large shifts and ~50 ms of latency at ±1 octave.

## Inset

`inset` crops a **composition** to a sub-rectangle of its content box. It's **composition-only** — to crop a clip or image, wrap it in a composition and inset that. (This keeps the windowing render cost an explicit, authored choice rather than something every node silently pays.)

It uses the same per-edge shorthand as text `padding`, but each edge is a `Length` (so `%`, px, and `%` ± px all work):

```json
{ "type": "composition", "inset": 100, "children": [ … ] }          // 100px off every edge
{ "type": "composition", "inset": [50, "10%"], "children": [ … ] }  // [vertical, horizontal]
{ "type": "composition", "inset": [0, "50%", 0, 0], "children": [ … ] } // [top, right, bottom, left] → left half
```

Percentages resolve against the matching axis of the content box: `left`/`right` against width, `top`/`bottom` against height.

Semantics (the order within [Spatial Layout](#spatial-layout)): objectFit/`size` build the content box → `origin`/`translation`/`size`/`rotation` place **that box** in the parent (placement is decoupled from the crop — no silent drift) → **`inset` clips a window** out of it, and **`insetMode`** decides how that window maps within the placed box.

### `insetMode`

| Mode | Behavior |
|------|----------|
| `window` *(default)* | Just a clip — the window stays exactly where it sits in the content box (no reposition or resize). The cropped-away area is simply not drawn. |
| `center` | The window is re-centered within the content box (at its own size). |
| `fit` | The window is scaled (aspect-preserving) to fit the content box, centered — letterboxed, like objectFit `fit`. |
| `cover` | The window is scaled (aspect-preserving) to cover the content box, cropping the overflow — like objectFit `cover`. |

```json
{ "type": "composition", "inset": [0, "50%", 0, 0], "insetMode": "cover", "children": [ … ] }
```

`insetMode` is a fixed enum (not animatable). To pan/zoom a crop on screen, animate `inset` (and/or `translation`/`size`), not the mode.

`inset` is **animatable** (keyframe-tuple syntax) for pan/zoom-style crops:

```json
{ "type": "composition",
  "inset": [[0, 0], ["100%", "25%", "ease-in-out"]],
  "children": [ … ] }
```

Both renderers honour animation: the visible sub-rect zoom-fills the placed box (overflow clipped) and the crop animates through the inset keyframes.

## Distort

`distort` pins the four corners of a **composition's** composited content to arbitrary points — a perspective / keystone / "corner pin" warp. It's **composition-only** (like `inset`): to distort a clip, image, or text, wrap it in a composition.

```json
{ "type": "composition",
  "distort": { "x1": "80%", "y1": "10%", "x2": "80%", "y2": "90%" },
  "children": [ … ] }
```

The value is an object with up to eight `Length`s — one per corner coordinate, **clockwise from the top-left**:

| Corner | Keys | Default |
|--------|------|---------|
| top-left | `x0`, `y0` | `"0%"`, `"0%"` |
| top-right | `x1`, `y1` | `"100%"`, `"0%"` |
| bottom-right | `x2`, `y2` | `"100%"`, `"100%"` |
| bottom-left | `x3`, `y3` | `"0%"`, `"100%"` |

Every key is optional; an absent corner stays where it is, so `{}` is the identity. Percentages resolve against the composition's **content canvas** — `x*` against `contentWidth`, `y*` against `contentHeight` — and a **bare number is a pixel offset from the corner's own default** (`x1: -20` pulls the top-right corner 20px in, the same as `"100% - 20"`), mirroring how `translation`'s bare numbers offset from center. Corners may go outside the canvas (`x1: "120%"`).

Semantics:

- The warp is the **projective map** (homography) that sends the canvas's corners to the pinned points — straight lines stay straight and perspective foreshortening is correct, not a bilinear blend that creases along the diagonal. A corner set that isn't a convex quad (a "bow-tie") falls back to a plain two-triangle blend.
- It is **purely visual**. The node's layout rect (`origin`/`translation`/`size`, what siblings see) is unchanged; the warped content may spill outside that rect. It composes with `rotation` (the pinned quad rotates about the authored `origin`), `opacity`, `filters`, and `inset` (the visible window is the matching sub-region of the warped canvas).
- Order within [Spatial Layout](#spatial-layout): objectFit/`size` build the content box → `origin`/`translation`/`rotation` place it → `inset` picks the window → **`distort` warps where that content is drawn**.
- Ignored on the root composition (there is no parent quad to draw into).

`distort` is **animatable** as a single value — keyframes carry a whole corner set and every coordinate tweens in pixels (corners you leave out of a keyframe sit at their defaults in that keyframe):

```json
{ "type": "composition",
  "distort": [[0, {}], ["100%", { "x1": "60%", "y1": "20%", "x2": "60%", "y2": "80%" }, "ease-in-out"]],
  "children": [ … ] }
```

Both the live preview and the headless renderer draw it through the shared WebGPU compositor (the composition takes the FBO path, like a rotated or inset one), so the two match by construction.

## Spatial Layout

A node's on-screen rect is built from three things:

- **`size`** — the final pixel width and height of the node.
- **`origin`** — a point inside the node.
- **`translation`** — a point in the parent's content space.

The renderer places the node so its `origin` lines up with the `translation` point in the parent. Together with `size`, that gives the final rect: `x = translation.x − origin.x`, `y = translation.y − origin.y`. Renderers consume this rect directly — there's no further objectFit math at draw time, and there's no separate `position` / edge-anchoring concept.

An optional **`rotation`** then spins that rect about its `origin` point (see [rotation](#rotation) below).

### Length values

Origin / translation / size and the content-dimension fields all take **`Length`** values:

| Form | Meaning |
|------|---------|
| `25` | bare number — pixel-only offset (no percent component) |
| `"50%"` | percent of the property's reference dim |
| `"50% + 10"` | combined: 50% of reference, plus 10 pixels |
| `"100% - 50"` | combined: 100% of reference, minus 50 pixels |

When you write a bare number (no percent), each property uses its own percent default for the missing component:

| Property | Percent reference | Number-only percent default | Absent default |
|----------|-------------------|------------------------------|----------------|
| `origin` | item's own (post-`size`) dim | `50%` | `"50%"` — center of self |
| `translation` | parent's content dim | `50%` | `0` — center of parent |
| `size` | post-`objectFit` "natural" dim | `0%` | `"100%"` — fills natural |
| `contentWidth` / `contentHeight` | parent's content dim | `0%` | inherits parent's |

So bare `0` for `translation` reads as "center of parent + 0px = center of parent", but bare `0` for `size` reads as "0 pixels". `"0%"` on either is "0% of reference + 0 pixels = the reference's start edge". The asymmetry is intentional: it lets you write origin/translation values as plain offsets from center and size values as plain pixel boxes without surprise.

### Point2D shape

`origin`, `translation`, and `size` are all 2D values written either as an object with optional axes, or as a bare `Length` that applies to both axes:

```json
{ "translation": { "x": 0, "y": -150 } }
```

```json
{ "size": "25%" }
```

In object form, an omitted axis falls back to the absent default — e.g. `{ "size": { "x": "50%" } }` is "half-width, full-height-of-natural".

### rotation

`rotation` spins the node about its `origin` point. It's a single **number in degrees, clockwise**, default `0`:

```json
{ "type": "static", "source": "badge.png", "duration": 5, "rotation": -15 }
```

The pivot is whatever `origin` resolves to, so it composes with the placement model: with the default `origin: "50%"` a node spins about its own center, while `origin: "0%"` (top-left) or `origin: "100%"` (bottom-right) pins the rotation to a corner. Rotation is applied *after* `size` / `origin` / `translation` build the rect — it doesn't change the rect's dimensions, only its orientation.

`rotation` is animatable (a single number per keyframe — not a `Point2D`):

```json
{ "type": "rect", "duration": 2, "size": 200, "rotation": [[0, 0], ["100%", 360, "ease-in-out"]] }
```

Rotating a composition spins the whole group (background + children) as one unit.

### objectFit

`objectFit` decides what `size: "100%"` actually evaluates to for the node, relative to its parent. That's its **only** job — once `size` is in pixels, the source stretches to fill it.

| Value | "100% size" evaluates to |
|-------|--------------------------|
| `"fit"` (default) | Largest box with the source's aspect ratio that fits inside the parent |
| `"cover"` | Smallest box with the source's aspect ratio that covers the parent |
| `"center"` | The source's own intrinsic size — no scaling |

The natural size comes from intrinsic media dims for clip / static / text (the source video / image dims, or the text canvas), and from `contentWidth`/`contentHeight` for compositions. With the default `size: "100%"` and the default `translation: 0`, a node is rendered at its natural size, centered in its parent — the previous "fit objectFit, centered" behavior is now the default.

`objectFit` only affects the node it's set on. It doesn't cascade to children — each child decides its own `objectFit`.

### Content dimensions

Compositions and text nodes carry an inner canvas defined by `contentWidth` / `contentHeight`. These are `Length` values; percentages resolve against the parent's content dim. The root composition is special — it has no parent reference, so the resolver rejects percentage values there.

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

The inner composition's canvas is 800×600. The default `objectFit: "fit"` + `size: "100%"` scales it to fit the parent canvas (1080×1920 portrait by default): natural box = `min(1080/800, 1920/600) × (800, 600) = 1.35 × (800, 600) = (1080, 810)`, centered in the parent. Children inside the inner composition position themselves in 800×600 coords, then get scaled along with the composition's display rect.

To stretch a composition past its aspect ratio, override `size` with explicit per-axis values — e.g. `{ "size": { "x": 1080, "y": 1920 } }` forces the 800×600 content space into a 9:16 box.

### Picture-in-picture example

```json
{
  "type": "composition",
  "children": [
    { "id": "main", "type": "clip", "source": "main.mp4", "in": 0, "out": 30 },
    {
      "type": "clip",
      "source": "camera.mp4",
      "in": 0,
      "out": 30,
      "start": "main",
      "size": "25%",
      "origin": "100%",
      "translation": "100% - 20"
    }
  ]
}
```

`start: "main"` starts the camera with the main clip instead of after it, and its later array position draws it on top. The camera box is 25% of its natural fit-box. Its `origin: "100%"` is the bottom-right corner of the box itself. Its `translation: "100% - 20"` lands 20px in from the parent's bottom-right corner. Pinning origin-bottom-right to translation-bottom-right-minus-20 puts the PiP 20px inside the parent's bottom-right corner.

### Shifting an image without distortion

```json
{
  "type": "static",
  "source": "portrait.jpg",
  "duration": 5,
  "translation": { "x": 0, "y": -150 }
}
```

Defaults take care of the rest: `size: "100%"` evaluates to the aspect-preserved fit-box of the image, `origin: "50%"` is the center of that box, and `translation: { x: 0, y: -150 }` reads as "parent center, shifted up 150px". The image is centered horizontally, shifted up 150px, with no squish.

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
  "translation": [[0, { "x": 0, "y": 0 }], [2, { "x": 200, "y": 0 }]],
  "opacity": [[0, 0], [1, 1, "ease-in-out"]]
}
```

Keyframe values follow the same shape as the static field. For `Point2D` fields (`origin`/`translation`/`size`), each keyframe value can be a scalar `Length` or a `{ x?, y? }` object — axes interpolate independently.

### What can be animated

| Node | Fields |
|------|--------|
| **Clip** | `opacity`, `volume`, `origin`, `translation`, `size`, `rotation` |
| **Audio** | `volume` |
| **Composition** | `opacity`, `inset`, `distort`, `origin`, `translation`, `size`, `rotation` |
| **Static** | `opacity`, `origin`, `translation`, `size`, `rotation` |
| **Text** (and per-run inside `text` array) | `opacity`, `fontSize`, `color`, `backgroundColor`, `backgroundPadding`, `strokeColor`, `strokeWidth`, `lineHeight`, `origin`, `translation`, `size`, `rotation` |
| **Rect** / **Circle** | `fill`, `stroke`, `strokeWidth`, `opacity`, `origin`, `translation`, `size`, `rotation` |
| **Map** | `latitude`, `longitude`, `zoom`, `mapOpacity`, per-path `color` / `progress` / `lineWidth`, `opacity`, `origin`, `translation`, `size`, `rotation` |
| **Any map child** | `pin` |
| **Filters** | Nothing — filter parameters are static numbers (not animatable). |

### Renderer support

The headless renderer honours every animatable field. It runs the same per-output-frame layout the editor preview uses (`buildRenderList`) and composites on WebGPU, so `origin`/`translation`/`size`, `rotation` (about the authored `origin`), `opacity`, `inset`, `distort`, and `volume` all animate identically to the preview. Text and maps rasterize per frame, shapes are drawn analytically on the GPU, and `origin`/`translation`/`size` are re-resolved each frame against the parent's content dims and the node's natural box. Filter parameters are static (not animatable).

Easings (linear, ease, ease-in/out, cubic-bezier) are folded into the baked samples by the same engine the editor preview uses, so the curve shape matches.

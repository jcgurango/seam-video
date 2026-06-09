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

There are eight node types: **clip**, **audio**, **static**, **empty**, **data**, **text**, **graphic**, and **composition**.

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
| `objectFit` | string | no | `"center"`, `"fit"`, or `"cover"` (see [Spatial Layout](#spatial-layout)) |
| `origin`, `translation`, `size` | `Length` \| `{x?, y?}` | no | Spatial layout (see [Spatial Layout](#spatial-layout)) |
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

Visual props (`filters`, `objectFit`, `origin`, `translation`, `size`) are rejected by the schema — `audio` doesn't render to a quad.

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
| `objectFit`, `origin`, `translation`, `size` | — | no | See [Spatial Layout](#spatial-layout) |
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
| `text` | string \| array | yes | Plain string, or an array of strings/`TextRun` objects for inline formatting (see below). `\n` inserts a hard line break |
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
| `contentWidth`, `contentHeight` | `Length` | no | Intrinsic SVG canvas dims (default: parent's content dim). Percentages resolve against the parent (see [Content Dimensions](#content-dimensions)) |
| `filters` | array | no | Visual effects applied in order (see [Filters](#filters)) |
| `objectFit`, `origin`, `translation`, `size` | — | no | Spatial properties (see [Spatial Layout](#spatial-layout)) |
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

#### Hard breaks

`\n` inside a run's `text` forces a line break — the layout breaks at every newline regardless of how much horizontal space is left, and a run of runs / text fragments can span multiple lines. Consecutive `\n`s emit blank lines that still consume one `lineHeight` of vertical space. All other whitespace (spaces, tabs, carriage returns) is collapsed normally.

```json
{ "type": "text", "text": "line one\nline two\n\nafter a blank", "duration": 3 }
```

Inline runs participate the same way — `[ "foo\n", { "text": "bar", "color": "red" } ]` puts a styled "bar" on its own line.

#### Sizing

Text mirrors composition sizing: `contentWidth`/`contentHeight` define the SVG's intrinsic canvas (defaulting to the parent display size; percentages resolve against the parent), then [Spatial Layout](#spatial-layout) places that canvas on the parent. Line wrapping uses the inner box (`contentWidth − padding.left − padding.right`). `\n` in the source text still forces a break inside that inner box.

Both backends share Pretext for layout. The editor preview measures + draws on `OffscreenCanvas`; the FFmpeg CLI path does the same on `@napi-rs/canvas` (Skia) by polyfilling `OffscreenCanvas` server-side, then writes one PNG per static text node and a numbered sequence per animated text node, which ffmpeg pulls in via `overlay`. Glyph metrics are very close but not pixel-identical between the two engines; line breaks land in the same places for typical Latin/CJK content.

### Graphic

A motion-graphics layer with its own internal keyframe timeline. The inner content is described in **fabric.js** terms (`Rect`, `Circle`, `Path`, `Polygon`, `Textbox`, `Image`, `Group`, plus seam-specific `Clip` and `Map`); each keyframe is a snapshot of that object tree, and the runtime tweens between adjacent keyframes.

```json
{
  "type": "graphic",
  "duration": 3,
  "contentWidth": 1080, "contentHeight": 1920,
  "frames": [
    [0,    [{ "id": "r", "type": "Rect", "left": 0,   "top": 200, "width": 200, "height": 200, "fill": "tomato" }]],
    ["50%",[{ "id": "r", "type": "Rect", "left": 400, "top": 800, "width": 200, "height": 200, "fill": "tomato" }], "ease-out"],
    [3,    [{ "id": "r", "type": "Rect", "left": 800, "top": 200, "width": 200, "height": 200, "fill": "tomato", "angle": 360 }]]
  ]
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `type` | `"graphic"` | yes | Must be `"graphic"` |
| `frames` | array | yes | Keyframe tuples: `[stamp, objectTree]` or `[stamp, objectTree, easing]`. At least one entry. `stamp` is a `Length` (number of seconds or `"50%"` of `duration`). Easing applies to the segment leading into this keyframe |
| `duration` | `Length` | no¹ | Internal timeline length in seconds. Defaults to the last keyframe's stamp. Required for percent-stamped frames |
| `loop` | boolean | no | When `true`, the animation wraps from the last keyframe back to the first via a ghost-keyframe pair at the seam |
| `contentWidth`, `contentHeight` | `Length` | no | Design canvas dimensions for the inner objects. Inner-object `left`/`top`/`width`/`height` resolve against this rect (default: parent's content dim). Percentages resolve against the parent (see [Content Dimensions](#content-dimensions)) |
| `clips` | array | no | Reusable sub-clips referenced from inside `frames` by `Clip` objects. See [Sub-clips](#sub-clips) |
| `in`, `out`, `overflow`, `underflow` | — | no | Window into the internal timeline. Same shape as Composition. Defaults: full internal duration |
| `filters` | array | no | Visual effects applied to the rasterized graphic (see [Filters](#filters)) |
| `objectFit`, `origin`, `translation`, `size` | — | no | Spatial properties for placing the graphic onto its parent (see [Spatial Layout](#spatial-layout)) |
| `id` | string | no | Identifier; referenceable by [attachments](#attachments) |
| `start`, `end` | object | no | Time anchors; only meaningful on [attachments](#attachments) |
| `metadata` | object | no | See [Metadata](#metadata) |

¹ `duration` is required unless `start` and `end` are both pinned, or every keyframe stamp is an absolute number (then it defaults to the last stamp).

#### Inner-object boundary

Inside `frames[i][1]` is **fabric's domain**, not seam's. The numeric props on inner objects (`left`, `top`, `width`, `height`, `scaleX`, `radius`, `strokeWidth`, etc.) are plain numbers — the `Length` system (`"50%"`, `"100% - 5"`) stops at the graphic boundary. Inner-object `left: "10%"` is rejected by the schema. Treat each graphic as a single compositable contained sub-scene.

Identity is path-based: across keyframes, an object at the same hierarchical path (its `id`, or its positional index when `id` is omitted) is the same object. Different paths between two adjacent keyframes are not tweened — the prev-side structure holds until the next keyframe replaces it.

#### Object types

| `type` | Notes |
|--------|-------|
| `Rect`, `Circle`, `Polygon`, `Path`, `Textbox`, `Image`, `Group` | Standard fabric.js classes; consult the fabric docs for the full prop list |
| `Clip` | References a sub-clip from `clips`. Fields: `clipId` (required), `startPosition` (sub-clip-local seconds, optional), `repeat` (integer or `-1` for infinite), plus the usual fabric transform props |
| `Map` | Pmtiles-backed map. Fields: `source` (pmtiles filename), `latitude`, `longitude`, `zoom`, `width`, `height`, optionally `paths` (array of `{ color, points: [[lng, lat], …], progress?, lineWidth? }`) for route overlays |

#### Sub-clips

A graphic can declare reusable inner animations under `clips`. Each clip is itself a self-contained sub-animation with its own `frames` array; references from outer keyframes use `{ type: "Clip", clipId, startPosition, repeat }`. Anchors are tracked per outer `Clip` instance — an outer keyframe that re-asserts `startPosition` re-anchors that instance's local clock at that outer time. `repeat: -1` (the default) loops the clip indefinitely.

```json
{
  "type": "graphic",
  "duration": 3,
  "clips": [{
    "id": "pulse",
    "duration": 1,
    "loop": true,
    "contentWidth": 300, "contentHeight": 300,
    "frames": [
      [0, [{ "id": "c", "type": "Circle", "left": 50,  "top": 50, "radius": 50,  "fill": "magenta" }]],
      [1, [{ "id": "c", "type": "Circle", "left": 50,  "top": 50, "radius": 120, "fill": "magenta" }]]
    ]
  }],
  "frames": [
    [0, [{ "id": "p1", "type": "Clip", "clipId": "pulse", "startPosition": 0, "left": 100, "top": 200 }]],
    [3, [{ "id": "p1", "type": "Clip", "clipId": "pulse",                       "left": 700, "top": 1400 }]]
  ]
}
```

#### Maps

`Map` elements composite a maplibre-rendered pmtiles view. `source` resolves the same way as clip sources (relative filename → platform-specific lookup). On web the pmtiles file lives in OPFS; reads are byte-range only — multi-GB pmtiles never fully materialise. Style dispatch picks OSM Bright for vector tiles or a passthrough raster style for raster tiles. The `paths` array overlays geojson lines with optional `progress` (0..1, partial line draw) and `lineWidth`.

Animating a Map across keyframes pans + zooms the same maplibre instance (path-id pooling), so a 30s animated map keeps using one GL context across all frames. Map updates are throttled to one flush per ~16 ms to keep maplibre's tile loader from falling behind.

#### Renderer support

Both the editor preview and the CLI rasterize the same way: fill defaults via fabric's round-trip, interpolate between flattened keyframes, then walk the resulting snapshot onto a fabric `StaticCanvas`. The preview goes to an `HTMLCanvasElement` → WebGPU texture; the CLI goes to `fabric/node` → PNG sequence → MLT `qimage` producer (one PNG per output frame, `ttl=1`). Maps render via maplibre-gl in the browser and via `@maplibre/maplibre-gl-native` (Node 22+ prebuilt) server-side.

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
| `children` | array | no | Child nodes (clip, audio, static, empty, data, text, graphic, composition) played sequentially. Optional; defaults to `[]` for bin-reference and script compositions whose body comes from elsewhere |
| `attachments` | array | no | Anchored children rendered on top of `children` (see [Attachments](#attachments)) |
| `bin` | array | no | Reusable bodies addressable by id. See [Bin & Scripts](#bin--scripts) |
| `binItem` | string | no | Names a bin entry whose body this composition adopts at compile time. See [Bin & Scripts](#bin--scripts) |
| `script` | string | no | JavaScript source. The compile pass runs it against this composition; the return value replaces it in the rendered tree. See [Bin & Scripts](#bin--scripts) |
| `in` | number | no | Window start into this composition's inner timeline (seconds, >= 0) |
| `out` | number | no | Window end into this composition's inner timeline (seconds, > 0) |
| `overflow` | string | no | Strategy when the composition is over-constrained shorter than its natural duration (only fires for [attachments](#attachments) with both ends pinned) |
| `underflow` | string | no | Strategy when the composition is over-constrained longer than its natural duration (only fires for attachments with both ends pinned) |
| `contentWidth` | `Length` | no | Inner canvas width (default: parent's content width). Percentages resolve against the parent; the **root composition** must use a pixel number. See [Content Dimensions](#content-dimensions) |
| `contentHeight` | `Length` | no | Inner canvas height. Same shape as `contentWidth` |
| `filters` | array | no | Visual effects applied in order (see [Filters](#filters)) |
| `backgroundColor` | string | no | Any valid SVG/CSS fill value (e.g. `"#000"`, `"rgba(255,0,0,0.5)"`, `"red"`). Painted across the composition's container rect under all children |
| `objectFit`, `origin`, `translation`, `size` | — | no | Spatial properties (see [Spatial Layout](#spatial-layout)) |
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

A node's on-screen rect is built from three things:

- **`size`** — the final pixel width and height of the node.
- **`origin`** — a point inside the node.
- **`translation`** — a point in the parent's content space.

The renderer places the node so its `origin` lines up with the `translation` point in the parent. Together with `size`, that gives the final rect: `x = translation.x − origin.x`, `y = translation.y − origin.y`. Renderers consume this rect directly — there's no further objectFit math at draw time, and there's no separate `position` / edge-anchoring concept.

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
    { "id": "main", "type": "clip", "source": "main.mp4", "in": 0, "out": 30 }
  ],
  "attachments": [
    {
      "type": "clip",
      "source": "camera.mp4",
      "in": 0,
      "out": 30,
      "start": { "anchor": "main", "timeSource": "output", "anchorPoint": "0%" },
      "size": "25%",
      "origin": "100%",
      "translation": "100% - 20"
    }
  ]
}
```

The camera box is 25% of its natural fit-box. Its `origin: "100%"` is the bottom-right corner of the box itself. Its `translation: "100% - 20"` lands 20px in from the parent's bottom-right corner. Pinning origin-bottom-right to translation-bottom-right-minus-20 puts the PiP 20px inside the parent's bottom-right corner.

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
  "filters": [
    { "type": "opacity", "value": [[0, 0], [1, 1, "ease-in-out"]] }
  ]
}
```

Keyframe values follow the same shape as the static field. For `Point2D` fields (`origin`/`translation`/`size`), each keyframe value can be a scalar `Length` or a `{ x?, y? }` object — axes interpolate independently.

### What can be animated

| Node | Fields |
|------|--------|
| **Clip** | `volume`, `origin`, `translation`, `size` |
| **Audio** | `volume` |
| **Composition** | `origin`, `translation`, `size` |
| **Static** | `origin`, `translation`, `size` |
| **Text** (and per-run inside `text` array) | `fontSize`, `color`, `backgroundColor`, `backgroundPadding`, `strokeColor`, `strokeWidth`, `lineHeight`, `origin`, `translation`, `size` |
| **Graphic** | Outer wrapper: `origin`, `translation`, `size`. Inner objects have their own keyframe system via `frames` (see [Graphic](#graphic)) — animated independently per-property by fabric's interpolation engine, not the keyframe-tuple syntax above |
| **Filters** | every numeric value: `adjust.{brightness,contrast,saturation,gamma}`, `opacity.value`, `colorbalance.{rs,gs,bs,rm,gm,bm,rh,gh,bh}`, `colortemperature.temperature` |

### Renderer support

The CLI ffmpeg / melt path supports every animatable field:

| Field | How it's rendered |
|---|---|
| Text styles (incl. per-run) | Pre-rasterized to a PNG sequence at output fps |
| Graphic frames (fabric objects + sub-clips + maps) | Pre-rasterized to a PNG sequence at output fps via `fabric/node` (and `@maplibre/maplibre-gl-native` for Map elements). One PNG per static graphic, numbered sequence per animated. Same MLT `qimage` + `ttl=1` pipeline as text. |
| `origin` / `translation` / `size` | Re-resolved per output frame against the parent's content dims and the node's natural box (the value of `size: "100%"`); the resulting rect is written into qtblend's `rect` keyframe string as `X Y W H ALPHA`. The source stretches to that rect (qtblend has no native cover/center mode), so authoring with non-default `size` overrides means stretching is intentional. |
| Volume | `volume=eval=frame` with the keyframes baked into a piecewise-linear expression in `t` (clip-local seconds). |
| Filter parameters | `eq` (adjust) uses `eval=frame` + per-parameter expressions. `colorchannelmixer` (opacity), `colorbalance`, and `colortemperature` use `sendcmd` to deliver one stepwise update per output frame to a labelled filter instance. |

Easings (linear, ease, ease-in/out, cubic-bezier) are folded into the baked samples by the same engine the editor preview uses, so the curve shape matches.

# Extensions

Working document for moving Seam to a core + extensions architecture. Status,
decisions and the extension contract live here; `CLAUDE.md` is updated as each
stage lands.

## Principle

Seam and its editor focus on the core editing workflow. Everything else is an
extension that exists per project or per installation.

Seam is middleware and honest about it: a capable short-form editor
(CapCut / Edits territory, reaching into Premiere / Resolve) whose core is
arranging things in time and space. Things that are *made* rather than
*placed* — grades, graphics, maps, captions pipelines — come from outside or
from extensions.

## Rules

- **Extensions are packages.** First-party ones live in `extensions/` as
  workspace packages and are registered statically by every host for now.
  Published names will be `@seam-media/extension-*`. A config file
  (`seam.config.js`, or a data form for the web shell) comes later.
- **Extensions are for the user.** Everyone runs their own set. Only
  first-party extensions carry any guarantee.
- **Entry points, not forks.** An extension contributes through declared
  entry points. It imports only the public extension API, never core
  internals.
- **Real editor surface.** Extensions can add Properties rows, draw gizmos
  and own whole views.
- **Clean breaks.** When a feature moves to an extension the old form is
  removed. No aliases, no converter.

Proposed, not yet confirmed:

- Render-affecting extensions travel with the project; authoring-only
  extensions are per installation and must leave a plain document behind.
- Package entry points split `./core` (pure), `./render` (both hosts, no
  React) and `./editor` (UI).

## Roadmap

| # | Extension | Status | First forces |
|---|-----------|--------|--------------|
| 0 | The `Seam` instance (no extension) | done | explicit registry threaded through validate / compile / resolve |
| 1 | Adjustments | done | property contribution, shader colour stage, Properties rows |
| 2 | Map | done | node-type contract, host services, lifecycle, child placement |
| 3 | Captions (CC cut + CC generation) | stage A done, awaiting JC's test; B–E to do | non-visual node types, a collected channel, overlay rendering, views, commands, services |
| 4 | Text | not started | natural-size feedback into layout, fonts as a host service |
| 5 | Shaders / transitions | not started | general shader command (0 / 1 / 2 inputs), pass chain |
| 6 | Motion suite | not started | embedded app as a view + its own node type |

### 1. Adjustments — scope

`filters` is removed. Five properties become first-class, keyframeable fields
on every visual node, contributed by the extension:

| Field | Range | Identity | Slider span |
|-------|-------|----------|-------------|
| `brightness` | −1 … 1 | 0 | −1 … 1 |
| `contrast` | −1000 … 1000 | 1 | 0 … 2 |
| `saturation` | 0 … 3 | 1 | 0 … 2 |
| `gamma` | 0.1 … 10 | 1 | 0.1 … 3 |
| `temperature` (Kelvin) | 1000 … 40000 | 6500 | 2000 … 12000 |
| `tint` (green–magenta) | −1 … 1 | 0 | −1 … 1 |

`tint`: positive pulls green down (towards magenta), negative pulls red and
blue down (towards green); ±1 is a 50 % pull. It multiplies into the same RGB
scale as temperature and only ever attenuates, so it cannot clip.

`colorbalance` (nine shadow / midtone / highlight values) is dropped: it is a
grading tool. `bypass` and the fold-by-type rule go with the array.

Editor: sliders in the Properties panel plus the existing keyframe stack. The
separate Filters accordion section is deleted. A slider drag is one undo
step; double-click resets (unsets the field).

Where it lives: `extensions/adjustments` (`@seam/extension-adjustments`),
registered by every host. It imports only types from `@seam/core`.

What it kept: the shader maths is the old `adjust` and `colortemperature`
code moved verbatim, so every pre-extension pixel value in
`compositor-adjust.test.ts` still holds.

Things that changed on purpose:

- One value per node. The fold-by-type rule and `bypass` are gone; to stack,
  nest compositions.
- All six fields are keyframeable.
- Fields on the **root** composition now apply to the whole output (the
  render list wraps the frame in one group). Root `filters` used to be
  silently ignored.

Known cost: the stage runs on every quad whenever the extension is
installed, including nodes that author nothing — exactly as the hard-coded
filter code always did. At its defaults it changes no pixel: the Y'CbCr round
trip uses rounded coefficients, but the worst-case drift is about 0.24 of one
8-bit step, under the half step needed to flip a value (checked exhaustively
over all 16.7 million 8-bit colours in a float32 simulation of the shader
maths; the Dawn test covers one colour on the real GPU). So "installed but
unused" matches "not installed", and skipping the maths at defaults would be
a small performance choice only.

### 2. Map — touchpoint inventory (2026-11-22)

Everything outside `packages/map` that knows about maps, pins or pmtiles
today. This list is the requirement for the node-type contract.

| Layer | Where | What it does for map |
|-------|-------|----------------------|
| Schema / types | `core/schema.ts`, `types.ts`, `resolved-types.ts` | `MapSchema`, `MapPathSchema`; `map` in the `Child` union; `PinSchema` + `pin` in the universal spatial fields |
| Samplers | `core/animation/keyframes.ts`, `layout/map-state.ts` | `sampleZoom` (scale-space), `samplePin`, `sampleMapState` |
| Resolver | `core/layout/resolve.ts` | duration = authored `duration`; children placed by runs in map-local time (speed 1, never extend the map); `pin` carried by `spatialExtras`; id-map and window-crop special cases |
| Spatial pass | `core/layout/resolve-spatial.ts` | inner canvas (`contentWidth`/`contentHeight`) like comp/text; children recursion; keeps `spatialInput` on pinned nodes; `resolveBoxProps(…, anchor)` |
| Flatten | `core/flatten.ts`, `cli/commands/flat.ts` | recurse map children |
| Render list | `compositor/RenderList.ts` | basemap `DrawCommand`; children walked in the map viewport; `MapContext` + `projectPin` (imports `@seam/map` projection maths); layered vs flattened |
| Renderer host | `renderer/frameSource.ts`, `mapRasterizer.ts`, `render.ts`, `audio.ts` | async rasterize (awaits tiles) on `@napi-rs/canvas`; pmtiles from fs / http; style JSON read from disk; tile pool per render; proxy + media-collection + audio recursion |
| Preview host | `preview/…/FrameCoordinator.ts`, `MapStore.ts`, `mapPool.ts`, `mapBasePath.ts`, three `main.tsx` | sync draw from whatever tiles are decoded + wake-and-repaint; page-global tile pool; pmtiles resolver injected at boot; themed style memo; clip/audio recursion |
| Editor | `useImport.ts`, `platform/{web,electron,types}.ts`, `exportHelpers.ts`, `remoteSeam.ts`, `propertyCatalog.ts`, `TimelinePanel.tsx`, `playheadKeyframe.ts`, `MediaBrowser.tsx`, `mediaThumbs.ts` | `.pmtiles` drop → map node; byte-range source opener (no blob URL); source walking; Properties rows + "Map" group; block colour; zoom interpolation special case |
| Assets | `renderer/osm-bright/`, CLI `build.mjs` vendoring, `SEAM_RENDERER_ASSETS` | bundled style |

Not in scope: Seam Cloud's `pmtiles` media kind (that is media handling, not
the node).

### 2. Map — what was built

The file format did not change: `"type": "map"` and `pin` are exactly as
authored before, now contributed by `extensions/map`
(`@seam/extension-map`). Core, the compositor and both hosts contain no map
code; `packages/map` and both copies of the OSM Bright style are gone.

- **`@seam/extension-map`** (pure): the `map` node definition, the `pin`
  field, their types, `sampleMapState` / `sampleZoom` / `samplePin`, the
  projection maths and the pin → pixel anchor function.
- **`@seam/extension-map/render`**: the same extension with its rasterizer
  attached (pmtiles + MVT decode + style evaluation + Canvas2D), and the
  style as a module. Hosts that draw register this entry.
- One rasterizer replaced the preview's `MapStore` + `mapPool` and the
  renderer's `MapRasterizer`.

Verification: the golden project's resolved tree is identical apart from the
renames (`pin` → `ext.pin` + `anchored`, `extension: true` on maps), and its
render is bit-identical to the baseline (all 4797 frames + audio), five maps
and fifteen pins included.

Fixed along the way (a pre-existing preview bug): the "loading map…"
placeholder set text alignment and font on the canvas that is then reused
for the real draw, so the live preview's maps differed from the render once
the placeholder had been shown. It is now wrapped in `save()` / `restore()`,
and a preview-mode draw converges to exactly the renderer's pixels (checked
with a one-off script against the golden project's map; there is no
committed test because the repo has no pmtiles fixture).

Not exercised live: a map in the running editor or preview app (the browser
profile used for checks has no pmtiles in its storage).

Left as is, knowingly:

- The editor's media library and Seam Cloud still classify `.pmtiles` as a
  media kind (icon, listing). That is file handling, not the node; turning a
  file into a node goes through the extension's import definition.
- `mapBasePath.ts` (editor, preview) keeps its name; it is the base path for
  any byte-range source.
- Children of an extension container still have no viewport gizmo
  (`locateNode` returned null for map children before, too).

### 3. Captions — design (agreed in discussion, 2026-11-22)

Today `data` does three jobs: the transcript of source footage (inside a bin
entry, read by CC cut), the captions shown in the video (root nodes anchored
to the footage, turned into `text` by the root script) and styling hints
(tags). "data + script" is a hand-rolled captions extension. The Captions
extension takes over all three jobs. **`data` itself stays in core**: data +
scripts was always meant to grow into something, it just hasn't yet.

**A caption is not text.** A caption is what was said and when; how it looks
is decided globally. Text is a designed element. They share layout code, not
a primitive.

- **One node type** for transcript and on-screen caption alike, with **words
  as child nodes** in a run, so retiming a word is ordinary timeline editing
  and "separate by word" / "group words" disappear.
- **Captions bubble**, the way audio already does: a caption is not drawn
  where it sits. It is collected up the tree, its time mapped through every
  composition window / speed / loop, and drawn at a surface. Ancestors do not
  transform, crop, fade or adjust it; only time is mapped. Words outside a
  window are dropped and the caption re-forms from the survivors.
- **Routing is one field on compositions**: `captions: "pass"` (default —
  continue upward) | `"off"` (stop, draw nothing) | `"show"` (stop and draw
  here with this composition's caption style). The root defaults to `"show"`.
- **The extension renders captions itself** (an overlay at the surface),
  from a style template held on the surface: default text properties plus
  per-speaker overrides. It does not expand into `text` nodes.
- **Display phrases are derived by default** from the bubbled word stream.
- **Reauthor**: sets the composition to `"off"` and writes its derived
  captions out as caption nodes beside it, anchored by source time, to edit
  by hand. No automatic revert (undo, or delete them and switch back).
- **Convert caption to text**: one click, for the rare caption that must
  look different.
- **Where a fix goes**: a fact about the footage (a misheard word, a word's
  timing, the speaker) is fixed on the source caption and every use gets it;
  a decision about this edit is what reauthor is for.

**CC cut**

- Its own view, reusing the player / timeline primitives.
- Works on a **selected composition** (bin item or not); never on a bare
  clip. Captions live inside the composition, so they travel with the cut.
- Apply **replaces the selection in place** and is implemented as split +
  run-aware delete at scale — one batch operation built from the same
  per-node split and delete the toolbar uses, one undo step. Anchors to a
  kept moment retarget to its piece; nodes anchored to a cut-out moment are
  removed by the delete cascade.
- Ranges are sorted and merged first. Playing ranges out of order and
  repeating a range (both possible today, by accident of selection order)
  are dropped; reorder or duplicate the pieces on the timeline instead.

**CC generation (transcribe)**

- A command of the extension. Transcribing a composition puts the captions
  inside it, in its inner time.
- The generator-server / Seam Cloud connection stays in core's editor and is
  handed to the extension as a service it can make requests through. Cloud /
  generator work is out of scope for this migration.

### 3. Captions — plan (agreed 2026-11-22)

Each stage green; the golden project checked at C and E.

| Stage | Builds | New contract |
|-------|--------|--------------|
| A ✔ | `caption` + `word` node types validate and resolve; `captions` routing field and caption style on compositions | node types with no visual presence; restricted children; a span taken from children; fields that target compositions only |
| B | Collecting captions: a pure function over the resolved tree giving every caption and word with its output time at its surface; derived display phrases; subtitle export falls out | a collected channel |
| C | Rendering: the overlay at each surface, in both hosts; golden parity (see below) | overlay rasterizers |
| D | Editor: transcribe command, words edited as children, reauthor, convert to text, a derived caption lane on the timeline, the CC cut view with batch split + delete | commands, views, services, document / selection / playhead access |
| E | Remove the transcription-specific uses of `data` from the editor: the word tools, the old CC cut mode and its bin-only entry point. The `data` node type stays | — |

Golden project: its captions become caption nodes and the root script goes
away. To keep a pixel check, the converted copy would hold the 102 root
phrases as **authored** captions (the reauthored state, source composition
`"off"`) with a style reproducing the script's text properties, so stage C
can be compared against the baseline. Derived phrasing is new behaviour and
is judged by eye.

Settled details:

- A caption may carry a small **style override** (the script's larger font
  for "LIT" and its italics-by-tag become these).
- **Derivation rule, first version:** authored caption boundaries are hard
  breaks; a caption longer than a maximum character count is split at word
  boundaries; short neighbours are not merged.
- Words are a second node type, **`word`**, the caption's children.
- Extension dependencies (`requires`) wait until text is extracted — Captions
  uses core's text layout until then, so nothing needs the declaration yet.

## Decision log

| Date | Decision | Why |
|------|----------|-----|
| 2026-11-22 | Registry is an explicit instance (`createSeam(extensions)`), not a module global | Per-project extension sets in one process; keeps core free of hidden state; a later config file just supplies the list |
| 2026-11-22 | Contributed fields are flat (`brightness: 0.1`); a duplicate key is a registration error | "First class" means flat; collisions must be loud |
| 2026-11-22 | A document using an unregistered field fails validation | Every node schema is already `.strict()`; silently ignoring a render-affecting field gives wrong pixels |
| 2026-11-22 | Adjustments contribute a WGSL colour stage fused into the existing fragment shader; uniform slots allocated at registration; a `prepare` hook for CPU-side maths (Kelvin → RGB) | Keeps one pass per quad; the pass chain arrives with the general shader command |
| 2026-11-22 | Stage order across extensions = registration order | Simplest rule that is deterministic |
| 2026-11-22 | `colorbalance` dropped; a `tint` scalar added | Grading left Seam; tint covers the green cast temperature cannot |
| 2026-11-22 | `filters` removal is a clean break, no converter | Standing project rule |
| 2026-11-22 | Adjustments are keyframeable | Properties-panel sliders + keyframes replace the Filters panel |
| 2026-11-22 | A field is declared once, as data (`FieldSpec`: key, type, range, default, animatable, presentation hints) — extensions do not hand core a Zod schema | One declaration drives validation, sampling and the Properties row; keeps Zod out of the extension API |
| 2026-11-22 | The render list and compositor take what they need explicitly (`new Compositor(backend, seam)`); the registry does not ride on the resolved timeline | Only a handful of call sites; data stays plain (it crosses IPC in the preview app) |
| 2026-11-22 | Resolved nodes carry contributed fields in an `ext` bag, authored values verbatim | Flat is the authoring rule; internally a bag lets the render list sample without knowing the extension set |
| 2026-11-22 | Root-composition fields apply to the whole frame | Silently ignoring a render-affecting field is the failure mode the validation rule exists to prevent |
| 2026-11-22 | Slider span (`softMin`/`softMax`) is separate from the valid range | `contrast` validates −1000…1000, which is useless as a control |
| 2026-11-22 | The field spec covers the kinds the Properties panel already renders (number, string, enum, colour, length); structured values use a `custom` field whose schema the extension builds with core's own Zod (`(z, h) => …`) | Simple fields get rows for free; `paths` and `pin` want a purpose-built editor, not a generated form |
| 2026-11-22 | `pin` is a field the Map extension contributes to every visual node | Keeps the format; without the extension a document using `pin` fails validation |
| 2026-11-22 | No general "lower to render commands" hook. A node type declares `children`, `draws` and `createAnchors`; core does the walk | Map needs nothing more; a hook nobody uses is an API to maintain |
| 2026-11-22 | Extension node and field TYPES reach TypeScript by declaration merging (`ExtensionNodeTypes`, `ResolvedExtensionNodeTypes`, `VisualExtensionFields`) | A union member with `type: string` destroys discriminated-union narrowing everywhere; merged literal types keep it, and a program is typed for exactly the extensions it imports |
| 2026-11-22 | Resolved extension nodes carry `extension: true` | Registry-free code (spatial pass, flatten, hosts) tells them from core types without a Seam instance (`asExtensionNode`, or `"extension" in node`) |
| 2026-11-22 | A rasterizer is attached to the node definition by the package's `./render` entry; the pure entry has none | Validate / resolve consumers never load pmtiles or the style evaluator |
| 2026-11-22 | One rasterizer for both hosts: sync `draw` from what is loaded + `requestRepaint`, and an optional async `ensure` the offline renderer awaits | Removes two parallel host adapters; parity by construction |
| 2026-11-22 | In the preview, rasterizers are page-lifetime (one per Seam instance and node type) | Decoded tiles stay warm across timelines and remounts, as the page-global tile pool did |

## Open questions

- Does a `.seam` declare the extensions it requires (names, versions)?
  Deferred until dynamic loading.
- Adjustments does not yet merge its six fields into
  `VisualExtensionFields` (Map does for `pin`), so TS code authoring
  `saturation` on a typed node still casts.
- A custom editing surface for `paths` and `pin` (click on the map).
- One shared "first-party extension list" module vs each host listing its
  own (today: each host).
- Sandboxing of project-local extension code (remote `.seam`, cloud render).
- Whether `rect` / `circle` leave core once the shader command exists.

## Extension contract

Grows only when an extension needs it.

### The instance (stage 0)

```ts
import { createSeam } from "@seam/core";

const seam = createSeam([/* extensions, in registration order */]);
seam.validate(input);
seam.parseSeamFile(json);
seam.compileSeamFile(doc, { runScripts });
seam.resolveComposition(composition, { uncropped });
```

- `validate`, `parseSeamFile`, `compileSeamFile` and `resolveComposition` are
  no longer exported from `@seam/core`; an instance is the only way to reach
  them. A call site that forgot its instance is a type error, not a silent
  fallback to "no extensions".
- Everything that does not depend on the extension set stays a plain export
  (`resolveSpatial`, samplers, anchor / loop / clip-span helpers, …).
- An extension today is just `{ name }`. Duplicate or empty names throw at
  `createSeam`.

Where each host gets its instance:

| Host | Instance |
|------|----------|
| CLI | `packages/cli/src/seam.ts` |
| Preview app | `packages/preview/src/seam.ts` (main and renderer processes) |
| Editor (Electron) | created in `packages/editor/src/renderer/main.tsx`, passed as `<App seam>` and to `detectPlatform(seam)` |
| Editor (web) | created in `packages/web/src/main.tsx`, passed as `<App seam>` and to `new WebPlatform(seam)` |
| Renderer | no instance of its own: `renderSeamToFile(seam, seamPath, outPath, options)` |

Inside the editor: components and hooks call `useSeam()` (context provided by
`App`); pure-logic tools take `seam` as their **first argument**
(`sliceAtPlayhead(seam, doc, t)`, `resizeChild(seam, …)`,
`descendToContainer(seam, …)`, `applyPropertyEdit(seam, …)`, …). Tests create
their own with `createSeam()`.

### Fields (stage 1)

```ts
const ext: SeamExtension = {
  name: "adjustments",
  fields: [
    { key: "saturation", nodes: "visual", type: "number",
      min: 0, max: 3, softMin: 0, softMax: 2, default: 1, step: 0.01,
      animatable: true, label: "Saturation", group: "Adjustments" },
  ],
  colorStage: { … },
};
```

- `nodes: "visual"` is the only target: clip, static, text, rect, circle,
  composition (`VISUAL_NODE_TYPES`) and every extension node type.
- **Schema:** built per instance (`buildSeamFileSchema`). Node schemas are
  strict, so an unregistered field fails validation. A key that collides
  with a core field or another extension's throws at `createSeam`.
- **Resolver:** authored values (plain or keyframes) ride on the resolved
  node as `ext: { saturation: … }`; on the root as `ResolvedTimeline.ext`.
- **Render list:** samples `ext` per frame in the node's own time into
  `fields` on every draw / fill / group command. A container with any
  authored field takes the FBO path.
- **Editor:** `extensionProps(seam)` turns each field into a Properties row
  (label, group, placeholder = default, keyframe toggle, slider when it has
  a range). `catalogFor(seam, type)` / `sharedProps(seam, nodes)` /
  `rootProps(seam)` append them.

### Field kinds (stage 2)

| `type` | Value | Properties row |
|--------|-------|----------------|
| `number` | number (`min` / `max`), optional custom `sample` | number box; slider when it declares a control span |
| `string` | non-empty string; `source: true` = a media path | text box |
| `enum` | one of `options` | select |
| `color` | CSS colour string | swatch + text |
| `length` | `Length` | percent + px |
| `custom` | whatever `schema(z, h)` returns | none (JSON panel) |

Any kind may be `animatable` (a `custom` field wraps keyframes itself with
`h.keyframed`). A `custom` field on visual nodes may be flagged `anchor`: it
positions the node inside an extension container, so layout re-evaluates per
frame.

### Node types (stage 2)

```ts
const mapNode: NodeTypeDef = {
  type: "map",
  fields: [ /* the node's own fields — no `nodes` */ ],
  children: true,          // a container
  draws: true,             // emits its own draw, beneath its children
  createAnchors(node, t, duration, inner) { … return (child, t, d) => ({ x, y }) | null },
  editor: { color, border },
  import: { extensions: ["pmtiles"], byteRange: true, create(source, { duration }) { … } },
  rasterizer: createMapRasterizer,   // only on the ./render entry
};
```

Core gives every extension node, undeclared: `duration` (required — the
node shows for exactly that long), an inner canvas (`contentWidth` /
`contentHeight`, default 100 % of the parent), the spatial fields, placement
(`id` / `start` / `offset`), `metadata`, and every field extensions
contribute to visual nodes.

- **Schema:** generated per instance around the declared fields; a type name
  or field key that collides with core or another extension throws at
  `createSeam`.
- **Resolver:** a leaf for timing; own fields ride flat on the resolved node,
  authored values verbatim, with `extension: true`. A container's children
  are placed by runs in node-local time at speed 1 and never extend it.
- **Spatial pass / flatten / audio / clip collection:** generic over
  `asExtensionNode(node)`.
- **Render list** (`buildRenderList(seam, …)`): the node's own draw at its
  inner-canvas size and node-local `drawTime`, then its children; each
  child's origin goes through the container's anchor function, built once
  per frame.
- **Sources:** `string` fields flagged `source` are walked by export, remote
  .seam, import rewriting and `--proxy`.
- **Editor:** the catalog (`catalogFor`) is the type's source fields,
  duration, placement, its other fields, spatial, inner canvas; the block
  colour comes from `editor`; dropped files matching `import.extensions`
  become the node `import.create` returns.

### Non-visual node types and composition fields (stage 3A)

```ts
{ type: "caption", visual: false, children: ["word"], span: "children", fields: [ … ] }
{ key: "captions", nodes: "composition", type: "enum", options: ["pass", "off", "show"] }
```

- **`visual: false`**: no spatial fields, inner canvas or visual extension
  fields in the schema; the resolved node carries `nonVisual: true` and no
  spatial data; the spatial pass and the render list skip it and everything
  under it; the editor gives it no gizmo and a timing-only catalog. Such a
  type cannot `draws`, anchor or rasterize.
- **`children: [types]`** restricts what a container holds (a caption holds
  only words). `children: true` still means any node.
- **`span: "children"`**: `duration` becomes optional and defaults to the
  extent of the children, like a composition; an authored `duration` wins.
- **`nodes: "composition"`** targets compositions only, the root included.
  The value rides in the resolved composition's `ext` (root:
  `ResolvedTimeline.ext`). TypeScript: `CompositionExtensionFields`.
- Only fields a colour stage consumes (numbers) make a container take the
  group path; a structured or routing field in `ext` does not. (Since stage 2
  a pinned composition had been taking it needlessly — fixed here.)

### Rasterizers and host services (stage 2)

```ts
rasterizer(host) → {
  draw(node, drawTime, width, height): CanvasLike | null   // sync, from what is ready
  ensure?(node, drawTime, width, height): Promise<void>    // the renderer awaits this
  clear?(): void                                           // new timeline
  dispose(): void | Promise<void>
}
host = {
  createCanvas(width, height),   // browser canvas / @napi-rs/canvas
  openSource(source),            // byte ranges: OPFS, file://, fs, http
  requestRepaint(),              // async content landed
}
```

- Renderer: `NodeRasterizers` (`packages/renderer/src/nodeRasterizers.ts`),
  one set per render run, reads the returned canvas back as RGBA.
- Preview: `media/nodeRasterizers.ts`, page-lifetime; the shell injects the
  source opener with `setByteSourceResolver` (was `setPmtilesResolver`);
  platforms expose `openByteSource` (was `openPmtilesSource`).

### Colour stages (stage 1)

```ts
colorStage: {
  slots: 2,                       // vec4f uniform slots
  entry: "adj_stage",
  wgsl: "fn adj_stage(rgb: vec3f, eq: vec4f, scale: vec4f) -> vec3f { … }",
  prepare(values, out) { … },     // sampled fields → slots × 4 floats
}
```

- The compositor assembles its fragment shader per instance:
  `new Compositor(backend, seam)`. Stages run in registration order on
  gamma-encoded RGB, after the texture sample and before the shape mask, in
  the same single pass per quad.
- Each stage owns a run of slots in one `ext: array<vec4f, N>` uniform
  member, after the fixed members. `prepare` is called per draw per frame
  with the command's sampled `fields`; a missing key means the default.
- WGSL identifiers must be prefixed (`adj_…`); a duplicate entry name throws
  at `createSeam`.
- Per-pixel only. Anything that samples neighbours, takes two inputs or
  generates content waits for the general shader command (roadmap 5).

Hosts pass the instance to the compositor: the renderer through
`renderSeamToFile(seam, …)`, the preview through `<Timeline seam>` /
`<Player seam>`. Hosts that draw list the `./render` entries:
`createSeam([adjustments, map])` with `map` from `@seam/extension-map/render`.

## Golden project

`/Users/jc/Downloads/GoldenTestVideo/GoldenTestVideo.seam` — 160 s,
1080×1920, 77 clips, 24 statics, 5 maps, 5 text nodes, 538 `data` nodes turned
into captions by the root script, 19 bin references. JC's own acceptance set.

It exercises exactly one filter: `adjust` with `saturation: 0` on the clip at
`children.0.children.0.children.1` (about 1.2 s – 3.4 s). Since stage 1 the
authored file no longer validates. `GoldenTestVideo-extensions.seam` beside it
is the same project in the current syntax (`"saturation": 0` on that clip);
future syntax changes go into that copy and the original stays as authored.

Baseline renders live in `_baseline/` inside that folder, named by commit.
`GoldenTestVideo-d78e536.mp4` is the pre-extensions reference. Stage 0
rendered all 4797 frames and the audio bit-identical to it (ffmpeg `psnr` +
audio md5).

`packages/renderer/src/__tests__/compositor-adjust.test.ts` pins the pixel
output of every adjustment (leaf and FBO-group paths) as captured from the
`filters` implementation; stage 1 must keep it passing with only its
`adjusted()` helper rewritten.

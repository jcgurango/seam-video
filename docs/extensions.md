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
- **Three layers, one contract** (agreed 2026-11-25). Code reaches a
  document from three places that differ only in where it lives and who
  vouches for it:

  | Layer | Lives | Vouched for by | For |
  |---|---|---|---|
  | Core | Seam | Seam | the editing model: timing, layout, compositing, simple nodes |
  | Bundled extensions | the installation | the user, as curator | what many projects need (text, captions, maps) |
  | Project extensions | the project folder | the project's author | the one-off: this chart, this 3D scene |

  All three use the same extension contract, so a project extension that
  earns its place moves into the bundled set unchanged. Promotion rule:
  written twice → an extension; needed by every project → core.
- **Two escape hatches.** Compile-time scripts generate ordinary nodes
  (editable, limited vocabulary). Project extensions draw (anything, but
  opaque pixels). If the editor should understand a thing, it gets a real
  node type.

Proposed, not yet confirmed:

- Render-affecting extensions travel with the project; authoring-only
  extensions are per installation and must leave a plain document behind.
- Package entry points split `./core` (pure), `./render` (both hosts, no
  React) and `./editor` (UI).

## Roadmap

**How work is organised from here (JC, 2026-11-25).** Phase A moved what
existed out of core (rows 0–4). Phase B builds the **project-extension
system** (row 5). After that the contract grows **project by project**: JC
feeds a concrete use case, I work toward it, and the contract gains only what
that use case needs. Each addition is recorded in "Extension contract" with
the project that introduced it. The contract is done when JC says it is.
The old rows "Shaders / transitions" and "Motion suite" are no longer
scheduled; they come back as use cases if and when JC brings them.

| # | Extension | Status | First forces |
|---|-----------|--------|--------------|
| 0 | The `Seam` instance (no extension) | done | explicit registry threaded through validate / compile / resolve |
| 1 | Adjustments | done | property contribution, shader colour stage, Properties rows |
| 2 | Map | done | node-type contract, host services, lifecycle, child placement |
| 3 | Captions (CC cut + CC generation) | done (A–E) | non-visual node types, a collected channel, overlay rendering, views, commands, services |
| 4 | Text | evicted into `extensions/text`; `wrap: false` (text sized by what it says) added on top. Awaiting JC's test | extension dependencies (`requires`), leaf self-drawing nodes, New-panel tiles, measured inner canvases |
| 5 | **Project extensions** (Phase B) | next — being scoped | extensions loaded from the project folder; a per-document `Seam` instance; bundling project code; trust |

### Use-case projects (Phase C)

One row per project JC brings. Each names the use case, what the contract
gained, and its status.

| Project | Use case | Contract gained | Status |
|---|---|---|---|
| — | — | — | — |

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
| B ✔ | Collecting captions: a pure function over the resolved tree giving every caption and word with its output time at its surface; derived display phrases; `toSrt` / `toVtt` | a collected channel (`walkResolved`) |
| C ✔ | Rendering: the overlay at each surface, in both hosts; golden parity (see below) | overlays (`OverlayDef`, `OverlayRasterizer`, `SurfaceView`) |
| D1 ✔ | Editor commands: generate captions, reauthor, convert to text; the batch keep-ranges cut (`cutTool.ts`); transcription as a service | commands, tools, services (`EditorExtension`) |
| D2 ✔ | The view contract (`EditorExtension.views`) and the CC cut view on a selected composition (using `keepRanges`), previewed live | views, preview documents, the player |
| Style ✔ | A built-in default caption style; a "Caption style" section in the Properties panel (every textual property, `maxChars`, speaker overrides); presets kept with the editor's settings | property editors, extension storage |
| D3 ✔ | Reauthoring at the word level with the editor's OWN tools: Slice cuts a caption between words, an edge drag retimes its first / last word, `CC+` merges captions. Generated captions carry no `duration` when they have words; zero-length words are repaired. (The derived caption lane was DROPPED: materialized things do not show on the timeline anywhere else) | node-type editing hooks (`editor.split` / `resize` / `blockLabel`) |
| E ✔ | Remove the transcription-specific uses of `data` from the editor: the word tools, the old CC cut mode and its bin-only entry point. The `data` node type stays | — |

Stage C result: see "Golden project" at the end of this document.

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
- Extension dependencies: Captions declares `requires: ["text"]` (built with
  the Text eviction).

## Where we are (handoff, 2026-11-22)

Committed by JC: everything through Captions (`99bfbc1 Phase 2: Captions
extension`). **Uncommitted in the working tree: roadmap item 4 — Text
evicted from core into `extensions/text`** (`@seam/extension-text`).

What moved:

- the `text` node type: schema, types, resolve branch, spatial special
  cases and the flatten branch are gone from core; the node is now a
  `NodeTypeDef` with its fields declared as data;
- the layout engine (`textLayout.ts`, `textCanvas.ts`, the Pretext
  dependency) → `extensions/text/src/render/`;
- the hosts' text paths: the preview's `TextStore` and the renderer's
  `frameSource` text branch are deleted — both hosts draw text through the
  one rasterizer the extension attaches, like a map;
- the editor's hand-written text catalog, timeline label, block colour and
  New-panel tile → generated rows / `editor.blockLabel` / `editor.palette`;
  the text itself and `padding` are edited in the extension's own
  "Text content" Properties section.

Captions now `requires: ["text"]` and takes the layout engine from
`@seam/extension-text/render`. Every host installs
`[adjustments, map, text, captions]`.

What stays in core, on purpose: the font-fallback family names
(`text/fallbackFonts.ts` — the Map extension's labels use them too), the
`TextPadding` box type and `samplePadding`. Font REGISTRATION is still each
host's own job (renderer `installFonts`, browser `loadFallbackFonts`) and
the Node `OffscreenCanvas` shim still lives in the renderer.

Behaviour that changed (all small):

- a `text` node cut by a composition window (or the crop at 0) now keeps
  its keyframes on its original span, like any extension node, instead of
  re-running them over the shortened one;
- `letterHeight` must be a non-negative percentage (`"120%"`); the old
  schema also let a negative one through;
- in the Properties panel `fontStyle` is a text box (it was a 3-way
  select), `padding` accepts the 2- and 4-value forms, and the text / padding
  rows sit in their own section below the generated ones;
- a document with `text` nodes does not validate on a Seam instance without
  the Text extension (true of every host's own instance; relevant to tests
  and to anyone calling `createSeam()` bare).

Verified: build + all tests; live in the web editor (New tile, block label,
runs, animated font size, rotation gizmo, Properties rows, a caption over
text). Golden: bit-identical to the reference (see "Golden project"). NOT exercised: the Electron shell, a
Docker build of the web image.

**Added on top (uncommitted): `wrap: false`** — JC's planned "single line
of text" (old Flash's, or SVG's). Lines break only at `\n`, and the node's
inner canvas is the MEASURED size of the text plus `padding` instead of
`contentWidth` / `contentHeight` (authoring those with it is a validation
error). From there it is an inner canvas like any other: the parent's
`objectFit` fits it, `size` / `origin` / `translation` place it — a piece of
rasterized media whose intrinsic size is the text's. See "Measured inner
canvases" in the contract. Verified by unit tests on the real Skia path and
a rendered sample frame (true size + rotation, `origin: "0%"`, a fitted
one); not looked at in the browser editor.

`objectFit` (confirmed by JC, 2026-11-22): a container's `objectFit` fits
its CHILDREN; a node is fitted by its parent's. So unwrapped text at true
pixel size needs `objectFit: "center"` on its container. `FILE-FORMAT.md`
said the opposite and is corrected.

**`fitSelf`** (core, added at JC's request): a visual node's own fit into
its parent, overriding the parent's `objectFit` for that node alone. Not
inherited by its children; refused on the root. `resolve-spatial.ts`
(`fitForSelf = input.fitSelf ?? parentObjectFit`) — the render list and the
gizmo already read the per-node baked fit. `fitSelf: "center"` on unwrapped
text is the direct way to its true pixel size.

**Next, in order:**

1. Roadmap row 5, project extensions. Scope it with JC first (open
   decisions: how a project declares its extensions, TypeScript, the trust
   prompt); no code before he confirms.
2. Loose ends: fonts as a host service (my idea, not a request — JC has it
   noted; only worth building for per-project or extension-shipped fonts);
   a CLI command for `toSrt` / `toVtt`; converting
   the golden project's bin-entry transcript `data` nodes; Adjustments
   merging its fields into `VisualExtensionFields`; caption preset rename;
   the renderer's `planned-source` test is load-sensitive.

**How JC wants this run:** one stage at a time, each green (build + tests),
then stop and let him test and commit — he commits himself. Check the golden
project per stage but do not chase sub-visible drift (see "Golden project").
Clean breaks, no converters. Keep this document and `CLAUDE.md` current.

## Decision log

| Date | Decision | Why |
|------|----------|-----|
| 2026-11-25 | Next step is the project-extension system; afterwards the contract grows only through concrete use-case projects JC brings, until he calls it done | JC's plan: grow the API from real needs, not from a speculative roadmap |
| 2026-11-25 | Project code reaches a document as a project-local *extension* on the same contract as bundled ones (not a separate "code node" API) | Promotion to the bundled set is then free, and a one-off still gets fields, Properties rows and validation |
| 2026-11-25 | Shaders / transitions and the motion suite are unscheduled; they return as use cases if JC brings them | Same reason |
| 2026-11-23 | Desktop first; web and cloud stagnate. If web returns it ships a curated extension set | JC: diverging installations make "a hosted editor that opens any project" incoherent; the reasons web existed (Electron HDR, mobile) are gone. See `docs/platforms.md` |
| 2026-11-23 | `objectFit` on a container fits its children (inherited); a node is fitted by its parent's. `fitSelf` overrides that per node | JC confirmed the code's rule as intended and asked for the override; mixed fits in one container, true-size text without a wrapper |
| 2026-11-22 | Unwrapped text (`wrap: false`) is a property of the text node; its measured box is its inner canvas and `objectFit` applies to it as to a composition's. No max width / height | JC's plan: single-line text whose natural size is the rendered text; you own the line breaks; resampling under `fit` is accepted (fix with font size / padding, supersampling later if needed) |
| 2026-11-22 | `padding` is kept on unwrapped text | JC: otherwise a background with background padding overflows the box |
| 2026-11-22 | The spatial pass takes an optional measurer, so a host that can draw gives measured nodes a real size at resolve time | JC asked whether resolve could give a rect; the CLI's `resolve` supplies one |
| 2026-11-22 | Text moved out of core as a pure relocation: same pixels, same fields. Natural-size feedback and a font host service are NOT part of it | My call (JC asked for the eviction): a move that must keep the golden render should not also change how text is sized |
| 2026-11-22 | An extension node type that draws itself and has no children is a leaf in the render list (one quad, no layer) | Text must composite exactly as it did; routing every rotated / faded text through an FBO would cost a pass and resample it |
| 2026-11-22 | Extensions declare dependencies with `requires` | Captions needs Text's layout engine and writes `text` nodes |
| 2026-11-22 | Slicing a caption duplicates its anchor, moved forward, instead of making the halves one run: seconds are added to a numeric / source-time anchor; a bare-id or percentage anchor takes the shift as `offset` | JC: each half should stay anchored to its own moment (revises the earlier "single run" wording) |
| 2026-11-22 | Word-level reauthoring uses the editor's own verbs (Slice between words, edge drag, Merge) — no word editor, no transcript view | JC: now that Seam knows what a caption is, Slice can act on it; split → adjust → regroup is the workflow he already has |
| 2026-11-22 | Generated captions are each placed on their own, not as one run with offsets | JC: positions are derived at merge time (earliest start wins); a single run is the consequence of authoring |
| 2026-11-22 | A caption with words carries no `duration` | JC: duration is only needed when there are no children to give a natural one |
| 2026-11-22 | A zero-length Whisper word borrows half of the next word (else the previous; else the line) | JC: it used to be an error / a lost word |
| 2026-11-22 | No derived caption lane on the timeline | JC: materialized content shows on the timeline in no other situation — it would bend the principle |
| 2026-11-22 | Captions have a built-in default style; a surface's `captionStyle` overrides it key by key | JC: captions should simply work before anyone personalises them |
| 2026-11-22 | Caption style presets are stored by the editor (with its settings), not in the document; the composition records only the preset's name in `metadata` | JC: presets are editor-specific; the name is enough to show whether the two have drifted |
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
| 2026-11-22 | An extension's `./editor` entry may depend on React and export view components; the editor passes its player / timeline primitives as props | Later roadmap items (motion suite) need real views; CC cut should be the extension's own view, not editor code fed with data |
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
  Deferred until dynamic loading. More pressing with desktop-first
  (`docs/platforms.md`): a project opened on an installation missing one of
  its extensions just fails validation today.
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

### Collected channels and overlays (stage 3B–C)

Captions are not drawn where they sit; they are gathered up the tree and
drawn at a surface. Two contract pieces make that possible.

**`walkResolved(children, visit, offset?, rate?)`** (core) walks a resolved
tree through compositions (speed, and loops unrolled into the cycles they
play) and extension containers, giving `visit` each node with its span in
the walk root's time; returning `false` skips a subtree. It is the same time
mapping `flattenResolved` and the audio mixers use. Composition windows need
no handling: the resolver already crops and rebases a windowed composition's
children.

```ts
overlays: [{
  key: "captions",
  active(surface, t) { … },            // pure; asked every frame
  rasterizer: createCaptionsRasterizer // only on the ./render entry
}]
surface = { root, ext, children }      // the root, or a composition
rasterizer(host) → { draw(surface, t, width, height): CanvasLike | null, ensure?, clear?, dispose }
```

- The render list asks every overlay, for the root and for each active
  composition, whether it has something to show at that surface's inner time,
  and emits one draw for it **on top of that surface's children**, filling
  its viewport at its inner-canvas size. The drawable is
  `{ overlay, surface }`, one stable object per pair.
- At the root the overlay sits outside the root's colour-stage group: a look
  applied to the whole video does not recolour its captions. In a composition
  that is a surface it is part of that composition's content.
- Hosts get the pixels from the overlay's rasterizer exactly as they do for a
  self-drawing node (`"overlay" in drawable`).

**A node cut by a composition window.** A resolved extension node whose span
a window (or the crop at time 0) cut into carries
`window: { offset, duration }` — where the visible part starts on its own
span, and that span's full length. Its content runs on that original span
(`extensionContentSpan(node)`): the render list gives the node's own draw and
its anchor function `offset + t`, and a rasterizer samples against
`duration`. Its children are cropped and rebased to the visible part, like a
composition's. Before this, a map cut at its head restarted its camera and
mistimed its children.

### The editor side (stage 3D)

An extension's **`./editor`** entry exports an `EditorExtension`. The types
live in core (`editor-api.ts`), so an extension still depends on nothing but
`@seam/core`; the editor never gets imported by an extension.

```ts
export const captionsEditor: EditorExtension = {
  name: "captions",
  commands: [{ id, label, title, enabled?(ctx), run(ctx) }],
  views: [{ id, label, title, enabled?(ctx), component }],
};
```

A command runs against an `EditorCommandContext` the editor builds from its
own state:

- `document`, `selection` (path keys), `node(key)`, `resolve(key)` (the node
  resolved on its own: bins inflated, scripts off, its window applied);
- `edit(next, { select? })` — one undo step; `notify(messages)`;
- `tools` — pure document edits by path key: `updateNode`, `appendChildren`,
  `parentKey`, `freshId`, and **`keepRanges`**;
- `services.transcribe()` — transcribes the selected root-level clip / audio /
  composition nodes through the editor's generator-server or Seam Cloud
  connection (which stays in core) and returns the segments per node WITHOUT
  touching the document. The editor shows its own progress, errors and the
  composition mix-mode prompt.

Shells pass the list: `<App seam editorExtensions={[captionsEditor]}>`. The
toolbar renders each command as a text button after the built-in ones.

**`keepRanges(doc, key, ranges)`** (`packages/editor/src/renderer/cutTool.ts`)
is split + delete at scale, for a composition: the ranges (inner time) are
sorted, clamped and merged; the composition becomes a run of pieces with one
`in` / `out` window each (same body, so its captions travel with it); the
first piece takes over `id` / `start` / `offset`; a sibling anchored to the
composition is retargeted to the piece holding its moment (percentages
re-expressed, a bare id kept only if the start is kept), and one whose moment
was cut is removed with its whole run and everything anchored to it. It is
computed directly, not by re-resolving the document per cut. One difference
from slicing by hand: the first kept piece keeps the composition's `id` even
when the original start was cut away.

Captions commands (stage D1):

| Command | Does |
|---------|------|
| Generate captions (`CC`) | Transcribes the selection. A composition gets its captions INSIDE it, placed by number in its inner time; a clip / audio gets them beside it, anchored to its source time |
| Reauthor (`CC✎`) | Sets the selected composition's `captions` to `"off"` and writes what it was showing out as caption nodes beside it, anchored to its source time (the root's `maxChars` applied) |
| Convert to text (`CC→T`) | Replaces root-level captions with `text` nodes carrying the root's style |

**Views (stage D2).** A view is a mode of the editor an extension owns. Its
`component` is a React function component — the ONE place an extension may
depend on React (a peer dependency, optional so the CLI and renderer never
pull it in; core types it as `(props: EditorViewProps) => unknown`, so core
itself stays React-free). The toolbar shows a button per view; clicking it
opens the view on the primary selection. While open:

- the component takes the editor's left pane (`ExtensionViewHost.tsx`);
- the edit toolbar is hidden and the timeline + viewport are read-only — the
  view carries its own apply / cancel;
- the editor closes it when the document changes underneath (undo / redo, or
  the view's own `context.edit`).

`EditorViewProps`:

| Prop | Is |
|------|----|
| `context` | The same `EditorCommandContext` commands get; its `document` is always the real one |
| `target` | Path key the view was opened on |
| `preview(doc \| null)` | Show `doc` in the player and on the timeline instead of the real document, outside history. A preview that fails to resolve is refused with a notice |
| `close()` | Leave (drops the preview). Commit with `context.edit` first |
| `player` | `time()`, `seek(t)`, `spanOf(key)` — global output seconds of the document being SHOWN (so, of the preview). A stable object read on demand: a view is not re-rendered per tick |

The preview is the idea worth keeping: a view computes the document it would
commit with the pure `tools`, hands it to `preview`, and Apply commits that
same document — what the user watches is exactly what they get.

**The CC cut view** (`extensions/captions/src/editor/CCCutView.tsx`, button
`CC✂`, a single selected composition): the words that bubble up inside the
composition (`cutWords`, in `cut.ts`: the composition resolved on its own,
`collectCaptions`, times shifted by its `in` into inner time; a caption with
no word timings is one word) as a ribbon coloured per caption. Dragging
across words marks a range to keep; ranges have drag handles and a ×. Every
change runs `tools.keepRanges` and previews the result; Alt-click seeks to a
word (through the piece that holds it, `innerToGlobal`); Apply = `edit` with
the pieces selected. Out-of-order and repeated ranges are not offered
(`keepRanges` sorts and merges).

**Node types under the editor's own tools (D3).** `NodeTypeDef.editor` grew
three optional pure functions, so the editor's existing verbs work on an
extension's nodes without the editor knowing what they are:

- `split(node, t)` → `{ left, right, at } | null` — **Slice**. `t` is
  seconds from the node's start; the type may snap it. `left` keeps the
  slot; `right` has no placement, and `at` says where it begins (seconds
  from the original's start). The EDITOR places it (`splitTool.ts`
  `splitExtensionAt`) on the same anchor as the left, moved forward by `at`:
  a numeric `start` → `start + at`; a source-time anchor `"id@12"` → the
  seconds advanced by `at` × the target's playback rate; a bare-id or
  percentage anchor → same anchor, `offset` + `at`. Only a node with no
  `start` (a run member) gets the right half as the next run member, with
  the gap as its `offset`. A type without `split` does not slice.
- `resize(node, side, delta)` — **edge drag**; without it the editor adjusts
  `duration`.
- `blockLabel(node)` — the text on its timeline block.

Captions use all three (`extensions/captions/src/edit.ts`):

- **Slice** (`splitCaption`) cuts at the NEAREST WORD BOUNDARY, never through
  a word. The right half starts at its first word and gets its own anchor
  (JC: the halves are NOT put on one run — each stays glued to its own
  moment), so nothing moves. Fewer than two words → no cut.
- **Edge drag** (`resizeCaption`): right edge = the last word's length, left
  edge = the first word's. With a caption sliced down to one word that is
  retiming the word. (Shift-drag keeps everything downstream in place, as
  for any node.)
- **Merge** (`CC+`, `mergeCaptions`): the selected sibling captions become
  one. They need not touch: the earliest keeps its slot, speaker and style;
  every word keeps the moment it was said, a silence between two captions
  becoming the pause before the later one's first word. It reads positions
  through the new tool `tools.childSpans(doc, containerKey)` and removes the
  others with `tools.removeNodes`.
- A block shows its phrase.

**Extension containers expand on the timeline (JC's go-ahead, 2026-11-22).**
A node type that holds `children` (a caption's words — and a map's pinned
nodes) now expands like a composition: `timelineTree.ts` lays its children
out in the node's own time (from 0, speed 1, no window; `TreeBlock.isContainer`),
and the block clips what runs past its length. The children are ordinary
blocks: select, edge-drag, Shift-drag to nudge `offset`, delete, edit in the
Properties panel. This works because `nodePath.ts` now treats any node with
a `children` array as a container (presented to the composition tools as a
stand-in composition; only `children` is written back), and
`resolveLocal.ts` maps the playhead into it. A container with RESTRICTED
children (`children: ["word"]`) carries `TreeGroup.accepts` /
`DropRegion.accepts`: nothing else can be dropped into it, and its children
only move among such containers (`regionsAccepting`, `dropTargetIn`) — a
word cannot be dragged out to the root, a clip cannot land in a caption.
A word block shows its text.

Generation rules that go with it (JC): each generated caption stays placed
on its own (a single run is what authoring — slicing — produces, not what
generation writes); a caption with words has **no `duration`** (its words
are its length; only a text-only caption needs one) and starts at its first
word; a **zero-length word** from Whisper takes half of the next word's time
(else half of the previous; a line with nothing to borrow from shares its
whole length among its words) — `repairWordTimings`. Before, such words were
silently dropped, text included.

**Property editors.** `EditorExtension.properties: [{ field, label,
component }]` — a section of the Properties panel the extension owns: the UI
of a structured (`custom`) field, which gets no generated row. It shows
whenever every selected node carries `field` (`fieldAppliesTo`; no selection
= the root). The component gets `{ seam, nodes, update(change, { coalesce? }),
storage }`: `update` applies a per-node change to every selected node as one
validated undo step — a whole-node change, so an editor can write its field
and `metadata` together.

**Extension storage.** `EditorStorage` (`get(key)` / `set(key, value)`, JSON
values) is a small persistent store scoped to the extension, kept where the
editor keeps its own settings (`seam.settings` in localStorage, under
`extensions.<name>`; the Settings dialog's Reset leaves it alone). It is per
installation, never in the document.

**Caption style** (`extensions/captions/src/editor/CaptionStyleEditor.tsx`,
pure half in `presets.ts`): one row per style key — an empty control means
"not set" and shows what it inherits as its placeholder (the default for a
surface, the surface's value for a speaker) — plus `maxChars` and a list of
speaker overrides. **Presets**: `[dropdown] [Save] [Save as] [Delete]`. A preset is a
whole surface style under a name, in the extension's storage (`presets`).
The composition only remembers the preset's NAME, as
`metadata.captionPreset`; the dropdown shows it with a `*` while the
composition's style differs from the stored one (`presetState`: none / clean
/ modified / missing — a name this installation has no preset for is shown
as "not saved here"). Picking a preset copies its style in; "(no preset)"
forgets the name and keeps the style. **Delete** (after a confirm) removes
the preset from storage and forgets the name on this composition, which
keeps its style; other compositions naming it show "not saved here".
A composition with no `captionStyle` shows only a **Define style** button
(which writes an empty `{}` — defined, nothing overridden, the default
showing as placeholders); **Remove style** takes it back to undefined and
drops the preset name. `withStyle(node, undefined, …)` removes the key; an
empty style is kept.

The old `data`-based tools (the built-in transcribe button, separate / group
words, the bin-only CC cut mode) were removed in stage E.

### Dependencies, leaf nodes and the New panel (Text, item 4)

- **`SeamExtension.requires: string[]`** — names of extensions that must be
  installed alongside. A missing one throws at `createSeam`; order does not
  matter. A package also lists the other as a peer dependency.
- **Leaf self-drawing nodes.** A node type with `draws: true` and no
  `children` is emitted by the render list as ONE `DrawCommand`, exactly like
  a clip: rotation, opacity, crossfade, corner mask and colour-stage fields
  ride on that quad, and its time is `extensionContentSpan(node).offset +
  drawTime`. Only container types take the group / FBO path.
- **`FieldSpec` additions:** `pattern` on a string field (a regular
  expression source the value must match), `exclusiveMin` on a number field.
- **`NodeTypeDef.editor.palette: { label, glyph?, create() }`** — a tile in
  the editor's New panel that drags the created node onto the timeline.

The `text` node declares: `text` (custom: a string, or strings and styled
runs — required), the style fields (`fontFamily`, `fontSize`▸, `color`▸,
`fontWeight`, `fontStyle`, `textDecoration`, `letterHeight`, `lineHeight`▸,
`textAlign`, `verticalAlign`, `backgroundColor`▸, `strokeColor`▸,
`strokeWidth`▸; ▸ = keyframeable) and two more custom ones (`padding`,
`backgroundPadding`▸). Its rasterizer keeps one canvas per node: static
text is drawn once and again only when the inner canvas changes size;
animated text when its time moves.

### Measured inner canvases (Text `wrap: false`)

A node type may say that a node's inner canvas is not `contentWidth` /
`contentHeight` but whatever its rasterizer measures:

- **`NodeTypeDef.measured(node)`** (pure) → the resolver stamps the resolved
  node `measured: true`.
- **`NodeRasterizer.measure(node, drawTime)`** → `{ width, height }`,
  synchronous. `draw` is then asked to fill exactly that.
- **Render list:** the host's size getter (already used for clip / static
  media dims) is asked for such a node with its content time —
  `getIntrinsicSize(node, t)`. That size is the inner canvas: it feeds
  `computeNaturalSize` (so `objectFit` fits it) and is the draw's
  `contentW` / `contentH`. Re-asked every frame, so a keyframed font size
  resizes the node live.
- **Spatial pass:** `resolveSpatial(timeline, w, h, { measure })`. With a
  measurer the node's `intrinsicWidth/Height` and natural size are its real
  first-frame box (the CLI's `resolve` passes one, via the renderer's
  `createInnerMeasurer`); without, they stay the parent-sized default. The
  node always keeps its `spatialInput`: hosts lay it out per frame.
- **Editor:** the transform gizmo measures through the preview's rasterizer
  (`locateNode(…, measure)`).
- **`NodeTypeDef.validate(node)`** — a cross-field check the declarations
  can't express (text: `wrap: false` with a `contentWidth`).
- **`FieldSpec` kind `boolean`** — a default / on / off select in the
  Properties panel.

Text's measurement (`measureText`): widest line × line count at the sampled
font size and line height, plus `padding`, rounded up. Backgrounds and
strokes are not counted — `padding` makes the room.

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

**Comparing renders exactly:** set `SEAM_FRAME_HASHES=<file>` when rendering
to write one checksum per raw composited frame (before encoding); `diff` two
such files to get the frames that differ. Comparing encoded video smears a
one-frame difference across a whole GOP. Byte-identical output is not a
promise Seam makes — it is the expectation for behaviour-neutral refactors,
and JC judges the rest by eye.

`GoldenTestVideo-captions.seam` is the same project with its 103 root caption
`data` nodes converted to `caption` nodes and the root script replaced by a
root `captionStyle`. It matches the baseline on 4746 of 4797 frames; the
other 51 (around 77.8 s and 114.5–116 s) differ invisibly, cause not found,
accepted by JC by eye on 2026-11-22.
After the Text eviction (item 4) `GoldenTestVideo-extensions.seam` — whose
root script emits `text` nodes — rendered all 4797 frames and the audio
bit-identical to the reference again (`_baseline/text-extension.mp4`).
`GoldenTestVideo-d78e536.mp4` is the pre-extensions reference. Stage 0
rendered all 4797 frames and the audio bit-identical to it (ffmpeg `psnr` +
audio md5).

`packages/renderer/src/__tests__/compositor-adjust.test.ts` pins the pixel
output of every adjustment (leaf and FBO-group paths) as captured from the
`filters` implementation; stage 1 must keep it passing with only its
`adjusted()` helper rewritten.

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
| 1 | Adjustments | done, awaiting JC's test | property contribution, shader colour stage, Properties rows |
| 2 | Map | not started | node-type contract, host services, lifecycle, child placement |
| 3 | CC Cut + CC generation | not started | views, panels, commands |
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

## Open questions

- Does a `.seam` declare the extensions it requires (names, versions)?
  Deferred until dynamic loading.
- TypeScript types for contributed fields: module augmentation vs a looser
  node type. Today the authored types (`Clip`, …) do not know the fields;
  code that builds documents in TS casts.
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
  map, composition (`VISUAL_NODE_TYPES`). `type: "number"` is the only type.
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
`<Player seam>`.

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

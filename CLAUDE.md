# Seam Video

Video editor where edits are defined as JSON (`.seam` files). No absolute timecodes — clips defined by source in/out, everything shifts automatically when you add/remove/reorder.

## Repo Structure

pnpm monorepo:

- **`@seam/core`** — Schema (Zod), types, layout resolver, compile pass. Pure logic, no I/O.
- **`@seam/renderer`** — Builds MLT projects from resolved timelines and executes them; uses FFmpeg for sample-accurate audio.
- **`@seam/cli`** — `render`, `preview`, `resolve` commands (Commander).
- **`@seam/preview`** — Electron + React live preview with file watching. Exports `Player`, `Timeline`, `VideoCanvas`, `TransportControls` for reuse.
- **`@seam/editor`** — Electron + React editing app. Owns React UI, platform abstraction (Electron / Web / Mobile), exports `App` + platform for host shells.
- **`@seam/web`** — Web (browser) shell for the editor. OPFS-backed storage with `projects/` and `clips/` directories.
- **`@seam/html-renderer`** — Static HTML host for the editor.
- **`generator-server`** — Python/FastAPI sidecar for transcription (faster-whisper) and audio enhancement (Resemble Enhance). Not wired through the JS monorepo.

## Commands

```
pnpm test              # all tests (core + renderer, Vitest)
pnpm build             # build all packages
pnpm --filter @seam/preview build && pnpm --filter @seam/preview dev   # preview dev
pnpm --filter @seam/editor build && pnpm --filter @seam/editor dev     # editor dev (Electron)
pnpm --filter @seam/web dev                                            # editor dev (web / OPFS)
npx tsx packages/cli/src/index.ts render <file.seam>                   # render via ffmpeg
```

## Core (`@seam/core`)

| File | Role |
|------|------|
| `src/schema.ts` | Zod schemas — `z.lazy` + `z.union` for recursive compositions |
| `src/types.ts` | TypeScript types mirroring the schema |
| `src/resolved-types.ts` | Output types after layout resolution |
| `src/compile.ts` | `compileSeamFile(doc, {runScripts?})` — splices `binItem` references, runs `script` fields |
| `src/layout/resolve.ts` | `resolveComposition()` — sequential `children` + anchored `attachments` |
| `src/layout/resolve-spatial.ts` | `resolveSpatial()` + `DEFAULT_CANVAS_WIDTH/HEIGHT` (1080×1920) |
| `src/flatten.ts` | Linearises the resolved tree into leaves |

## Renderer (`@seam/renderer`)

| File | Role |
|------|------|
| `src/mlt-builder.ts` | ResolvedTimeline → MLT XML (melt-compatible) |
| `src/mlt-runner.ts` | Executes melt |
| `src/ffmpeg-audio.ts` | Pre-renders a sample-accurate mixed audio file with ffmpeg |
| `src/text/textRaster.ts` | Pretext-laid-out text → PNG (Skia via `@napi-rs/canvas`) for melt's qimage |

## Preview (`@seam/preview`)

| File | Role |
|------|------|
| `src/renderer/components/Timeline.tsx` | rAF clock, single WebGPU canvas |
| `src/renderer/components/Player.tsx` | Wraps Timeline + VideoCanvas + TransportControls |
| `src/renderer/components/VideoCanvas.tsx` | `<canvas>` shell, `maxWidth/maxHeight: 100%` fit-to-container |
| `src/renderer/media/gpu/WebGPURenderer.ts` | GPU compositor — blit + filter shaders (adjust, opacity, colorbalance, colortemp), FBO for group filters, 1×1 fill tiles for `backgroundColor` |
| `src/renderer/media/gpu/RenderList.ts` | Walks resolved timeline tree → draw/group/fill commands |
| `src/renderer/media/FrameCoordinator.ts` | Manages ClipPlayers, decodes video frames via mediabunny |
| `src/renderer/media/StaticStore.ts` | Decodes one frame per `static` node (image or video freeze-frame) |
| `src/renderer/media/TextStore.ts` | Rasterises text nodes to OffscreenCanvas via Pretext |
| `src/renderer/media/AudioScheduler.ts` | Web Audio API master clock + per-clip scheduling |

## Editor (`@seam/editor`) — pure-logic modules

| File | Role |
|------|------|
| `src/renderer/compile.ts` | Thin shim over `@seam/core`'s `compileSeamFile` |
| `src/renderer/nodeBin.ts` | Reads/writes `comp.bin` and `comp.binItem` (first-party schema fields) |
| `src/renderer/nodeScript.ts` | Reads/writes `comp.script`; enable/disable/bake helpers |
| `src/renderer/splitTool.ts` | `sliceAtPlayhead(doc, t)` + anchor-rewrite when a node is split |
| `src/renderer/attachTool.ts` | `applyAttach(doc, t, sel, side)` — moves selection into `attachments` with source-mode anchor |
| `src/renderer/composeTool.ts` | `applyCompose` — wrap selection in a composition |
| `src/renderer/binTool.ts` | `applyBin` — promote a composition to `doc.bin`, leave a `binItem` reference behind |
| `src/renderer/ccCutTool.ts` | CC-cut math (transcription → composition-time, splice as bin references) |
| `src/renderer/anchorEdit.ts` | Anchor-line math (computePointTime, dragAnchorPoint, dragOffset, toggle{AnchorPoint,Offset}, setAttachmentSpec) |
| `src/renderer/exportHelpers.ts` | `buildExportPlan` (zip), `remapSourcesToRelative` (Save As), `collectClipSources` (compile-then-walk) |
| `src/renderer/mediaSource.ts` | `isMediaSource(child): child is Clip | Audio | Static` — single canonical predicate |
| `src/renderer/pathUtils.ts` | `dirname`, `basename`, `basenameWithoutExt`, `isAbsolute`, `relative` |
| `src/renderer/views.ts` | `getViewDocument`, `timeOnEnter`, `translateTimeOnExit` for view navigation |
| `src/renderer/selection.ts` | `removeSelected` + selection-set helpers |
| `src/renderer/useHistory.ts` | Undo/redo with `isEqual` dedupe |
| `src/renderer/useEvent.ts` | Stable identity / latest closure hook (drop-in for React's `useEffectEvent`) |
| `src/renderer/jsonFormat.ts` | JSON formatter that records dotted-path → char-offset for "jump to JSON" |

## Editor — React components

| File | Role |
|------|------|
| `src/renderer/App.tsx` | Root: state, history, timeline derivations, `onAction` wiring, render shell |
| `src/renderer/TimelinePanel.tsx` | Scroll shells (`DesktopTimeline`, `MobileTimeline`) sharing `useTimelineSurfaceState` + `<TimelineSurface>` |
| `src/renderer/AnchorLinesLayer.tsx` | SVG overlay; pointer-drag state machine driving `anchorEdit.ts` |
| `src/renderer/timelineLayout.ts` | `ROW_HEIGHT`/`ROW_GAP`/`RULER_HEIGHT`, `ChildBlock` type, `rowYTop` |
| `src/renderer/ControlsBar.tsx` | Toolbar — wires `applyBin`/`applyAttach`/`sliceAtPlayhead`/`applyCompose` and transport |
| `src/renderer/InspectorTabs.tsx` | Inspector panel (timing, source, filters, spatial) |
| `src/renderer/JsonNodePanel.tsx` | Monaco-based JSON editor on the selected node |
| `src/renderer/BinPanel.tsx` | Lists bin entries; supports rename + entry into CC Cut view |
| `src/renderer/ScriptPanel.tsx` | Monaco script editor; enable/disable/bake |
| `src/renderer/CCCutView.tsx` | Word ribbon + selection model for CC Cut |
| `src/renderer/WebTopBar.tsx` | Web's File menu (New / Open / Save / Import/Export .seam / Import/Export Zip / Browse) |
| `src/renderer/ProjectBrowser.tsx` | Web project listing |
| `src/renderer/ProjectPicker.tsx`, `SettingsDialog.tsx` | UI dialogs |
| `src/renderer/platform/{electron,web}.ts` | `Platform` implementations; `onAction` covers `"new" | "open" | "save" | "save-as" | "export" | "settings"` |

## Conventions

- **Seconds everywhere** — frames only at the MLT boundary (default 30fps).
- **`children`** = sequential body; **`attachments`** = anchored overlays. Both arrays of `Child`.
- **Node types**: `clip`, `audio`, `static`, `empty`, `data`, `text`, `composition`.
- **`isMediaSource(child)`** = `clip | audio | static` — anything with an external `source` path. Use this for blob-URL preloading, path rewriting, export bundling. Source-time-aware paths (split, attach, JSON inspector) keep the narrower `clip | audio` check because static has no in/out trim.
- **Compositions carry first-party `bin`, `binItem`, `script`** (not metadata conventions). The compile pass in `@seam/core` resolves them:
  - `binItem: "<id>"` adopts the named bin entry's body; lookup is lexically scoped (nearest-enclosing wins).
  - `script` runs at compile time, receives the bin-resolved composition as `currentNode`, returns the replacement composition.
  - `compileSeamFile(doc, { runScripts: false })` skips scripts (used by the editor's timeline panel so blocks map 1:1 to authored children).
- **Two resolved timelines per view** in the editor:
  - `playerTimeline` — full compile (bins + scripts). Drives the canvas.
  - `editorTimeline` — `runScripts: false`. Drives the timeline panel so drag/trim/delete writes back to positions the user can see.
- **Schema is the single source of truth**; types mirror it. Defaults flow through Zod (`children` defaults to `[]`).
- **Default canvas**: `DEFAULT_CANVAS_WIDTH = 1080`, `DEFAULT_CANVAS_HEIGHT = 1920` (portrait). Used by App.tsx, preview main, VideoCanvas, CLI render/resolve.
- **Spatial model**: every node lays out via `origin` + `translation` + `size` (no more `top/left/right/bottom/width/height/position`):
  - `Length` value = `number | "p%" | "p% +/- n"`. Each property substitutes its own percent default when only a pixel number is given.
  - `origin` (point on the item, default `"50%"` = center): percent reference = item's own size. `0` evaluates to center.
  - `translation` (point in parent where origin lands, default `0` = center): percent reference = parent's content size. `0` = center; `"0%"` = top-left.
  - `size` (final pixel size, default `"100%"` = post-objectFit natural rect): percent reference = post-objectFit size. `100` (bare) = literal 100px box.
  - Final rect = `(translation - origin, size)`. Renderers consume this `SpatialRect` directly — no further objectFit math at draw time. `objectFit` only determines what `size: "100%"` evaluates to.
  - `contentWidth`/`contentHeight` accept `Length` too. Percentages resolve against the parent container; root composition must use pixel numbers.
- **`overflow`/`underflow`** are flex strategies (`trim-end`, `stretch`, etc.) only meaningful for attachments with both ends pinned and for composition windowing. Default `"trim-end"`.
- **`ChildTimingFields`** shared interface for `in`, `out`, `overflow`, `underflow`, `id`, `start`, `end`, `metadata` — extended by Clip, Composition.
- Preview renders via a single WebGPU canvas; `RenderList` walks the resolved tree into draw/group/fill commands. Compositions with filters use FBO render-to-texture; without filters, children flatten into the parent pass. `backgroundColor` renders as a stretched 1×1 color tile under the children.
- Web platform: `WebPlatform.preloadBlobUrls(sources)` must run before mounting the document so `resolveSource` returns blob URLs rather than bare filenames. `collectClipSources` compiles the doc first so clips inside bin entries are reachable.

## Tech

- TypeScript (ES2022, strict, ESM)
- Vitest for testing
- Zod for schema validation
- Electron + React (electron-vite) for editor + preview shells
- React 19 + Monaco for JSON/script editing
- Commander for CLI
- mediabunny for in-browser audio/video decode
- WebGPU for preview compositing
- @napi-rs/canvas (Skia) for server-side text rasterization
- JSZip for web import/export
- melt + ffmpeg externally for final render

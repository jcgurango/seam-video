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
| `src/animation/interp.ts` | `buildFlat` (mutates a `FlatFrame` — does NOT return one) + `interpolateFrames` for graphic keyframe tweening |

## Renderer (`@seam/renderer`)

| File | Role |
|------|------|
| `src/mlt-builder.ts` | ResolvedTimeline → MLT XML (melt-compatible) |
| `src/mlt-runner.ts` | Executes melt |
| `src/ffmpeg-audio.ts` | Pre-renders a sample-accurate mixed audio file with ffmpeg |
| `src/text/textRaster.ts` | Pretext-laid-out text → PNG (Skia via `@napi-rs/canvas`) for melt's qimage |
| `src/graphic/fill.ts` | Round-trips an authored object through `fabric/node` to apply default props before interpolation. `CUSTOM_PROPS` keeps seam-specific fields (`source`, `latitude`, `clipId`, …) from being dropped by fabric's serialization |
| `src/graphic/playback.ts` | `precomputeGraphicPlayback` (fills every keyframe + builds extKfs with loop ghosts) + `snapshotAt(t)` (pair lookup + `interpolateFrames` from `@seam/core`). `isStatic` short-circuit |
| `src/graphic/clip.ts` | Sub-clip playback: `precomputeClipPlayback`, `getClipAnchorsAtPath` (reads from **raw authored** outer frames, not filled — so `startPosition: 0` is distinguishable from "missing"), `computeLocalTime` (anchor + elapsed + repeat), `clipSnapAtLocalTime` |
| `src/graphic/render.ts` | Snapshot → PNG via `fabric/node` StaticCanvas + `enlivenObjects`. Walks the tree handling `Group` (recurse), `Clip` (materialize from clipDef), `Map` (renderMapToFabric via the pool). Output via `getNodeCanvas().toBuffer("image/png")` |
| `src/graphic/map-render.ts` | `MapInstance` wraps `@maplibre/maplibre-gl-native` (Node 22 LTS prebuilt — see `.nvmrc` / engines field). `NodeFileSource` does pmtiles byte-range reads via `fs/promises` file handle. `MapPool` keys `${path}\|${source}` so animating maps share one GL context across frames; rasterizer owns the pool for one ResolvedGraphic's lifetime |
| `src/graphic/raster.ts` | `rasterizeAllGraphics(timeline, dir, fps, mapBasePath?)` → PNG (static) or `graphic-N-%04d.png` (animated) per ResolvedGraphic. Mirrors `textRaster.ts` so the MLT builder treats both identically |

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
| `src/renderer/media/GraphicStore.ts` | Per-`ResolvedGraphic` HTMLCanvasElement + fabric `StaticCanvas`. `update(t)` re-rasterizes the snapshot via `materializeTree`. Caches `MapLibreMap` instances by path-id (`mapCache`) with `isPreEnliven=true` so fabric's add/remove churn doesn't kill the pool refs. `after:render` → `onFrameAvailable` lets async maplibre tile loads push frames through the GPU pipeline while paused |
| `src/renderer/media/graphic/fill.ts`, `playback.ts`, `clip.ts` | Browser mirrors of the renderer's modules; use fabric's browser build's `classRegistry` so we don't pull in `node-canvas`. **Watch out:** `buildFlat` is `void`, mutates the third arg — don't write `const flat = buildFlat(...)` |
| `src/renderer/media/graphic/MapLibreMap.ts` | Fabric subclass; registered in `classRegistry.setClass(MapLibreMap, "Map")` at module load (side-effect import from GraphicStore). `SharedMaplibre` pool keyed by `${path}\|${source}` with a per-instance **16 ms flush interval** that drains the `pendingUpdate` buffer — every camera / size / paths write goes through `_queuePending`, last-write-wins per field. Bundled OSM Bright `style.json` lives at `./osm-bright/style.json`. Host registers `setPmtilesResolver` so pmtiles `Source` resolution stays platform-specific |
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
| `src/renderer/useImport.ts` | File-drop importer. `.pmtiles` → graphic node with a Map element (no blob URL, OPFS-direct byte-range reads). Standard media kinds route to `clip`/`audio`/`static` |
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
| `src/renderer/platform/{electron,web}.ts` | `Platform` implementations; `onAction` covers `"new" | "open" | "save" | "save-as" | "export" | "settings"`. `openPmtilesSource(filename)` → byte-range pmtiles `Source` (Web: `FileSource(OPFS File)`. Electron: `FetchSource(file://)`). Wired in `main.tsx` via `setPmtilesResolver` |

## Conventions

- **Seconds everywhere** — frames only at the MLT boundary (default 30fps).
- **`children`** = sequential body; **`attachments`** = anchored overlays. Both arrays of `Child`.
- **Node types**: `clip`, `audio`, `static`, `empty`, `data`, `text`, `graphic`, `composition`.
- **Graphic boundary**: inside a graphic's `frames[i][1]` is **fabric's domain**, NOT seam's. Inner-object numeric props (`left`, `top`, `width`, `height`, `radius`, …) are plain numbers — the `Length` system (`"50%"`, `"100% - 5"`) stops at the graphic. The schema rejects Length strings on inner objects. Outer-world fields on the graphic itself (`duration`, `contentWidth/Height`, frame stamps) still take `Length`. Treat each graphic as a single compositable sub-scene that doesn't interact with anything outside its hierarchy.
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
- Web platform: `WebPlatform.preloadBlobUrls(sources)` must run before mounting the document so `resolveSource` returns blob URLs rather than bare filenames. `collectClipSources` compiles the doc first so clips inside bin entries are reachable. **pmtiles skip blob URL creation** in `importClip` — they go through `openPmtilesSource` (byte-range OPFS reads), never `resolveSource`.
- **Graphic pipeline (preview)**: per-tick, `GraphicStore.materializeTree` clears the fabric canvas and re-adds objects. `Map` instances are CACHED per (graphic, path) — re-using `MapLibreMap` survives fabric's add/remove because `isPreEnliven=true` disables `dispose` on `removed`. New maps create fresh; subsequent ticks call `cached.set(filled)` which routes through the 16 ms `pendingUpdate` flush. Without the cache, maplibre would churn its setup on every frame.
- **Graphic pipeline (CLI)**: rasterize each ResolvedGraphic to a PNG sequence, wire into MLT alongside text (`qimage` + `ttl=1`, one track per graphic with its own qtblend transition + rect). Inspect `<file>.seam-rendered/graphic/` for spot-check PNGs.
- **Node 22 LTS** is pinned at the repo root (`.nvmrc`) and on the renderer/CLI packages' `engines` because `@maplibre/maplibre-gl-native` only ships prebuilt binaries through Node 22's ABI. Editor / preview / web all run on whatever Node version the user's on, since they use the browser maplibre-gl.
- **Timeline block colors** in TimelinePanel's `BLOCK_COLORS` — `graphic` is deep magenta (`#b03a8f` bg / `#d957b8` border) to distinguish from text's rose and composition's violet.

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
- fabric.js (browser + `fabric/node`) for graphic object rendering
- maplibre-gl (browser) + @maplibre/maplibre-gl-native (Node 22) for Map elements
- pmtiles for byte-range vector/raster tile reads (OPFS on web, fs on node)
- JSZip for web import/export
- melt + ffmpeg externally for final render

# Seam Video

Video editor where edits are defined as JSON (`.seam` files). No absolute timecodes — clips defined by source in/out, everything shifts automatically when you add/remove/reorder.

## Repo Structure

pnpm monorepo:

- **`@seam/core`** — Schema (Zod), types, layout resolver, compile pass. Pure logic, no I/O.
- **`@seam/renderer`** — Builds MLT projects from resolved timelines and executes them; uses FFmpeg for sample-accurate audio.
- **`@seam/cli`** — `render`, `preview`, `resolve` commands (Commander).
- **`@seam/preview`** — Electron + React live preview with file watching. Exports `Player`, `Timeline`, `VideoCanvas`, `TransportControls` for reuse.
- **`@seam/editor`** — Electron + React editing app. Owns React UI, platform abstraction (Electron / Web), exports `App` + platform for host shells. (Desktop-only for now — mobile layout was removed pending a dedicated UI pass.)
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
| `src/mlt-builder.ts` | ResolvedTimeline → MLT XML (melt-compatible). Positioned overlays composite via **`affine`** transitions (not qtblend — see Conventions) with `distort=1`. objectFit cover/center/fit driven by probed media dims; animated rect keyframes keep both endpoints of every constant run so holds hold; video statics freeze via a producer-level `freeze` filter; complex nested comps reference pre-rendered sub-`.mlt`s. Overlay transitions are emitted in painter's **`z` order** (document order, the preview's compositing order) — track indices are grouped by type but z-order follows authoring, so a later-authored overlay lands on top regardless of node type |
| `src/mlt-runner.ts` | Executes melt. Writes a sidecar `.profile` **file** (`buildMeltProfile` — canonical key=value, square pixels + 709) and passes `-profile <file>`: melt 7.38 ignores ad-hoc `-profile WxH/fps` strings and the inline `<profile>`, falling back to dv_pal (SAR 16:15 → output displays stretched, e.g. 1080×1920 as 1152×1920) |
| `src/media-probe.ts` | `probeIntrinsicSizes()` — ffprobe display dims (SAR + rotation, incl. JPEG EXIF orientation from frame side-data), cached. Without these the builder can't compute objectFit and qtblend/affine stretches |
| `src/composition-prerender.ts` | `prerenderCompositionMlts()` — recursively renders each *complex* composition (own spatial / non-fit objectFit / filters / `backgroundColor`) to a sidecar sub-`.mlt`, keyed by node identity; the builder references each as a producer placed at its display rect. Sub-`.mlt`s render on a **transparent** base (`defaultBackgroundColor: "#00000000"`) so they layer cleanly, with the comp's `speed` baked in via `rootSpeed` (stretched comps fill their window); trivial comps still flatten |
| `src/ffmpeg-audio.ts` | Pre-renders a sample-accurate mixed audio file with ffmpeg |
| `src/text/textRaster.ts` | Pretext-laid-out text → PNG (Skia via `@napi-rs/canvas`) for melt's qimage |
| `src/graphic/fill.ts` | Round-trips an authored object through `fabric/node` to apply default props before interpolation. `CUSTOM_PROPS` keeps seam-specific fields (`source`, `latitude`, `clipId`, …) from being dropped by fabric's serialization |
| `src/graphic/playback.ts` | `precomputeGraphicPlayback` (fills every keyframe + builds extKfs with loop ghosts) + `snapshotAt(t)` (pair lookup + `interpolateFrames` from `@seam/core`). `isStatic` short-circuit |
| `src/graphic/clip.ts` | Sub-clip playback: `precomputeClipPlayback`, `getClipAnchorsAtPath` (reads from **raw authored** outer frames, not filled — so `startPosition: 0` is distinguishable from "missing"), `computeLocalTime` (anchor + elapsed + repeat), `clipSnapAtLocalTime` |
| `src/graphic/render.ts` | Snapshot → PNG via `fabric/node` StaticCanvas + `enlivenObjects`. Walks the tree handling `Group` (recurse), `Clip` (materialize from clipDef), `Map` (renderMapToFabric via the pool). Output via `getNodeCanvas().toBuffer("image/png")` |
| `src/graphic/map-render.ts` | Headless **OpenLayers** rasterizer for Map elements — no maplibre, no WebGL. Fakes a DOM with **jsdom** (node-canvas backed) so OL's Canvas2D renderer runs, then per frame: set view → `renderSync()` → await `rendercomplete` (tiles loaded) → composite the layer canvas over the OSM Bright cream base → draw path overlays via `getPixelFromCoordinate` (progress truncated in web-mercator space). `NodeFileSource` does pmtiles byte-range reads via `fs/promises`; `PMTilesVectorSource` (ol-pmtiles) consumes it. `ol-mapbox-style` applies the bundled `osm-bright/style.json` (symbol `text-font` → bundled families via `mapLabelFontStack`, `text-size` ×1.3, `glyphs`/`sprite` dropped); labels render as canvas text using node-canvas-registered fonts, with a jsdom `document.fonts` **stub** so ol-mapbox-style finds them "loaded" and never fetches its font CDN. `MapPool` keys `${path}\|${source}`, reused across a ResolvedGraphic's frames. jsdom globals install **lazily** (first render, after fabric/node — which keeps its own private jsdom env and reads `window.devicePixelRatio` once at load). Mirrors the preview's `OpenLayersMap`; no Node native code (pin removed) |
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
| `src/renderer/media/StaticStore.ts` | Decodes one frame per `static` node (image or video freeze-frame). Images decode with `createImageBitmap(blob, { imageOrientation: "from-image" })` so EXIF orientation matches the CLI render (melt qimage + ffprobe both honor it) — must stay explicit |
| `src/renderer/media/TextStore.ts` | Rasterises text nodes to OffscreenCanvas via Pretext |
| `src/renderer/media/GraphicStore.ts` | Per-`ResolvedGraphic` HTMLCanvasElement + fabric `StaticCanvas`. `update(t)` re-rasterizes the snapshot via `materializeTree`. Graphics nested in compositions get their **composition-local** time via a per-graphic `toLocal` mapper built in `collectGraphicEntries` (composes each enclosing comp's `(t−timelineStart)·speed`, matching RenderList). Caches `OpenLayersMap` instances by path-id (`mapCache`) with `isPreEnliven=true` so fabric's add/remove churn doesn't kill the pool refs; `addRenderListener` → `pendingMapWake` lets async OL tile loads push frames while paused. **No redraw throttle** — OL's 2D canvas→canvas blit has no WebGL readback stall (the old 60 Hz cap is gone); redraws only when time advanced or a map woke |
| `src/renderer/media/graphic/fill.ts`, `playback.ts`, `clip.ts` | Browser mirrors of the renderer's modules; use fabric's browser build's `classRegistry` so we don't pull in `node-canvas`. **Watch out:** `buildFlat` is `void`, mutates the third arg — don't write `const flat = buildFlat(...)` |
| `src/renderer/media/graphic/OpenLayersMap.ts` | Fabric subclass backing Map elements; registered `classRegistry.setClass(OpenLayersMap, "Map")` (side-effect import from GraphicStore). Runs **OpenLayers** off-screen (hidden div) purely as an **on-demand rasterizer** — `_render` does `renderSync()`, blits the layer canvas over the cream base, then draws paths via `getPixelFromCoordinate` (progress truncated in web-mercator space); no live map in the scene, no WebGL. `SharedOLMap` pool keyed by `${path}\|${source}`. `set()` applies camera (view center + resolution; zoom via the **maplibre-512** resolution convention, `78271.517/2^z`) / size directly — no flush buffer. Host registers `setPmtilesResolver`. `ol-mapbox-style` + bundled `osm-bright/style.json`; labels via `mapLabelFontStack` families preloaded into `document.fonts` by `loadMapLabelFonts`, `text-size` ×1.3, `glyphs`/`sprite` dropped (no POI icons yet). Mirrored by the renderer's `map-render.ts` |
| `src/renderer/media/AudioScheduler.ts` | Web Audio API master clock + per-clip scheduling |

## Editor (`@seam/editor`) — pure-logic modules

| File | Role |
|------|------|
| `src/renderer/compile.ts` | Thin shim over `@seam/core`'s `compileSeamFile` |
| `src/renderer/nodeBin.ts` | Reads/writes `comp.bin` and `comp.binItem` (first-party schema fields) |
| `src/renderer/nodeScript.ts` | Reads/writes `comp.script`; enable/disable/bake helpers |
| `src/renderer/splitTool.ts` | `sliceAtPlayhead(doc, t)` + anchor-rewrite when a node is split. Container-aware in the toolbar: `ControlsBar` slices in the **deepest-selected** node's container (don't bubble up) via `editContainer` + `descendToContainer` (root/no-selection → root) |
| `src/renderer/resolveLocal.ts` | `descendToContainer(resolvedRoot, doc, containerPath, globalTime)` — maps the global playhead into a nested container's inner-timeline time. Per level `inner = (in ?? 0) + (t − comp.timelineStart) · comp.speed` (the resolver keeps a comp's children in inner coords, not output). Shared by the toolbar slice + attach |
| `src/renderer/attachTool.ts` | Toolbar **`applyAttach(doc, resolvedRoot, t, primaryKey, secondaryKeys, side)`** — path-keyed: first selection is the primary anchor, the rest become attachments in the **primary's container** with their chosen `side` (re)anchored to a source-mode point on the primary at the playhead (other side left intact → overwrite-one-side semantics). Works with any mix of children/attachments at any level: children promote, attachments re-anchor, cross-container secondaries get pulled in (no validity check on the untouched anchor — user sees + adjusts). The playhead→source mapping uses `resolveLocal.ts`'s `descendToContainer` (the primary's container-local time). Bin-rooted primaries are out. `attachNewItems` (drag path) is separate |
| `src/renderer/composeTool.ts` | Two compose modes: **children** — `walkComposeDependencies` (contiguous run + dependent attachments) → `applyCompose` clubs them into one composition; **attachments** — `composeAttachments` wraps *each* selected attachment in a composition that takes over its slot, lifting the slot-level fields (`LIFTED_FIELDS` = `start`/`end`/`id`/`overflow`/`underflow`) to the wrapper and dropping everything else (`source`, `in`/`out`, …) into the single inner child; nothing else inferred. `ControlsBar` gates the two on all-children vs all-attachments selections |
| `src/renderer/binTool.ts` | `applyBin` — promote a composition to `doc.bin`, leave a `binItem` reference behind |
| `src/renderer/ccCutTool.ts` | CC-cut math (transcription → composition-time, splice as bin references) |
| `src/renderer/anchorEdit.ts` | Anchor-line math (computePointTime, dragAnchorPoint, dragOffset, toggle{AnchorPoint,Offset}, setAttachmentSpec) |
| `src/renderer/exportHelpers.ts` | `buildExportPlan` (zip), `remapSourcesToRelative` (Save As), `collectClipSources` (compile-then-walk) |
| `src/renderer/mediaSource.ts` | `isMediaSource(child): child is Clip | Audio | Static` — single canonical predicate |
| `src/renderer/useImport.ts` | File-drop importer. `.pmtiles` → graphic node with a Map element (no blob URL, OPFS-direct byte-range reads). Standard media kinds route to `clip`/`audio`/`static` |
| `src/renderer/pathUtils.ts` | `dirname`, `basename`, `basenameWithoutExt`, `isAbsolute`, `relative` |
| `src/renderer/selection.ts` | Legacy flat-root-index `removeSelected`/`splitSelection` (still used by ControlsBar's delete) |
| `src/renderer/nodePath.ts` | **Path-keyed addressing** — `NodePath` (`{field,index}[]`; a leading `{field:"bin",id}` segment roots at a shared bin entry, `bin.<id>.children.0`), `pathKey`/`parsePath`, immutable tree `get`/`updateComp`/`remove`/`insert`/`moveNode` (cross-container incl. in/out of bin entries; index-shift aware via `segEq`/`adjustPathAfterRemoval`), `editContainer` lens (runs any `(Composition)→Composition` tool at a path — bin roots rewrite the entry, so edits hit every reference — injecting the root bin for nested `binItem` resolution), and root-index adapters (`rootIndicesFromKeys`/`rootKeyFromIndex`) the legacy root-only tools consume. Assumes bin ids are dot-free |
| `src/renderer/dropRegions.ts` | One walk, two views: `flattenDropRegions` (content-space drop targets per editable container, for drag) + `flattenGroups` (each editable group's content-space origin, for the anchor overlay). `regionAt`/`insertionIndexIn`/`insertionXIn`/`localTime`. Geometry invariant: `contentX / pxPerSec` is global output time at every nesting level (the window transform reconstructs it), so a container's local time at a cursor is `originSec + (contentX − containerLeft)/pxPerSec · scale`. Tracks each container's true content-top (root rows start at `RULER_HEIGHT + ROW_GAP`); the root region rect still starts at y=0 as the hit-test floor |
| `src/renderer/useHistory.ts` | Undo/redo with `isEqual` dedupe |
| `src/renderer/useEvent.ts` | Stable identity / latest closure hook (drop-in for React's `useEffectEvent`) |
| `src/renderer/jsonFormat.ts` | JSON formatter that records dotted-path → char-offset for "jump to JSON" |

## Editor — React components

| File | Role |
|------|------|
| `src/renderer/App.tsx` | Root: state, history, timeline derivations, `onAction` wiring, render shell |
| `src/renderer/TimelinePanel.tsx` | `DesktopTimeline` scroll shell built on `useTimelineSurfaceState` + `<TimelineSurface>` (split out so a future mobile shell can reuse them) |
| `src/renderer/AnchorLinesLayer.tsx` | SVG overlay; pointer-drag state machine driving `anchorEdit.ts`. Draws a plumb line for **every selected attachment at any editable level** — resolves each container un-windowed in its own scope (authored body + local resolved children rebuilt from the group's blocks), positions lines in content coords via `flattenGroups` placements, and commits edits through `editContainer` at the container's path |
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
- **Two resolved timelines** in the editor (both off the active document — the root doc, or the CC-cut preview while that mode is active):
  - `playerTimeline` — full compile (bins + scripts). Drives the canvas.
  - `editorTimeline` — `runScripts: false`. Drives the timeline panel so drag/trim/delete writes back to positions the user can see.
- **No drill-down navigation**: the editor always operates on the root document; there is no "enter into a clip/composition" view. CC Cut is the one editor mode, a modal flag (`ccCut` in `App.tsx`), not a view variant. Instead, compositions **expand inline** on the timeline (`timelineTree.ts` → recursive `TimelineGroup` in clip-boxes) and are edited in place.
- **Path-keyed selection (single source of truth)**: `App` holds `selection: string[]` of path keys (`children.0`, `children.3.attachments.1` — see `nodePath.ts`). The UI layer resolves each key to a node. Nested blocks support select / resize / delete / drag at any depth; mutations run the existing pure tools (`resizeChild`, `attachNewItems`, …) against the target composition through the `editContainer` lens. **`binItem` expansions are editable too** — their children address a `bin.<id>` root (`bin.intro.children.0`), so the same tools rewrite the shared bin entry and the edit propagates to every reference (Phase 3, intentional — the binItem block keeps its dashed-border/`Boxes` marker as the signal). Most legacy toolbar actions (compose/bin/slice/word/transcribe in `ControlsBar`, anchor lines, CC-cut) consume **flat root indices** derived via `rootIndicesFromKeys` and ignore nested selections; **Attach is the exception** — it's path-keyed and works at any level (`ControlsBar` gets both `selectedIndices` and `selection`). Selection display: `selection[0]` (the attach primary) renders **solid**, every other selected block **dashed**, regardless of type.
- **Unified timeline drag** (`DesktopTimeline` + `dropRegions.ts`): one drag pass handles reorder, drag **in/out of compositions**, and OS file-drop into any container. A grabbed block (`onReorderDragStart(path,…)`) or file is hit-tested against the flattened drop regions → target container + insertion slot → `moveNode` / `onImportAt`. The `[`/`]` **attach drop-zone** appears for a single selected clip/audio/composition primary at **any editable level** (incl. windowed containers — `attachNewItems` resolves the container **un-windowed** so child indices stay 1:1, and the drop's container-local `localTime` is likewise un-windowed, so they line up). Resize deltas in a nested group scale by the group's window `scale`. `flattenGroups`/`flattenDropRegions` track each container's *true* content-top (`RULER_HEIGHT + ROW_GAP` at root, then accumulated clip-box tops) — the root drop-region rect still starts at y=0 as the hit-test floor.
- **Schema is the single source of truth**; types mirror it. Defaults flow through Zod (`children` defaults to `[]`).
- **Default canvas**: `DEFAULT_CANVAS_WIDTH = 1080`, `DEFAULT_CANVAS_HEIGHT = 1920` (portrait). Used by App.tsx, preview main, VideoCanvas, CLI render/resolve.
- **Spatial model**: every node lays out via `origin` + `translation` + `size` (no more `top/left/right/bottom/width/height/position`):
  - `Length` value = `number | "p%" | "p% +/- n"`. Each property substitutes its own percent default when only a pixel number is given.
  - `origin` (point on the item, default `"50%"` = center): percent reference = item's own size. `0` evaluates to center.
  - `translation` (point in parent where origin lands, default `0` = center): percent reference = parent's content size. `0` = center; `"0%"` = top-left.
  - `size` (final pixel size, default `"100%"` = post-objectFit natural rect): percent reference = post-objectFit size. `100` (bare) = literal 100px box.
  - `rotation` (degrees, clockwise, default `0`, animatable): rotates the node about its `origin` point. Baked onto `SpatialRect.rotation` (+ `originX`/`originY` for the pivot) only when authored — non-rotated rects stay a plain `{x,y,width,height}` so existing equality checks hold. Preview rotates the textured quad in the WGSL vertex shader (and a rotated composition takes the FBO path so the whole group rotates as one); CLI composites rotated overlays via `qtblend` (see the MLT note below).
  - Final rect = `(translation - origin, size)`. Renderers consume this `SpatialRect` directly — no further objectFit math at draw time. `objectFit` only determines what `size: "100%"` evaluates to.
  - `contentWidth`/`contentHeight` accept `Length` too. Percentages resolve against the parent container; root composition must use pixel numbers.
- **`overflow`/`underflow`** are flex strategies (`trim-end`, `stretch`, etc.) only meaningful for attachments with both ends pinned and for composition windowing. Default `"trim-end"`.
- **`transition`** (`transitions` memory) — crossfade overlap (seconds) with the previous sequential sibling, on any producing type (clip/audio/static/text/graphic/composition). The resolver rewinds the placement cursor by the (clamped) overlap, shrinking the comp, stamps the effective `transition` (incoming) on the node and a mirrored `transitionOut` on the previous sibling (for audio's fade-out). First child / attachments ignore it. **Video** crossfade = fade the *incoming* element's alpha in over its first `transition` s; the outgoing one is occluded as it ramps (over-composite) — so MLT only needs the incoming clip on its own track (`isClipPositioned`) with a fade-in alpha ramp folded into its overlay rect, and the preview folds the fade into the draw/group opacity (routing a crossfading comp through the FBO). **Audio** sums, so both sides ramp (`afade` in/out in ffmpeg-audio; gain envelope in `AudioScheduler`/`FrameCoordinator`). Linear, matched preview↔render. Editor timeline shows the overlap by keeping sequential children on one row.
- **`ChildTimingFields`** shared interface for `in`, `out`, `overflow`, `underflow`, `id`, `start`, `end`, `metadata` — extended by Clip, Composition.
- **Composition `speed`/`duration`** mirror clips: the "source" is the inner window (`[in, out]`, default whole timeline). `speed` scales the window's playback (output = `windowSpan / speed`); `duration` sets the output length (derived rate = `windowSpan / duration`). Mutually exclusive. The resolved `ResolvedComposition.speed` carries the net rate (base × any overflow/underflow stretch) — overflow/underflow still layer on top when an anchor forces a different target, exactly as for clips.
- Preview renders via a single WebGPU canvas; `RenderList` walks the resolved tree into draw/group/fill commands. Compositions with filters use FBO render-to-texture; without filters, children flatten into the parent pass. `backgroundColor` renders as a stretched 1×1 color tile under the children.
- Web platform: `WebPlatform.preloadBlobUrls(sources)` must run before mounting the document so `resolveSource` returns blob URLs rather than bare filenames. `collectClipSources` compiles the doc first so clips inside bin entries are reachable. **pmtiles skip blob URL creation** in `importClip` — they go through `openPmtilesSource` (byte-range OPFS reads), never `resolveSource`.
- **Graphic pipeline (preview)**: per-tick, `GraphicStore.materializeTree` clears the fabric canvas and re-adds objects. `Map` instances are CACHED per (graphic, path) — re-using `OpenLayersMap` survives fabric's add/remove because `isPreEnliven=true` disables `dispose` on `removed`. New maps create fresh; subsequent ticks call `cached.set(filled)` which updates the OL view directly. Without the cache, OL would rebuild its style + drop its warm tile cache every frame.
- **Graphic pipeline (CLI)**: rasterize each ResolvedGraphic to a PNG sequence, wire into MLT alongside text (`qimage` + `ttl=1`, one track per graphic with its own `affine` transition + rect). Inspect `<file>.seam-rendered/graphic/` for spot-check PNGs.
- **MLT compositing uses `affine`, not `qtblend`** (melt 7.38): qtblend mis-scales an *overflowing* (cover) rect in non-portrait profiles (square sub-comp content boxes, square/landscape projects) — it silently falls back to fit. `affine` is a drop-in superset (same `rect` keyframe format, honors static+animated opacity, scales overflow correctly in every profile). Always emit **`distort=1`** so content fills the rect (matches the preview's quad), since objectFit is already baked into the rect dims; without it, non-uniform `size` (x≠y) is dropped. Deeper notes live in the `mlt-qtblend-rect-behavior` memory.
- **Rotation is the one `affine` exception** (`spatial-rotation` memory): melt 7.38's `affine` `fix_rotate_z` does NOT do in-plane 2D rotation (no tilt at 30/45°, content vanishes at 90°), so a node with a spatial `rotation` composites via **`qtblend`** instead (`rotation` degrees CW + `rotate_center=1`, both verified pixel-exact). qtblend rotates about the rect *center*; seam rotates about `origin`, so `formatGeometry` shifts the rect by `d − R(d)` (`d = origin − center`) to move the effective pivot to the origin. qtblend ignores partial rect opacity (same as affine on synthetic media) but honors op=0 show/hide. The narrow cost of qtblend: a rotated *overflowing* (cover) rect can mis-scale in non-portrait profiles — flagged as an `MltLimitation`. Animated rotation rides the rect's keyframe times.
- **Background base (track 0)**: the builder fills track 0 with `timeline.backgroundColor` if set, else `options.defaultBackgroundColor`, else opaque `black`. The root render uses the black default; a nested comp's sub-`.mlt` passes transparent (`#00000000`) so it composites as a layer. A comp's `backgroundColor` therefore both forces the sub-`.mlt` path (it's a complexity trigger) and becomes that sub-`.mlt`'s base.
- **CLI `render --proxy ORIGINAL:REPLACEMENT`** (repeatable): swaps any node `source` that *exactly equals* ORIGINAL for REPLACEMENT before render — verbatim match, no path resolution, split on first `:`. Applied to the resolved timeline so probe/audio/raster/build all see it.
- **No Node version pin needed.** The renderer's only native deps (`@napi-rs/canvas`, `canvas`) use **N-API** (ABI-stable across Node versions), so `engines` is just a `>=22` floor on renderer/CLI and `.nvmrc` tracks `lts/*`. The old exact-LTS pin (`>=22 <23 || >=24 <25`) existed solely for `@maplibre/maplibre-gl-native`'s V8-ABI-specific prebuilds (missing on 23/25); that dep is gone (map rendering is now pure-JS OpenLayers).
- **Timeline block colors** in TimelinePanel's `BLOCK_COLORS` — `graphic` is deep magenta (`#b03a8f` bg / `#d957b8` border) to distinguish from text's rose and composition's violet.
- **Font fallback (CJK + emoji)**: the bundled body font (Liberation Sans) is followed everywhere by **Noto Sans CJK JP** + **OpenMoji**. The family names + `withFallbackFamilies()` live in `@seam/core`'s `text/fallbackFonts.ts` (single source of truth); every `ctx.font` string appends them — text nodes (core, both sides), graphic text (a `FabricText._getFontDeclaration` patch in each package's `graphic/fontFallback.ts`, since fabric passes a comma-list `fontFamily` through verbatim), and map labels (both sides via `mapLabelFontStack` → `ol-mapbox-style` canvas text). Registration: renderer registers all three with **both** `@napi-rs/canvas` GlobalFonts (text nodes, `installFonts`) and **node-canvas** `registerFont` (fabric graphics + OpenLayers map labels, `registerNodeCanvasFonts`); the browser registers FontFaces via `loadFallbackFonts` (warmed at boot in preview/editor/web mains). TTFs live at `packages/renderer/fonts/{noto-cjk-jp,openmoji}/` and `packages/preview/src/renderer/fonts/` with their licenses (Noto = OFL, OpenMoji = CC BY-SA 4.0). **Emoji colour caveat**: rendered in colour by Skia (text nodes) and Chromium (all preview, incl. map labels), but **monochrome** in graphic-node and map-label CLI exports (both go through node-canvas/Cairo, which can't do COLR) — CJK is consistent everywhere. The CJK TTF is a 35 MB variable font, so browser loads are fire-and-forget (web bundle is heavy — subset later if it matters).

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
- OpenLayers + ol-mapbox-style + ol-pmtiles for Map elements — browser preview and headless renderer alike (renderer runs OL via jsdom + node-canvas)
- pmtiles for byte-range vector/raster tile reads (OPFS on web, fs on node)
- JSZip for web import/export
- melt + ffmpeg externally for final render

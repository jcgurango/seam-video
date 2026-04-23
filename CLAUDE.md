# Seam Video

Video editor where edits are defined as JSON (`.seam` files). No absolute timecodes — clips defined by source in/out, everything shifts automatically when you add/remove/reorder.

## Repo Structure

pnpm monorepo with 6 packages:

- **`@seam/core`** — Schema (Zod), types, layout resolver. Pure logic, no I/O.
- **`@seam/renderer`** — Builds FFmpeg filter graphs from resolved timelines and executes them.
- **`@seam/cli`** — `render` and `preview` commands (Commander).
- **`@seam/preview`** — Electron + React live preview with file watching. Exports Player, Timeline, TransportControls components for reuse.
- **`@seam/editor`** — Electron + React editing app. Owns React UI, platform abstraction (Electron / Web / Mobile), exports App + platform for host shells to consume.
- **`@seam/web`** — Web (browser) shell for the editor. OPFS-backed storage with `projects/` and `clips/` directories.

## Commands

```
pnpm test              # all tests (core + renderer, Vitest)
pnpm build             # build all packages
pnpm --filter @seam/preview build && pnpm --filter @seam/preview dev   # preview dev
pnpm --filter @seam/editor build && pnpm --filter @seam/editor dev    # editor dev (Electron)
pnpm --filter @seam/web dev                                           # editor dev (web / OPFS)
npx tsx packages/cli/src/index.ts render <file.seam>                   # render via ffmpeg
```

## Key Files

| File | Role |
|------|------|
| `packages/core/src/schema.ts` | Zod schemas — uses `z.lazy` + `z.union` for recursive compositions |
| `packages/core/src/types.ts` | TypeScript types matching the schema |
| `packages/core/src/resolved-types.ts` | Output types after layout resolution |
| `packages/core/src/layout/resolve.ts` | `resolveComposition()` — the layout engine (sequential `children` + anchored `attachments`) |
| `packages/renderer/src/ffmpeg-builder.ts` | ResolvedTimeline → FFmpeg filter graph + args |
| `packages/renderer/src/ffmpeg-runner.ts` | Executes FFmpeg commands |
| `packages/preview/src/renderer/components/Timeline.tsx` | Root player — rAF clock, single WebGPU canvas |
| `packages/preview/src/renderer/media/gpu/WebGPURenderer.ts` | GPU compositor — blit + filter shaders (eq, colorbalance, colortemp, opacity), FBO for group filters |
| `packages/preview/src/renderer/media/gpu/RenderList.ts` | Walks resolved timeline tree → draw/group commands for GPU |
| `packages/preview/src/renderer/media/FrameCoordinator.ts` | Manages ClipPlayers, decodes video frames via mediabunny |
| `packages/preview/src/renderer/media/AudioScheduler.ts` | Web Audio API master clock + per-clip audio scheduling |
| `FILE-FORMAT.md` | User-facing file format documentation |

## Conventions

- **Seconds everywhere** — frames only at the FFmpeg boundary (default 30fps)
- **`children`** not `segments` for composition arrays
- **`overflow`/`underflow`** for flex adjustment strategies (trim-end, stretch, etc.). `overflow` is optional in schema; default is `"trim-end"` for composition children
- **`ChildTimingFields`** shared interface for `in`, `out`, `flex`, `overflow`, `underflow`, `id`, `start`, `end` — used by Clip, Composition, and RefChild
- **Node types**: `clip`, `empty`, `composition` (sequential `children` + anchored `attachments` that render on top), `ref`
- Schema is the single source of truth; types mirror it exactly
- Preview renders via a single WebGPU canvas — `RenderList` walks the resolved tree into draw/group commands, `WebGPURenderer` executes them. Compositions with filters use FBO render-to-texture; without filters, children are flattened

## Tech

- TypeScript (ES2022, strict, ESM)
- Vitest for testing
- Zod for schema validation
- Electron + React (electron-vite) for preview
- Commander for CLI

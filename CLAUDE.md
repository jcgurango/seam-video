# Seam Video

Video editor where edits are defined as JSON (`.seam` files). No absolute timecodes — clips defined by source in/out, everything shifts automatically when you add/remove/reorder.

## Repo Structure

pnpm monorepo with 4 packages:

- **`@seam/core`** — Schema (Zod), types, layout resolver. Pure logic, no I/O.
- **`@seam/renderer`** — Builds FFmpeg filter graphs from resolved timelines and executes them.
- **`@seam/cli`** — `render` and `preview` commands (Commander).
- **`@seam/preview`** — Electron + React live preview with file watching.

## Commands

```
pnpm test              # all tests (core + renderer, Vitest)
pnpm build             # build all packages
pnpm --filter @seam/preview build && pnpm --filter @seam/preview dev   # preview dev
npx tsx packages/cli/src/index.ts render <file.seam>                   # render via ffmpeg
```

## Key Files

| File | Role |
|------|------|
| `packages/core/src/schema.ts` | Zod schemas — uses `z.lazy` + `z.union` for recursive compositions |
| `packages/core/src/types.ts` | TypeScript types matching the schema |
| `packages/core/src/resolved-types.ts` | Output types after layout resolution |
| `packages/core/src/layout/resolve.ts` | `resolveComposition()` + `resolveOverlay()` — the layout engine |
| `packages/renderer/src/ffmpeg-builder.ts` | ResolvedTimeline → FFmpeg filter graph + args |
| `packages/renderer/src/ffmpeg-runner.ts` | Executes FFmpeg commands |
| `packages/preview/src/renderer/components/Timeline.tsx` | Root player — rAF clock, context provider |
| `packages/preview/src/renderer/components/Clip.tsx` | Video element with play/scrub sync |
| `FILE-FORMAT.md` | User-facing file format documentation |

## Conventions

- **Seconds everywhere** — frames only at the FFmpeg boundary (default 30fps)
- **`children`** not `segments` for composition arrays
- **`overflow`/`underflow`** for flex adjustment strategies (trim-end, stretch, etc.). `overflow` is optional in schema; defaults applied at resolution time (compositions: `"trim-end"`, overlays: depends on `alignItems`)
- **`ChildTimingFields`** shared interface for `in`, `out`, `flex`, `overflow`, `underflow` — used by Clip, Composition, and Overlay
- **Node types**: `clip`, `empty`, `composition` (sequential), `overlay` (stacked z-order)
- Schema is the single source of truth; types mirror it exactly
- Preview components use a context-override pattern: `<Composition>`/`<Overlay>` re-provides `TimelineContext` with local time so children don't know their nesting depth

## Tech

- TypeScript (ES2022, strict, ESM)
- Vitest for testing
- Zod for schema validation
- Electron + React (electron-vite) for preview
- Commander for CLI

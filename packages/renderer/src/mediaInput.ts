/**
 * Where a node's `source` string lives: a path (relative to the .seam's dir)
 * or an `http(s)://` URL. Remote sources — e.g. the editor's "Export Remote
 * .seam", whose sources are Seam Cloud streaming URLs — are streamed through
 * `@seam/media-source`'s block cache (`PlannedSource` over a `BlockStores`
 * registry): bounded `Range` requests, one shared byte budget, eviction and
 * prefetch driven by the timeline (`CutPlanner` in `render.ts`) rather than
 * by mediabunny's positional `UrlSource` heuristics.
 *
 * Every opener in a render shares one registry so the planner's warmed blocks
 * are the ones the frame loop and the audio mix read. Callers that don't pass
 * one (tests) get a process-wide default.
 */
import { isAbsolute, join } from "node:path";
import { FilePathSource } from "mediabunny";
import { BlockStores, PlannedSource } from "@seam/media-source";

export function isRemoteSource(src: string): boolean {
  return /^https?:\/\//i.test(src);
}

/** Absolute path for a local source; a URL comes back untouched. */
export function resolveSourcePath(src: string, basePath: string): string {
  if (isRemoteSource(src)) return src;
  return isAbsolute(src) ? src : join(basePath, src);
}

let defaultStores: BlockStores | null = null;

/** Process-wide registry for callers that don't thread their own. */
export function sharedBlockStores(): BlockStores {
  return (defaultStores ??= new BlockStores());
}

/** The mediabunny input source for a clip/audio node. */
export function openMediaSource(
  src: string,
  basePath: string,
  stores: BlockStores = sharedBlockStores(),
): FilePathSource | PlannedSource {
  return isRemoteSource(src)
    ? new PlannedSource(stores.get(src))
    : new FilePathSource(resolveSourcePath(src, basePath));
}

/**
 * Where a node's `source` string lives: a path (relative to the .seam's dir)
 * or an `http(s)://` URL. Remote sources — e.g. the editor's "Export Remote
 * .seam", whose sources are Seam Cloud streaming URLs — are streamed with
 * mediabunny's byte-range `UrlSource` instead of being downloaded first.
 *
 * mediabunny ≥ 1.61.5 required: earlier UrlSource read orchestrators could
 * leave a queued read pending forever on far seeks (see the
 * `urlsource-deadlock` memory and `__tests__/url-source-far-seek.test.ts`).
 */
import { isAbsolute, join } from "node:path";
import { FilePathSource, UrlSource } from "mediabunny";

export function isRemoteSource(src: string): boolean {
  return /^https?:\/\//i.test(src);
}

/** Absolute path for a local source; a URL comes back untouched. */
export function resolveSourcePath(src: string, basePath: string): string {
  if (isRemoteSource(src)) return src;
  return isAbsolute(src) ? src : join(basePath, src);
}

/** The mediabunny input source for a clip/audio node. */
export function openMediaSource(
  src: string,
  basePath: string,
): FilePathSource | UrlSource {
  return isRemoteSource(src)
    ? new UrlSource(src)
    : new FilePathSource(resolveSourcePath(src, basePath));
}

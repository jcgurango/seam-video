/**
 * Where a node's `source` string lives: a path (relative to the .seam's dir)
 * or an `http(s)://` URL. Remote sources — e.g. the editor's "Export Remote
 * .seam", whose sources are Seam Cloud streaming URLs — are streamed with
 * mediabunny's byte-range `UrlSource` instead of being downloaded first.
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

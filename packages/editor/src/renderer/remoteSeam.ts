/**
 * "Remote .seam" — a document whose every media source is a Seam Cloud
 * streaming URL (token attached). Meant for a final render straight off the
 * cloud without pulling the media down. These are the pure document rewrites
 * behind the Cloud menu's Export / Import Remote .seam; the platform supplies
 * the name↔URL lookups.
 */
import type { SeamFile } from "@seam/core";
import { mapDocumentSources } from "./exportHelpers.js";

/** `http(s)://` sources — already remote, streamed as-is by every host. */
export function isRemoteSource(src: string): boolean {
  return /^https?:\/\//i.test(src);
}

/** Sources no host can hand off to another machine: in-memory blob / data
 *  URLs. They are never rewritten (and can't be uploaded). */
export function isOpaqueSource(src: string): boolean {
  return /^(blob:|data:)/i.test(src);
}

export interface RemoteDocumentResult {
  /** Every cloud-backed source replaced by its streaming URL. */
  document: SeamFile;
  /** Sources `urlFor` couldn't resolve (left untouched). Unique, in order. */
  unresolved: string[];
}

/**
 * Rewrite every local media source (clip/audio/static `source`, graphic
 * `Image` `src`, recursing bin bodies) to the URL `urlFor` returns for it.
 * Remote and opaque sources pass through; a `null` from `urlFor` leaves the
 * source as-is and reports it in `unresolved` so the caller can abort.
 */
export function toRemoteDocument(
  doc: SeamFile,
  urlFor: (name: string) => string | null
): RemoteDocumentResult {
  const unresolved = new Set<string>();
  const document = mapDocumentSources(doc, (src) => {
    if (isRemoteSource(src) || isOpaqueSource(src)) return src;
    const url = urlFor(src);
    if (url == null) {
      unresolved.add(src);
      return src;
    }
    return url;
  });
  return { document, unresolved: [...unresolved] };
}

export interface LocalDocumentResult {
  /** Every recognised cloud URL replaced by the asset's filename. */
  document: SeamFile;
  /** Remote sources `nameFor` didn't recognise (left as URLs). Unique. */
  kept: string[];
}

/**
 * Inverse of {@link toRemoteDocument}: map each remote source back to a bare
 * filename via `nameFor`. Unrecognised URLs stay remote (they still stream),
 * and are reported in `kept`.
 */
export function fromRemoteDocument(
  doc: SeamFile,
  nameFor: (url: string) => string | null
): LocalDocumentResult {
  const kept = new Set<string>();
  const document = mapDocumentSources(doc, (src) => {
    if (!isRemoteSource(src)) return src;
    const name = nameFor(src);
    if (name == null) {
      kept.add(src);
      return src;
    }
    return name;
  });
  return { document, kept: [...kept] };
}

/**
 * Extract the media id from a Seam Cloud streaming URL
 * (`<base>/api/media/<id>/file[?token=…]`) issued by `baseUrl`. Null for any
 * other URL — including the same path on a different cloud.
 */
export function parseCloudMediaUrl(url: string, baseUrl: string): string | null {
  const base = baseUrl.replace(/\/+$/, "");
  if (!url.startsWith(base + "/")) return null;
  const rest = url.slice(base.length);
  const m = /^\/api\/media\/([^/?#]+)\/file(?:[?#]|$)/.exec(rest);
  return m ? decodeURIComponent(m[1]) : null;
}

const REMOTE_SUFFIX = "-remote";

/** `intro` → `intro-remote.seam`. */
export function remoteExportFilename(stem: string): string {
  return `${stem}${REMOTE_SUFFIX}.seam`;
}

/** `intro-remote.seam` → `intro.seam`; anything else keeps its name (with a
 *  `.seam` extension ensured). */
export function localProjectFilename(remoteFilename: string): string {
  const name = remoteFilename.endsWith(".seam")
    ? remoteFilename
    : `${remoteFilename}.seam`;
  const stem = name.slice(0, -".seam".length);
  return stem.endsWith(REMOTE_SUFFIX) && stem.length > REMOTE_SUFFIX.length
    ? `${stem.slice(0, -REMOTE_SUFFIX.length)}.seam`
    : name;
}

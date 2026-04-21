export type SourceResolver = (source: string, basePath: string) => string;

/**
 * The built-in resolver (file:// URLs). Exported so platform implementations
 * can delegate to it without going through the pluggable `resolveSource` —
 * calling the pluggable version from an override would recurse.
 */
export function defaultResolveSource(
  source: string,
  basePath: string
): string {
  if (
    source.startsWith("http://") ||
    source.startsWith("https://") ||
    source.startsWith("blob:")
  ) {
    return source;
  }
  // Already absolute: Windows drive letter (C:\) or Unix root (/)
  const isAbsolute = source.startsWith("/") || /^[A-Z]:/i.test(source);
  const fullPath = isAbsolute ? source : `${basePath}/${source}`;
  return `file:///${fullPath.replace(/^\//, "")}`;
}

let currentResolver: SourceResolver = defaultResolveSource;

/** Override the global source resolver (used by the media layer). */
export function setSourceResolver(fn: SourceResolver): void {
  currentResolver = fn;
}

/** Reset to the default `file://`-based resolver. */
export function resetSourceResolver(): void {
  currentResolver = defaultResolveSource;
}

export function resolveSource(source: string, basePath: string): string {
  return currentResolver(source, basePath);
}

export function resolveSource(source: string, basePath: string): string {
  if (source.startsWith("http://") || source.startsWith("https://")) {
    return source;
  }
  // Already absolute: Windows drive letter (C:\) or Unix root (/)
  const isAbsolute = source.startsWith("/") || /^[A-Z]:/i.test(source);
  const fullPath = isAbsolute ? source : `${basePath}/${source}`;
  return `file:///${fullPath.replace(/^\//, "")}`;
}

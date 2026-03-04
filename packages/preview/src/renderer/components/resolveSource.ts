export function resolveSource(source: string, basePath: string): string {
  if (source.startsWith("http://") || source.startsWith("https://")) {
    return source;
  }
  const fullPath = source.includes(":") ? source : `${basePath}/${source}`;
  return `file:///${fullPath}`;
}

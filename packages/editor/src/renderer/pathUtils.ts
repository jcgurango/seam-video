/** Extract directory from a file path. */
export function dirname(p: string): string {
  const sep = p.lastIndexOf("/");
  const backslash = p.lastIndexOf("\\");
  const last = Math.max(sep, backslash);
  if (last === -1) return ".";
  if (last === 0) return "/";
  return p.slice(0, last);
}

/** Last segment of a path. Handles both `/` and `\` separators. */
export function basename(p: string): string {
  const i = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  return i < 0 ? p : p.slice(i + 1);
}

/** Basename with the final extension stripped. */
export function basenameWithoutExt(p: string): string {
  const file = basename(p);
  const dot = file.lastIndexOf(".");
  return dot > 0 ? file.slice(0, dot) : file;
}

/** Check if a path is absolute. */
export function isAbsolute(p: string): boolean {
  return p.startsWith("/") || /^[A-Z]:\\/i.test(p);
}

/** Compute a relative path from `from` directory to `to` file. */
export function relative(from: string, to: string): string {
  const normalize = (s: string) =>
    s.replace(/\\/g, "/").replace(/\/+$/, "").split("/");
  const fromParts = normalize(from);
  const toParts = normalize(to);

  // Find common prefix length
  let common = 0;
  while (
    common < fromParts.length &&
    common < toParts.length &&
    fromParts[common] === toParts[common]
  ) {
    common++;
  }

  const ups = fromParts.length - common;
  const remainder = toParts.slice(common);
  const parts = [...Array(ups).fill(".."), ...remainder];
  return parts.join("/");
}

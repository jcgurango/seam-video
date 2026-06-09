// In-memory src registry — the test bench's stand-in for the editor's
// asset cache. JSON stores a logical id; resolve() maps to a runtime URL
// (blob URL today, cache key in the real editor). The host swaps these
// values in/out at the boundaries of fabric serialization.

const realByLogical = new Map<string, string>();

let counter = 0;

export function registerBlob(blob: Blob, hint?: string): string {
  const id = `img-${hint ?? counter.toString(36)}-${crypto.randomUUID().slice(0, 6)}`;
  counter++;
  const url = URL.createObjectURL(blob);
  realByLogical.set(id, url);
  return id;
}

export function resolveSrc(logical: string): string | undefined {
  return realByLogical.get(logical);
}

// Pre-loadFromJSON: walks the object tree, replacing any image's `src` with
// the resolved real URL if it matches a registered logical id. The original
// logical id is stashed as `logicalSrc` so writeBack can re-emit it.
export function rewriteToReal<T>(node: T): T {
  return walk(node, (n: Record<string, unknown>) => {
    if (n.type === "Image" && typeof n.src === "string") {
      const real = realByLogical.get(n.src);
      if (real) {
        return { ...n, src: real, logicalSrc: n.src };
      }
    }
    return n;
  }) as T;
}

// Post-toObject: walks the serialized tree, replacing real URLs with the
// logical id stashed in `logicalSrc`. Images without a `logicalSrc` pass
// through untouched (e.g. user-authored absolute URLs).
export function rewriteToLogical<T>(node: T): T {
  return walk(node, (n: Record<string, unknown>) => {
    if (
      n.type === "Image" &&
      typeof n.logicalSrc === "string" &&
      n.logicalSrc.length > 0
    ) {
      const next: Record<string, unknown> = { ...n, src: n.logicalSrc };
      delete next.logicalSrc;
      return next;
    }
    // Always drop logicalSrc from output even if no rewrite happens —
    // it's runtime bookkeeping, never the schema.
    if ("logicalSrc" in n) {
      const next = { ...n };
      delete next.logicalSrc;
      return next;
    }
    return n;
  }) as T;
}

function walk(
  node: unknown,
  transform: (n: Record<string, unknown>) => Record<string, unknown>,
): unknown {
  if (Array.isArray(node)) {
    return node.map(child => walk(child, transform));
  }
  if (node && typeof node === "object") {
    const transformed = transform(node as Record<string, unknown>);
    const out: Record<string, unknown> = { ...transformed };
    if (Array.isArray(out.objects)) {
      out.objects = (out.objects as unknown[]).map(child =>
        walk(child, transform),
      );
    }
    return out;
  }
  return node;
}

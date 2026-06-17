// Graphic `Image` objects carry a `src` that points at external media, the
// same way `clip`/`audio`/`static` nodes carry `source`. But an Image lives
// deep inside a graphic node's `frames` (and clip defs), nested through
// Groups and Map anchor wrappers — so the flat Child-walk the export/collect
// helpers use can't reach it. This module is the recursive traversal that
// maps every graphic Image `src` through a function, for collection (push the
// src) and rewriting (export basename / relative path) alike.

type Obj = Record<string, unknown>;

/** True for an Image `src` worth bundling / preloading / rewriting — a
 *  file-like reference, not an inline `data:` URI or a remote URL (those load
 *  directly and aren't backed by a file on disk / in OPFS). */
export function isBundleableImageSrc(src: unknown): src is string {
  return (
    typeof src === "string" &&
    src.length > 0 &&
    !/^(data:|https?:|blob:)/i.test(src)
  );
}

/** Map one graphic object's Image `src`s through `fn` (file-like srcs only),
 *  recursing into Groups and Map anchor wrappers. Returns a new object when
 *  anything changed, else the original. */
function mapGraphicObject(obj: Obj, fn: (src: string) => string): Obj {
  const type = obj.type;
  if (type === "Image") {
    return isBundleableImageSrc(obj.src)
      ? { ...obj, src: fn(obj.src) }
      : obj;
  }
  if (type === "Group" && Array.isArray(obj.objects)) {
    return {
      ...obj,
      objects: (obj.objects as Obj[]).map((o) => mapGraphicObject(o, fn)),
    };
  }
  if (type === "Map") {
    let next = obj;
    if (Array.isArray(obj.objects)) {
      next = {
        ...next,
        objects: (obj.objects as Obj[]).map((w) => mapAnchorWrapper(w, fn)),
      };
    }
    if (Array.isArray(obj.paths)) {
      next = {
        ...next,
        paths: (obj.paths as Obj[]).map((p) =>
          Array.isArray(p.objects)
            ? { ...p, objects: (p.objects as Obj[]).map((w) => mapAnchorWrapper(w, fn)) }
            : p,
        ),
      };
    }
    return next;
  }
  return obj;
}

/** A Map anchor wrapper is `{ latitude?, longitude?, position?, object }` —
 *  recurse into its inner object. */
function mapAnchorWrapper(wrap: Obj, fn: (src: string) => string): Obj {
  const inner = wrap.object;
  if (inner && typeof inner === "object") {
    return { ...wrap, object: mapGraphicObject(inner as Obj, fn) };
  }
  return wrap;
}

/** Map every Image `src` in a graphic node — across all keyframes and clip
 *  definitions — through `fn`. Returns a new graphic node. */
export function mapGraphicImageSources(
  graphic: Obj,
  fn: (src: string) => string,
): Obj {
  const mapFrames = (frames: unknown): unknown => {
    if (!Array.isArray(frames)) return frames;
    return frames.map((f) => {
      if (!Array.isArray(f) || !Array.isArray(f[1])) return f;
      const next = [...f];
      next[1] = (f[1] as Obj[]).map((o) => mapGraphicObject(o, fn));
      return next;
    });
  };
  let next: Obj = { ...graphic, frames: mapFrames(graphic.frames) };
  if (Array.isArray(graphic.clips)) {
    next = {
      ...next,
      clips: (graphic.clips as Obj[]).map((c) => ({
        ...c,
        frames: mapFrames(c.frames),
      })),
    };
  }
  return next;
}

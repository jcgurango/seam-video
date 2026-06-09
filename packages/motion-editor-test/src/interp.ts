import { classRegistry, Color } from "fabric";

// Props beyond fabric's own that participate in serialization and animation.
// `logicalSrc` is bookkeeping for Image instances — it round-trips through
// toObject so the post-process swap can rewrite the real URL back to the
// logical id before saving to JSON.
export const CUSTOM_PROPS: string[] = [
  "id",
  "revolutions",
  "angleDirection",
  "logicalSrc",
];

export type FilledObject = Record<string, unknown>;
export type FilledTree = FilledObject[];
// Flat path-keyed map. Each entry holds the node's own props with `objects`
// stripped — it represents one renderable node, not its descendants.
export type FlatFrame = Record<string, FilledObject>;
export type FilledFrame = {
  tree: FilledTree;
  flat: FlatFrame;
  frameIndex: number;
};

// ───────────────────────────────────────────────────────────────────────────
// Filling defaults
// ───────────────────────────────────────────────────────────────────────────

export async function fillObject(
  authored: Record<string, unknown>,
): Promise<FilledObject> {
  const type = authored.type;
  if (typeof type !== "string") return { ...authored };
  try {
    const Cls = classRegistry.getClass(type) as unknown as {
      fromObject?: (o: Record<string, unknown>) => Promise<unknown>;
      new (o?: Record<string, unknown>): unknown;
    };
    let inst: {
      includeDefaultValues: boolean;
      toObject(props: string[]): FilledObject;
    };
    if (typeof Cls.fromObject === "function") {
      inst = (await Cls.fromObject({ ...authored })) as typeof inst;
    } else {
      inst = new (Cls as unknown as new (o: Record<string, unknown>) => typeof inst)(
        { ...authored },
      );
    }
    const prev = inst.includeDefaultValues;
    inst.includeDefaultValues = true;
    const filled = inst.toObject(CUSTOM_PROPS);
    inst.includeDefaultValues = prev;
    return filled;
  } catch {
    return { ...authored };
  }
}

function pathKey(node: FilledObject, index: number): string {
  const id = node.id;
  if (typeof id === "string" && id.length > 0) return id;
  return String(index);
}

function buildFlat(
  tree: FilledTree,
  parentPath: string,
  flat: FlatFrame,
): void {
  tree.forEach((node, i) => {
    const key = pathKey(node, i);
    const path = parentPath === "" ? key : `${parentPath}.${key}`;
    const { objects: children, ...rest } = node;
    flat[path] = rest;
    if (Array.isArray(children)) {
      buildFlat(children as FilledTree, path, flat);
    }
  });
}

export async function fillFrame(
  authored: ReadonlyArray<unknown>,
  frameIndex: number,
): Promise<FilledFrame> {
  const tree: FilledTree = await Promise.all(
    authored.map(o => fillObject(o as Record<string, unknown>)),
  );
  const flat: FlatFrame = {};
  buildFlat(tree, "", flat);
  return { tree, flat, frameIndex };
}

// ───────────────────────────────────────────────────────────────────────────
// Path walking for the live fabric tree (used by playback to look up nodes).
// ───────────────────────────────────────────────────────────────────────────

export interface FabricLike {
  id?: unknown;
  getObjects?: () => FabricLike[];
}

export function attachPaths(
  tree: FilledTree,
  live: FabricLike[],
  parentPath: string,
  pathToObj: Map<string, FabricLike>,
): void {
  for (let i = 0; i < tree.length; i++) {
    const node = tree[i];
    const obj = live[i];
    if (!obj) continue;
    const key = pathKey(node, i);
    const path = parentPath === "" ? key : `${parentPath}.${key}`;
    pathToObj.set(path, obj);
    const children = node.objects;
    if (Array.isArray(children) && typeof obj.getObjects === "function") {
      attachPaths(children as FilledTree, obj.getObjects(), path, pathToObj);
    }
  }
}

// ───────────────────────────────────────────────────────────────────────────
// Interpolation
// ───────────────────────────────────────────────────────────────────────────

const DISCRETE_PROPS = new Set<string>([
  "type",
  "id",
  "version",
  "revolutions",
  "angleDirection",
  "visible",
  "flipX",
  "flipY",
  "originX",
  "originY",
  "fontFamily",
  "fontStyle",
  "fontWeight",
  "text",
  "textAlign",
  "textBackgroundColor",
  "underline",
  "overline",
  "linethrough",
  "direction",
  "strokeLineCap",
  "strokeLineJoin",
  "strokeMiterLimit",
  "strokeUniform",
  "strokeDashArray",
  "strokeDashOffset",
  "paintFirst",
  "globalCompositeOperation",
  "selectable",
  "evented",
  "excludeFromExport",
  "objectCaching",
  "absolutePositioned",
  "inverted",
  "centeredScaling",
  "centeredRotation",
  "lockMovementX",
  "lockMovementY",
  "lockRotation",
  "lockScalingX",
  "lockScalingY",
  "lockSkewingX",
  "lockSkewingY",
  "lockScalingFlip",
  "hasBorders",
  "hasControls",
  "noScaleCache",
  "borderColor",
  "cornerColor",
  "cornerStrokeColor",
  "cornerStyle",
  "borderDashArray",
  "cornerDashArray",
  "transparentCorners",
  "hoverCursor",
  "moveCursor",
  "borderOpacityWhenMoving",
  "borderScaleFactor",
  "minScaleLimit",
  "padding",
  "perPixelTargetFind",
  "snapAngle",
  "snapThreshold",
  "splitByGrapheme",
  "styles",
  "subTargetCheck",
  "interactive",
  "layoutManager",
  "clipId",
  "startPosition",
  "repeat",
  "logicalSrc",
  "src",
  "crossOrigin",
]);

type Direction = "shortest" | "cw" | "ccw";

function lerpNum(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function computeAngleDelta(
  prev: number,
  next: number,
  revolutions: number,
  dir: Direction,
): number {
  const a = ((prev % 360) + 360) % 360;
  const b = ((next % 360) + 360) % 360;
  let base: number;
  let sign: number;
  if (dir === "cw") {
    base = b - a;
    if (base < 0) base += 360;
    sign = 1;
  } else if (dir === "ccw") {
    base = b - a;
    if (base > 0) base -= 360;
    sign = -1;
  } else {
    base = b - a;
    if (base > 180) base -= 360;
    else if (base < -180) base += 360;
    sign = base >= 0 ? 1 : -1;
  }
  return base + revolutions * 360 * sign;
}

function lerpColor(a: unknown, b: unknown, t: number): string | null {
  if (typeof a !== "string" || typeof b !== "string") return null;
  try {
    const ca = new Color(a).getSource();
    const cb = new Color(b).getSource();
    if (!ca || !cb) return null;
    const r = Math.round(lerpNum(ca[0], cb[0], t));
    const g = Math.round(lerpNum(ca[1], cb[1], t));
    const bl = Math.round(lerpNum(ca[2], cb[2], t));
    const al = lerpNum(ca[3] ?? 1, cb[3] ?? 1, t);
    return `rgba(${r},${g},${bl},${al})`;
  } catch {
    return null;
  }
}

type PathCmd = (string | number)[];

function pathsStructureMatch(a: PathCmd[], b: PathCmd[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i].length !== b[i].length) return false;
    if (a[i][0] !== b[i][0]) return false;
  }
  return true;
}

function lerpPath(a: PathCmd[], b: PathCmd[], t: number): PathCmd[] {
  return a.map((cmd, i) =>
    cmd.map((val, j) => {
      if (j === 0) return val;
      const bn = b[i][j];
      if (typeof val === "number" && typeof bn === "number") {
        return lerpNum(val, bn, t);
      }
      return val;
    }),
  );
}

function interpolateObject(
  prev: FilledObject,
  next: FilledObject,
  t: number,
): FilledObject {
  const out: FilledObject = {};
  const keys = new Set<string>([...Object.keys(prev), ...Object.keys(next)]);
  for (const k of keys) {
    const a = prev[k];
    const b = next[k];
    if (a === undefined && b === undefined) continue;
    if (DISCRETE_PROPS.has(k)) {
      out[k] = a !== undefined ? a : b;
      continue;
    }
    if (k === "angle") {
      const aa = typeof a === "number" ? a : 0;
      const bb = typeof b === "number" ? b : 0;
      const rev =
        typeof next.revolutions === "number" ? (next.revolutions as number) : 0;
      const rawDir = next.angleDirection;
      const dir: Direction =
        rawDir === "cw" || rawDir === "ccw" ? rawDir : "shortest";
      const delta = computeAngleDelta(aa, bb, rev, dir);
      out.angle = aa + delta * t;
      continue;
    }
    if (k === "fill" || k === "stroke") {
      const lerped = lerpColor(a, b, t);
      out[k] = lerped ?? (a !== undefined ? a : b);
      continue;
    }
    if (
      k === "points" &&
      Array.isArray(a) &&
      Array.isArray(b) &&
      a.length === b.length
    ) {
      out[k] = a.map((pt, i) => ({
        x: lerpNum(
          (pt as { x: number }).x,
          ((b as { x: number }[])[i]).x,
          t,
        ),
        y: lerpNum(
          (pt as { y: number }).y,
          ((b as { y: number }[])[i]).y,
          t,
        ),
      }));
      continue;
    }
    if (
      k === "path" &&
      Array.isArray(a) &&
      Array.isArray(b) &&
      pathsStructureMatch(a as PathCmd[], b as PathCmd[])
    ) {
      out[k] = lerpPath(a as PathCmd[], b as PathCmd[], t);
      continue;
    }
    if (typeof a === "number" && typeof b === "number") {
      out[k] = lerpNum(a, b, t);
      continue;
    }
    out[k] = a !== undefined ? a : b;
  }
  return out;
}

// Walk prev.flat — for each path: if next has the same path AND same type,
// lerp; else freeze at prev. Paths only in `next` are dropped (they appear
// discretely at next's stamp, when prev structure flips to next's).
export function interpolateFrames(
  prev: FilledFrame,
  next: FilledFrame,
  t: number,
): FlatFrame {
  const out: FlatFrame = {};
  for (const path in prev.flat) {
    const a = prev.flat[path];
    const b = next.flat[path];
    if (b && a.type === b.type) {
      out[path] = interpolateObject(a, b, t);
    } else {
      out[path] = { ...a };
    }
  }
  return out;
}

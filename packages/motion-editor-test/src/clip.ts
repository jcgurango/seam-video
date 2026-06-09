import {
  classRegistry,
  FixedLayout,
  Group,
  LayoutManager,
  type FabricObject,
  type GroupProps,
} from "fabric";
import {
  fillFrame,
  interpolateFrames,
  type FilledFrame,
  type FilledTree,
  type FlatFrame,
  type FilledObject,
} from "./interp.js";

// Schema-level shape of a Clip instance. The live fabric instance has empty
// children until a post-load pass walks the canvas and resolves each Clip
// against the doc's clip definitions.
export interface ClipOptions extends Partial<GroupProps> {
  clipId?: string;
  startPosition?: number;
  repeat?: number;
}

export class Clip extends Group {
  static type = "Clip";

  clipId = "";
  startPosition = 0;
  repeat = -1;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  constructor(options: ClipOptions = {}, children: FabricObject[] = []) {
    // Strip `type` — fabric warns when setOptions tries to assign it because
    // `type` is class-defined. Strip our own props before they reach Group's
    // setOptions which only knows about Group props.
    const {
      type: _ignoredType,
      clipId,
      startPosition,
      repeat,
      layoutManager: _ignoredLM,
      ...groupOptions
    } = options as Record<string, unknown> & ClipOptions;

    super(children, {
      ...groupOptions,
      // Fixed layout: the Clip's bbox is owned by the schema
      // (contentWidth/contentHeight from the clip definition), not derived
      // from the children. Passing it in options means the *initial* layout
      // pass — which fabric runs synchronously inside groupInit — already
      // uses the strategy, so the bbox is correct from the first frame.
      layoutManager: new LayoutManager(new FixedLayout()),
    } as Partial<GroupProps>);

    if (typeof clipId === "string") this.clipId = clipId;
    if (typeof startPosition === "number") this.startPosition = startPosition;
    if (typeof repeat === "number") this.repeat = repeat;
    this.subTargetCheck = false;
    this.interactive = false;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  static async fromObject(obj: any): Promise<Clip> {
    // Children are derived at resolve time, not from JSON.
    return new Clip(obj, []);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  toObject(propertiesToInclude: any = []): any {
    const extra = [
      ...(propertiesToInclude as string[]),
      "clipId",
      "startPosition",
      "repeat",
    ];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const out = (super.toObject as any).call(this, extra) as Record<
      string,
      unknown
    >;
    delete out.objects;
    delete out.layoutManager;
    // Width and height are derived from the clip definition at resolve
    // time. Stripping them from the JSON means the schema can't drift out
    // of sync with the referenced clip's contentWidth/contentHeight.
    delete out.width;
    delete out.height;
    return out;
  }
}

classRegistry.setClass(Clip, "Clip");

// ───────────────────────────────────────────────────────────────────────────
// Sub-clip playback
// ───────────────────────────────────────────────────────────────────────────

// Each frame tuple is read positionally: [0]=stamp, [1]=objects, [2]=easing?.
// Typed loosely as ReadonlyArray<unknown> so the optional 3rd element doesn't
// force callers to ceremoniously narrow.
export type FrameTuple = ReadonlyArray<unknown>;

export type ClipDefLike = {
  id: string;
  duration?: number;
  loop?: boolean;
  contentWidth?: number;
  contentHeight?: number;
  frames: ReadonlyArray<FrameTuple>;
};

type ClipExtKf = {
  stamp: number;
  snap: FilledFrame;
  frameIdx: number;
  easing?: string;
};

export type ClipPlayback = {
  filledFrames: FilledFrame[];
  extKfs: ClipExtKf[];
  duration: number;
  loop: boolean;
};

export async function precomputeClipPlayback(
  clipDef: ClipDefLike,
): Promise<ClipPlayback> {
  const filledFrames = await Promise.all(
    clipDef.frames.map((f, i) =>
      fillFrame(f[1] as unknown[], i),
    ),
  );
  const stamps = clipDef.frames.map(f => f[0] as number);
  const easings = clipDef.frames.map(
    f => f[2] as string | undefined,
  );
  const firstStamp = stamps[0] ?? 0;
  const lastStamp = stamps[stamps.length - 1] ?? 0;
  const duration =
    typeof clipDef.duration === "number" && clipDef.duration > 0
      ? clipDef.duration
      : lastStamp;
  const loop =
    clipDef.loop === true && duration > 0 && filledFrames.length >= 1;

  const extKfs: ClipExtKf[] = filledFrames.map((snap, i) => ({
    stamp: stamps[i],
    snap,
    frameIdx: i,
    easing: easings[i],
  }));
  if (loop && filledFrames.length >= 1) {
    const lastIdx = filledFrames.length - 1;
    extKfs.unshift({
      stamp: lastStamp - duration,
      snap: filledFrames[lastIdx],
      frameIdx: lastIdx,
      easing: easings[lastIdx],
    });
    extKfs.push({
      stamp: duration + firstStamp,
      snap: filledFrames[0],
      frameIdx: 0,
      easing: easings[0],
    });
  }
  extKfs.sort((a, b) => a.stamp - b.stamp);

  return { filledFrames, extKfs, duration, loop };
}

// Anchor schedule: every (outerT, startPosition) pair where the Clip
// instance at this path has startPosition explicitly authored.
export type ClipAnchor = { outerT: number; startPosition: number };

export function getClipAnchorsAtPath(
  outerFrames: ReadonlyArray<FrameTuple>,
  clipPath: string,
): ClipAnchor[] {
  const anchors: ClipAnchor[] = [];
  const parts = clipPath.split(".");
  for (const f of outerFrames) {
    const outerT = f[0] as number;
    const objs = f[1] as ReadonlyArray<unknown>;
    const found = walkAuthoredToPath(objs, parts, 0);
    if (
      found &&
      typeof (found as { startPosition?: unknown }).startPosition === "number"
    ) {
      anchors.push({
        outerT,
        startPosition: (found as { startPosition: number }).startPosition,
      });
    }
  }
  return anchors;
}

function walkAuthoredToPath(
  nodes: ReadonlyArray<unknown>,
  parts: ReadonlyArray<string>,
  depth: number,
): Record<string, unknown> | null {
  if (depth >= parts.length) return null;
  const target = parts[depth];
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i] as Record<string, unknown>;
    const id = node.id;
    const key = typeof id === "string" && id.length > 0 ? id : String(i);
    if (key !== target) continue;
    if (depth === parts.length - 1) return node;
    const children = node.objects;
    if (!Array.isArray(children)) return null;
    return walkAuthoredToPath(children, parts, depth + 1);
  }
  return null;
}

export function computeLocalTime(
  anchors: ReadonlyArray<ClipAnchor>,
  outerT: number,
  duration: number,
  repeat: number,
): number {
  // Default anchor — if a Clip is never explicitly seeded with startPosition,
  // treat it as starting at 0 from outer-t 0.
  let anchor: ClipAnchor = { outerT: 0, startPosition: 0 };
  for (const a of anchors) {
    if (a.outerT <= outerT) anchor = a;
    else break;
  }
  const elapsed = anchor.startPosition + (outerT - anchor.outerT);
  if (duration <= 0) return anchor.startPosition;
  if (repeat === -1) {
    return ((elapsed % duration) + duration) % duration;
  }
  const cyclesTotal = repeat + 1;
  if (elapsed >= duration * cyclesTotal) return duration;
  return elapsed % duration;
}

export function clipSnapAtLocalTime(
  playback: ClipPlayback,
  localTime: number,
): FlatFrame {
  const { extKfs } = playback;
  if (extKfs.length === 0) return {};
  if (extKfs.length === 1) return { ...extKfs[0].snap.flat };
  if (localTime <= extKfs[0].stamp) return { ...extKfs[0].snap.flat };
  if (localTime >= extKfs[extKfs.length - 1].stamp) {
    return { ...extKfs[extKfs.length - 1].snap.flat };
  }
  let prevIdx = 0;
  for (let i = 0; i < extKfs.length - 1; i++) {
    if (extKfs[i].stamp <= localTime && localTime < extKfs[i + 1].stamp) {
      prevIdx = i;
      break;
    }
  }
  const nextIdx = prevIdx + 1;
  const span = extKfs[nextIdx].stamp - extKfs[prevIdx].stamp;
  const pairT = span > 0 ? (localTime - extKfs[prevIdx].stamp) / span : 0;
  return interpolateFrames(
    extKfs[prevIdx].snap,
    extKfs[nextIdx].snap,
    pairT,
    extKfs[prevIdx].easing,
  );
}

const CLIP_APPLY_SKIP = new Set([
  "type",
  "id",
  "version",
  "revolutions",
  "angleDirection",
]);

// Walk clipDef.frames[0]'s filled tree in parallel with the Clip's live
// children, applying interpolated state. Top-level left/top get the
// clip-local→group-center shift; nested levels stay group-local.
export function applyClipState(
  clip: Clip,
  treeFrame0: FilledTree,
  snap: FlatFrame,
): void {
  const cw = (clip as unknown as { width?: number }).width ?? 0;
  const ch = (clip as unknown as { height?: number }).height ?? 0;
  const dx = -cw / 2;
  const dy = -ch / 2;

  const walk = (
    tree: FilledTree,
    live: FabricObject[],
    parentPath: string,
    isTopLevel: boolean,
  ): void => {
    for (let i = 0; i < tree.length; i++) {
      const node = tree[i];
      const obj = live[i];
      if (!obj) continue;
      const id = (node as FilledObject).id;
      const key = typeof id === "string" && id.length > 0 ? id : String(i);
      const path = parentPath === "" ? key : `${parentPath}.${key}`;
      const state = snap[path];
      if (state) {
        obj.visible = true;
        const patch: Record<string, unknown> = {};
        for (const k in state) {
          if (CLIP_APPLY_SKIP.has(k)) continue;
          if (
            isTopLevel &&
            k === "left" &&
            typeof state[k] === "number"
          ) {
            patch[k] = (state[k] as number) + dx;
            continue;
          }
          if (
            isTopLevel &&
            k === "top" &&
            typeof state[k] === "number"
          ) {
            patch[k] = (state[k] as number) + dy;
            continue;
          }
          patch[k] = state[k];
        }
        (
          obj as unknown as {
            set: (p: Record<string, unknown>) => unknown;
          }
        ).set(patch);
        (obj as unknown as { setCoords: () => void }).setCoords();
      } else {
        obj.visible = false;
      }
      const childNodes = (node as FilledObject).objects;
      const innerLive =
        typeof (obj as unknown as { getObjects?: () => FabricObject[] })
          .getObjects === "function"
          ? (obj as unknown as { getObjects: () => FabricObject[] }).getObjects()
          : [];
      if (Array.isArray(childNodes) && innerLive.length > 0) {
        walk(childNodes as FilledTree, innerLive, path, false);
      }
    }
  };

  walk(treeFrame0, clip.getObjects(), "", true);
}

// Walk a parent (canvas or group) and, for every Clip whose children are
// empty, build a fresh Clip with the looked-up content at construction
// time. Replacement in place is safer than mutating because the layout
// manager only honors the size once, during initialization.
export async function resolveClipsInTree(
  parent: {
    getObjects(): FabricObject[];
    insertAt(index: number, ...obj: FabricObject[]): unknown;
    remove(...obj: FabricObject[]): unknown;
  },
  clips: ReadonlyArray<{
    id: string;
    contentWidth?: number;
    contentHeight?: number;
    frames: ReadonlyArray<FrameTuple>;
  }>,
  enliven: (
    specs: Record<string, unknown>[],
  ) => Promise<FabricObject[]>,
): Promise<void> {
  const objs = parent.getObjects().slice();
  for (let i = 0; i < objs.length; i++) {
    const obj = objs[i];
    if (obj instanceof Clip) {
      // Skip if already populated (e.g., enliven path that survived a
      // previous resolution).
      if (obj.size() > 0) continue;
      const clipDef = clips.find(c => c.id === obj.clipId);
      if (!clipDef || !clipDef.frames || clipDef.frames.length === 0) continue;
      const specs = clipDef.frames[0][1] as Record<string, unknown>[];
      const children = await enliven(specs.map(s => ({ ...s })));

      const cw = typeof clipDef.contentWidth === "number" ? clipDef.contentWidth : 0;
      const ch = typeof clipDef.contentHeight === "number" ? clipDef.contentHeight : 0;
      // Shift so the clip-local (0, 0) maps to the group's top-left (fabric
      // groups treat children's left/top as offsets from the group center).
      const dx = -cw / 2;
      const dy = -ch / 2;
      for (const child of children) {
        child.set("left", (child.left ?? 0) + dx);
        child.set("top", (child.top ?? 0) + dy);
        child.setCoords();
      }

      // Build a replacement Clip with the children at construction time so
      // FixedLayout's initialization respects the schema-provided size.
      const savedOpts = obj.toObject([
        "id",
        "revolutions",
        "angleDirection",
        "clipId",
        "startPosition",
        "repeat",
      ]) as Record<string, unknown>;
      delete savedOpts.objects;
      savedOpts.width = cw;
      savedOpts.height = ch;
      const replacement = new Clip(savedOpts as ClipOptions, children);
      replacement.setCoords();

      parent.remove(obj);
      parent.insertAt(i, replacement);
    } else if (obj instanceof Group) {
      await resolveClipsInTree(
        obj as unknown as {
          getObjects(): FabricObject[];
          insertAt(index: number, ...obj: FabricObject[]): unknown;
          remove(...obj: FabricObject[]): unknown;
        },
        clips,
        enliven,
      );
    }
  }
}

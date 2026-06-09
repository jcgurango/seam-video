import { useEffect, useMemo, useRef, useState } from "react";
import Editor from "@monaco-editor/react";
import {
  ActiveSelection,
  Canvas as FabricCanvas,
  FabricImage,
  Group,
  loadSVGFromString,
  Point,
  util as fabricUtil,
  type FabricObject,
  type TMat2D,
} from "fabric";
import {
  attachPaths,
  CUSTOM_PROPS,
  fillFrame,
  interpolateFrames,
  type FabricLike,
  type FilledFrame,
  type FlatFrame,
} from "./interp.js";
import {
  applyClipState,
  Clip,
  clipSnapAtLocalTime,
  computeLocalTime,
  getClipAnchorsAtPath,
  precomputeClipPlayback,
  resolveClipsInTree,
  type ClipPlayback,
} from "./clip.js";
import {
  registerBlob,
  resolveSrc,
  rewriteToLogical,
  rewriteToReal,
} from "./src-registry.js";

const DESIGN_W = 1080;
const DESIGN_H = 1920;
const MIN_ZOOM = 0.05;
const MAX_ZOOM = 20;

type FrameObjects = unknown[];

type ClipDef = {
  id: string;
  type: "graphic";
  duration?: number;
  loop?: boolean;
  contentWidth?: number;
  contentHeight?: number;
  frames: Array<[number, FrameObjects]>;
};

type GraphicDoc = {
  type: "graphic";
  duration?: number;
  loop?: boolean;
  contentWidth?: number;
  contentHeight?: number;
  clips?: ClipDef[];
  frames: Array<[number, FrameObjects]>;
};

const INITIAL_DOC: GraphicDoc = {
  type: "graphic",
  duration: 2,
  loop: false,
  contentWidth: 1080,
  contentHeight: 1920,
  clips: [
    {
      id: "wave",
      type: "graphic",
      duration: 1,
      loop: true,
      contentWidth: 400,
      contentHeight: 400,
      frames: [
        [
          0,
          [
            { id: "dot", type: "Circle", left: 60, top: 180, radius: 40, fill: "magenta" },
            { id: "ring", type: "Circle", left: 200, top: 200, radius: 80, fill: "transparent", stroke: "magenta", strokeWidth: 4 },
          ],
        ],
        [
          1,
          [
            { id: "dot", type: "Circle", left: 300, top: 180, radius: 40, fill: "magenta" },
            { id: "ring", type: "Circle", left: 200, top: 200, radius: 140, fill: "transparent", stroke: "magenta", strokeWidth: 4 },
          ],
        ],
      ],
    },
  ],
  frames: [
    [
      0,
      [
        { id: "tomato", type: "Rect", left: 100, top: 200, width: 300, height: 220, fill: "tomato" },
        { id: "cyan", type: "Rect", left: 600, top: 1200, width: 260, height: 420, fill: "#00bcd4" },
        { id: "wave1", type: "Clip", clipId: "wave", startPosition: 0, left: 600, top: 200, scaleX: 0.6, scaleY: 0.6 },
      ],
    ],
    [
      1,
      [
        { id: "tomato", type: "Rect", left: 380, top: 400, width: 300, height: 220, fill: "tomato", angle: 20 },
        { id: "cyan", type: "Rect", left: 480, top: 1080, width: 260, height: 420, fill: "#00bcd4", angle: -12 },
        { id: "wave1", type: "Clip", clipId: "wave", left: 300, top: 700, scaleX: 0.8, scaleY: 0.8, angle: 10 },
      ],
    ],
    [
      2,
      [
        { id: "tomato", type: "Rect", left: 680, top: 620, width: 300, height: 220, fill: "tomato", angle: 40, revolutions: 1 },
        { id: "cyan", type: "Rect", left: 360, top: 940, width: 260, height: 420, fill: "#00bcd4", angle: 18, angleDirection: "ccw" },
        { id: "wave1", type: "Clip", clipId: "wave", startPosition: 0, left: 600, top: 1400, scaleX: 1, scaleY: 1, angle: -10 },
      ],
    ],
  ],
};

// Props that uniquely identify the object instance; never written back.
const APPLY_SKIP = new Set(["type", "id", "version"]);

// Stable empty frame array — referenced from the render path when the doc
// is invalid. Module-scope so its identity is constant across renders.
const EMPTY_FRAMES: GraphicDoc["frames"] = [];

function applySnap(
  pathToObj: Map<string, FabricLike>,
  snap: FlatFrame,
): void {
  for (const [path, like] of pathToObj) {
    const obj = like as FabricObject;
    const state = snap[path];
    if (!state) {
      obj.visible = false;
      continue;
    }
    obj.visible = true;
    const isClip = obj instanceof Clip;
    const patch: Record<string, unknown> = {};
    for (const k in state) {
      if (APPLY_SKIP.has(k)) continue;
      // Clip dimensions are owned by the clip definition; never overwrite.
      if (isClip && (k === "width" || k === "height")) continue;
      patch[k] = state[k];
    }
    obj.set(patch);
    obj.setCoords();
  }
}

// Walk a fabric tree collecting all Clip instances with their hierarchical
// paths (same id-or-positional-index scheme used for animation paths).
function collectClips(
  objs: FabricObject[],
  parentPath: string,
  out: Array<[string, Clip]>,
): void {
  for (let i = 0; i < objs.length; i++) {
    const obj = objs[i];
    const id = (obj as unknown as { id?: string }).id;
    const key = typeof id === "string" && id.length > 0 ? id : String(i);
    const path = parentPath === "" ? key : `${parentPath}.${key}`;
    if (obj instanceof Clip) {
      out.push([path, obj]);
    } else if (
      typeof (obj as unknown as { getObjects?: () => FabricObject[] })
        .getObjects === "function"
    ) {
      collectClips(
        (obj as unknown as { getObjects: () => FabricObject[] }).getObjects(),
        path,
        out,
      );
    }
  }
}

// Apply each Clip's sub-state at the given outer time. Uses each Clip's
// authored anchor schedule, clipDef's playback, and runtime properties
// (clipId, repeat) to compute local time, then writes interpolated state
// onto the live children.
function applyAllClips(
  clips: Array<[string, Clip]>,
  outerT: number,
  outerFrames: ReadonlyArray<readonly [number, ReadonlyArray<unknown>]>,
  playbacks: Map<string, ClipPlayback>,
): void {
  for (const [path, clip] of clips) {
    const pb = playbacks.get(clip.clipId);
    if (!pb) continue;
    const anchors = getClipAnchorsAtPath(outerFrames, path);
    const localT = computeLocalTime(anchors, outerT, pb.duration, clip.repeat);
    const snap = clipSnapAtLocalTime(pb, localT);
    if (pb.filledFrames.length === 0) continue;
    applyClipState(clip, pb.filledFrames[0].tree, snap);
  }
}

// Group/ungroup helpers. Both fire `object:modified` so the bidirectional
// sync writes the new structure back into the JSON.
function groupActiveSelection(fc: FabricCanvas): void {
  const active = fc.getActiveObject();
  if (!active || !(active instanceof ActiveSelection)) return;
  const objs = active.getObjects().slice();
  if (objs.length < 2) return;
  fc.discardActiveObject();
  for (const o of objs) fc.remove(o);
  const group = new Group(objs);
  fc.add(group);
  fc.setActiveObject(group);
  fc.requestRenderAll();
  fc.fire("object:modified", { target: group });
}

function ungroupActive(fc: FabricCanvas): void {
  const active = fc.getActiveObject();
  if (!active || !(active instanceof Group)) return;
  const children = active.removeAll() as FabricObject[];
  fc.remove(active);
  for (const child of children) fc.add(child);
  if (children.length > 0) {
    const sel = new ActiveSelection(children, { canvas: fc });
    fc.setActiveObject(sel);
  }
  fc.requestRenderAll();
  fc.fire("object:modified", { target: children[0] ?? active });
}

export function App() {
  const [jsonText, setJsonText] = useState(() => JSON.stringify(INITIAL_DOC, null, 2));
  const [frameIndex, setFrameIndex] = useState(0);
  const [playing, setPlaying] = useState(false);

  const parsed = useMemo<{ doc: GraphicDoc | null; error: string | null }>(() => {
    try {
      const obj = JSON.parse(jsonText) as GraphicDoc;
      if (obj?.type !== "graphic" || !Array.isArray(obj.frames)) {
        return { doc: null, error: "expected { type: 'graphic', frames: [...] }" };
      }
      return { doc: obj, error: null };
    } catch (e) {
      return { doc: null, error: (e as Error).message };
    }
  }, [jsonText]);

  const doc = parsed.doc;
  // Stable empty fallback — using `?? []` would mint a fresh array on every
  // render while the JSON is invalid, retriggering every effect that watches
  // `frames` and hanging the editor in a render loop.
  const frames = doc?.frames ?? EMPTY_FRAMES;
  const safeFrameIndex = Math.min(frameIndex, Math.max(0, frames.length - 1));

  const canvasElRef = useRef<HTMLCanvasElement | null>(null);
  const fabricRef = useRef<FabricCanvas | null>(null);
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const initialFitDone = useRef(false);

  // Bi-directional sync gates.
  // - `lastFrameSigRef` holds JSON.stringify of whichever frame-root the canvas
  //   currently shows. The load effect skips reloading when the incoming JSON
  //   matches this (i.e. the change originated from the canvas itself).
  // - `isLoadingRef` suppresses write-back during programmatic loads.
  // - `reloadKey` bumps to force a fresh load after playback (which mutates
  //   canvas objects in place and leaves the sig stale).
  const isLoadingRef = useRef(false);
  const lastFrameSigRef = useRef("");
  const [reloadKey, setReloadKey] = useState(0);

  // Keep handlers reading fresh state without re-registering.
  const stateRef = useRef({ doc, safeFrameIndex });
  stateRef.current = { doc, safeFrameIndex };

  // Initialise fabric, load background image, wire wheel + cmd-drag handlers.
  useEffect(() => {
    if (!canvasElRef.current) return;
    const c = new FabricCanvas(canvasElRef.current, {
      width: 100,
      height: 100,
      backgroundColor: "rgba(0,0,0,0)",
      preserveObjectStacking: true,
      includeDefaultValues: false,
    });
    fabricRef.current = c;

    let cancelled = false;
    FabricImage.fromURL("/test-frame.jpg", { crossOrigin: "anonymous" }).then(img => {
      if (cancelled) return;
      img.set({
        left: 0,
        top: 0,
        originX: "left",
        originY: "top",
        selectable: false,
        evented: false,
        excludeFromExport: true,
      });
      c.backgroundImage = img;
      c.renderAll();
    });

    const wrap = c.wrapperEl;

    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = wrap.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      let zoom = c.getZoom();
      zoom *= Math.pow(1.0015, -e.deltaY);
      zoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, zoom));
      c.zoomToPoint(new Point(x, y), zoom);
    };
    wrap.addEventListener("wheel", onWheel, { passive: false });

    let pan: { startX: number; startY: number; vptX: number; vptY: number } | null = null;
    const onMouseDown = (opt: { e: Event }) => {
      const e = opt.e as MouseEvent;
      if (!e || !(e.metaKey || e.ctrlKey)) return;
      pan = {
        startX: e.clientX,
        startY: e.clientY,
        vptX: c.viewportTransform[4],
        vptY: c.viewportTransform[5],
      };
      c.selection = false;
      c.defaultCursor = "grabbing";
      c.setCursor("grabbing");
    };
    const onMouseMove = (opt: { e: Event }) => {
      if (!pan) return;
      const e = opt.e as MouseEvent;
      const dx = e.clientX - pan.startX;
      const dy = e.clientY - pan.startY;
      const vpt = c.viewportTransform.slice() as TMat2D;
      vpt[4] = pan.vptX + dx;
      vpt[5] = pan.vptY + dy;
      c.setViewportTransform(vpt);
    };
    const onMouseUp = () => {
      if (!pan) return;
      pan = null;
      c.selection = true;
      c.defaultCursor = "default";
      c.setCursor("default");
    };
    c.on("mouse:down", onMouseDown);
    c.on("mouse:move", onMouseMove);
    c.on("mouse:up", onMouseUp);

    const writeBack = () => {
      if (isLoadingRef.current) return;
      const { doc: d, safeFrameIndex: idx } = stateRef.current;
      if (!d) return;
      const raw =
        (c.toObject(CUSTOM_PROPS) as { objects?: FrameObjects }).objects ?? [];
      // Rewrite blob/data URLs back to logical ids so the JSON stays
      // compact and portable across sessions/caches.
      const objects = rewriteToLogical(raw) as FrameObjects;
      lastFrameSigRef.current = JSON.stringify(objects);
      const next: GraphicDoc = {
        ...d,
        frames: d.frames.map((f, i): [number, FrameObjects] =>
          i === idx ? [f[0], objects] : f,
        ),
      };
      setJsonText(JSON.stringify(next, null, 2));
    };
    c.on("object:modified", writeBack);

    // Drag-and-drop: register files in the src registry (rasters) or parse
    // SVG text inline (SVGs). Drop position is converted from the wrapper's
    // CSS coords through the inverse viewport transform.
    const onDragOver = (e: DragEvent) => {
      if (!e.dataTransfer) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "copy";
    };
    const onDrop = async (e: DragEvent) => {
      e.preventDefault();
      if (!e.dataTransfer) return;
      const files = Array.from(e.dataTransfer.files);
      if (files.length === 0) return;
      const rect = wrap.getBoundingClientRect();
      const cssPoint = new Point(e.clientX - rect.left, e.clientY - rect.top);
      const worldPoint = cssPoint.transform(
        fabricUtil.invertTransform(c.viewportTransform),
      );
      for (const file of files) {
        try {
          if (file.type === "image/svg+xml" || /\.svg$/i.test(file.name)) {
            const text = await file.text();
            const result = await loadSVGFromString(text);
            const valid = result.objects.filter(
              (o): o is FabricObject => o !== null,
            );
            if (valid.length === 0) continue;
            const group = fabricUtil.groupSVGElements(
              valid,
              result.options,
            ) as unknown as FabricObject;
            group.set({
              left: worldPoint.x,
              top: worldPoint.y,
              originX: "center",
              originY: "center",
            });
            c.add(group);
            c.setActiveObject(group);
            c.fire("object:modified", { target: group });
          } else if (file.type.startsWith("image/")) {
            const logical = registerBlob(file, file.name.split(".")[0]);
            const real = resolveSrc(logical);
            if (!real) continue;
            const img = await FabricImage.fromURL(real, {
              crossOrigin: "anonymous",
            });
            img.set({
              left: worldPoint.x,
              top: worldPoint.y,
              originX: "center",
              originY: "center",
            });
            (img as unknown as { logicalSrc: string }).logicalSrc = logical;
            c.add(img);
            c.setActiveObject(img);
            c.fire("object:modified", { target: img });
          }
        } catch (err) {
          console.warn("drop failed for", file.name, err);
        }
      }
    };
    wrap.addEventListener("dragover", onDragOver);
    wrap.addEventListener("drop", onDrop);

    return () => {
      cancelled = true;
      wrap.removeEventListener("wheel", onWheel);
      wrap.removeEventListener("dragover", onDragOver);
      wrap.removeEventListener("drop", onDrop);
      c.off("mouse:down", onMouseDown);
      c.off("mouse:move", onMouseMove);
      c.off("mouse:up", onMouseUp);
      c.off("object:modified", writeBack);
      void c.dispose();
      fabricRef.current = null;
    };
  }, []);

  // Re-load whenever the current frame's data changes — but skip if the
  // incoming objects array is exactly what the canvas just wrote (avoids
  // the write-back → reparse → reload loop). `reloadKey` is in the dep
  // list so playback-end can force a re-run after clearing lastFrameSigRef.
  useEffect(() => {
    const fc = fabricRef.current;
    const objects = frames[safeFrameIndex]?.[1];
    if (!fc || !objects) return;
    const sig = JSON.stringify(objects);
    if (sig === lastFrameSigRef.current) return;
    lastFrameSigRef.current = sig;
    let cancelled = false;
    const bg = fc.backgroundImage;
    isLoadingRef.current = true;
    // Swap logical ids to real URLs so fabric's enliven can actually load
    // the bytes. The reverse swap happens in writeBack via toObject.
    const resolved = rewriteToReal(objects) as FrameObjects;
    fc.loadFromJSON({ objects: resolved }).then(async () => {
      if (cancelled) return;
      // loadFromJSON clears backgroundImage; restore.
      if (bg) fc.backgroundImage = bg;
      const cur = stateRef.current;
      const clips = cur.doc?.clips ?? [];
      if (clips.length > 0) {
        await resolveClipsInTree(fc, clips, specs =>
          fabricUtil.enlivenObjects(specs) as Promise<FabricObject[]>,
        );
        if (cancelled) return;

        // Apply each Clip's sub-state at the current outer frame's stamp.
        // Use the ref because precompute may finish after this .then() resolves.
        const clipsInCanvas: Array<[string, Clip]> = [];
        collectClips(fc.getObjects(), "", clipsInCanvas);
        const outerT = cur.doc?.frames[cur.safeFrameIndex]?.[0] ?? 0;
        applyAllClips(
          clipsInCanvas,
          outerT,
          cur.doc?.frames ?? [],
          clipPlaybacksRef.current,
        );
      }
      fc.renderAll();
      isLoadingRef.current = false;
    });
    return () => {
      cancelled = true;
      isLoadingRef.current = false;
    };
  }, [safeFrameIndex, frames, reloadKey]);

  // Pre-compute filled snapshots for every frame so the playback tick loop
  // can interpolate synchronously without touching fabric reviver async paths.
  const [filledFrames, setFilledFrames] = useState<FilledFrame[]>([]);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const out = await Promise.all(frames.map((f, i) => fillFrame(f[1], i)));
      if (!cancelled) setFilledFrames(out);
    })();
    return () => {
      cancelled = true;
    };
  }, [frames]);

  // Pre-compute clipDef playback (filled frames + extKfs + duration) so
  // sub-clip interpolation per tick is synchronous.
  const [clipPlaybacks, setClipPlaybacks] = useState<Map<string, ClipPlayback>>(
    () => new Map(),
  );
  const clipPlaybacksRef = useRef(clipPlaybacks);
  clipPlaybacksRef.current = clipPlaybacks;
  useEffect(() => {
    const clipDefs = doc?.clips ?? [];
    if (clipDefs.length === 0) {
      setClipPlaybacks(new Map());
      return;
    }
    let cancelled = false;
    (async () => {
      const out = new Map<string, ClipPlayback>();
      for (const clipDef of clipDefs) {
        const pb = await precomputeClipPlayback(clipDef);
        if (cancelled) return;
        out.set(clipDef.id, pb);
      }
      if (!cancelled) setClipPlaybacks(out);
    })();
    return () => {
      cancelled = true;
    };
  }, [doc]);

  // Re-apply all clip sub-states whenever clipPlaybacks change. Handles the
  // mount race: the initial loadFromJSON may resolve before precompute and
  // would otherwise leave clips frozen at their static frame-0 content.
  useEffect(() => {
    if (isLoadingRef.current || playing) return;
    const fc = fabricRef.current;
    if (!fc) return;
    const cur = stateRef.current;
    if (!cur.doc) return;
    const clipsInCanvas: Array<[string, Clip]> = [];
    collectClips(fc.getObjects(), "", clipsInCanvas);
    if (clipsInCanvas.length === 0) return;
    const outerT = cur.doc.frames[cur.safeFrameIndex]?.[0] ?? 0;
    applyAllClips(
      clipsInCanvas,
      outerT,
      cur.doc.frames,
      clipPlaybacks,
    );
    fc.requestRenderAll();
  }, [clipPlaybacks, safeFrameIndex, playing]);

  // Resize fabric to its viewport box. Apply an initial fit on the first sizing.
  useEffect(() => {
    if (!viewportRef.current) return;
    const ro = new ResizeObserver(entries => {
      const { width, height } = entries[0].contentRect;
      const fc = fabricRef.current;
      if (!fc || width <= 0 || height <= 0) return;
      fc.setDimensions({ width, height });
      if (!initialFitDone.current) {
        const scale = Math.min(width / DESIGN_W, height / DESIGN_H) * 0.9;
        const tx = (width - DESIGN_W * scale) / 2;
        const ty = (height - DESIGN_H * scale) / 2;
        fc.setViewportTransform([scale, 0, 0, scale, tx, ty]);
        initialFitDone.current = true;
      }
      fc.renderAll();
    });
    ro.observe(viewportRef.current);
    return () => ro.disconnect();
  }, []);

  // Playback: pre-enliven every frame's tree once, then per-tick (a) detect
  // when we cross into a new pair, (b) swap the canvas to the new prev
  // frame's instance set, (c) apply interpolated state by path.
  // The "structure stays prev's until we hit next" rule is enforced by
  // keying canvas swaps to extKf.prev only — interp never tries to add
  // objects from the next side that don't exist in prev.
  useEffect(() => {
    if (!playing || frames.length === 0) return;
    if (filledFrames.length !== frames.length) return;
    const fc = fabricRef.current;
    if (!fc) return;

    let cancelled = false;
    let raf = 0;
    const stamps = frames.map(f => f[0]);
    const firstStamp = stamps[0];
    const lastStamp = stamps[stamps.length - 1];
    const startWall = performance.now();

    const durationRaw = doc?.duration;
    const duration =
      typeof durationRaw === "number" && durationRaw > 0
        ? durationRaw
        : lastStamp;
    const loop = doc?.loop === true && duration > 0 && frames.length >= 1;

    // Extended keyframe list — each entry remembers which real frame's
    // tree should be on the canvas while it's the "prev" side.
    type ExtKf = { stamp: number; snap: FilledFrame; frameIdx: number };
    const extKfs: ExtKf[] = filledFrames.map((snap, i) => ({
      stamp: stamps[i],
      snap,
      frameIdx: i,
    }));
    if (loop && filledFrames.length >= 1) {
      extKfs.unshift({
        stamp: lastStamp - duration,
        snap: filledFrames[filledFrames.length - 1],
        frameIdx: filledFrames.length - 1,
      });
      extKfs.push({
        stamp: duration + firstStamp,
        snap: filledFrames[0],
        frameIdx: 0,
      });
    }
    extKfs.sort((a, b) => a.stamp - b.stamp);

    const treesByFrame: FabricObject[][] = [];
    let currentPrevFrameIdx = -1;
    let pathToObj = new Map<string, FabricLike>();

    const swapToFrame = (frameIdx: number) => {
      const tree = treesByFrame[frameIdx];
      if (!tree) return;
      const bg = fc.backgroundImage;
      fc.remove(...fc.getObjects());
      for (const obj of tree) fc.add(obj);
      if (bg) fc.backgroundImage = bg;
      pathToObj = new Map();
      attachPaths(
        filledFrames[frameIdx].tree,
        tree as unknown as FabricLike[],
        "",
        pathToObj,
      );
      currentPrevFrameIdx = frameIdx;
    };

    const startup = async () => {
      // Enliven every frame's tree once. Pair transitions then just swap
      // which set of live instances is on the canvas — no async per tick.
      const clips = doc?.clips ?? [];
      for (let i = 0; i < filledFrames.length; i++) {
        const resolvedSpecs = rewriteToReal(
          filledFrames[i].tree.map(o => ({ ...o })),
        ) as Record<string, unknown>[];
        const enlivened = (await fabricUtil.enlivenObjects(
          resolvedSpecs,
        )) as FabricObject[];
        if (cancelled) return;
        if (clips.length > 0) {
          // Pseudo-parent stub: delegates to the in-memory array so
          // resolveClipsInTree can splice replacements into the tree
          // without needing a real fabric parent.
          const stub = {
            getObjects: () => enlivened,
            insertAt: (index: number, ...obj: FabricObject[]) => {
              enlivened.splice(index, 0, ...obj);
            },
            remove: (...obj: FabricObject[]) => {
              for (const o of obj) {
                const idx = enlivened.indexOf(o);
                if (idx >= 0) enlivened.splice(idx, 1);
              }
            },
          };
          await resolveClipsInTree(stub, clips, specs =>
            fabricUtil.enlivenObjects(specs) as Promise<FabricObject[]>,
          );
          if (cancelled) return;
        }
        treesByFrame[i] = enlivened;
      }

      isLoadingRef.current = true;
      fc.selection = false;
      fc.discardActiveObject();
      isLoadingRef.current = false;

      raf = requestAnimationFrame(tick);
    };

    const applyClipsAtOuterT = (outerT: number) => {
      const playbacks = clipPlaybacksRef.current;
      if (playbacks.size === 0) return;
      const clipsInPath: Array<[string, Clip]> = [];
      for (const [path, like] of pathToObj) {
        if (like instanceof Clip) clipsInPath.push([path, like as Clip]);
      }
      if (clipsInPath.length === 0) return;
      applyAllClips(clipsInPath, outerT, frames, playbacks);
    };

    const tick = (now: number) => {
      if (cancelled) return;
      let t = (now - startWall) / 1000;

      if (loop) {
        t = ((t % duration) + duration) % duration;
      } else if (t >= duration) {
        const lastFrameIdx = filledFrames.length - 1;
        if (lastFrameIdx >= 0) {
          isLoadingRef.current = true;
          swapToFrame(lastFrameIdx);
          applySnap(pathToObj, filledFrames[lastFrameIdx].flat);
          applyClipsAtOuterT(duration);
          isLoadingRef.current = false;
        }
        fc.requestRenderAll();
        setFrameIndex(Math.max(0, frames.length - 1));
        setPlaying(false);
        return;
      }

      if (extKfs.length === 0) {
        raf = requestAnimationFrame(tick);
        return;
      }

      let prevIdx = 0;
      for (let i = 0; i < extKfs.length - 1; i++) {
        if (extKfs[i].stamp <= t && t < extKfs[i + 1].stamp) {
          prevIdx = i;
          break;
        }
      }
      const targetFrameIdx = extKfs[prevIdx].frameIdx;
      if (targetFrameIdx !== currentPrevFrameIdx) {
        isLoadingRef.current = true;
        swapToFrame(targetFrameIdx);
        isLoadingRef.current = false;
      }

      if (extKfs.length <= 1) {
        applySnap(pathToObj, filledFrames[targetFrameIdx].flat);
        applyClipsAtOuterT(t);
        fc.requestRenderAll();
        raf = requestAnimationFrame(tick);
        return;
      }

      const nextIdx = prevIdx + 1;
      const span = extKfs[nextIdx].stamp - extKfs[prevIdx].stamp;
      const pairT = span > 0 ? (t - extKfs[prevIdx].stamp) / span : 0;
      const snap = interpolateFrames(
        extKfs[prevIdx].snap,
        extKfs[nextIdx].snap,
        pairT,
      );
      applySnap(pathToObj, snap);
      applyClipsAtOuterT(t);
      fc.requestRenderAll();
      raf = requestAnimationFrame(tick);
    };
    void startup();

    return () => {
      cancelled = true;
      if (raf) cancelAnimationFrame(raf);
      if (fc) fc.selection = true;
      // Wash playback mutations by forcing a fresh reload of the current frame.
      lastFrameSigRef.current = "";
      setReloadKey(k => k + 1);
    };
  }, [playing, frames, filledFrames]);

  // Keyboard: G groups the active selection, Shift+G ungroups the active
  // group. Ignored when focus is in an input or Monaco editor.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() !== "g") return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const target = e.target;
      if (target instanceof HTMLElement) {
        const tag = target.tagName;
        if (tag === "INPUT" || tag === "TEXTAREA" || target.isContentEditable) {
          return;
        }
        if (target.closest(".monaco-editor")) return;
      }
      const fc = fabricRef.current;
      if (!fc) return;
      e.preventDefault();
      if (e.shiftKey) ungroupActive(fc);
      else groupActiveSelection(fc);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const fitToFrame = () => {
    const fc = fabricRef.current;
    const vp = viewportRef.current;
    if (!fc || !vp) return;
    const { width, height } = vp.getBoundingClientRect();
    const scale = Math.min(width / DESIGN_W, height / DESIGN_H) * 0.9;
    const tx = (width - DESIGN_W * scale) / 2;
    const ty = (height - DESIGN_H * scale) / 2;
    fc.setViewportTransform([scale, 0, 0, scale, tx, ty]);
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: "8px 12px",
          background: "#222",
          borderBottom: "1px solid #333",
          flexShrink: 0,
        }}
      >
        {frames.map((_, i) => (
          <button
            key={i}
            onClick={() => {
              setPlaying(false);
              setFrameIndex(i);
            }}
            style={{
              background: i === safeFrameIndex ? "#4080ff" : "#333",
              color: "#fff",
              border: 0,
              padding: "6px 12px",
              borderRadius: 4,
              cursor: "pointer",
              fontSize: 13,
            }}
          >
            Frame {i}{" "}
            <span style={{ opacity: 0.6, fontSize: 11 }}>(t={frames[i][0]}s)</span>
          </button>
        ))}
        <div style={{ width: 1, height: 24, background: "#444", margin: "0 8px" }} />
        <button
          onClick={() => setPlaying(p => !p)}
          disabled={frames.length === 0}
          style={{
            background: playing ? "#c0392b" : "#27ae60",
            color: "#fff",
            border: 0,
            padding: "6px 14px",
            borderRadius: 4,
            cursor: "pointer",
            fontSize: 13,
            fontWeight: 600,
          }}
        >
          {playing ? "■ Stop" : "▶ Play"}
        </button>
        <div style={{ width: 1, height: 24, background: "#444", margin: "0 8px" }} />
        <button
          onClick={fitToFrame}
          style={{
            background: "#333",
            color: "#fff",
            border: 0,
            padding: "6px 12px",
            borderRadius: 4,
            cursor: "pointer",
            fontSize: 13,
          }}
        >
          Fit
        </button>
        <div style={{ marginLeft: "auto", color: "#888", fontSize: 11, fontFamily: "monospace" }}>
          scroll = zoom · ⌘/ctrl+drag = pan · G = group · ⇧G = ungroup
        </div>
        {parsed.error && (
          <div style={{ marginLeft: 16, color: "#e74c3c", fontSize: 12, fontFamily: "monospace" }}>
            {parsed.error}
          </div>
        )}
      </div>

      <div style={{ display: "flex", flex: 1, minHeight: 0 }}>
        <div style={{ flex: "0 0 45%", borderRight: "1px solid #333", minWidth: 0 }}>
          <Editor
            height="100%"
            defaultLanguage="json"
            value={jsonText}
            onChange={v => setJsonText(v ?? "")}
            theme="vs-dark"
            options={{
              minimap: { enabled: false },
              fontSize: 12,
              tabSize: 2,
              wordWrap: "on",
            }}
          />
        </div>
        <div
          ref={viewportRef}
          style={{
            flex: 1,
            position: "relative",
            background: "#0e0e0e",
            overflow: "hidden",
          }}
        >
          <canvas
            ref={canvasElRef}
            style={{ display: "block" }}
          />
        </div>
      </div>
    </div>
  );
}

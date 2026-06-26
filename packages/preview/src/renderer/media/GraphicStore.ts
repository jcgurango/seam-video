// Browser-side graphic compositing. Mirrors TextStore's shape: per
// ResolvedGraphic an OffscreenCanvas (or HTMLCanvasElement) at the
// authored contentWidth/Height, redrawn each tick by walking the
// snapshot from playback.ts onto a fabric.StaticCanvas.
//
// Map elements are backed by TileMap (a synchronous Canvas2D rasterizer over
// the shared @seam/map TileSource); see ./graphic/TileMap.ts.

import type {
  ResolvedChild,
  ResolvedGraphic,
  ResolvedTimeline,
} from "@seam/core";
import type { FlatFrame, FilledObject, FilledTree, FilledFrame } from "@seam/core";
import {
  FixedLayout,
  Group,
  LayoutManager,
  StaticCanvas,
  util as fabricUtil,
  type FabricObject,
} from "fabric";
import {
  precomputeGraphicPlayback,
  snapshotAt,
  treeAt,
  isStatic,
  type GraphicPlayback,
} from "./graphic/playback.js";
import {
  precomputeClipPlayback,
  clipSnapAtLocalTime,
  clipTreeAtLocalTime,
  computeLocalTime,
  getClipAnchorsAtPath,
  type ClipDefLike,
  type ClipPlayback,
} from "./graphic/clip.js";
// Side-effect import: registers the Map class into fabric's classRegistry so
// enlivenObjects(spec.type === "Map") produces the @seam/map-backed rasterizer
// FabricObject instead of falling back to the default rect. subscribeMapWake
// bubbles tile loads up to the redraw loop (like an Image's load event).
import {
  TileMap,
  subscribeMapWake,
  type MapOverlay,
} from "./graphic/TileMap.js";
import { installGraphicFontFallback } from "./graphic/fontFallback.js";
import { resolveSource } from "../components/resolveSource.js";

// Patch fabric's font declaration so graphic text falls back to CJK/emoji
// (same as the renderer). Side-effect at module load, before any render.
installGraphicFontFallback();

interface GraphicEntry {
  node: ResolvedGraphic;
  /** Maps the global playhead time to this graphic's enclosing-container
   *  local time, composing every composition the graphic is nested in
   *  (`(t - comp.timelineStart) · comp.speed`, clamped — matching
   *  RenderList's descent). The root graphic's mapper is identity.
   *  `node.timelineStart` is then subtracted to get the animation time. */
  toLocal: (globalTime: number) => number;
  canvas: HTMLCanvasElement;
  fabric: StaticCanvas;
  playback: GraphicPlayback;
  clipPlaybacks: Map<string, ClipPlayback>;
  clipDefs: Map<string, ClipDefLike>;
  outerFrames: ReadonlyArray<ReadonlyArray<unknown>>;
  isStaticGraphic: boolean;
  lastT: number;
  /** True while a `draw()` is in flight. Draws are single-flighted per entry
   *  so an async (image-enliven) draw can't pile up or land out of order. */
  drawing: boolean;
  /** Latest draw time requested while a draw was in flight. Coalesced — only
   *  the most recent is kept; intermediate frames are dropped, then one final
   *  draw converges to it. */
  pendingDrawT: number | null;
  /** A map tile (or header) finished loading since the last fabric draw — the
   *  decoded-tile cache advanced but the snapshot tree didn't. Forces a redraw
   *  even when isStaticGraphic short-circuits and even when the node-local time
   *  hasn't advanced (paused playback). Cleared on draw. */
  pendingMapWake: boolean;
}

/** Baked (t=0) design size: the spatial pass stores it in `intrinsicWidth`
 *  (default = 100% of parent); `asNumber` only catches hand-built nodes. */
function bakedGraphicSize(node: ResolvedGraphic): { w: number; h: number } {
  const w = node.intrinsicWidth ?? asNumber(node.contentWidth, 1080);
  const h = node.intrinsicHeight ?? asNumber(node.contentHeight, 1920);
  return { w: Math.max(1, Math.round(w)), h: Math.max(1, Math.round(h)) };
}

export class GraphicStore {
  private entries = new Map<ResolvedGraphic, GraphicEntry>();
  /** Live design size per node, sampled per-frame by the compositor and pushed
   *  in via {@link setContentSizes}. Absent → the baked size. */
  private sizes = new Map<ResolvedGraphic, { w: number; h: number }>();
  onFrameAvailable: (() => void) | null = null;

  private sizeFor(node: ResolvedGraphic): { w: number; h: number } {
    return this.sizes.get(node) ?? bakedGraphicSize(node);
  }
  /** Base path for resolving relative graphic `Image` `src`s (mirrors the
   *  media layer's `basePath`). Set per-timeline. */
  private basePath = "";
  /** One subscription to the Map tile pool: any tile/header load anywhere
   *  flags every entry for a redraw (coalesced by the single-flight draw). */
  private mapWakeUnsub: (() => void) | null = null;

  async setTimeline(timeline: ResolvedTimeline, basePath = ""): Promise<void> {
    this.dispose();
    this.basePath = basePath;
    this.mapWakeUnsub = subscribeMapWake(() => {
      for (const entry of this.entries.values()) entry.pendingMapWake = true;
      this.onFrameAvailable?.();
    });
    const collected = collectGraphicEntries(timeline.children);
    for (const { node, toLocal } of collected) {
      try {
        const { w: W, h: H } = this.sizeFor(node);
        const canvas = document.createElement("canvas");
        canvas.width = W;
        canvas.height = H;
        const fabric = new StaticCanvas(canvas, {
          width: W,
          height: H,
          backgroundColor: "rgba(0,0,0,0)",
          enableRetinaScaling: false,
        });
        // (No fabric after:render → onFrameAvailable wiring anymore —
        // fabric renders are driven exclusively by this store's update().
        // Map tile-load wake-ups arrive via subscribeMapWake → pendingMapWake.)

        const playback = await precomputeGraphicPlayback({
          duration:
            typeof node.duration === "number" ? node.duration : undefined,
          loop: node.loop,
          frames: node.frames as ReadonlyArray<ReadonlyArray<unknown>>,
        });

        const clipDefs = new Map<string, ClipDefLike>();
        const clipPlaybacks = new Map<string, ClipPlayback>();
        for (const c of node.clips ?? []) {
          const def: ClipDefLike = {
            id: c.id,
            duration: c.duration,
            loop: c.loop,
            contentWidth: c.contentWidth,
            contentHeight: c.contentHeight,
            frames: c.frames as ReadonlyArray<ReadonlyArray<unknown>>,
          };
          clipDefs.set(c.id, def);
          clipPlaybacks.set(c.id, await precomputeClipPlayback(def));
        }

        const entry: GraphicEntry = {
          node,
          toLocal,
          canvas,
          fabric,
          playback,
          clipPlaybacks,
          clipDefs,
          outerFrames: node.frames as ReadonlyArray<ReadonlyArray<unknown>>,
          isStaticGraphic: isStatic(playback) && clipPlaybacks.size === 0,
          lastT: -1,
          drawing: false,
          pendingDrawT: null,
          pendingMapWake: false,
        };
        this.entries.set(node, entry);
        // Prime the first frame through the same single-flight path.
        this.scheduleDraw(entry, 0);
      } catch (err) {
        console.error("[graphic] store setup failed:", err);
      }
    }
    if (this.entries.size > 0) this.onFrameAvailable?.();
  }

  /** Per-tick hook. Redraws only when there's something new — driven by
   *  the rAF loop, no extra throttle:
   *    1. Static graphic + pendingMapWake → fabric.renderAll only (the
   *       snapshot tree is unchanged; we just need fabric to re-run
   *       Map._render so the freshly-loaded tiles land).
   *    2. Animated graphic + (time advanced OR pendingMapWake) → full
   *       draw() so a new snapshot is interpolated AND the map is picked up.
   *    3. Otherwise → skip.
   *
   *  Map draws are a pure Canvas2D rasterize from decoded tiles (no WebGL
   *  readback stall), so graphics redraw at the rAF rate with no throttle. */
  async update(currentTime: number): Promise<void> {
    if (this.entries.size === 0) return;
    for (const entry of this.entries.values()) {
      const mapWake = entry.pendingMapWake;

      if (entry.isStaticGraphic) {
        // Single-keyframe + no clips. Only redraw on a map wake (synchronous —
        // the objects are already on the canvas, we just re-blit the map).
        if (!mapWake) continue;
        entry.pendingMapWake = false;
        try {
          entry.fabric.renderAll();
          this.onFrameAvailable?.();
        } catch (err) {
          console.error("[graphic] static map redraw failed:", err);
        }
        continue;
      }

      // Map the global playhead into the graphic's enclosing-container
      // local time (accounts for any compositions it's nested in), then
      // subtract its own start to get the animation time.
      const t = entry.toLocal(currentTime) - entry.node.timelineStart;
      const duration = entry.node.timelineEnd - entry.node.timelineStart;
      if (t < 0 || t > duration) continue;
      const tChanged = Math.abs(t - entry.lastT) >= 0.001;
      if (!tChanged && !mapWake) continue;
      entry.pendingMapWake = false;
      entry.lastT = t;
      // Non-blocking + coalesced: never await here (update() is called every
      // rAF tick, fire-and-forget). scheduleDraw keeps the canvas on its last
      // good frame until the new one is ready, so an async image-enliven draw
      // can't leave the graphic invisible.
      this.scheduleDraw(entry, t);
    }
  }

  /** Push the compositor's per-frame design sizes (from the render list). When
   *  a graphic's inner canvas changes, resize its canvas + fabric and schedule
   *  a redraw — covers static graphics on an animating canvas too (they
   *  short-circuit `update`). Async redraw keeps the prior frame until ready. */
  setContentSizes(
    sizes: Map<ResolvedGraphic, { w: number; h: number }>,
    currentTime: number,
  ): void {
    for (const [node, size] of sizes) {
      const w = Math.max(1, Math.round(size.w));
      const h = Math.max(1, Math.round(size.h));
      const prev = this.sizes.get(node);
      this.sizes.set(node, { w, h });
      const entry = this.entries.get(node);
      if (!entry) continue;
      if (prev && prev.w === w && prev.h === h) continue; // unchanged
      try {
        entry.canvas.width = w;
        entry.canvas.height = h;
        entry.fabric.setDimensions({ width: w, height: h });
      } catch (err) {
        console.error("[graphic] resize failed:", err);
      }
      const t = Math.max(0, entry.toLocal(currentTime) - entry.node.timelineStart);
      this.scheduleDraw(entry, t);
    }
  }

  /** Single-flight, coalesced draw for one entry. If a draw is already
   *  running, the latest requested time is stashed (intermediate frames
   *  dropped) and run once the current draw finishes. */
  private scheduleDraw(entry: GraphicEntry, t: number): void {
    if (entry.drawing) {
      entry.pendingDrawT = t;
      return;
    }
    entry.drawing = true;
    void (async () => {
      let cur: number | null = t;
      while (cur != null) {
        try {
          await this.draw(entry, cur);
          this.onFrameAvailable?.();
        } catch (err) {
          console.error("[graphic] redraw failed:", err);
        }
        // Pick up the most recent request that arrived during the draw (no
        // await between this read and the `drawing = false` below, so the
        // single-threaded loop can't drop a late request).
        cur = entry.pendingDrawT;
        entry.pendingDrawT = null;
      }
      entry.drawing = false;
    })();
  }

  getFrame(node: ResolvedGraphic): HTMLCanvasElement | null {
    return this.entries.get(node)?.canvas ?? null;
  }

  dispose(): void {
    this.mapWakeUnsub?.();
    this.mapWakeUnsub = null;
    for (const entry of this.entries.values()) {
      try {
        entry.fabric.dispose();
      } catch {
        // ignore
      }
    }
    this.entries.clear();
  }

  // ── Drawing ───────────────────────────────────────────────────

  private async draw(entry: GraphicEntry, t: number): Promise<void> {
    const snap = resolveImageFlat(snapshotAt(entry.playback, t), this.basePath);
    // Structure follows the *prev* keyframe at `t` (not always frame 0), so an
    // object introduced in a later keyframe renders once its frame is reached.
    const tree = treeAt(entry.playback, t);
    // Materialize FIRST (this is the async part — image enliven decodes the
    // bitmap), leaving the previous frame on the canvas. Only once the new
    // objects are ready do we swap them in, in one synchronous burst. Clearing
    // up front (as before) blanked the canvas for the whole enliven gap, so a
    // graphic with an animated image read back invisible every frame.
    const specs = await this.materializeTree(tree, snap, "", entry, t);
    entry.fabric.clear();
    entry.fabric.backgroundColor = "rgba(0,0,0,0)";
    for (const obj of specs) entry.fabric.add(obj);
    entry.fabric.renderAll();
  }

  private async materializeTree(
    tree: FilledTree,
    snap: FlatFrame,
    parentPath: string,
    entry: GraphicEntry,
    outerT: number,
  ): Promise<FabricObject[]> {
    const out: FabricObject[] = [];
    for (let i = 0; i < tree.length; i++) {
      const node = tree[i];
      const key = pathKey(node, i);
      const path = parentPath === "" ? key : `${parentPath}.${key}`;
      const state = snap[path] ?? node;
      const merged: FilledObject = { ...node, ...state };
      const live = await this.materializeOne(merged, snap, path, entry, outerT);
      if (live) out.push(live);
    }
    return out;
  }

  private async materializeOne(
    filled: FilledObject,
    snap: FlatFrame,
    path: string,
    entry: GraphicEntry,
    outerT: number,
  ): Promise<FabricObject | null> {
    const type = filled.type;
    if (typeof type !== "string") return null;

    if (type === "Map") {
      // Throwaway like every other object: build a fresh fabric Map from the
      // snapshot. It holds no state — the decoded-tile cache lives in the
      // pooled TileSource (keyed by source), and tile loads bubble up via
      // subscribeMapWake → pendingMapWake. _render draws synchronously from
      // whatever tiles are in memory now and requests any missing ones.
      const live = await reviveSpec(filled);
      if (!(live instanceof TileMap)) return live;
      // Materialize the embedded objects (map-level geo anchors + per-path
      // anchors) through the normal pipeline — so Clips/Groups get clip
      // context — and hand them to the map as overlays. The map projects +
      // draws them against its current view in _render.
      live.setOverlayObjects(
        await this.materializeMapOverlays(filled, path, entry, outerT, snap),
      );
      return live;
    }
    if (type === "Group" && Array.isArray(filled.objects)) {
      const children = await this.materializeTree(
        filled.objects as FilledTree,
        snap,
        path,
        entry,
        outerT,
      );
      // Build the Group from the LIVE materialized children — don't round-trip
      // them through toObject → reviveSpec. Serializing would discard each
      // child's host-set state, notably a Map's pushed overlays
      // (setOverlayObjects), so a Map nested in a Group rendered without its
      // embedded objects. No layoutManager → fabric's default FitContent,
      // matching what enliven did before.
      return new Group(children, {
        left: filled.left as number | undefined,
        top: filled.top as number | undefined,
        scaleX: filled.scaleX as number | undefined,
        scaleY: filled.scaleY as number | undefined,
        angle: filled.angle as number | undefined,
        opacity: filled.opacity as number | undefined,
        flipX: filled.flipX === true,
        flipY: filled.flipY === true,
        originX: filled.originX as "left" | "center" | "right" | undefined,
        originY: filled.originY as "top" | "center" | "bottom" | undefined,
      }) as unknown as FabricObject;
    }
    if (type === "Clip") {
      const clipId = typeof filled.clipId === "string" ? filled.clipId : null;
      if (!clipId) return null;
      const playback = entry.clipPlaybacks.get(clipId);
      const clipDef = entry.clipDefs.get(clipId);
      if (!playback || !clipDef) return makePlaceholder(filled, "#3a2a40", "#7a5b88", `Clip: ${clipId}`);
      const anchors = getClipAnchorsAtPath(entry.outerFrames, path);
      const repeat = typeof filled.repeat === "number" ? filled.repeat : -1;
      const localT = computeLocalTime(anchors, outerT, playback.duration, repeat);
      const clipSnap = resolveImageFlat(
        clipSnapAtLocalTime(playback, localT),
        this.basePath,
      );
      const tree0 = clipTreeAtLocalTime(playback, localT);
      const cw = playback.contentWidth;
      const ch = playback.contentHeight;
      const childSpecs = collectClipChildSpecs(tree0, clipSnap, "");
      if (cw > 0 || ch > 0) {
        const dx = -cw / 2;
        const dy = -ch / 2;
        for (const s of childSpecs) {
          if (typeof s.left === "number") s.left = (s.left as number) + dx;
          if (typeof s.top === "number") s.top = (s.top as number) + dy;
        }
      }
      // Enliven children individually so we can hand them to the
      // Group constructor directly — bypassing enliven-on-Group lets
      // us pin FixedLayout up front. Without FixedLayout, fabric's
      // default (FitContent) recomputes the group's bbox from the
      // children and the explicit clip-content size + (-cw/2, -ch/2)
      // shift no longer align: the Clip lands in the wrong place,
      // typically off-canvas.
      const children: FabricObject[] = [];
      for (const spec of childSpecs) {
        const [obj] = (await fabricUtil.enlivenObjects([
          spec as Record<string, unknown>,
        ])) as FabricObject[];
        if (obj) children.push(obj);
      }
      const groupW = cw > 0 ? cw : (filled.width as number | undefined);
      const groupH = ch > 0 ? ch : (filled.height as number | undefined);
      try {
        return new Group(children, {
          left: filled.left as number | undefined,
          top: filled.top as number | undefined,
          width: groupW,
          height: groupH,
          scaleX: filled.scaleX as number | undefined,
          scaleY: filled.scaleY as number | undefined,
          angle: filled.angle as number | undefined,
          opacity: filled.opacity as number | undefined,
          flipX: filled.flipX === true,
          flipY: filled.flipY === true,
          // Pass origin verbatim — fabric's default (center) applies
          // when unset, matching the renderer side and fabric's docs.
          originX: filled.originX as "left" | "center" | "right" | undefined,
          originY: filled.originY as "top" | "center" | "bottom" | undefined,
          // FixedLayout: keep the group's bbox at the explicit content
          // size; don't let fabric recompute from children.
          layoutManager: new LayoutManager(new FixedLayout()),
        });
      } catch (err) {
        console.warn("[graphic] Clip group failed:", err);
        return null;
      }
    }
    return reviveSpec(filled);
  }

  /** Build the live overlay objects for a Map. Structure (which objects
   *  exist, their ids, path points/progress) comes from the map node; each
   *  object's animated state — its own props AND its anchor (lat/lng /
   *  position) — comes from its own flat path in `snap` (see core's
   *  buildFlat). Objects materialize through the normal pipeline so
   *  Clips/Groups get context. Path position default = the path's current
   *  `progress` (unset ⇒ 1, the path's end). */
  private async materializeMapOverlays(
    filled: FilledObject,
    path: string,
    entry: GraphicEntry,
    outerT: number,
    snap: FlatFrame,
  ): Promise<MapOverlay[]> {
    const overlays: MapOverlay[] = [];
    const mapObjs = Array.isArray(filled.objects) ? filled.objects : [];

    for (let i = 0; i < mapObjs.length; i++) {
      const wrap = mapObjs[i] as Record<string, unknown>;
      const obj = wrap.object as FilledObject | undefined;
      if (!obj || typeof obj.type !== "string") continue;
      const key = pathKey(obj, i);
      const state =
        (snap[`${path}.objects.${key}`] as FilledObject | undefined) ?? {
          ...obj,
          latitude: wrap.latitude,
          longitude: wrap.longitude,
        };
      const { latitude, longitude, ...objSpec } = state as Record<
        string,
        unknown
      >;
      const live = await this.materializeOne(
        objSpec as FilledObject,
        snap,
        `${path}.objects.${key}`,
        entry,
        outerT,
      );
      if (!live) continue;
      overlays.push({
        live,
        anchor: {
          kind: "geo",
          longitude: numberOr(longitude, numberOr(wrap.longitude, 0)),
          latitude: numberOr(latitude, numberOr(wrap.latitude, 0)),
        },
      });
    }

    const paths = Array.isArray(filled.paths) ? filled.paths : [];
    for (let pi = 0; pi < paths.length; pi++) {
      const p = paths[pi] as Record<string, unknown>;
      const pObjs = Array.isArray(p.objects) ? p.objects : [];
      if (!pObjs.length) continue;
      const points = Array.isArray(p.points) ? (p.points as number[][]) : [];
      if (points.length < 2) continue;
      const progress = typeof p.progress === "number" ? p.progress : 1;
      for (let oi = 0; oi < pObjs.length; oi++) {
        const wrap = pObjs[oi] as Record<string, unknown>;
        const obj = wrap.object as FilledObject | undefined;
        if (!obj || typeof obj.type !== "string") continue;
        const key = pathKey(obj, oi);
        const state =
          (snap[`${path}.paths.${pi}.objects.${key}`] as
            | FilledObject
            | undefined) ?? { ...obj, position: wrap.position };
        const { position, ...objSpec } = state as Record<string, unknown>;
        const live = await this.materializeOne(
          objSpec as FilledObject,
          snap,
          `${path}.paths.${pi}.objects.${key}`,
          entry,
          outerT,
        );
        if (!live) continue;
        overlays.push({
          live,
          anchor: {
            kind: "path",
            points,
            position: typeof position === "number" ? position : progress,
          },
        });
      }
    }

    return overlays;
  }
}

async function reviveSpec(spec: FilledObject): Promise<FabricObject | null> {
  try {
    const [obj] = (await fabricUtil.enlivenObjects([
      spec as Record<string, unknown>,
    ])) as FabricObject[];
    return obj ?? null;
  } catch (err) {
    console.warn("[graphic] enliven failed:", spec.type, err);
    return null;
  }
}

function makePlaceholder(
  spec: FilledObject,
  fill: string,
  stroke: string,
  label: string,
): Promise<FabricObject | null> {
  const w = numberOr(spec.width, 200);
  const h = numberOr(spec.height, 200);
  return reviveSpec({
    type: "Group",
    left: numberOr(spec.left, 0),
    top: numberOr(spec.top, 0),
    width: w,
    height: h,
    angle: numberOr(spec.angle, 0),
    scaleX: numberOr(spec.scaleX, 1),
    scaleY: numberOr(spec.scaleY, 1),
    originX: spec.originX,
    originY: spec.originY,
    objects: [
      {
        type: "Rect",
        width: w,
        height: h,
        left: -w / 2,
        top: -h / 2,
        fill,
        stroke,
        strokeWidth: 2,
      },
      {
        type: "Textbox",
        text: label,
        left: -w / 2 + 12,
        top: -h / 2 + 12,
        width: w - 24,
        fontFamily: "monospace",
        fontSize: 14,
        fill: "#cccccc",
      },
    ],
  });
}

function collectClipChildSpecs(
  tree: FilledTree,
  snap: FlatFrame,
  parentPath: string,
): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (let i = 0; i < tree.length; i++) {
    const node = tree[i];
    const key = pathKey(node, i);
    const path = parentPath === "" ? key : `${parentPath}.${key}`;
    const state = snap[path];
    if (!state) {
      out.push({ ...node } as Record<string, unknown>);
      continue;
    }
    const merged: Record<string, unknown> = { ...node, ...state };
    if (merged.type === "Group" && Array.isArray(merged.objects)) {
      merged.objects = collectClipChildSpecs(
        merged.objects as FilledTree,
        snap,
        path,
      );
    }
    out.push(merged);
  }
  return out;
}

/** Strip a filled spec down to fields that can flow into a fabric
 *  object's .set() — everything we'd otherwise pass to the constructor
 *  on a fresh enliven. Type + clipId/source-style identity is dropped
 *  because those are immutable for a cached instance. */
/** Return a flat snapshot with every graphic `Image` node's `src` resolved to
 *  a loadable URL (blob:/file:// via the platform's `resolveSource`), so
 *  fabric's image enliven gets a URL it can actually fetch — the same
 *  host-resolution clips get. `data:`/`http(s)`/`blob:` srcs pass through.
 *  Non-Image entries are shared by reference (only changed entries are
 *  cloned, so the cached snapshot isn't mutated). */
function resolveImageFlat(flat: FlatFrame, basePath: string): FlatFrame {
  let out = flat;
  for (const key in flat) {
    const e = flat[key];
    const src = (e as { type?: unknown; src?: unknown }).src;
    if (
      (e as { type?: unknown }).type === "Image" &&
      typeof src === "string" &&
      !/^(data:|https?:|blob:)/i.test(src)
    ) {
      if (out === flat) out = { ...flat };
      out[key] = { ...e, src: resolveSource(src, basePath) };
    }
  }
  return out;
}

function pathKey(node: FilledObject, index: number): string {
  const id = node.id;
  if (typeof id === "string" && id.length > 0) return id;
  return String(index);
}

function numberOr(v: unknown, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

function asNumber(v: unknown, fallback: number): number {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return fallback;
}

interface CollectedGraphic {
  node: ResolvedGraphic;
  /** Global → enclosing-container local time for this graphic. */
  toLocal: (globalTime: number) => number;
}

/** Flatten every graphic in the tree, carrying for each a `toLocal` mapper
 *  that composes the time transform of every composition it's nested in.
 *  The per-composition transform mirrors RenderList's descent exactly so a
 *  graphic's animation stays in sync with where it's drawn. */
function collectGraphicEntries(children: ResolvedChild[]): CollectedGraphic[] {
  const out: CollectedGraphic[] = [];
  walk(children, (t) => t);
  return out;
  function walk(arr: ResolvedChild[], toLocal: (t: number) => number) {
    for (const c of arr) {
      if (c.type === "graphic") {
        out.push({ node: c, toLocal });
      } else if (c.type === "composition") {
        const comp = c;
        const parentToLocal = toLocal;
        // Clamp to the comp's inner-window span (duration × speed), not its
        // output duration — see FrameCoordinator/RenderList. Otherwise a
        // graphic in a duration-compressed comp freezes past output 2s.
        const childToLocal = (t: number): number =>
          Math.min(
            (parentToLocal(t) - comp.timelineStart) * comp.speed,
            comp.duration * comp.speed,
          );
        walk(comp.children, childToLocal);
      }
    }
  }
}

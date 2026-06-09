// Browser-side graphic compositing. Mirrors TextStore's shape: per
// ResolvedGraphic an OffscreenCanvas (or HTMLCanvasElement) at the
// authored contentWidth/Height, redrawn each tick by walking the
// snapshot from playback.ts onto a fabric.StaticCanvas.
//
// Map elements emit a labelled placeholder rect for now; the full
// maplibre-gl browser path will land in a follow-up that reuses
// motion-editor-test/src/maplibre-map.ts.

import type {
  ResolvedChild,
  ResolvedGraphic,
  ResolvedTimeline,
} from "@seam/core";
import type { FlatFrame, FilledObject, FilledTree, FilledFrame } from "@seam/core";
import { StaticCanvas, util as fabricUtil, type FabricObject } from "fabric";
import {
  precomputeGraphicPlayback,
  snapshotAt,
  isStatic,
  type GraphicPlayback,
} from "./graphic/playback.js";
import {
  precomputeClipPlayback,
  clipSnapAtLocalTime,
  computeLocalTime,
  getClipAnchorsAtPath,
  type ClipDefLike,
  type ClipPlayback,
} from "./graphic/clip.js";
// Side-effect import: registers MapLibreMap into fabric's classRegistry
// so enlivenObjects(spec.type === "Map") produces a live maplibre-backed
// FabricObject instead of falling back to the default rect.
import { MapLibreMap } from "./graphic/MapLibreMap.js";

interface GraphicEntry {
  node: ResolvedGraphic;
  canvas: HTMLCanvasElement;
  fabric: StaticCanvas;
  playback: GraphicPlayback;
  clipPlaybacks: Map<string, ClipPlayback>;
  clipDefs: Map<string, ClipDefLike>;
  outerFrames: ReadonlyArray<ReadonlyArray<unknown>>;
  isStaticGraphic: boolean;
  lastT: number;
  /** MapLibreMap instances keyed by hierarchical path-id, persisted
   *  across animation frames. Without this, each re-materialize would
   *  spin up a fresh maplibre — destroying any chance of pooling. */
  mapCache: Map<string, MapLibreMap>;
}

export class GraphicStore {
  private entries = new Map<ResolvedGraphic, GraphicEntry>();
  onFrameAvailable: (() => void) | null = null;

  async setTimeline(timeline: ResolvedTimeline): Promise<void> {
    this.dispose();
    const nodes = collectGraphicNodes(timeline.children);
    for (const node of nodes) {
      try {
        const W = Math.max(1, Math.round(asNumber(node.contentWidth, 1080)));
        const H = Math.max(1, Math.round(asNumber(node.contentHeight, 1920)));
        const canvas = document.createElement("canvas");
        canvas.width = W;
        canvas.height = H;
        const fabric = new StaticCanvas(canvas, {
          width: W,
          height: H,
          backgroundColor: "rgba(0,0,0,0)",
          enableRetinaScaling: false,
        });
        // Async re-renders driven by MapLibreMap (maplibre fires when
        // tiles arrive) bypass the per-tick update loop. Hook the
        // fabric canvas so each off-tick redraw also tells the GPU
        // texture manager that this graphic changed.
        fabric.on("after:render", () => this.onFrameAvailable?.());

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
          canvas,
          fabric,
          playback,
          clipPlaybacks,
          clipDefs,
          outerFrames: node.frames as ReadonlyArray<ReadonlyArray<unknown>>,
          isStaticGraphic: isStatic(playback) && clipPlaybacks.size === 0,
          lastT: -1,
          mapCache: new Map<string, MapLibreMap>(),
        };
        this.entries.set(node, entry);
        await this.draw(entry, 0);
      } catch (err) {
        console.error("[graphic] store setup failed:", err);
      }
    }
    if (this.entries.size > 0) this.onFrameAvailable?.();
  }

  /** Per-tick hook. Each animated graphic re-renders its snapshot if
   *  its node-local time has advanced; static graphics no-op after the
   *  one-shot seed in setTimeline. */
  async update(currentTime: number): Promise<void> {
    if (this.entries.size === 0) return;
    let anyRedrew = false;
    for (const entry of this.entries.values()) {
      if (entry.isStaticGraphic) continue;
      const t = currentTime - entry.node.timelineStart;
      const duration = entry.node.timelineEnd - entry.node.timelineStart;
      if (t < 0 || t > duration) continue;
      if (Math.abs(t - entry.lastT) < 0.001) continue;
      entry.lastT = t;
      try {
        await this.draw(entry, t);
        anyRedrew = true;
      } catch (err) {
        console.error("[graphic] redraw failed:", err);
      }
    }
    if (anyRedrew) this.onFrameAvailable?.();
  }

  getFrame(node: ResolvedGraphic): HTMLCanvasElement | null {
    return this.entries.get(node)?.canvas ?? null;
  }

  dispose(): void {
    for (const entry of this.entries.values()) {
      // Release pooled maplibre refs explicitly — the fabric canvas's
      // own dispose() removes children which fires "removed", but
      // isPreEnliven Maps short-circuit dispose there to survive
      // frame churn. Drop the pre-enliven flag and call dispose
      // ourselves so the SharedMaplibre refcount actually decrements.
      for (const map of entry.mapCache.values()) {
        map.isPreEnliven = false;
        try {
          map.dispose();
        } catch {
          // ignore
        }
      }
      entry.mapCache.clear();
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
    const snap = snapshotAt(entry.playback, t);
    const tree = entry.playback.filledFrames[0]?.tree ?? [];
    entry.fabric.clear();
    entry.fabric.backgroundColor = "rgba(0,0,0,0)";
    const specs = await this.materializeTree(tree, snap, "", entry, t);
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
      // Reuse a cached MapLibreMap for this path-id across animation
      // frames. Each tick the GraphicStore re-materializes; without
      // caching we'd construct a new maplibre instance per frame
      // (the pool would share the GL context but the wrapper-level
      // setup churn alone is enough to chase maplibre into the weeds).
      //
      // Cached instances stay alive across fabric's add/remove cycle
      // via isPreEnliven=true (which disables dispose-on-removed).
      // Per-frame prop changes flow through .set() → the 16ms
      // pendingUpdate buffer → flushPending.
      const cached = entry.mapCache.get(path);
      if (cached) {
        cached.set(toFabricUpdate(filled));
        return cached;
      }
      const live = await reviveSpec(filled);
      if (live instanceof MapLibreMap) {
        live.isPreEnliven = true;
        live.attachToPath(path);
        entry.mapCache.set(path, live);
      }
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
      return reviveSpec({
        ...filled,
        objects: children.map((c) => c.toObject(["id"])) as Record<string, unknown>[],
      });
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
      const clipSnap = clipSnapAtLocalTime(playback, localT);
      const tree0 = playback.filledFrames[0]?.tree ?? [];
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
      return reviveSpec({
        type: "Group",
        left: filled.left,
        top: filled.top,
        width: cw > 0 ? cw : filled.width,
        height: ch > 0 ? ch : filled.height,
        scaleX: filled.scaleX,
        scaleY: filled.scaleY,
        angle: filled.angle,
        opacity: filled.opacity,
        flipX: filled.flipX,
        flipY: filled.flipY,
        originX: filled.originX ?? "left",
        originY: filled.originY ?? "top",
        objects: childSpecs,
      });
    }
    return reviveSpec(filled);
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
    originX: spec.originX ?? "left",
    originY: spec.originY ?? "top",
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
function toFabricUpdate(filled: FilledObject): Record<string, unknown> {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { type, id, ...rest } = filled;
  return rest;
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

function collectGraphicNodes(children: ResolvedChild[]): ResolvedGraphic[] {
  const out: ResolvedGraphic[] = [];
  walk(children);
  return out;
  function walk(arr: ResolvedChild[]) {
    for (const c of arr) {
      if (c.type === "graphic") out.push(c);
      else if (c.type === "composition") walk(c.children);
    }
  }
}

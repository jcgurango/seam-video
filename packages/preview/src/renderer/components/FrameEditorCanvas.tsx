// Direct-manipulation editor for ONE graphic keyframe's fabric scene.
//
// This is the production descendant of the motion-editor-test bench: a fabric
// Canvas bound bidirectionally to a frame's authored object array. It reuses
// the production graphic machinery — `TileMap` (registered into fabric's
// classRegistry on import) for Map elements, and the global `resolveSource`
// (blob/file URLs) + pmtiles resolver the rest of the app already wires — so
// what you edit here renders identically in the main preview.
//
// Scope (v1): native fabric shapes + text + images are fully editable. Maps
// render via the @seam/map tile rasterizer and move/scale/rotate as boxes;
// their camera (lat/lng/zoom) is tuned in JSON. Clips render as a labelled
// placeholder box that round-trips its authored props — the real clip content
// shows live in the right-hand preview.
//
// The component owns no document state: `objects` in, edited `objects` out via
// `onChange` (with logical source ids, ready to drop straight into the doc).

import React, { useEffect, useRef } from "react";
import {
  ActiveSelection,
  Canvas as FabricCanvas,
  FabricImage,
  Group,
  Point,
  Rect,
  classRegistry,
  util as fabricUtil,
  type FabricObject,
  type TMat2D,
} from "fabric";
// Side-effect: registers TileMap as the "Map" class in fabric's registry.
import { TileMap } from "../media/graphic/TileMap.js";
import { CUSTOM_PROPS } from "../media/graphic/fill.js";
import { resolveSource } from "./resolveSource.js";

const MIN_ZOOM = 0.05;
const MAX_ZOOM = 20;

// Default size (design px) for a dropped Map; authors then place + size it.
const DROP_MAP_W = 480;
const DROP_MAP_H = 320;

// Props serialized off the canvas. `logicalSrc` is Image bookkeeping: on load
// we swap a logical source id for a real (blob/file) URL and stash the logical
// id here, then swap it back on write-back so the JSON keeps the portable id.
const SERIALIZE_PROPS = [...CUSTOM_PROPS, "logicalSrc"] as string[];

// ── Clip placeholder ────────────────────────────────────────────────────
// Production has no editable Clip fabric class (GraphicStore inlines clip
// materialization for rendering). For the editor we register a lightweight
// box under the "Clip" type so a Clip spec revives into a movable placeholder
// that re-emits its authored props. Safe alongside GraphicStore: that path
// handles "Clip" explicitly and never revives one through the registry.
class EditorClip extends Rect {
  static type = "Clip";
  constructor(options: Record<string, unknown> = {}) {
    super({
      width: 200,
      height: 200,
      fill: "rgba(120, 90, 160, 0.22)",
      stroke: "#9b6fc0",
      strokeWidth: 2,
      strokeDashArray: [6, 4],
      ...options,
    });
  }
  // fabric's `toObject` has an over-constrained generic signature; we emit a
  // bespoke Clip spec, so `any` here is the pragmatic override type.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  toObject(propsToInclude: any[] = []): any {
    const o = super.toObject(propsToInclude) as Record<string, unknown>;
    const self = this as unknown as Record<string, unknown>;
    // Re-emit a clean Clip spec — keep the transform, drop the box styling
    // and the placeholder's fixed width/height.
    const out: Record<string, unknown> = {
      type: "Clip",
      left: o.left,
      top: o.top,
      scaleX: o.scaleX,
      scaleY: o.scaleY,
      angle: o.angle,
      originX: o.originX,
      originY: o.originY,
    };
    for (const k of ["id", "clipId", "startPosition", "repeat", "source"]) {
      if (self[k] != null) out[k] = self[k];
    }
    return out;
  }
}
classRegistry.setClass(EditorClip, "Clip");

type Obj = Record<string, unknown>;

/** Walk an object tree (through `objects` children), applying `transform` to
 *  every node. Returns a fresh tree. */
function walkObjects(node: unknown, transform: (n: Obj) => Obj): unknown {
  if (Array.isArray(node)) return node.map((c) => walkObjects(c, transform));
  if (node && typeof node === "object") {
    const t = transform(node as Obj);
    const out: Obj = { ...t };
    if (Array.isArray(out.objects)) {
      out.objects = (out.objects as unknown[]).map((c) => walkObjects(c, transform));
    }
    return out;
  }
  return node;
}

const isResolvedUrl = (s: string) => /^(data:|https?:|blob:|file:)/i.test(s);

/** Logical source ids → loadable URLs for fabric's enliven. Images keep their
 *  logical id in `logicalSrc` for the reverse swap. */
function toReal(objects: unknown[], basePath: string): unknown[] {
  return walkObjects(objects, (n) => {
    if (n.type === "Image" && typeof n.src === "string" && !isResolvedUrl(n.src)) {
      return { ...n, src: resolveSource(n.src, basePath), logicalSrc: n.src };
    }
    return n;
  }) as unknown[];
}

/** Reverse of `toReal`: restore Image `src` from the stashed logical id and
 *  strip the bookkeeping field, so the doc keeps portable ids. */
function toLogical(objects: unknown[]): unknown[] {
  return walkObjects(objects, (n) => {
    if (typeof n.logicalSrc === "string" && n.logicalSrc.length > 0) {
      const next: Obj = { ...n, src: n.logicalSrc };
      delete next.logicalSrc;
      return next;
    }
    if ("logicalSrc" in n) {
      const next = { ...n };
      delete next.logicalSrc;
      return next;
    }
    return n;
  }) as unknown[];
}


export interface FrameEditorCanvasProps {
  /** The frame's authored objects (`frames[i][1]`), with logical source ids. */
  objects: unknown[];
  /** The graphic's design canvas — the editable frame extents. */
  contentWidth: number;
  contentHeight: number;
  /** Base path for resolving relative image sources (ignored on web, which
   *  resolves OPFS filenames to blob URLs by name). */
  basePath: string;
  /** Edited objects (logical source ids) after any direct manipulation. */
  onChange?: (objects: unknown[]) => void;
  /** Drop a file into the scene (FE-4). Returns the stored source + kind, or
   *  null if the file isn't supported. */
  onImportFile?: (
    file: File,
  ) => Promise<{ source: string; kind: "image" | "pmtiles" } | null>;
}

export default function FrameEditorCanvas({
  objects,
  contentWidth,
  contentHeight,
  basePath,
  onChange,
  onImportFile,
}: FrameEditorCanvasProps) {
  const canvasElRef = useRef<HTMLCanvasElement | null>(null);
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const fabricRef = useRef<FabricCanvas | null>(null);
  const initialFitDone = useRef(false);

  // Bidirectional-sync gates (mirror the test bench): `lastSig` holds the
  // JSON of whatever the canvas currently shows; the load effect skips when
  // the incoming objects match (the edit came from the canvas). `isLoading`
  // suppresses write-back during programmatic loads.
  const isLoadingRef = useRef(false);
  const lastSigRef = useRef("");

  // Keep the latest props readable from stable canvas handlers.
  const stateRef = useRef({ basePath, onChange, onImportFile });
  stateRef.current = { basePath, onChange, onImportFile };

  // Init fabric once: black frame backdrop, wheel-zoom, ⌘/ctrl-drag pan,
  // write-back on modify, group/ungroup keys.
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
    const wrap = c.wrapperEl;

    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = wrap.getBoundingClientRect();
      const p = new Point(e.clientX - rect.left, e.clientY - rect.top);
      let zoom = c.getZoom() * Math.pow(1.0015, -e.deltaY);
      zoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, zoom));
      c.zoomToPoint(p, zoom);
    };
    wrap.addEventListener("wheel", onWheel, { passive: false });

    let pan: { x: number; y: number; vptX: number; vptY: number } | null = null;
    const onDown = (opt: { e: Event }) => {
      const e = opt.e as MouseEvent;
      if (!e || !(e.metaKey || e.ctrlKey)) return;
      pan = { x: e.clientX, y: e.clientY, vptX: c.viewportTransform[4], vptY: c.viewportTransform[5] };
      c.selection = false;
      c.setCursor("grabbing");
    };
    const onMove = (opt: { e: Event }) => {
      if (!pan) return;
      const e = opt.e as MouseEvent;
      const vpt = c.viewportTransform.slice() as TMat2D;
      vpt[4] = pan.vptX + (e.clientX - pan.x);
      vpt[5] = pan.vptY + (e.clientY - pan.y);
      c.setViewportTransform(vpt);
    };
    const onUp = () => {
      if (!pan) return;
      pan = null;
      c.selection = true;
      c.setCursor("default");
    };
    c.on("mouse:down", onDown);
    c.on("mouse:move", onMove);
    c.on("mouse:up", onUp);

    const writeBack = () => {
      if (isLoadingRef.current) return;
      const cb = stateRef.current.onChange;
      if (!cb) return;
      const raw = (c.toObject(SERIALIZE_PROPS) as { objects?: unknown[] }).objects ?? [];
      const next = toLogical(raw);
      lastSigRef.current = JSON.stringify(next);
      cb(next);
    };
    c.on("object:modified", writeBack);

    // Drag-and-drop: store the file via the host (OPFS on web) → a source
    // id, then add the matching fabric object at the drop point. The host
    // owns import; we only place + fire `object:modified` so write-back picks
    // the new object up (with its logical source id).
    const onDragOver = (e: DragEvent) => {
      if (!e.dataTransfer) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "copy";
    };
    const onDrop = async (e: DragEvent) => {
      if (!e.dataTransfer) return;
      e.preventDefault();
      const importFile = stateRef.current.onImportFile;
      const files = Array.from(e.dataTransfer.files);
      if (files.length === 0) return;
      const rect = wrap.getBoundingClientRect();
      const world = new Point(e.clientX - rect.left, e.clientY - rect.top).transform(
        fabricUtil.invertTransform(c.viewportTransform),
      );
      for (const file of files) {
        try {
          // All files (incl. SVG — see FrameEditorPane) are host-stored, then
          // placed as an Image or Map. (Parsing SVGs inline into native fabric
          // objects via loadSVGFromString + util.groupSVGElements is possible
          // and kept in reserve — for now an SVG imports as a raster Image.)
          if (!importFile) continue;
          const imported = await importFile(file);
          if (!imported) continue;
          if (imported.kind === "image") {
            const img = await FabricImage.fromURL(
              resolveSource(imported.source, stateRef.current.basePath),
              { crossOrigin: "anonymous" },
            );
            img.set({ left: world.x, top: world.y, originX: "center", originY: "center" });
            (img as unknown as { logicalSrc: string }).logicalSrc = imported.source;
            c.add(img);
            c.setActiveObject(img);
            c.fire("object:modified", { target: img });
          } else {
            const map = new TileMap({
              source: imported.source,
              left: world.x,
              top: world.y,
              width: DROP_MAP_W,
              height: DROP_MAP_H,
              originX: "center",
              originY: "center",
              latitude: 0,
              longitude: 0,
              zoom: 1,
            });
            c.add(map);
            c.setActiveObject(map);
            c.fire("object:modified", { target: map });
          }
        } catch (err) {
          console.warn("[FrameEditor] drop failed for", file.name, err);
        }
      }
      c.requestRenderAll();
    };
    wrap.addEventListener("dragover", onDragOver);
    wrap.addEventListener("drop", onDrop);

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() !== "g" || e.metaKey || e.ctrlKey || e.altKey) return;
      const t = e.target;
      if (t instanceof HTMLElement) {
        if (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable) return;
        if (t.closest(".monaco-editor")) return;
      }
      e.preventDefault();
      if (e.shiftKey) ungroupActive(c);
      else groupActiveSelection(c);
    };
    window.addEventListener("keydown", onKeyDown);

    return () => {
      wrap.removeEventListener("wheel", onWheel);
      wrap.removeEventListener("dragover", onDragOver);
      wrap.removeEventListener("drop", onDrop);
      window.removeEventListener("keydown", onKeyDown);
      void c.dispose();
      fabricRef.current = null;
    };
  }, []);

  // Resize to the viewport box; fit the frame on first sizing.
  useEffect(() => {
    if (!viewportRef.current) return;
    const ro = new ResizeObserver((entries) => {
      const { width, height } = entries[0].contentRect;
      const c = fabricRef.current;
      if (!c || width <= 0 || height <= 0) return;
      c.setDimensions({ width, height });
      if (!initialFitDone.current) {
        fitFrame(c, width, height, contentWidth, contentHeight);
        initialFitDone.current = true;
      }
      c.renderAll();
    });
    ro.observe(viewportRef.current);
    return () => ro.disconnect();
  }, [contentWidth, contentHeight]);

  // Load the frame's objects whenever they change — unless the change is the
  // canvas's own write-back (sig match), which would loop.
  useEffect(() => {
    const c = fabricRef.current;
    if (!c) return;
    const sig = JSON.stringify(objects);
    if (sig === lastSigRef.current) return;
    lastSigRef.current = sig;

    let cancelled = false;
    isLoadingRef.current = true;
    const resolved = toReal(objects, stateRef.current.basePath) as Record<string, unknown>[];
    void c.loadFromJSON({ objects: resolved }).then(() => {
      if (cancelled) return;
      addFrameBackdrop(c, contentWidth, contentHeight);
      c.renderAll();
      isLoadingRef.current = false;
    });
    return () => {
      cancelled = true;
      isLoadingRef.current = false;
    };
  }, [objects, contentWidth, contentHeight]);

  return (
    <div
      ref={viewportRef}
      style={{ flex: 1, minHeight: 0, position: "relative", overflow: "hidden", background: "#0e0e0e" }}
    >
      <canvas ref={canvasElRef} style={{ display: "block" }} />
    </div>
  );
}

/** Center + scale the frame in the viewport at 90% with margins. */
function fitFrame(
  c: FabricCanvas,
  vw: number,
  vh: number,
  fw: number,
  fh: number,
): void {
  const scale = Math.min(vw / fw, vh / fh) * 0.9;
  c.setViewportTransform([scale, 0, 0, scale, (vw - fw * scale) / 2, (vh - fh * scale) / 2]);
}

/** A non-exported, non-interactive black rectangle at the frame's extents, so
 *  the editable area reads clearly against the darker viewport surround. */
function addFrameBackdrop(c: FabricCanvas, w: number, h: number): void {
  const backdrop = new Rect({
    // fabric defaults originX/originY to "center", so a (0,0)-placed box would
    // center on the origin and cover (-w/2,-h/2)..(w/2,h/2). Anchor top-left so
    // the backdrop exactly covers the frame extents (0,0)..(w,h).
    originX: "left",
    originY: "top",
    left: 0,
    top: 0,
    width: w,
    height: h,
    fill: "#000",
    stroke: "#444",
    strokeWidth: 1,
    selectable: false,
    evented: false,
    excludeFromExport: true,
    hoverCursor: "default",
  });
  c.add(backdrop);
  c.sendObjectToBack(backdrop);
}

function groupActiveSelection(c: FabricCanvas): void {
  const active = c.getActiveObject();
  if (!active || !(active instanceof ActiveSelection)) return;
  const objs = active.getObjects().slice();
  if (objs.length < 2) return;
  c.discardActiveObject();
  for (const o of objs) c.remove(o);
  const group = new Group(objs);
  c.add(group);
  c.setActiveObject(group);
  c.requestRenderAll();
  c.fire("object:modified", { target: group });
}

function ungroupActive(c: FabricCanvas): void {
  const active = c.getActiveObject();
  if (!active || !(active instanceof Group)) return;
  const children = active.removeAll() as FabricObject[];
  c.remove(active);
  for (const child of children) c.add(child);
  if (children.length > 0) c.setActiveObject(new ActiveSelection(children, { canvas: c }));
  c.requestRenderAll();
  c.fire("object:modified", { target: children[0] ?? active });
}

// Render a graphic snapshot to a PNG buffer via fabric/node. Walks the
// flat path-keyed snapshot, revives each entry as a fabric object on a
// StaticCanvas sized to the graphic's design space, then serializes the
// canvas to PNG.
//
// Map elements currently render a labelled placeholder rect — server-side
// maplibre rendering is gated on @maplibre/maplibre-gl-native shipping
// Node 25 prebuilds (or building from source). Everything else routes
// through fabric's native renderers.

import {
  FabricImage,
  FixedLayout,
  Group,
  LayoutManager,
  StaticCanvas,
  util as fabricUtil,
  type FabricObject,
} from "fabric/node";
import type { FlatFrame, FilledObject, FilledTree, FilledFrame } from "@seam/core";
import {
  clipSnapAtLocalTime,
  computeLocalTime,
  getClipAnchorsAtPath,
  type ClipDefLike,
  type ClipPlayback,
} from "./clip.js";
import { rgbaToCanvas, type MapPool } from "./map-render.js";
import { installGraphicFontFallback } from "./fontFallback.js";

/** Outer-graphic context threaded through materialize so Clip instances
 *  can compute their local time + render their content. When omitted,
 *  Clip elements render as labelled placeholders (back-compat for the
 *  single-frame static path). */
export interface GraphicContext {
  outerT: number;
  outerFrames: ReadonlyArray<ReadonlyArray<unknown>>;
  clipPlaybacks: Map<string, ClipPlayback>;
  clipDefs: Map<string, ClipDefLike>;
  /** Used to resolve relative Map source paths. Defaults to cwd. */
  mapBasePath?: string;
  /** Path-id keyed pool of maplibre instances. When supplied, Map
   *  elements reuse one instance per (path, source) across all output
   *  frames in this rasterize run. */
  mapPool?: MapPool;
}

export interface RenderOptions {
  contentWidth: number;
  contentHeight: number;
  /** Optional background. Default transparent. */
  backgroundColor?: string;
  /** Sub-clip playback context. Omit for static / placeholder-only renders. */
  context?: GraphicContext;
}

/** Render a flat snapshot to a PNG buffer. The flat snapshot must come
 *  paired with the originating filled tree so groups/clips can reach
 *  their authored child structure when reviving. */
export async function renderSnapshotToPng(
  snap: FlatFrame,
  tree: FilledTree,
  opts: RenderOptions,
): Promise<Buffer> {
  installGraphicFontFallback();
  const canvas = new StaticCanvas(undefined, {
    width: opts.contentWidth,
    height: opts.contentHeight,
    backgroundColor: opts.backgroundColor ?? "rgba(0,0,0,0)",
    enableRetinaScaling: false,
  });

  // Build live objects by walking the tree and substituting each node
  // with the eased state from `snap`.
  const specs = await materializeTree(tree, snap, "", opts.context);
  for (const obj of specs) canvas.add(obj);
  canvas.renderAll();

  // fabric/node's StaticCanvas exposes getNodeCanvas() returning the
  // underlying node-canvas, which has toBuffer().
  return (
    canvas as unknown as {
      getNodeCanvas(): { toBuffer(mime: string): Buffer };
    }
  )
    .getNodeCanvas()
    .toBuffer("image/png");
}

/** Recursively walks the filled tree and the snapshot in lockstep,
 *  producing a list of live fabric instances at the top level. Path
 *  computation matches @seam/core's buildFlat (id | positional-index). */
async function materializeTree(
  tree: FilledTree,
  snap: FlatFrame,
  parentPath: string,
  context: GraphicContext | undefined,
): Promise<FabricObject[]> {
  const out: FabricObject[] = [];
  for (let i = 0; i < tree.length; i++) {
    const node = tree[i];
    const key = pathKey(node, i);
    const path = parentPath === "" ? key : `${parentPath}.${key}`;
    const state = snap[path] ?? node;
    const merged: FilledObject = { ...node, ...state };
    const live = await materializeOne(merged, snap, path, context);
    if (live) out.push(live);
  }
  return out;
}

function pathKey(node: FilledObject, index: number): string {
  const id = node.id;
  if (typeof id === "string" && id.length > 0) return id;
  return String(index);
}

async function materializeOne(
  filled: FilledObject,
  snap: FlatFrame,
  path: string,
  context: GraphicContext | undefined,
): Promise<FabricObject | null> {
  const type = filled.type;
  if (typeof type !== "string") return null;

  if (type === "Map") {
    if (context) {
      const rendered = await renderMapToFabric(filled, path, context);
      if (rendered) return rendered;
    }
    return renderMapPlaceholder(filled);
  }

  if (type === "Group" && Array.isArray(filled.objects)) {
    // Recurse into the group's children so their paths/snap entries
    // resolve correctly.
    const children = await materializeTree(
      filled.objects as FilledTree,
      snap,
      path,
      context,
    );
    const group = await reviveSpec({
      ...filled,
      objects: children.map((c) => c.toObject(["id"])) as Record<string, unknown>[],
    });
    return group;
  }

  if (type === "Clip") {
    if (context) {
      const live = await materializeClip(filled, path, context);
      if (live) return live;
    }
    return renderClipPlaceholder(filled);
  }

  return reviveSpec(filled);
}

/** Build a fabric Group containing the clipDef's frame-0 tree mutated
 *  by the clip snap at this Clip instance's local time. Mirrors
 *  motion-editor-test's applyClipState + group-construction path. */
async function materializeClip(
  filled: FilledObject,
  path: string,
  context: GraphicContext,
): Promise<FabricObject | null> {
  const clipId = typeof filled.clipId === "string" ? filled.clipId : null;
  if (!clipId) return null;
  const playback = context.clipPlaybacks.get(clipId);
  const clipDef = context.clipDefs.get(clipId);
  if (!playback || !clipDef) return null;

  const anchors = getClipAnchorsAtPath(context.outerFrames, path);
  const repeat = typeof filled.repeat === "number" ? filled.repeat : -1;
  const localT = computeLocalTime(
    anchors,
    context.outerT,
    playback.duration,
    repeat,
  );
  const clipSnap = clipSnapAtLocalTime(playback, localT);

  // Build the children from clipDef.frames[0]'s structure (the "Frame A
  // structure until Frame B" rule). Each child gets its state from the
  // clip snap; clip-local coords are shifted by (-cw/2, -ch/2) so the
  // (0, 0) origin lands at the group's top-left rather than centre.
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

  // Enliven children individually so the Group can be constructed
  // directly with FixedLayout — fabric's default FitContent strategy
  // recomputes the group bbox from children, which breaks our
  // explicit content-size + (-cw/2, -ch/2) child shift. The browser
  // GraphicStore does the same dance for the same reason.
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
      originX: filled.originX as "left" | "center" | "right" | undefined,
      originY: filled.originY as "top" | "center" | "bottom" | undefined,
      layoutManager: new LayoutManager(new FixedLayout()),
    });
  } catch (err) {
    console.warn("[graphic] Clip group failed:", err);
    return null;
  }
}

/** Walk a clipDef's frame-0 tree paired with the clip snap, producing
 *  a list of fabric specs ready to feed into a Group's `objects`. Group
 *  children inside the clip recurse the same way. */
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
      // Object disappeared mid-pair — preserve the prev-side authored
      // version so the structure stays stable (the engine itself never
      // emits a missing path for prev's tree, but defensive).
      out.push({ ...node } as Record<string, unknown>);
      continue;
    }
    const merged: Record<string, unknown> = { ...node, ...state };
    if (
      typeof merged.type === "string" &&
      merged.type === "Group" &&
      Array.isArray(merged.objects)
    ) {
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

async function reviveSpec(spec: FilledObject): Promise<FabricObject | null> {
  try {
    const [obj] = (await fabricUtil.enlivenObjects([
      spec as Record<string, unknown>,
    ])) as FabricObject[];
    return obj ?? null;
  } catch (err) {
    console.warn("[graphic] failed to enliven:", spec.type, err);
    return null;
  }
}

/** Render the pmtiles-backed map to RGBA via maplibre-native, wrap the
 *  buffer in a node-canvas, hand it to fabric as a FabricImage with the
 *  authored Map instance's transform. Uses context.mapPool when present
 *  so successive frames at the same path-id share the same instance. */
async function renderMapToFabric(
  spec: FilledObject,
  path: string,
  context: GraphicContext,
): Promise<FabricObject | null> {
  const source = typeof spec.source === "string" ? spec.source : null;
  if (!source) return null;
  const width = Math.max(1, Math.round(numberOr(spec.width, 400)));
  const height = Math.max(1, Math.round(numberOr(spec.height, 400)));
  const paths = Array.isArray(spec.paths)
    ? (spec.paths as Array<Record<string, unknown>>)
        .filter(
          (p) =>
            typeof p.color === "string" &&
            Array.isArray(p.points) &&
            (p.points as unknown[]).length >= 2,
        )
        .map((p) => ({
          color: p.color as string,
          points: p.points as Array<[number, number]>,
          progress: typeof p.progress === "number" ? p.progress : undefined,
          lineWidth:
            typeof p.lineWidth === "number" ? p.lineWidth : undefined,
        }))
    : undefined;
  try {
    let rendered;
    if (context.mapPool) {
      const inst = await context.mapPool.acquire(
        path,
        source,
        context.mapBasePath,
      );
      rendered = await inst.render({
        latitude: numberOr(spec.latitude, 0),
        longitude: numberOr(spec.longitude, 0),
        zoom: numberOr(spec.zoom, 1),
        width,
        height,
        paths,
      });
    } else {
      const { renderMapToRgba } = await import("./map-render.js");
      rendered = await renderMapToRgba({
        source,
        basePath: context.mapBasePath,
        latitude: numberOr(spec.latitude, 0),
        longitude: numberOr(spec.longitude, 0),
        zoom: numberOr(spec.zoom, 1),
        width,
        height,
        paths,
      });
    }
    const nodeCanvas = rgbaToCanvas(rendered);
    // fabric/node's FabricImage accepts a node-canvas as the element.
    // Origin: pass through as-is; fabric's own default (center) applies
    // when unset. The browser preview honours the same default, so a
    // graphic JSON renders identically across both surfaces.
    const img = new FabricImage(
      nodeCanvas as unknown as HTMLImageElement,
      {
        left: numberOr(spec.left, 0),
        top: numberOr(spec.top, 0),
        scaleX: numberOr(spec.scaleX, 1),
        scaleY: numberOr(spec.scaleY, 1),
        angle: numberOr(spec.angle, 0),
        opacity: typeof spec.opacity === "number" ? spec.opacity : 1,
        flipX: spec.flipX === true,
        flipY: spec.flipY === true,
        originX: spec.originX as
          | "left"
          | "center"
          | "right"
          | undefined,
        originY: spec.originY as
          | "top"
          | "center"
          | "bottom"
          | undefined,
      },
    );
    return img as unknown as FabricObject;
  } catch (err) {
    console.warn("[graphic] map render failed:", (err as Error).message);
    return null;
  }
}

async function renderMapPlaceholder(
  spec: FilledObject,
): Promise<FabricObject | null> {
  const w = numberOr(spec.width, 200);
  const h = numberOr(spec.height, 200);
  const left = numberOr(spec.left, 0);
  const top = numberOr(spec.top, 0);
  const lat = numberOr(spec.latitude, 0);
  const lng = numberOr(spec.longitude, 0);
  const zoom = numberOr(spec.zoom, 1);
  const source = typeof spec.source === "string" ? spec.source : "(none)";
  // Build a Group-as-placeholder: dark rect + label text.
  return reviveSpec({
    type: "Group",
    left,
    top,
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
        fill: "#2a3340",
        stroke: "#5a6878",
        strokeWidth: 2,
      },
      {
        type: "Textbox",
        text: `Map: ${source}\n${lat.toFixed(3)}, ${lng.toFixed(3)} @ z${zoom}`,
        left: -w / 2 + 12,
        top: -h / 2 + 12,
        width: w - 24,
        fontFamily: "monospace",
        fontSize: 14,
        fill: "#9aa6b3",
      },
    ],
  });
}

async function renderClipPlaceholder(
  spec: FilledObject,
): Promise<FabricObject | null> {
  const w = numberOr(spec.width, 100);
  const h = numberOr(spec.height, 100);
  const left = numberOr(spec.left, 0);
  const top = numberOr(spec.top, 0);
  const clipId = typeof spec.clipId === "string" ? spec.clipId : "(?)";
  return reviveSpec({
    type: "Group",
    left,
    top,
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
        fill: "#3a2a40",
        stroke: "#7a5b88",
        strokeWidth: 2,
        strokeDashArray: [6, 4],
      },
      {
        type: "Textbox",
        text: `Clip: ${clipId}`,
        left: -w / 2 + 12,
        top: -h / 2 + 12,
        width: w - 24,
        fontFamily: "monospace",
        fontSize: 14,
        fill: "#c0a8d0",
      },
    ],
  });
}

function numberOr(v: unknown, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

/** Convenience: render a single filled frame (no animation) directly to a
 *  PNG buffer. Used for the static-graphic fast path. */
export async function renderFilledFrameToPng(
  frame: FilledFrame,
  opts: RenderOptions,
): Promise<Buffer> {
  return renderSnapshotToPng(frame.flat, frame.tree, opts);
}

/**
 * Walks the resolved timeline tree at a given time and produces a command
 * list for the GPU renderer. Clips become DrawCommands with absolute pixel
 * positions. Compositions with extension fields (colour adjustments, …)
 * become GroupCommands whose children are rendered to an intermediate
 * texture (FBO) so the group's colour stages can
 * be applied to the composite.
 *
 * Spatial model (post origin/translation/size rewrite):
 *   The resolver writes a `SpatialRect` per node that already accounts
 *   for objectFit — `size: "100%"` resolves to the post-objectFit natural
 *   rect, and origin+translation place that rect in parent space. The
 *   renderer treats `spatial` as the final draw rect: no further
 *   objectFit math at draw time. For clip/static the resolver doesn't
 *   know the media's intrinsic size, so we recompute the natural rect
 *   per-node from the probed media dims before solving spatial.
 *
 * Shapes (`rect` / `circle`) are FillCommands carrying a {@link ShapeGeometry}
 * the shader rasterizes analytically (signed distance, 1px AA) — a fill draw
 * and, when stroked, a ring draw. Every node's `cornerRadius` is the same
 * geometry applied as an alpha mask on its draw (leaf) or on its composited
 * group (composition / map).
 *
 * Extension node types (`seam.nodeTypes` — e.g. the Map extension's `map`)
 * are containers too: a DrawCommand for the node itself when it draws (the
 * host gets the pixels from the extension's rasterizer), then its children
 * walked in node-local time inside its inner canvas; a container that
 * defines `createAnchors` places each child's origin (a map `pin`).
 *
 * (Original note, map being the first such type:)
 * Maps are containers: a DrawCommand for the basemap (the host rasterizes it
 * at the inner canvas size for `drawTime`), then the map's children walked
 * like a composition's children — except a child with a `pin` has its origin
 * placed at the pin's projected pixel (camera sampled in map-local time).
 */

import type {
  ResolvedTimeline,
  ResolvedChild,
  ResolvedClip,
  ResolvedStatic,
  ResolvedRect,
  ResolvedCircle,
  ResolvedExtensionNode,
  ResolvedComposition,
  SpatialRect,
  ObjectFit,
  ExtFields,
  Length,
  Seam,
  SurfaceView,
  ChildAnchor,
  ExtensionNodeView,
} from "@seam/core";
import {
  resolveBoxProps,
  computeNaturalSize,
  sampleContentDim,
  sampleNumber,
  sampleColor,
  sampleLength,
  sampleDistort,
  isIdentityDistort,
  loopLocalTime,
  squareToQuad,
  applyHomography,
  asExtensionNode,
  extensionContentSpan,
  type Keyframed,
  type Quad,
  type DistortCorners,
} from "@seam/core";

/** Sample a node's first-class opacity (Keyframed);
 *  absent means fully opaque. */
function sampleOpacity(
  opacity: Keyframed<number> | undefined,
  t: number,
  duration: number,
): number {
  return opacity == null ? 1 : sampleNumber(opacity, t, duration);
}

/** A node's extension-contributed field values sampled at one instant, keyed
 *  by field key. Only authored fields appear; the colour stage that consumes
 *  them supplies defaults for the rest. */
export type FieldValues = Readonly<Record<string, number>>;

/** Shared "no contributed fields" value (background fills, layered basemaps). */
export const NO_FIELDS: FieldValues = Object.freeze({});

/** What the render list needs from a Seam instance: the contributed node
 *  types (containers, self-drawing nodes, child anchoring) and fields (which
 *  ones are numbers a colour stage can consume). */
export type RenderListExtensions = Pick<Seam, "nodeTypes" | "fields" | "overlays">;

/** Per-instance lookups, built once and cached. */
interface Env {
  seam: RenderListExtensions;
  /** Numeric contributed fields by key → custom sampler (or null = linear). */
  numeric: Map<string, ((value: unknown, t: number, duration: number) => number) | null>;
}

const envCache = new WeakMap<RenderListExtensions, Env>();
function envFor(seam: RenderListExtensions): Env {
  let env = envCache.get(seam);
  if (!env) {
    const numeric: Env["numeric"] = new Map();
    for (const f of seam.fields) {
      if (f.type === "number") numeric.set(f.key, f.sample ?? null);
    }
    env = { seam, numeric };
    envCache.set(seam, env);
  }
  return env;
}

/** Sample a node's NUMERIC contributed fields (plain numbers or keyframes) in
 *  its own time, like opacity — the values colour stages read. Structured
 *  fields (a map `pin`) ride in `ext` too but are not sampled here. */
function sampleFields(
  env: Env,
  ext: ExtFields | undefined,
  t: number,
  duration: number,
): FieldValues {
  if (!ext) return NO_FIELDS;
  let out: Record<string, number> | undefined;
  for (const key in ext) {
    const sampler = env.numeric.get(key);
    if (sampler === undefined) continue;
    (out ??= {})[key] = sampler
      ? sampler(ext[key], t, duration)
      : sampleNumber(ext[key] as Keyframed<number>, t, duration);
  }
  return out ?? NO_FIELDS;
}

/** True when a node authors at least one field a colour stage consumes.
 *  Other extension fields (a map `pin`, a composition's caption routing) ride
 *  in `ext` too and must not, by themselves, change how the node is drawn. */
function hasStageFields(env: Env, ext: ExtFields | undefined): boolean {
  if (!ext) return false;
  for (const key in ext) if (env.numeric.has(key)) return true;
  return false;
}

// Surfaces and their overlay drawables are cached so the same objects come
// back every frame for a given resolved timeline (hosts cache canvases and
// textures by identity).
const surfaceViews = new WeakMap<object, SurfaceView>();
function surfaceOf(children: ResolvedChild[], ext: ExtFields | undefined, root: boolean): SurfaceView {
  let view = surfaceViews.get(children);
  if (!view || view.ext !== ext) {
    view = { root, children, ...(ext ? { ext } : {}) };
    surfaceViews.set(children, view);
  }
  return view;
}
const overlayDrawables = new WeakMap<SurfaceView, Map<string, OverlayDrawable>>();
function overlayDrawable(surface: SurfaceView, key: string): OverlayDrawable {
  let byKey = overlayDrawables.get(surface);
  if (!byKey) overlayDrawables.set(surface, (byKey = new Map()));
  let d = byKey.get(key);
  if (!d) byKey.set(key, (d = { overlay: key, surface }));
  return d;
}

/** Emit the draws of every extension overlay that has something to show at
 *  `surface` at its inner time `t` — on top of whatever is already in
 *  `commands`, filling the surface's viewport at its inner-canvas size. */
function pushOverlays(
  env: Env,
  surface: SurfaceView,
  t: number,
  viewport: Viewport,
  scissor: ClipRect,
  opacity: number,
  commands: RenderCommand[],
): void {
  for (const overlay of env.seam.overlays) {
    if (!overlay.active(surface, t)) continue;
    commands.push({
      type: "draw",
      clip: overlayDrawable(surface, overlay.key),
      fields: NO_FIELDS,
      scissorX: scissor.x,
      scissorY: scissor.y,
      scissorW: scissor.w,
      scissorH: scissor.h,
      quadX: viewport.x,
      quadY: viewport.y,
      quadW: viewport.w,
      quadH: viewport.h,
      rotation: 0,
      pivotX: 0,
      pivotY: 0,
      opacity,
      drawTime: t,
      contentW: viewport.contentW,
      contentH: viewport.contentH,
    });
  }
}

/** Analytic shape the shader rasterizes, in TARGET pixels relative to the
 *  command's quad. Used both as the geometry of a shape fill and as the alpha
 *  mask (`cornerRadius`) of any textured draw / composited group. */
export interface ShapeGeometry {
  /** `roundrect`: the quad with `radius` corners. `ellipse`: inscribed in the quad. */
  kind: "roundrect" | "ellipse";
  /** Corner radius (px) — roundrect only. */
  radius: number;
  /** Inset (px) of the outer boundary from the quad edge. A stroked shape's
   *  fill shrinks by the stroke width so the stroke sits inside the box. */
  outerInset: number;
  /** Inset (px) of a hole boundary; negative = solid. A stroke ring is
   *  `outerInset: 0, innerInset: strokeWidth`. */
  innerInset: number;
}

/** An extension overlay drawn at a surface (the root or a composition): the
 *  thing a host asks the overlay's rasterizer for. One stable object per
 *  (surface, overlay), so hosts and the compositor can key textures on it. */
export interface OverlayDrawable {
  /** The overlay's key (`OverlayDef.key`). */
  overlay: string;
  surface: SurfaceView;
}

/** What a {@link DrawCommand} draws: a core drawable, an extension node that
 *  draws itself, or an extension overlay. Tell them apart with
 *  `"overlay" in clip`, then `"extension" in clip` (core types carry neither
 *  key), after which `clip.type` narrows as usual. */
export type Drawable =
  | ResolvedClip
  | ResolvedStatic
  | ResolvedExtensionNode
  | OverlayDrawable;

export interface DrawCommand {
  type: "draw";
  clip: Drawable;
  /** Sampled extension fields for this draw (colour stages read them).
   *  Normally the node's own; an extension container's own draw carries none
   *  when the container is layered (the group applies them). */
  fields: FieldValues;
  scissorX: number;
  scissorY: number;
  scissorW: number;
  scissorH: number;
  quadX: number;
  quadY: number;
  quadW: number;
  quadH: number;
  /** In-plane rotation in radians (clockwise in screen space), about the
   *  pivot below. 0 = no rotation. */
  rotation: number;
  /** Rotation pivot in target-pixel space (the node's origin point). */
  pivotX: number;
  pivotY: number;
  opacity: number;
  /** Elapsed time (s) into this node within its container — i.e.
   *  `containerLocalTime − node.timelineStart`, with every enclosing
   *  composition's offset + speed already folded into the container time. The
   *  host uses this (not the global output time) to address the node's source:
   *  clip `clipSourceTime(node, drawTime)` (= `sourceIn + drawTime·speed`,
   *  or `sourceOut − drawTime·speed` when reversed), text/map local time
   *  `drawTime`. */
  drawTime: number;
  /** Inner-canvas (contentWidth/Height) in pixels for text/map nodes,
   *  sampled per-frame against the live parent dims. The host rasterizer
   *  renders the texture at this size (text reflows, map re-projects).
   *  Absent for clip/static (their texture size is the probed media). */
  contentW?: number;
  contentH?: number;
  /** Visible source sub-rect (UV fractions) when the node is `inset`; absent
   *  = full texture. The blit samples this window into the quad. */
  sourceRect?: { u0: number; v0: number; u1: number; v1: number };
  /** `cornerRadius` alpha mask; absent = no mask. */
  mask?: ShapeGeometry;
}

export interface FillCommand {
  type: "fill";
  key: object;
  color: string;
  destX: number;
  destY: number;
  destW: number;
  destH: number;
  scissorX: number;
  scissorY: number;
  scissorW: number;
  scissorH: number;
  opacity: number;
  /** Rotation of the fill quad (shape nodes); background fills are never
   *  rotated (a rotated comp's bg fill rides inside its FBO). */
  rotation: number;
  pivotX: number;
  pivotY: number;
  /** Analytic shape to rasterize (rect/circle nodes); absent = the plain quad. */
  shape?: ShapeGeometry;
  /** Sampled extension fields of the shape node (absent for background fills). */
  fields?: FieldValues;
}

export interface GroupCommand {
  type: "group";
  destX: number;
  destY: number;
  destW: number;
  destH: number;
  scissorX: number;
  scissorY: number;
  scissorW: number;
  scissorH: number;
  fboW: number;
  fboH: number;
  /** Sampled extension fields, applied to the composited group. */
  fields: FieldValues;
  opacity: number;
  /** In-plane rotation in radians of the composited FBO quad, about the
   *  pivot below. 0 = no rotation. */
  rotation: number;
  pivotX: number;
  pivotY: number;
  children: RenderCommand[];
  /** Visible FBO sub-rect (UV fractions) when the composition is `inset`. */
  sourceRect?: { u0: number; v0: number; u1: number; v1: number };
  /** Corner-pin (`distort`): where the four corners of the drawn quad land,
   *  in target-pixel space *before* `rotation`, clockwise from top-left.
   *  Present only when the composition authored a non-identity `distort`;
   *  the compositor then ignores `dest*` for geometry and interpolates the
   *  FBO texture projectively across this quad. `dest*` still describes the
   *  undistorted layout box. */
  corners?: Quad;
  /** `cornerRadius` alpha mask on the composited quad; absent = no mask. */
  mask?: ShapeGeometry;
}

export type RenderCommand = DrawCommand | GroupCommand | FillCommand;

interface Viewport {
  x: number;
  y: number;
  w: number;
  h: number;
  contentW: number;
  contentH: number;
}

interface ClipRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** The host's sizes: a clip / static's probed media dims, or — for an
 *  extension node whose type measures its inner canvas (`measured`) — that
 *  canvas at the node's own time `t`. Null when not known yet. */
type SizeGetter = (
  node: ResolvedClip | ResolvedStatic | ResolvedExtensionNode,
  t?: number,
) => { w: number; h: number } | null;

/** An extension node's inner canvas this frame: measured by its rasterizer
 *  when its type says so, else `contentWidth` / `contentHeight` sampled
 *  against the live parent. `t` is the node's local time (its content time
 *  adds the window offset). */
function innerCanvas(
  node: ResolvedExtensionNode,
  t: number,
  duration: number,
  parentW: number,
  parentH: number,
  getIntrinsicSize: SizeGetter,
): { w: number; h: number } {
  if (node.measured) {
    const m = getIntrinsicSize(node, extensionContentSpan(node).offset + t);
    if (m && m.w > 0 && m.h > 0) return m;
  }
  return {
    w: sampleContentDim(node.contentWidth, t, duration, parentW),
    h: sampleContentDim(node.contentHeight, t, duration, parentH),
  };
}

type SpatialNode =
  | ResolvedClip
  | ResolvedStatic
  | ResolvedRect
  | ResolvedCircle
  | ResolvedComposition;

export function buildRenderList(
  seam: RenderListExtensions,
  timeline: ResolvedTimeline,
  currentTime: number,
  canvasW: number,
  canvasH: number,
  getIntrinsicSize: SizeGetter,
): RenderCommand[] {
  const env = envFor(seam);
  const commands: RenderCommand[] = [];

  const rootViewport: Viewport = {
    x: 0,
    y: 0,
    w: canvasW,
    h: canvasH,
    contentW: (timeline.contentWidth as number | undefined) ?? canvasW,
    contentH: (timeline.contentHeight as number | undefined) ?? canvasH,
  };

  const rootClip: ClipRect = { x: 0, y: 0, w: canvasW, h: canvasH };

  if (timeline.backgroundColor != null) {
    commands.push(
      plainFill(timeline, timeline.backgroundColor, rootViewport, rootClip, 1),
    );
  }

  walkChildren(
    env,
    timeline.children,
    currentTime,
    rootViewport,
    rootClip,
    1,
    getIntrinsicSize,
    commands,
    null,
  );

  // Extension fields authored on the root composition (a colour adjustment
  // of the whole video): composite the frame as one full-canvas group so the
  // colour stages see it as a unit, like any composition that carries them.
  // Extension overlays at the root (captions): on top of everything, and
  // outside the root's colour-stage group — a look applied to the video does
  // not recolour its captions.
  const overlays: RenderCommand[] = [];
  if (env.seam.overlays.length > 0) {
    pushOverlays(
      env,
      surfaceOf(timeline.children, timeline.ext, true),
      currentTime,
      rootViewport,
      rootClip,
      1,
      overlays,
    );
  }

  if (hasStageFields(env, timeline.ext)) {
    return [
      {
        type: "group",
        destX: 0,
        destY: 0,
        destW: canvasW,
        destH: canvasH,
        scissorX: 0,
        scissorY: 0,
        scissorW: canvasW,
        scissorH: canvasH,
        fboW: canvasW,
        fboH: canvasH,
        fields: sampleFields(env, timeline.ext, currentTime, timeline.duration),
        opacity: 1,
        rotation: 0,
        pivotX: 0,
        pivotY: 0,
        children: commands,
      },
      ...overlays,
    ];
  }

  return overlays.length > 0 ? [...commands, ...overlays] : commands;
}

/** An un-rotated, un-shaped fill covering `rect` (composition background). */
function plainFill(
  key: object,
  color: string,
  rect: ClipRect,
  scissor: ClipRect,
  opacity: number,
): FillCommand {
  return {
    type: "fill",
    key,
    color,
    destX: rect.x,
    destY: rect.y,
    destW: rect.w,
    destH: rect.h,
    scissorX: scissor.x,
    scissorY: scissor.y,
    scissorW: scissor.w,
    scissorH: scissor.h,
    opacity,
    rotation: 0,
    pivotX: 0,
    pivotY: 0,
  };
}

/** Compute the post-objectFit "natural" rect for a media-bearing node
 *  given its intrinsic dims and the parent content size. Mirrors the
 *  core resolver's `computeNaturalSize`. */
function naturalSize(
  intrinsicW: number,
  intrinsicH: number,
  parentW: number,
  parentH: number,
  objectFit: ObjectFit | undefined,
): { w: number; h: number } {
  const fit = objectFit ?? "fit";
  let scale: number;
  switch (fit) {
    case "fit":
      scale = Math.min(parentW / intrinsicW, parentH / intrinsicH);
      break;
    case "cover":
      scale = Math.max(parentW / intrinsicW, parentH / intrinsicH);
      break;
    case "center":
      scale = 1;
      break;
  }
  return { w: intrinsicW * scale, h: intrinsicH * scale };
}

/** Resolve the per-frame spatial rect for a child in its parent's
 *  content-coordinate space. `anchor` (a projected map pin, parent px)
 *  replaces the parent center as the translation reference. */
function dynamicSpatial(
  child: SpatialNode,
  viewport: Viewport,
  localTime: number,
  getIntrinsicSize: SizeGetter,
  anchor: { x: number; y: number } | null,
): SpatialRect {
  const parentW = viewport.contentW;
  const parentH = viewport.contentH;
  const t = localTime - child.timelineStart;
  const duration = child.timelineEnd - child.timelineStart;

  // Determine the post-objectFit natural rect (size "100%" reference).
  // Shapes have no intrinsic dims: their natural box is the parent.
  let naturalW = parentW;
  let naturalH = parentH;
  if (child.type === "clip" || child.type === "static") {
    const media = getIntrinsicSize(child);
    if (media && media.w > 0 && media.h > 0) {
      const n = naturalSize(media.w, media.h, parentW, parentH, child.objectFit);
      naturalW = n.w;
      naturalH = n.h;
    }
  } else if (
    child.type === "composition" ||
    asExtensionNode(child) != null
  ) {
    // Sample the (animatable) inner canvas against the LIVE parent dims, then
    // post-objectFit it — mirrors the resolver's t=0 bake but per-frame, so an
    // animated contentWidth (or an animated parent canvas) reflows the natural
    // rect here instead of using a stale baked value. (Every extension node
    // has an inner canvas.)
    const inner = child as {
      contentWidth?: Keyframed<Length>;
      contentHeight?: Keyframed<Length>;
      objectFit?: ObjectFit;
    };
    const ext = asExtensionNode(child);
    const { w: iw, h: ih } = ext
      ? innerCanvas(ext, t, duration, parentW, parentH, getIntrinsicSize)
      : {
          w: sampleContentDim(inner.contentWidth, t, duration, parentW),
          h: sampleContentDim(inner.contentHeight, t, duration, parentH),
        };
    const n = computeNaturalSize(inner.objectFit ?? "fit", iw, ih, parentW, parentH);
    naturalW = n.naturalWidth;
    naturalH = n.naturalHeight;
  }

  if (child.spatialInput || anchor) {
    return resolveBoxProps(
      child.spatialInput ?? {},
      parentW,
      parentH,
      naturalW,
      naturalH,
      t,
      duration,
      anchor ?? undefined,
    );
  }

  // No animated input: use the resolver's baked rect if it carried one
  // (composition / text with authored spatial); otherwise center the
  // natural rect in the parent.
  if (child.spatial) return child.spatial;
  return {
    x: (parentW - naturalW) / 2,
    y: (parentH - naturalH) / 2,
    width: naturalW,
    height: naturalH,
  };
}

/** `cornerRadius` in TARGET px for a node's rect: `%` resolves against the
 *  shorter side (content px), then scales to target px. 0 when unset. */
function cornerRadiusPx(
  value: Keyframed<Length> | undefined,
  t: number,
  duration: number,
  spatial: SpatialRect,
  scale: number,
): number {
  if (value == null) return 0;
  const ref = Math.min(spatial.width, spatial.height);
  return Math.max(0, sampleLength(value, t, duration, ref, 0)) * scale;
}

function roundRectMask(radius: number): ShapeGeometry | undefined {
  if (radius <= 0) return undefined;
  return { kind: "roundrect", radius, outerInset: 0, innerInset: -1 };
}

/** Stable fill-texture keys per shape node (one for the fill, one for the
 *  stroke) so the backends' colour-tile caches persist across frames. */
const shapeKeys = new WeakMap<object, { fill: object; stroke: object }>();
function keysFor(node: object): { fill: object; stroke: object } {
  let k = shapeKeys.get(node);
  if (!k) {
    k = { fill: {}, stroke: {} };
    shapeKeys.set(node, k);
  }
  return k;
}

function isNoColor(c: string): boolean {
  const s = c.trim().toLowerCase();
  return s === "" || s === "none" || s === "transparent";
}

function walkChildren(
  env: Env,
  children: ResolvedChild[],
  localTime: number,
  viewport: Viewport,
  clipRect: ClipRect,
  opacity: number,
  getIntrinsicSize: SizeGetter,
  commands: RenderCommand[],
  /** The enclosing extension container's child-anchor function, if any. */
  anchors: ChildAnchor | null,
): void {
  for (const child of children) {
    if (child.type === "audio" || child.type === "data") continue;
    // An extension node with no visual presence (a caption) — and its children.
    if (asExtensionNode(child)?.nonVisual) continue;

    const isActive =
      localTime >= child.timelineStart && localTime < child.timelineEnd;
    if (!isActive) continue;

    const drawDuration = child.timelineEnd - child.timelineStart;
    const drawTime = localTime - child.timelineStart;
    // Content time: a looping clip/composition (`underflow: "loop"`) replays
    // its single cycle, so the media / inner-window time wraps while the
    // node's own keyframes (opacity, spatial, mask…) keep using `drawTime`.
    const contentTime =
      child.type === "clip" || child.type === "composition"
        ? loopLocalTime(child.loop, drawTime)
        : drawTime;

    // Inside an extension container that anchors its children (a map and
    // its pins): where this child's origin lands, or null to lay out normally.
    const anchor = anchors
      ? anchors(child as unknown as ExtensionNodeView, drawTime, drawDuration)
      : null;

    // Content→target scale (for px-valued strokes / radii on this level).
    const scale = Math.min(
      viewport.contentW > 0 ? viewport.w / viewport.contentW : 1,
      viewport.contentH > 0 ? viewport.h / viewport.contentH : 1,
    );

    // An extension node type that draws itself and holds no children (the
    // Text extension's `text`) is a plain leaf: one quad, like a clip — its
    // rotation / opacity / mask / fields ride on the draw, no layer needed.
    const leafExt = asExtensionNode(child);
    const leafDef = leafExt ? env.seam.nodeTypes.get(leafExt.type) : undefined;
    const drawsItself = leafExt != null && leafDef?.draws === true && !leafDef.children;

    if (child.type === "clip" || child.type === "static" || drawsItself) {
      // One shape for the three: placement, fade, opacity, mask and fields
      // are the common node fields (a self-drawing node has them all).
      const leaf = child as ResolvedClip | ResolvedStatic;
      const spatial = dynamicSpatial(leaf, viewport, localTime, getIntrinsicSize, anchor);
      const quad = absoluteRect(viewport, spatial);
      const { rotation, pivotX, pivotY } = rotationFor(viewport, spatial, quad);
      const scissor = scissorFor(clipRect, quad, rotation, pivotX, pivotY);
      if (scissor.w <= 0 || scissor.h <= 0) continue;

      const fade = transitionFade(leaf, localTime);
      const nodeOpacity = sampleOpacity(leaf.opacity, drawTime, drawDuration);

      // A self-drawing node rasterizes at its inner canvas — sampled
      // per-frame against the live parent dims so an animated contentWidth
      // reflows the texture. clip/static texture size is the probed media
      // (omit). Its content runs on its original span even when a window cut
      // into it (`extensionContentSpan`).
      let contentW: number | undefined;
      let contentH: number | undefined;
      let ownTime = contentTime;
      if (drawsItself) {
        const inner = innerCanvas(
          leafExt!,
          drawTime,
          drawDuration,
          viewport.contentW,
          viewport.contentH,
          getIntrinsicSize,
        );
        contentW = inner.w;
        contentH = inner.h;
        ownTime = extensionContentSpan(leafExt!).offset + drawTime;
      }

      const mask = roundRectMask(
        cornerRadiusPx(leaf.cornerRadius, drawTime, drawDuration, spatial, scale),
      );

      commands.push({
        type: "draw",
        clip: drawsItself ? leafExt! : leaf,
        fields: sampleFields(env, leaf.ext, drawTime, drawDuration),
        scissorX: scissor.x,
        scissorY: scissor.y,
        scissorW: scissor.w,
        scissorH: scissor.h,
        quadX: quad.x,
        quadY: quad.y,
        quadW: quad.w,
        quadH: quad.h,
        rotation,
        pivotX,
        pivotY,
        opacity: opacity * fade * nodeOpacity,
        drawTime: ownTime,
        contentW,
        contentH,
        sourceRect: spatial.sourceRect,
        ...(mask ? { mask } : {}),
      });
      continue;
    }

    if (child.type === "rect" || child.type === "circle") {
      const spatial = dynamicSpatial(child, viewport, localTime, getIntrinsicSize, anchor);
      const quad = absoluteRect(viewport, spatial);
      const { rotation, pivotX, pivotY } = rotationFor(viewport, spatial, quad);
      const scissor = scissorFor(clipRect, quad, rotation, pivotX, pivotY);
      if (scissor.w <= 0 || scissor.h <= 0) continue;

      const fade = transitionFade(child, localTime);
      const nodeOpacity = sampleOpacity(child.opacity, drawTime, drawDuration);
      const alpha = opacity * fade * nodeOpacity;

      const kind: ShapeGeometry["kind"] = child.type === "circle" ? "ellipse" : "roundrect";
      const radius =
        kind === "roundrect"
          ? cornerRadiusPx(child.cornerRadius, drawTime, drawDuration, spatial, scale)
          : 0;
      const strokeW =
        child.strokeWidth != null
          ? Math.max(0, sampleNumber(child.strokeWidth, drawTime, drawDuration)) * scale
          : 0;
      const strokeColor =
        strokeW > 0 && child.stroke != null
          ? sampleColor(child.stroke, drawTime, drawDuration)
          : null;
      const hasStroke = strokeColor != null && !isNoColor(strokeColor);
      const fillColor =
        child.fill != null ? sampleColor(child.fill, drawTime, drawDuration) : "black";
      const keys = keysFor(child);
      const base = {
        type: "fill" as const,
        destX: quad.x,
        destY: quad.y,
        destW: quad.w,
        destH: quad.h,
        scissorX: scissor.x,
        scissorY: scissor.y,
        scissorW: scissor.w,
        scissorH: scissor.h,
        opacity: alpha,
        rotation,
        pivotX,
        pivotY,
        fields: sampleFields(env, child.ext, drawTime, drawDuration),
      };
      if (!isNoColor(fillColor)) {
        commands.push({
          ...base,
          key: keys.fill,
          color: fillColor,
          // The fill shrinks by the stroke so the stroke sits inside the box.
          shape: { kind, radius, outerInset: hasStroke ? strokeW : 0, innerInset: -1 },
        });
      }
      if (hasStroke) {
        commands.push({
          ...base,
          key: keys.stroke,
          color: strokeColor,
          shape: { kind, radius, outerInset: 0, innerInset: strokeW },
        });
      }
      continue;
    }

    // ── containers: composition / extension node ──
    // An extension node always takes this path: it is a container when its
    // type has `children`, and simply has none otherwise.
    const extNode = asExtensionNode(child);
    const def = extNode ? env.seam.nodeTypes.get(extNode.type) : undefined;
    // A type this instance has no definition for (resolved elsewhere): skip.
    if (extNode && !def) continue;
    const isExt = extNode != null;
    // Composition-only fields below are read through `comp`, guarded by
    // `!isExt` (the union may also hold extension node types here).
    const comp = child as ResolvedComposition;

    // `childLocalTime` is the comp's *inner-window* time (children were
    // rebased into inner coords spanning [0, windowOut−windowIn]). Clamp it
    // to the inner span, NOT the comp's output `duration`: for a sped/
    // duration-compressed comp the span is `duration * speed`
    // (windowDur = span / speed), which also holds with overflow/underflow
    // stretch folded into `speed`. Clamping to `duration` alone pinned inner
    // time at the output length, freezing the first child and starving every
    // later child. An extension container's children live in node-local time at speed 1. A
    // looping comp's `contentTime` already wraps into one cycle.
    const childLocalTime = isExt
      ? drawTime
      : Math.min(contentTime * comp.speed, comp.duration * comp.speed);

    const spatial = dynamicSpatial(comp, viewport, localTime, getIntrinsicSize, anchor);
    const container = absoluteRect(viewport, spatial);
    const { rotation, pivotX, pivotY } = rotationFor(viewport, spatial, container);

    // Inner content dim — sample the (animatable) inner canvas against the
    // live parent dims at the node's OUTPUT-local time (like opacity below,
    // not the sped inner time `childLocalTime`). This sizes the FBO and the
    // child viewport, so children re-layout against the live inner canvas.
    // Default ("100%") tracks the parent; falls back to the display rect only
    // when there are no parent dims to resolve against.
    const innerContentW = sampleContentDim(
      child.contentWidth,
      drawTime,
      drawDuration,
      viewport.contentW,
    );
    const innerContentH = sampleContentDim(
      child.contentHeight,
      drawTime,
      drawDuration,
      viewport.contentH,
    );

    // Corner-pin distortion (compositions only): sample the authored corners
    // (percent against the inner canvas) in output time, then place the
    // *visible window's* corners through that homography into target pixels.
    // Identity corners (the default) carry nothing, so an un-distorted comp
    // stays on the plain path.
    let corners: Quad | undefined;
    if (!isExt && comp.distort != null && innerContentW > 0 && innerContentH > 0) {
      const c = sampleDistort(comp.distort, drawTime, drawDuration, innerContentW, innerContentH);
      if (!isIdentityDistort(c, innerContentW, innerContentH)) {
        corners = distortedCorners(c, innerContentW, innerContentH, container, spatial.sourceRect);
      }
    }

    // Scissor: the (rotated) layout box, or — when distorted — the AABB of
    // the pinned corners, so content pulled outside the box isn't clipped
    // to it. Still bounded by the parent's clip.
    const childClip = corners
      ? intersect(clipRect, rotatedAABB(corners, pivotX, pivotY, rotation))
      : scissorFor(clipRect, container, rotation, pivotX, pivotY);
    if (childClip.w <= 0 || childClip.h <= 0) continue;

    const fade = transitionFade(child, localTime);
    // Opacity describes the container box in its *parent*, like the other
    // spatial fields (`dynamicSpatial` above samples them in output time),
    // so it resolves against the output span / output-relative time — NOT
    // the sped inner timeline `childLocalTime` used to recurse the comp's
    // own children. This keeps a keyframe at "1s" landing at 1s of the
    // block regardless of the comp's speed, matching the CLI overlay
    // sampler and keeping preview↔render in lockstep.
    const nodeOpacity = sampleOpacity(child.opacity, drawTime, drawDuration);
    const mask = roundRectMask(
      cornerRadiusPx(child.cornerRadius, drawTime, drawDuration, spatial, scale),
    );

    // An extension container that anchors its children (a map and its
    // pins): build this frame's anchor function from the node's state at
    // `drawTime` — the same node-local time its own draw carries, so the host
    // rasterizes it for exactly the state the children are placed against.
    // The node's CONTENT runs on its original span even when a composition
    // window cut into it (`extensionContentSpan`), so a cropped map shows the
    // camera it would have had at that moment. Its children are already
    // cropped + rebased to the visible part, so they keep using `drawTime`.
    const content = extNode ? extensionContentSpan(extNode) : null;
    const ownTime = content ? content.offset + drawTime : drawTime;
    const innerAnchors: ChildAnchor | null =
      extNode && def?.createAnchors
        ? def.createAnchors(extNode as unknown as ExtensionNodeView, ownTime, content!.duration, {
            width: innerContentW,
            height: innerContentH,
          })
        : null;
    const innerChildren: ResolvedChild[] = isExt ? (extNode!.children ?? []) : comp.children;
    // The node's own draw, beneath its children.
    const ownDraw = isExt && def?.draws === true;

    // An authored colour-stage field (a colour adjustment, …) applies to the
    // composited group as a unit.
    const hasFields = hasStageFields(env, child.ext);
    // A rotated container can't be flattened into the parent pass (its
    // children would need the rotation composed per-quad about the pivot).
    // Render it to an FBO and rotate the composited quad — same path extension fields
    // take. `spatial.rotation != null` covers static and animated rotation
    // alike (resolver only sets it when authored).
    const hasRotation = spatial.rotation != null;
    // A crossfading or partially-opaque container must also go through the
    // FBO so the fade/opacity applies to the composited group as a unit (not
    // per child). Only while actually <1; at full opacity it flattens like
    // before, and the boundary is seamless (=== 1 either way). An `inset`
    // composition likewise needs the FBO so we can sample its cropped
    // sub-rect (`sourceRect`) out of the composited content box. A
    // `distort`ed composition is a projective warp of the composited group,
    // and a `cornerRadius` mask clips the composited group, so both need the
    // FBO too.
    const needsLayer =
      hasFields ||
      hasRotation ||
      fade < 1 ||
      nodeOpacity < 1 ||
      spatial.sourceRect != null ||
      corners != null ||
      mask != null;

    if (needsLayer) {
      const fboW = Math.round(innerContentW);
      const fboH = Math.round(innerContentH);

      const fboViewport: Viewport = {
        x: 0,
        y: 0,
        w: fboW,
        h: fboH,
        contentW: fboW,
        contentH: fboH,
      };
      const fboClip: ClipRect = { x: 0, y: 0, w: fboW, h: fboH };

      const groupChildren: RenderCommand[] = [];
      if (ownDraw) {
        groupChildren.push(
          nodeDraw(extNode!, fboViewport, fboClip, 1, ownTime, fboW, fboH, NO_FIELDS),
        );
      } else if (!isExt && comp.backgroundColor != null) {
        groupChildren.push(plainFill(comp, comp.backgroundColor, fboClip, fboClip, 1));
      }
      walkChildren(
        env,
        innerChildren,
        childLocalTime,
        fboViewport,
        fboClip,
        1,
        getIntrinsicSize,
        groupChildren,
        innerAnchors,
      );
      // Overlays this composition is a surface for (its own captions), on top
      // of its children, inside its group.
      if (!isExt && env.seam.overlays.length > 0) {
        pushOverlays(
          env,
          surfaceOf(comp.children, comp.ext, false),
          childLocalTime,
          fboViewport,
          fboClip,
          1,
          groupChildren,
        );
      }

      commands.push({
        type: "group",
        destX: container.x,
        destY: container.y,
        destW: container.w,
        destH: container.h,
        scissorX: childClip.x,
        scissorY: childClip.y,
        scissorW: childClip.w,
        scissorH: childClip.h,
        fboW,
        fboH,
        fields: sampleFields(env, child.ext, drawTime, drawDuration),
        opacity: opacity * fade * nodeOpacity,
        rotation,
        pivotX,
        pivotY,
        children: groupChildren,
        sourceRect: spatial.sourceRect,
        ...(corners ? { corners } : {}),
        ...(mask ? { mask } : {}),
      });
    } else {
      const childViewport: Viewport = {
        x: container.x,
        y: container.y,
        w: container.w,
        h: container.h,
        contentW: innerContentW,
        contentH: innerContentH,
      };

      if (ownDraw) {
        commands.push(
          nodeDraw(
            extNode!,
            childViewport,
            childClip,
            opacity,
            ownTime,
            innerContentW,
            innerContentH,
            NO_FIELDS,
          ),
        );
      } else if (!isExt && comp.backgroundColor != null) {
        commands.push(plainFill(comp, comp.backgroundColor, container, childClip, opacity));
      }

      walkChildren(
        env,
        innerChildren,
        childLocalTime,
        childViewport,
        childClip,
        opacity,
        getIntrinsicSize,
        commands,
        innerAnchors,
      );
      if (!isExt && env.seam.overlays.length > 0) {
        pushOverlays(
          env,
          surfaceOf(comp.children, comp.ext, false),
          childLocalTime,
          childViewport,
          childClip,
          opacity,
          commands,
        );
      }
    }
  }
}

/** An extension node's own draw (a map's basemap): fills its container
 *  viewport; the host gets the pixels from the type's rasterizer, at
 *  `contentW`×`contentH` for node-local `drawTime`. */
function nodeDraw(
  node: ResolvedExtensionNode,
  viewport: Viewport,
  scissor: ClipRect,
  opacity: number,
  drawTime: number,
  contentW: number,
  contentH: number,
  fields: FieldValues,
): DrawCommand {
  return {
    type: "draw",
    clip: node,
    fields,
    scissorX: scissor.x,
    scissorY: scissor.y,
    scissorW: scissor.w,
    scissorH: scissor.h,
    quadX: viewport.x,
    quadY: viewport.y,
    quadW: viewport.w,
    quadH: viewport.h,
    rotation: 0,
    pivotX: 0,
    pivotY: 0,
    opacity,
    drawTime,
    contentW,
    contentH,
  };
}

// ── Helpers ──

function absoluteRect(
  parent: Viewport,
  spatial: SpatialRect,
): ClipRect {
  const sx = parent.w / parent.contentW;
  const sy = parent.h / parent.contentH;
  return {
    x: parent.x + spatial.x * sx,
    y: parent.y + spatial.y * sy,
    w: spatial.width * sx,
    h: spatial.height * sy,
  };
}

/** Resolve a spatial rect's rotation into a target-pixel pivot + radians.
 *  The pivot is the node's `origin` point (defaulting to the rect center),
 *  carried through `absoluteRect`'s parent→target scaling. */
function rotationFor(
  parent: Viewport,
  spatial: SpatialRect,
  quad: ClipRect,
): { rotation: number; pivotX: number; pivotY: number } {
  const deg = spatial.rotation ?? 0;
  const sx = parent.contentW > 0 ? parent.w / parent.contentW : 1;
  const sy = parent.contentH > 0 ? parent.h / parent.contentH : 1;
  const ox = spatial.originX ?? spatial.width / 2;
  const oy = spatial.originY ?? spatial.height / 2;
  return {
    rotation: (deg * Math.PI) / 180,
    pivotX: quad.x + ox * sx,
    pivotY: quad.y + oy * sy,
  };
}

/** Place a `distort`ed composition's visible corners in target pixels.
 *
 *  `c` are the sampled pin points in inner-canvas px (`innerW`×`innerH`). The
 *  homography that sends the canvas's own corners to `c` is the warp; the
 *  drawn quad is the image of the *visible window* (`sourceRect`, or the
 *  whole canvas) under it, then carried through the same window→`container`
 *  scaling an undistorted draw uses (the FBO's `sourceRect` fills
 *  `container`). With no inset this is just `c` scaled onto `container`. */
function distortedCorners(
  c: DistortCorners,
  innerW: number,
  innerH: number,
  container: ClipRect,
  sourceRect: SpatialRect["sourceRect"],
): Quad {
  const m = squareToQuad([
    { x: c.x0 / innerW, y: c.y0 / innerH },
    { x: c.x1 / innerW, y: c.y1 / innerH },
    { x: c.x2 / innerW, y: c.y2 / innerH },
    { x: c.x3 / innerW, y: c.y3 / innerH },
  ]);
  const u0 = sourceRect?.u0 ?? 0;
  const v0 = sourceRect?.v0 ?? 0;
  const u1 = sourceRect?.u1 ?? 1;
  const v1 = sourceRect?.v1 ?? 1;
  const spanU = u1 - u0 > 0 ? u1 - u0 : 1;
  const spanV = v1 - v0 > 0 ? v1 - v0 : 1;
  const place = (u: number, v: number) => {
    const q = applyHomography(m, u, v);
    return {
      x: container.x + ((q.x - u0) / spanU) * container.w,
      y: container.y + ((q.y - v0) / spanV) * container.h,
    };
  };
  return [place(u0, v0), place(u1, v0), place(u1, v1), place(u0, v1)];
}

/** Axis-aligned bounding box of a quad (rect or explicit corners) after
 *  rotating about a pivot. Used to widen the (axis-aligned) scissor so a
 *  rotated / distorted draw isn't clipped to its un-rotated layout bounds. */
function rotatedAABB(
  quad: ClipRect | Quad,
  pivotX: number,
  pivotY: number,
  rotation: number,
): ClipRect {
  const c = Math.cos(rotation);
  const s = Math.sin(rotation);
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const corners: [number, number][] = Array.isArray(quad)
    ? quad.map((p) => [p.x, p.y] as [number, number])
    : [
        [quad.x, quad.y],
        [quad.x + quad.w, quad.y],
        [quad.x, quad.y + quad.h],
        [quad.x + quad.w, quad.y + quad.h],
      ];
  for (const [cx, cy] of corners) {
    const dx = cx - pivotX;
    const dy = cy - pivotY;
    const rx = pivotX + dx * c - dy * s;
    const ry = pivotY + dx * s + dy * c;
    minX = Math.min(minX, rx);
    minY = Math.min(minY, ry);
    maxX = Math.max(maxX, rx);
    maxY = Math.max(maxY, ry);
  }
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

/** Crossfade fade-in factor (0..1) for an incoming child over its first
 *  `transition` seconds. Returns 1 when there's no transition. The outgoing
 *  sibling needs no fade — it's occluded as this one fades up (the renderer
 *  composites over). */
function transitionFade(
  child: { transition?: number; timelineStart: number },
  localTime: number,
): number {
  const d = child.transition;
  if (d == null || d <= 0) return 1;
  const elapsed = localTime - child.timelineStart;
  if (elapsed <= 0) return 0;
  if (elapsed >= d) return 1;
  return elapsed / d;
}

/** Scissor for a (possibly rotated) quad, clipped to the parent region. */
function scissorFor(
  clipRect: ClipRect,
  quad: ClipRect,
  rotation: number,
  pivotX: number,
  pivotY: number,
): ClipRect {
  if (rotation === 0) return intersect(clipRect, quad);
  return intersect(clipRect, rotatedAABB(quad, pivotX, pivotY, rotation));
}

function intersect(a: ClipRect, b: ClipRect): ClipRect {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  const right = Math.min(a.x + a.w, b.x + b.w);
  const bottom = Math.min(a.y + a.h, b.y + b.h);
  return { x, y, w: Math.max(0, right - x), h: Math.max(0, bottom - y) };
}

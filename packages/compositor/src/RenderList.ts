/**
 * Walks the resolved timeline tree at a given time and produces a command
 * list for the GPU renderer. Clips become DrawCommands with absolute pixel
 * positions. Compositions with filters become GroupCommands whose children
 * are rendered to an intermediate texture (FBO) so the group's filters can
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
  ResolvedText,
  ResolvedRect,
  ResolvedCircle,
  ResolvedMap,
  ResolvedComposition,
  SpatialRect,
  ObjectFit,
  Filter,
  Length,
  Pin,
} from "@seam/core";
import {
  resolveBoxProps,
  computeNaturalSize,
  sampleContentDim,
  sampleNumber,
  sampleColor,
  sampleLength,
  sampleMapState,
  samplePin,
  sampleDistort,
  isIdentityDistort,
  loopLocalTime,
  squareToQuad,
  applyHomography,
  type Keyframed,
  type MapState,
  type Quad,
  type DistortCorners,
} from "@seam/core";
import { lngLatToWorld, truncateToFraction } from "@seam/map";

/** Sample a node's first-class opacity (Keyframed, ejected from filters);
 *  absent means fully opaque. */
function sampleOpacity(
  opacity: Keyframed<number> | undefined,
  t: number,
  duration: number,
): number {
  return opacity == null ? 1 : sampleNumber(opacity, t, duration);
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

export interface DrawCommand {
  type: "draw";
  clip: ResolvedClip | ResolvedText | ResolvedStatic | ResolvedMap;
  /** Filters applied to this draw. Normally the node's own; a map's basemap
   *  draw carries none when the map is layered (the group applies them). */
  filters: Filter[];
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
   *  clip `sourceIn + drawTime·speed`, text/map local time `drawTime`. */
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
  /** Colour filters on the shape node (identity for background fills). */
  filters?: Filter[];
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
  filters: Filter[];
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

type SizeGetter = (
  clip: ResolvedClip | ResolvedStatic,
) => { w: number; h: number } | null;

/** A map's camera + paths at the current map-local time, used to project the
 *  `pin` of each attachment into the map's content space. */
interface MapContext {
  latitude: number;
  longitude: number;
  zoom: number;
  width: number;
  height: number;
  paths: MapState["paths"];
}

type SpatialNode =
  | ResolvedClip
  | ResolvedStatic
  | ResolvedText
  | ResolvedRect
  | ResolvedCircle
  | ResolvedMap
  | ResolvedComposition;

export function buildRenderList(
  timeline: ResolvedTimeline,
  currentTime: number,
  canvasW: number,
  canvasH: number,
  getIntrinsicSize: SizeGetter,
): RenderCommand[] {
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
    timeline.children,
    currentTime,
    rootViewport,
    rootClip,
    1,
    getIntrinsicSize,
    commands,
    null,
  );

  return commands;
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
    child.type === "text" ||
    child.type === "map"
  ) {
    // Sample the (animatable) inner canvas against the LIVE parent dims, then
    // post-objectFit it — mirrors the resolver's t=0 bake but per-frame, so an
    // animated contentWidth (or an animated parent canvas) reflows the natural
    // rect here instead of using a stale baked value.
    const iw = sampleContentDim(child.contentWidth, t, duration, parentW);
    const ih = sampleContentDim(child.contentHeight, t, duration, parentH);
    const n = computeNaturalSize(child.objectFit ?? "fit", iw, ih, parentW, parentH);
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

/** Project a pinned child's anchor into the map's content space (px). Null
 *  when the pin can't be resolved (unknown path) — the child then lays out
 *  as if unpinned. */
function projectPin(
  pin: Keyframed<Pin>,
  t: number,
  duration: number,
  ctx: MapContext,
): { x: number; y: number } | null {
  const p = samplePin(pin, t, duration);
  if ("latitude" in p) {
    const [x, y] = projectLngLat(ctx, p.longitude, p.latitude);
    return { x, y };
  }
  const paths = ctx.paths ?? [];
  const path =
    typeof p.path === "number"
      ? paths[p.path]
      : paths.find((pp) => pp.id === p.path);
  if (!path || path.points.length < 2) return null;
  const position = p.position ?? path.progress;
  const screen = path.points.map(([lng, lat]) => projectLngLat(ctx, lng, lat));
  const frac = Math.max(0, Math.min(1, position));
  const pt = frac >= 1 ? screen[screen.length - 1] : truncateToFraction(screen, frac).at(-1);
  return pt ? { x: pt[0], y: pt[1] } : null;
}

/** lon/lat → map content px (top-left origin) for the camera in `ctx`.
 *  Same math as @seam/map's MapView.project, so overlays land exactly where
 *  the basemap rasterizer puts the geometry. */
function projectLngLat(ctx: MapContext, lng: number, lat: number): [number, number] {
  const [x, y] = lngLatToWorld(lng, lat, ctx.zoom);
  const [cx, cy] = lngLatToWorld(ctx.longitude, ctx.latitude, ctx.zoom);
  return [x - (cx - ctx.width / 2), y - (cy - ctx.height / 2)];
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
  children: ResolvedChild[],
  localTime: number,
  viewport: Viewport,
  clipRect: ClipRect,
  opacity: number,
  getIntrinsicSize: SizeGetter,
  commands: RenderCommand[],
  mapCtx: MapContext | null,
): void {
  for (const child of children) {
    if (child.type === "audio" || child.type === "data") continue;

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

    // A pinned attachment of a map: its origin lands on the projected pin.
    const anchor =
      mapCtx && child.pin != null
        ? projectPin(child.pin, drawTime, drawDuration, mapCtx)
        : null;

    // Content→target scale (for px-valued strokes / radii on this level).
    const scale = Math.min(
      viewport.contentW > 0 ? viewport.w / viewport.contentW : 1,
      viewport.contentH > 0 ? viewport.h / viewport.contentH : 1,
    );

    if (
      child.type === "clip" ||
      child.type === "static" ||
      child.type === "text"
    ) {
      const spatial = dynamicSpatial(child, viewport, localTime, getIntrinsicSize, anchor);
      const quad = absoluteRect(viewport, spatial);
      const { rotation, pivotX, pivotY } = rotationFor(viewport, spatial, quad);
      const scissor = scissorFor(clipRect, quad, rotation, pivotX, pivotY);
      if (scissor.w <= 0 || scissor.h <= 0) continue;

      const fade = transitionFade(child, localTime);
      const nodeOpacity = sampleOpacity(child.opacity, drawTime, drawDuration);

      // text rasterizes at its inner canvas — sampled per-frame against the
      // live parent dims so an animated contentWidth reflows the texture.
      // clip/static texture size is the probed media (omit).
      let contentW: number | undefined;
      let contentH: number | undefined;
      if (child.type === "text") {
        contentW = sampleContentDim(child.contentWidth, drawTime, drawDuration, viewport.contentW);
        contentH = sampleContentDim(child.contentHeight, drawTime, drawDuration, viewport.contentH);
      }

      const mask = roundRectMask(
        cornerRadiusPx(child.cornerRadius, drawTime, drawDuration, spatial, scale),
      );

      commands.push({
        type: "draw",
        clip: child,
        filters: child.filters ?? [],
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
        drawTime: contentTime,
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
        filters: child.filters ?? [],
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

    // ── containers: composition / map ──
    const isMap = child.type === "map";

    // `childLocalTime` is the comp's *inner-window* time (children were
    // rebased into inner coords spanning [0, windowOut−windowIn]). Clamp it
    // to the inner span, NOT the comp's output `duration`: for a sped/
    // duration-compressed comp the span is `duration * speed`
    // (windowDur = span / speed), which also holds with overflow/underflow
    // stretch folded into `speed`. Clamping to `duration` alone pinned inner
    // time at the output length, freezing the first child and starving every
    // later child. A map's children live in map-local time at speed 1. A
    // looping comp's `contentTime` already wraps into one cycle.
    const childLocalTime = isMap
      ? drawTime
      : Math.min(contentTime * child.speed, child.duration * child.speed);

    const spatial = dynamicSpatial(child, viewport, localTime, getIntrinsicSize, anchor);
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
    if (!isMap && child.distort != null && innerContentW > 0 && innerContentH > 0) {
      const c = sampleDistort(child.distort, drawTime, drawDuration, innerContentW, innerContentH);
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

    // The map's camera at this instant, for its pinned children. The
    // basemap draw's `drawTime` is the same map-local time, so the host
    // rasterizes the tiles for exactly this camera.
    let innerMapCtx: MapContext | null = null;
    if (isMap) {
      const st = sampleMapState(child, drawTime, drawDuration);
      innerMapCtx = {
        latitude: st.latitude,
        longitude: st.longitude,
        zoom: st.zoom,
        width: innerContentW,
        height: innerContentH,
        paths: st.paths,
      };
    }

    const hasFilters = child.filters && child.filters.length > 0;
    // A rotated container can't be flattened into the parent pass (its
    // children would need the rotation composed per-quad about the pivot).
    // Render it to an FBO and rotate the composited quad — same path filters
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
      hasFilters ||
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
      if (isMap) {
        groupChildren.push(
          basemapDraw(child, fboViewport, fboClip, 1, drawTime, fboW, fboH, []),
        );
      } else if (child.backgroundColor != null) {
        groupChildren.push(plainFill(child, child.backgroundColor, fboClip, fboClip, 1));
      }
      walkChildren(
        child.children,
        childLocalTime,
        fboViewport,
        fboClip,
        1,
        getIntrinsicSize,
        groupChildren,
        innerMapCtx,
      );

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
        filters: child.filters ?? [],
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

      if (isMap) {
        commands.push(
          basemapDraw(
            child,
            childViewport,
            childClip,
            opacity,
            drawTime,
            innerContentW,
            innerContentH,
            [],
          ),
        );
      } else if (child.backgroundColor != null) {
        commands.push(plainFill(child, child.backgroundColor, container, childClip, opacity));
      }

      walkChildren(
        child.children,
        childLocalTime,
        childViewport,
        childClip,
        opacity,
        getIntrinsicSize,
        commands,
        innerMapCtx,
      );
    }
  }
}

/** The basemap draw of a map node: fills its container viewport; the host
 *  rasterizes the tiles at `contentW`×`contentH` for the camera at `drawTime`. */
function basemapDraw(
  map: ResolvedMap,
  viewport: Viewport,
  scissor: ClipRect,
  opacity: number,
  drawTime: number,
  contentW: number,
  contentH: number,
  filters: Filter[],
): DrawCommand {
  return {
    type: "draw",
    clip: map,
    filters,
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

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
 */

import type {
  ResolvedTimeline,
  ResolvedChild,
  ResolvedClip,
  ResolvedGraphic,
  ResolvedStatic,
  ResolvedText,
  ResolvedComposition,
  SpatialRect,
  ObjectFit,
  Filter,
} from "@seam/core";
import {
  resolveBoxProps,
  computeNaturalSize,
  sampleContentDim,
  sampleNumber,
  type Keyframed,
} from "@seam/core";

/** Sample a node's first-class opacity (Keyframed, ejected from filters);
 *  absent means fully opaque. */
function sampleOpacity(
  opacity: Keyframed<number> | undefined,
  t: number,
  duration: number,
): number {
  return opacity == null ? 1 : sampleNumber(opacity, t, duration);
}

export interface DrawCommand {
  type: "draw";
  clip: ResolvedClip | ResolvedText | ResolvedStatic | ResolvedGraphic;
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
   *  clip `sourceIn + drawTime·speed`, graphic/text local time `drawTime`. */
  drawTime: number;
  /** Inner-canvas (contentWidth/Height) in pixels for text/graphic nodes,
   *  sampled per-frame against the live parent dims. The host rasterizer
   *  renders the texture at this size (text reflows, graphic canvas reveals).
   *  Absent for clip/static (their texture size is the probed media). */
  contentW?: number;
  contentH?: number;
  /** Visible source sub-rect (UV fractions) when the node is `inset`; absent
   *  = full texture. The blit samples this window into the quad. */
  sourceRect?: { u0: number; v0: number; u1: number; v1: number };
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
    commands.push({
      type: "fill",
      key: timeline,
      color: timeline.backgroundColor,
      destX: rootViewport.x,
      destY: rootViewport.y,
      destW: rootViewport.w,
      destH: rootViewport.h,
      scissorX: rootClip.x,
      scissorY: rootClip.y,
      scissorW: rootClip.w,
      scissorH: rootClip.h,
      opacity: 1,
    });
  }

  walkChildren(
    timeline.children,
    currentTime,
    rootViewport,
    rootClip,
    1,
    getIntrinsicSize,
    commands,
  );

  return commands;
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
 *  content-coordinate space. Returns `null` when there's no displayable
 *  rect (rare — only happens if natural dims are zero). */
function dynamicSpatial(
  child:
    | ResolvedClip
    | ResolvedStatic
    | ResolvedText
    | ResolvedGraphic
    | ResolvedComposition,
  viewport: Viewport,
  localTime: number,
  getIntrinsicSize: SizeGetter,
): SpatialRect {
  const parentW = viewport.contentW;
  const parentH = viewport.contentH;
  const t = localTime - child.timelineStart;
  const duration = child.timelineEnd - child.timelineStart;

  // Determine the post-objectFit natural rect (size "100%" reference).
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
    child.type === "graphic"
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

  if (child.spatialInput) {
    return resolveBoxProps(
      child.spatialInput,
      parentW,
      parentH,
      naturalW,
      naturalH,
      t,
      duration,
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

function walkChildren(
  children: ResolvedChild[],
  localTime: number,
  viewport: Viewport,
  clipRect: ClipRect,
  opacity: number,
  getIntrinsicSize: SizeGetter,
  commands: RenderCommand[],
): void {
  for (const child of children) {
    if (
      child.type === "empty" ||
      child.type === "audio" ||
      child.type === "data"
    )
      continue;

    const isActive =
      localTime >= child.timelineStart && localTime < child.timelineEnd;
    if (!isActive) continue;

    if (
      child.type === "clip" ||
      child.type === "static" ||
      child.type === "text" ||
      child.type === "graphic"
    ) {
      const spatial = dynamicSpatial(child, viewport, localTime, getIntrinsicSize);
      const quad = absoluteRect(viewport, spatial);
      const { rotation, pivotX, pivotY } = rotationFor(viewport, spatial, quad);
      const scissor = scissorFor(clipRect, quad, rotation, pivotX, pivotY);
      if (scissor.w <= 0 || scissor.h <= 0) continue;

      const fade = transitionFade(child, localTime);
      const drawDuration = child.timelineEnd - child.timelineStart;
      const drawTime = localTime - child.timelineStart;
      const nodeOpacity = sampleOpacity(child.opacity, drawTime, drawDuration);

      // text/graphic rasterize at their inner canvas — sampled per-frame
      // against the live parent dims so an animated contentWidth reflows the
      // texture. clip/static texture size is the probed media (omit).
      let contentW: number | undefined;
      let contentH: number | undefined;
      if (child.type === "text" || child.type === "graphic") {
        contentW = sampleContentDim(child.contentWidth, drawTime, drawDuration, viewport.contentW);
        contentH = sampleContentDim(child.contentHeight, drawTime, drawDuration, viewport.contentH);
      }

      commands.push({
        type: "draw",
        clip: child,
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
        drawTime,
        contentW,
        contentH,
        sourceRect: spatial.sourceRect,
      });
    } else {
      // composition
      // `childLocalTime` is the comp's *inner-window* time (children were
      // rebased into inner coords spanning [0, windowOut−windowIn]). Clamp it
      // to the inner span, NOT the comp's output `duration`: for a sped/
      // duration-compressed comp the span is `duration * speed`
      // (windowDur = span / speed), which also holds with overflow/underflow
      // stretch folded into `speed`. Clamping to `duration` alone pinned inner
      // time at the output length, freezing the first child and starving every
      // later child.
      const childLocalTime = Math.min(
        (localTime - child.timelineStart) * child.speed,
        child.duration * child.speed,
      );

      const spatial = dynamicSpatial(child, viewport, localTime, getIntrinsicSize);
      const container = absoluteRect(viewport, spatial);
      const { rotation, pivotX, pivotY } = rotationFor(viewport, spatial, container);
      const childClip = scissorFor(clipRect, container, rotation, pivotX, pivotY);
      if (childClip.w <= 0 || childClip.h <= 0) continue;

      const fade = transitionFade(child, localTime);
      // Opacity describes the composition box in its *parent*, like the other
      // spatial fields (`dynamicSpatial` above samples them in output time),
      // so it resolves against the output span / output-relative time — NOT
      // the sped inner timeline `childLocalTime` used to recurse the comp's
      // own children. This keeps a keyframe at "1s" landing at 1s of the
      // block regardless of the comp's speed, matching the CLI overlay
      // sampler (`mlt-builder`) and keeping preview↔render in lockstep.
      const nodeOpacity = sampleOpacity(
        child.opacity,
        localTime - child.timelineStart,
        child.timelineEnd - child.timelineStart,
      );

      const hasFilters = child.filters && child.filters.length > 0;
      // A rotated composition can't be flattened into the parent pass (its
      // children would need the rotation composed per-quad about the comp
      // pivot). Render it to an FBO and rotate the composited quad — same
      // path filters take. `spatial.rotation != null` covers static and
      // animated rotation alike (resolver only sets it when authored).
      const hasRotation = spatial.rotation != null;
      // A crossfading or partially-opaque composition must also go through
      // the FBO so the fade/opacity applies to the composited group as a unit
      // (not per child). Only while actually <1; at full opacity it flattens
      // like before, and the boundary is seamless (=== 1 either way). An
      // `inset` composition likewise needs the FBO so we can sample its
      // cropped sub-rect (`sourceRect`) out of the composited content box.
      const needsLayer =
        hasFilters ||
        hasRotation ||
        fade < 1 ||
        nodeOpacity < 1 ||
        spatial.sourceRect != null;

      // Inner content dim — sample the (animatable) inner canvas against the
      // live parent dims at the comp's OUTPUT-local time (like opacity above,
      // not the sped inner time `childLocalTime`). This sizes the FBO and the
      // child viewport, so children re-layout against the live inner canvas.
      // Default ("100%") tracks the parent; falls back to the display rect only
      // when there are no parent dims to resolve against.
      const compT = localTime - child.timelineStart;
      const compDur = child.timelineEnd - child.timelineStart;
      const innerContentW = sampleContentDim(
        child.contentWidth,
        compT,
        compDur,
        viewport.contentW,
      );
      const innerContentH = sampleContentDim(
        child.contentHeight,
        compT,
        compDur,
        viewport.contentH,
      );

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
        if (child.backgroundColor != null) {
          groupChildren.push({
            type: "fill",
            key: child,
            color: child.backgroundColor,
            destX: 0,
            destY: 0,
            destW: fboW,
            destH: fboH,
            scissorX: 0,
            scissorY: 0,
            scissorW: fboW,
            scissorH: fboH,
            opacity: 1,
          });
        }
        walkChildren(
          child.children,
          childLocalTime,
          fboViewport,
          fboClip,
          1,
          getIntrinsicSize,
          groupChildren,
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

        if (child.backgroundColor != null) {
          commands.push({
            type: "fill",
            key: child,
            color: child.backgroundColor,
            destX: container.x,
            destY: container.y,
            destW: container.w,
            destH: container.h,
            scissorX: childClip.x,
            scissorY: childClip.y,
            scissorW: childClip.w,
            scissorH: childClip.h,
            opacity,
          });
        }

        walkChildren(
          child.children,
          childLocalTime,
          childViewport,
          childClip,
          opacity,
          getIntrinsicSize,
          commands,
        );
      }
    }
  }
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

/** Axis-aligned bounding box of a quad after rotating about a pivot. Used
 *  to widen the (axis-aligned) scissor so a rotated draw isn't clipped to
 *  its un-rotated bounds. */
function rotatedAABB(
  quad: ClipRect,
  pivotX: number,
  pivotY: number,
  rotation: number,
): ClipRect {
  const c = Math.cos(rotation);
  const s = Math.sin(rotation);
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const corners = [
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

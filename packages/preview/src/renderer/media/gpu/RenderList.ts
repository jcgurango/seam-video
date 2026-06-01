/**
 * Walks the resolved timeline tree at a given time and produces a command
 * list for the GPU renderer. Clips become DrawCommands with absolute pixel
 * positions. Compositions with filters become GroupCommands whose children
 * are rendered to an intermediate texture (FBO) so the group's filters can
 * be applied to the composite.
 */

import type {
  ResolvedTimeline,
  ResolvedChild,
  ResolvedClip,
  ResolvedStatic,
  ResolvedText,
  ResolvedComposition,
  SpatialAnchor,
  SpatialRect,
  ObjectFit,
  Filter,
} from "@seam/core";
import { resolveBoxProps } from "@seam/core";

export interface DrawCommand {
  type: "draw";
  clip: ResolvedClip | ResolvedText | ResolvedStatic;
  scissorX: number;
  scissorY: number;
  scissorW: number;
  scissorH: number;
  quadX: number;
  quadY: number;
  quadW: number;
  quadH: number;
  opacity: number;
  /** Node-local time (seconds since this clip/text became active) and total
   *  duration. Used by the renderer to sample animated filter values. */
  nodeTime: number;
  nodeDuration: number;
}

/** Solid-color fill of an axis-aligned rect. Emitted under a
 *  composition's children when it has `backgroundColor` set. */
export interface FillCommand {
  type: "fill";
  /** Stable identity for the texture cache — typically the resolved
   *  composition (or the timeline root) the fill belongs to. Reused
   *  across frames so the renderer doesn't churn the 1x1 color tile. */
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
  /** Where to draw the FBO result on the parent target. */
  destX: number;
  destY: number;
  destW: number;
  destH: number;
  /** Scissor for the dest (from ancestor clipping). */
  scissorX: number;
  scissorY: number;
  scissorW: number;
  scissorH: number;
  /** FBO dimensions (content resolution). */
  fboW: number;
  fboH: number;
  /** Filters applied when compositing the FBO to the parent. */
  filters: Filter[];
  opacity: number;
  /** Commands to render into the FBO. */
  children: RenderCommand[];
  /** Node-local time + duration for sampling animated filter values. */
  nodeTime: number;
  nodeDuration: number;
}

export type RenderCommand = DrawCommand | GroupCommand | FillCommand;

/** Internal viewport tracking during tree walk. */
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
    contentW: timeline.contentWidth ?? canvasW,
    contentH: timeline.contentHeight ?? canvasH,
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

/** Re-evaluate a node's spatial rect at the current local time. For static
 *  nodes the resolver already baked `spatial`/`anchor`; this just reads them
 *  back. For animated nodes (`spatialInput` retained on the resolved node)
 *  we re-run the box solver against the current parent content dims so
 *  width/height/edges can interpolate frame-to-frame. */
function dynamicSpatial(
  child:
    | ResolvedClip
    | ResolvedStatic
    | ResolvedText
    | ResolvedComposition,
  viewport: Viewport,
  localTime: number,
): { spatial: SpatialRect | undefined; anchor: SpatialAnchor | undefined } {
  if (child.spatialInput) {
    const t = localTime - child.timelineStart;
    const duration = child.timelineEnd - child.timelineStart;
    return resolveBoxProps(
      child.spatialInput,
      viewport.contentW,
      viewport.contentH,
      t,
      duration,
    );
  }
  return { spatial: child.spatial, anchor: child.anchor };
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
    // Empty, audio, and data nodes have no visible quad — they affect
    // playback or carry metadata but never produce a draw command.
    if (
      child.type === "empty" ||
      child.type === "audio" ||
      child.type === "data"
    )
      continue;

    const isActive =
      localTime >= child.timelineStart && localTime < child.timelineEnd;
    if (!isActive) continue;

    if (child.type === "clip" || child.type === "static") {
      const { spatial, anchor } = dynamicSpatial(child, viewport, localTime);
      const container = absoluteRect(viewport, spatial);
      const scissor = intersect(clipRect, container);
      if (scissor.w <= 0 || scissor.h <= 0) continue;

      const intrinsic = getIntrinsicSize(child);
      const videoW = intrinsic?.w ?? container.w;
      const videoH = intrinsic?.h ?? container.h;
      const quad = objectFitQuad(
        container,
        videoW,
        videoH,
        child.objectFit,
        anchor,
      );

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
        opacity,
        nodeTime: localTime - child.timelineStart,
        nodeDuration: child.timelineEnd - child.timelineStart,
      });
    } else if (child.type === "text") {
      // Text mirrors clip placement: SpatialFields → spatial rect on
      // the parent, contentWidth/contentHeight → intrinsic dims fed to
      // objectFit for aspect handling.
      const { spatial, anchor } = dynamicSpatial(child, viewport, localTime);
      const container = absoluteRect(viewport, spatial);
      const scissor = intersect(clipRect, container);
      if (scissor.w <= 0 || scissor.h <= 0) continue;
      const quad = objectFitQuad(
        container,
        child.contentWidth,
        child.contentHeight,
        child.objectFit,
        anchor,
      );
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
        opacity,
        nodeTime: localTime - child.timelineStart,
        nodeDuration: child.timelineEnd - child.timelineStart,
      });
    } else {
      // composition
      const childLocalTime = Math.min(
        (localTime - child.timelineStart) * child.speed,
        child.duration,
      );

      const { spatial } = dynamicSpatial(child, viewport, localTime);
      const container = absoluteRect(viewport, spatial);
      const childClip = intersect(clipRect, container);
      if (childClip.w <= 0 || childClip.h <= 0) continue;

      const hasFilters = child.filters && child.filters.length > 0;

      if (hasFilters) {
        // Render children to FBO, apply filters when compositing
        const fboW = child.contentWidth ?? Math.round(container.w);
        const fboH = child.contentHeight ?? Math.round(container.h);

        // Children are positioned relative to FBO origin (0,0)
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
          // Fill the FBO before any children draw so the bg lands
          // under the kids inside the group.
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
          1, // opacity inside FBO is 1; group opacity applied when compositing
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
          filters: child.filters!,
          opacity,
          children: groupChildren,
          nodeTime: childLocalTime,
          nodeDuration: child.duration,
        });
      } else {
        // No filters — flatten children directly (no FBO overhead)
        const childViewport: Viewport = {
          x: container.x,
          y: container.y,
          w: container.w,
          h: container.h,
          contentW: child.contentWidth ?? container.w,
          contentH: child.contentHeight ?? container.h,
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
  spatial: { x: number; y: number; width: number; height: number } | undefined,
): ClipRect {
  if (!spatial) {
    return { x: parent.x, y: parent.y, w: parent.w, h: parent.h };
  }
  const sx = parent.w / parent.contentW;
  const sy = parent.h / parent.contentH;
  return {
    x: parent.x + spatial.x * sx,
    y: parent.y + spatial.y * sy,
    w: spatial.width * sx,
    h: spatial.height * sy,
  };
}

function intersect(a: ClipRect, b: ClipRect): ClipRect {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  const right = Math.min(a.x + a.w, b.x + b.w);
  const bottom = Math.min(a.y + a.h, b.y + b.h);
  return { x, y, w: Math.max(0, right - x), h: Math.max(0, bottom - y) };
}

function objectFitQuad(
  container: ClipRect,
  videoW: number,
  videoH: number,
  objectFit?: ObjectFit,
  anchor?: SpatialAnchor,
): ClipRect {
  if (!objectFit || objectFit === "fill") {
    return container;
  }

  let scaledW: number;
  let scaledH: number;

  if (objectFit === "center") {
    scaledW = videoW;
    scaledH = videoH;
  } else if (objectFit === "fit") {
    const scale = Math.min(container.w / videoW, container.h / videoH);
    scaledW = videoW * scale;
    scaledH = videoH * scale;
  } else {
    // cover
    const scale = Math.max(container.w / videoW, container.h / videoH);
    scaledW = videoW * scale;
    scaledH = videoH * scale;
  }

  let offsetX: number;
  if (anchor?.right != null && anchor?.left == null) {
    offsetX = container.w - scaledW;
  } else if (anchor?.left != null && anchor?.right == null) {
    offsetX = 0;
  } else {
    offsetX = (container.w - scaledW) / 2;
  }

  let offsetY: number;
  if (anchor?.bottom != null && anchor?.top == null) {
    offsetY = container.h - scaledH;
  } else if (anchor?.top != null && anchor?.bottom == null) {
    offsetY = 0;
  } else {
    offsetY = (container.h - scaledH) / 2;
  }

  return {
    x: container.x + offsetX,
    y: container.y + offsetY,
    w: scaledW,
    h: scaledH,
  };
}

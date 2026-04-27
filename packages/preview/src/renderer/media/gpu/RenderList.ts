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
  SpatialAnchor,
  ObjectFit,
  Filter,
} from "@seam/core";

export interface DrawCommand {
  type: "draw";
  clip: ResolvedClip;
  scissorX: number;
  scissorY: number;
  scissorW: number;
  scissorH: number;
  quadX: number;
  quadY: number;
  quadW: number;
  quadH: number;
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
}

export type RenderCommand = DrawCommand | GroupCommand;

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

type SizeGetter = (clip: ResolvedClip) => { w: number; h: number } | null;

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
    // Empty + audio nodes have no visible quad — they affect playback but
    // never produce a draw command.
    if (child.type === "empty" || child.type === "audio") continue;

    const isActive =
      localTime >= child.timelineStart && localTime < child.timelineEnd;
    if (!isActive) continue;

    if (child.type === "clip") {
      const container = absoluteRect(viewport, child.spatial);
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
        child.anchor,
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
      });
    } else {
      // composition
      const childLocalTime = Math.min(
        (localTime - child.timelineStart) * child.speed,
        child.duration,
      );

      const container = absoluteRect(viewport, child.spatial);
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

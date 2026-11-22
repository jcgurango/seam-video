import React, { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import type { Child, ResolvedTimeline, SeamFile } from "@seam/core";
import { rasterizerFor, useTimeline, useTimelineMedia } from "@seam/preview";
import type { GizmoSurface } from "@seam/preview";
import type { History } from "./useHistory.js";
import { getNodeAtPath, parsePath, updateNodeAtPath } from "./nodePath.js";
import {
  apply,
  invert,
  locateNode,
  mul,
  rotateVec,
  type LocatedNode,
  type Mat3,
  type NodeMeasurer,
  type Pt,
} from "./viewportLocate.js";
import {
  animatedTransformProps,
  applyTransformDrag,
  transformCapabilities,
  type HandlePos,
  type KeyframeTargets,
  type TransformDrag,
} from "./transformEdit.js";
import { activeKeyframeIndex, nodeClock } from "./playheadKeyframe.js";
import { useSeam } from "./seamContext.js";

interface TransformGizmoProps {
  surface: GizmoSurface;
  /** Root canvas size (px) — the space `surface` displays. */
  canvasWidth: number;
  canvasHeight: number;
  document: SeamFile;
  /** Path key of the one selected node. */
  selectedKey: string;
  /** The editor timeline (scripts off, root `uncropped`). */
  timeline: ResolvedTimeline;
  history: History<SeamFile>;
}

const ACCENT = "#4a9eff";
const DISTORT = "#ffb020";
const HANDLE = 9;
const ROTATE_ZONE = 20;
const DRAG_THRESHOLD_PX = 2;
/** Screen distance within which a dragged origin snaps to a box edge / centre line. */
const ORIGIN_SNAP_PX = 8;
const SNAP_FRACTIONS: HandlePos[] = [0, 0.5, 1];

const HANDLES: { hx: HandlePos; hy: HandlePos }[] = [
  { hx: 0, hy: 0 },
  { hx: 0.5, hy: 0 },
  { hx: 1, hy: 0 },
  { hx: 1, hy: 0.5 },
  { hx: 1, hy: 1 },
  { hx: 0.5, hy: 1 },
  { hx: 0, hy: 1 },
  { hx: 0, hy: 0.5 },
];
/** Box corners clockwise from top-left — the distort corner order. */
const CORNERS: { hx: HandlePos; hy: HandlePos }[] = [
  { hx: 0, hy: 0 },
  { hx: 1, hy: 0 },
  { hx: 1, hy: 1 },
  { hx: 0, hy: 1 },
];

const ROTATE_CURSOR = (() => {
  const svg =
    "<svg xmlns='http://www.w3.org/2000/svg' width='24' height='24' viewBox='0 0 24 24' fill='none' stroke-linecap='round' stroke-linejoin='round'>" +
    "<g stroke='black' stroke-width='4'><path d='M20 12a8 8 0 1 1-2.3-5.6'/><path d='M20 4v5h-5'/></g>" +
    "<g stroke='white' stroke-width='2'><path d='M20 12a8 8 0 1 1-2.3-5.6'/><path d='M20 4v5h-5'/></g>" +
    "</svg>";
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}") 12 12, crosshair`;
})();

/** Resize cursor for a handle whose outward direction on screen is `v`. */
function resizeCursor(v: Pt): string {
  const deg = ((Math.atan2(v.y, v.x) * 180) / Math.PI + 360) % 180;
  if (deg < 22.5 || deg >= 157.5) return "ew-resize";
  if (deg < 67.5) return "nwse-resize";
  if (deg < 112.5) return "ns-resize";
  return "nesw-resize";
}

/** Tracks Shift / Cmd-Ctrl while the gizmo is mounted. */
function useModifiers(onChange: (m: { shift: boolean; mod: boolean }) => void) {
  const [mods, setMods] = useState({ shift: false, mod: false });
  const cb = useRef(onChange);
  cb.current = onChange;
  useEffect(() => {
    const set = (next: { shift: boolean; mod: boolean }) =>
      setMods((cur) => (cur.shift === next.shift && cur.mod === next.mod ? cur : next));
    const read = (e: KeyboardEvent | PointerEvent) => ({
      shift: e.shiftKey,
      mod: e.metaKey || e.ctrlKey,
    });
    const onKey = (e: KeyboardEvent) => {
      const next = read(e);
      set(next);
      cb.current(next);
    };
    // Key events alone miss a modifier pressed while focus was elsewhere (or
    // swallowed by a focused editor), so the pointer keeps the state honest.
    const onPointer = (e: PointerEvent) => set(read(e));
    const clear = () => set({ shift: false, mod: false });
    // Capture phase: a handler that stops propagation can't hide the key.
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("keyup", onKey, true);
    window.addEventListener("pointermove", onPointer, true);
    window.addEventListener("blur", clear);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("keyup", onKey, true);
      window.removeEventListener("pointermove", onPointer, true);
      window.removeEventListener("blur", clear);
    };
  }, []);
  return mods;
}

type DragKind =
  | { kind: "move" }
  | { kind: "origin" }
  | { kind: "rotate" }
  | { kind: "scale"; hx: HandlePos; hy: HandlePos }
  | { kind: "distort"; corner: 0 | 1 | 2 | 3 };

/**
 * Bounding box + handles for the selected node, drawn over the preview.
 * Body = move · corner/midpoint handles = scale about the origin (Shift keeps
 * the aspect ratio) · just outside a handle = rotate (Shift snaps to 15°
 * steps) · centre target = origin (each axis snaps to the box's edge and centre
 * lines) · Cmd/Ctrl + corner (compositions) =
 * corner-pin distort. On a node with animated transform properties the gizmo
 * shows only while the playhead is ON a keyframe, and edits that keyframe.
 */
export default function TransformGizmo({
  surface,
  canvasWidth,
  canvasHeight,
  document,
  selectedKey,
  timeline,
  history,
}: TransformGizmoProps) {
  const seam = useSeam();
  const { currentTime } = useTimeline();
  const media = useTimelineMedia();

  // Media sizes land asynchronously; re-locate when one does.
  const [, bump] = useReducer((n: number) => n + 1, 0);
  useEffect(() => media.subscribeMediaSizes(bump), [media]);

  const compiled = useMemo(() => {
    try {
      return seam.compileSeamFile(document, { runScripts: false }).doc;
    } catch {
      return null;
    }
  }, [document]);

  const path = useMemo(() => parsePath(selectedKey), [selectedKey]);
  const node = getNodeAtPath(document, path) as Child | null | undefined;

  // Structural index path. Bin-rooted selections (`bin.<id>.…`) have no single
  // on-screen instance — not handled in this pass.
  const indices = useMemo(() => {
    const out: number[] = [];
    for (const seg of path) {
      if (seg.field !== "children") return null;
      out.push(seg.index);
    }
    return out;
  }, [path]);

  // Unwrapped text is as big as what it says: measured by the same
  // rasterizer the preview draws it with.
  const measureNode = useCallback<NodeMeasurer>(
    (authored, t, duration) =>
      rasterizerFor(seam.nodeTypes, authored.type)?.measure?.(
        { ...(authored as unknown as Record<string, unknown>), type: authored.type, timelineStart: 0, timelineEnd: duration },
        t,
      ) ?? null,
    [seam],
  );

  const located: LocatedNode | null =
    compiled && indices && node
      ? locateNode(seam, compiled, timeline, indices, currentTime, media.getMediaSize, measureNode)
      : null;

  // The active drag re-evaluates when a modifier flips without pointer motion.
  const dragRef = useRef<{ update: (shift: boolean) => void } | null>(null);
  const mods = useModifiers((m) => dragRef.current?.update(m.shift));

  if (!located || !node) return null;

  // Animated properties are edited one keyframe at a time: the gizmo only
  // appears while the playhead sits on a keyframe, and a drag rewrites that
  // keyframe (properties that aren't on one right now lose their handle).
  const animatedProps = animatedTransformProps(node);
  const targets: KeyframeTargets = {};
  if (animatedProps.length > 0) {
    const clock = nodeClock(seam, timeline, document, path, currentTime);
    const rec = node as unknown as Record<string, [number | string, unknown][]>;
    for (const key of animatedProps) {
      const index = activeKeyframeIndex(rec[key], clock);
      if (index != null) targets[key] = index;
    }
    if (Object.keys(targets).length === 0) return null;
  }
  const caps = transformCapabilities(node, targets);

  const sx = surface.rect.width / canvasWidth;
  const sy = surface.rect.height / canvasHeight;
  const toScreen = (m: Mat3, p: Pt): Pt => {
    const c = apply(m, p);
    return { x: c.x * sx, y: c.y * sy };
  };
  const { box, pivot, rotation } = located;
  /** A point at box fraction (hx, hy), in parent content px (rotated). */
  const boxPoint = (hx: number, hy: number): Pt => {
    const v = rotateVec(
      { x: box.x + hx * box.width - pivot.x, y: box.y + hy * box.height - pivot.y },
      rotation,
    );
    return { x: pivot.x + v.x, y: pivot.y + v.y };
  };
  const P = (hx: number, hy: number) => toScreen(located.parentToCanvas, boxPoint(hx, hy));

  const corners = CORNERS.map((c) => P(c.hx, c.hy));
  const center = P(0.5, 0.5);
  const pivotScreen = toScreen(located.parentToCanvas, pivot);
  const outline = corners.map((p) => `${p.x},${p.y}`).join(" ");

  // Distort: where each pinned corner of the inner canvas shows.
  const inner = located.inner;
  const innerToCanvas = inner ? mul(located.parentToCanvas, inner.toParent) : null;
  const pins =
    inner && innerToCanvas
      ? ([0, 1, 2, 3] as const).map((i) =>
          toScreen(innerToCanvas, {
            x: inner.corners[`x${i}`],
            y: inner.corners[`y${i}`],
          }),
        )
      : null;
  const pinHome =
    inner && innerToCanvas
      ? [
          toScreen(innerToCanvas, { x: 0, y: 0 }),
          toScreen(innerToCanvas, { x: inner.width, y: 0 }),
          toScreen(innerToCanvas, { x: inner.width, y: inner.height }),
          toScreen(innerToCanvas, { x: 0, y: inner.height }),
        ]
      : null;
  const distortMode = mods.mod && caps.distort && pins != null;
  const showDistort = pins != null && (distortMode || inner!.distorted);

  const begin = (e: React.PointerEvent, what: DragKind) => {
    if (e.button !== 0) return;
    // Keep the free-mode canvas from panning underneath.
    e.stopPropagation();
    e.preventDefault();
    const target = e.currentTarget as Element;
    const pointerId = e.pointerId;
    const startDoc = document;
    const geom = located;
    const toParent = invert(geom.parentToCanvas);
    const toInner = innerToCanvas ? invert(innerToCanvas) : null;
    if (!toParent) return;
    const canvasPoint = (clientX: number, clientY: number): Pt => {
      const n = surface.toNorm(clientX, clientY);
      return { x: n.x * canvasWidth, y: n.y * canvasHeight };
    };
    const c0 = canvasPoint(e.clientX, e.clientY);
    const q0 = apply(toParent, c0);
    const startClient = { x: e.clientX, y: e.clientY };
    let last = { x: e.clientX, y: e.clientY, shift: e.shiftKey };
    let dragging = false;
    // Rotation accumulates so it can pass ±180° without wrapping.
    let prevAngle = Math.atan2(q0.y - geom.pivot.y, q0.x - geom.pivot.x);
    let turned = 0;

    try {
      target.setPointerCapture(pointerId);
    } catch {
      /* element gone — the window listeners below still get the events */
    }

    const run = (clientX: number, clientY: number, shift: boolean) => {
      last = { x: clientX, y: clientY, shift };
      if (!dragging) {
        if (Math.hypot(clientX - startClient.x, clientY - startClient.y) < DRAG_THRESHOLD_PX) return;
        dragging = true;
        history.pushPast(startDoc);
      }
      const c = canvasPoint(clientX, clientY);
      const q = apply(toParent, c);
      const dx = q.x - q0.x;
      const dy = q.y - q0.y;
      let drag: TransformDrag;
      switch (what.kind) {
        case "move":
          drag = { kind: "move", dx, dy };
          break;
        case "origin": {
          // Snap each axis on its own to the box's edge / centre lines (in
          // the box's frame), so the origin can sit on the vertical centre
          // line and still slide freely along it. The box doesn't move
          // during an origin drag, so pointer-down geometry stays valid.
          const { width, height } = geom.box;
          const local = rotateVec({ x: dx, y: dy }, -geom.rotation);
          const fx = width > 0 ? (geom.pivot.x - geom.box.x + local.x) / width : null;
          const fy = height > 0 ? (geom.pivot.y - geom.box.y + local.y) / height : null;
          const snapAxis = (
            f: number | null,
            other: number | null,
            horizontal: boolean,
          ): HandlePos | undefined => {
            if (f == null) return undefined;
            const o = other ?? 0.5;
            const here = horizontal ? P(f, o) : P(o, f);
            let best: HandlePos | undefined;
            let reach = ORIGIN_SNAP_PX;
            for (const s of SNAP_FRACTIONS) {
              const line = horizontal ? P(s, o) : P(o, s);
              const dist = Math.hypot(line.x - here.x, line.y - here.y);
              if (dist < reach) {
                reach = dist;
                best = s;
              }
            }
            return best;
          };
          drag = {
            kind: "origin",
            dx,
            dy,
            snapX: snapAxis(fx, fy, true),
            snapY: snapAxis(fy, fx, false),
          };
          break;
        }
        case "rotate": {
          const a = Math.atan2(q.y - geom.pivot.y, q.x - geom.pivot.x);
          let d = a - prevAngle;
          if (d > Math.PI) d -= 2 * Math.PI;
          else if (d < -Math.PI) d += 2 * Math.PI;
          turned += d;
          prevAngle = a;
          drag = { kind: "rotate", deltaDeg: (turned * 180) / Math.PI, snap: shift };
          break;
        }
        case "scale":
          drag = { kind: "scale", hx: what.hx, hy: what.hy, dx, dy, uniform: shift };
          break;
        case "distort": {
          if (!toInner) return;
          const r0 = apply(toInner, c0);
          const r = apply(toInner, c);
          drag = { kind: "distort", corner: what.corner, dx: r.x - r0.x, dy: r.y - r0.y };
          break;
        }
      }
      history.replace(
        updateNodeAtPath(startDoc, path, (n) => applyTransformDrag(n, geom, drag, targets)),
      );
    };

    const onMove = (ev: Event) => {
      const me = ev as PointerEvent;
      if (me.pointerId !== pointerId) return;
      run(me.clientX, me.clientY, me.shiftKey);
    };
    const onUp = (ev: Event) => {
      const me = ev as PointerEvent;
      if (me.pointerId !== pointerId) return;
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
      dragRef.current = null;
      try {
        target.releasePointerCapture(pointerId);
      } catch {
        /* ignore */
      }
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
    dragRef.current = { update: (shift) => run(last.x, last.y, shift) };
  };

  const interactive: React.CSSProperties = { pointerEvents: "all" };
  const stop = (e: React.SyntheticEvent) => e.stopPropagation();

  return (
    <svg
      width={surface.rect.width}
      height={surface.rect.height}
      style={{ position: "absolute", left: 0, top: 0, overflow: "visible", pointerEvents: "none" }}
      onDoubleClick={stop}
    >
      {/* Rotate zones: a ring just outside each handle (the body and the
          handle itself sit on top and take the inside). */}
      {caps.rotate &&
        HANDLES.map(({ hx, hy }) => {
          const p = P(hx, hy);
          return (
            <circle
              key={`r${hx}-${hy}`}
              cx={p.x}
              cy={p.y}
              r={ROTATE_ZONE}
              fill="transparent"
              style={{ ...interactive, cursor: ROTATE_CURSOR }}
              onPointerDown={(e) => begin(e, { kind: "rotate" })}
            />
          );
        })}

      {/* Body: empty space inside the box translates. */}
      <polygon
        points={outline}
        fill="transparent"
        style={caps.move ? { ...interactive, cursor: "move" } : undefined}
        onPointerDown={caps.move ? (e) => begin(e, { kind: "move" }) : undefined}
      />
      <polygon points={outline} fill="none" stroke="rgba(0,0,0,0.55)" strokeWidth={3} />
      <polygon points={outline} fill="none" stroke={ACCENT} strokeWidth={1.5} />

      {/* Distort: the pinned quad, plus a line from each corner's home to
          where it is pinned. */}
      {showDistort && pins && pinHome && (
        <g>
          {pins.map((p, i) => (
            <line
              key={`h${i}`}
              x1={pinHome[i].x}
              y1={pinHome[i].y}
              x2={p.x}
              y2={p.y}
              stroke={DISTORT}
              strokeWidth={1}
              strokeDasharray="2 3"
            />
          ))}
          <polygon
            points={pins.map((p) => `${p.x},${p.y}`).join(" ")}
            fill="none"
            stroke={DISTORT}
            strokeWidth={1.5}
            strokeDasharray="6 4"
          />
        </g>
      )}

      {/* Scale handles (hidden while Cmd/Ctrl swaps the corners to pins). */}
      {caps.scale &&
        !distortMode &&
        HANDLES.map(({ hx, hy }) => {
          const p = P(hx, hy);
          return (
            <rect
              key={`s${hx}-${hy}`}
              x={p.x - HANDLE / 2}
              y={p.y - HANDLE / 2}
              width={HANDLE}
              height={HANDLE}
              fill="#fff"
              stroke={ACCENT}
              strokeWidth={1.5}
              style={{
                ...interactive,
                cursor: resizeCursor({ x: p.x - center.x, y: p.y - center.y }),
              }}
              onPointerDown={(e) => {
                // Cmd/Ctrl decided at the press itself, in case the pins
                // haven't swapped in yet: a corner starts a distort.
                const corner = CORNERS.findIndex((c) => c.hx === hx && c.hy === hy);
                if ((e.metaKey || e.ctrlKey) && caps.distort && inner && corner >= 0) {
                  begin(e, { kind: "distort", corner: corner as 0 | 1 | 2 | 3 });
                } else {
                  begin(e, { kind: "scale", hx, hy });
                }
              }}
            />
          );
        })}

      {distortMode &&
        pins &&
        pins.map((p, i) => (
          <circle
            key={`d${i}`}
            cx={p.x}
            cy={p.y}
            r={HANDLE / 2 + 1}
            fill={DISTORT}
            stroke="#fff"
            strokeWidth={1.5}
            style={{ ...interactive, cursor: "crosshair" }}
            onPointerDown={(e) => begin(e, { kind: "distort", corner: i as 0 | 1 | 2 | 3 })}
          />
        ))}

      {/* Origin: where `origin` lands (the rotation / scale pivot). */}
      <g
        style={caps.origin ? { ...interactive, cursor: "crosshair" } : undefined}
        onPointerDown={caps.origin ? (e) => begin(e, { kind: "origin" }) : undefined}
      >
        <circle cx={pivotScreen.x} cy={pivotScreen.y} r={9} fill="transparent" />
        <circle
          cx={pivotScreen.x}
          cy={pivotScreen.y}
          r={5}
          fill="rgba(0,0,0,0.35)"
          stroke="#fff"
          strokeWidth={1.5}
        />
        <path
          d={`M${pivotScreen.x - 8} ${pivotScreen.y}h16M${pivotScreen.x} ${pivotScreen.y - 8}v16`}
          stroke={ACCENT}
          strokeWidth={1.5}
        />
      </g>
    </svg>
  );
}

import React, {
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import { DEFAULT_CANVAS_HEIGHT, DEFAULT_CANVAS_WIDTH } from "@seam/core";
import { TimelineCanvasContext } from "./TimelineContext.js";

/** Display mode for the preview surface.
 *  - `"fit"` (default): the canvas scales to fit its container (the original,
 *    and only, behavior the standalone Player needs).
 *  - `"free"`: the canvas is freely pan/zoomable — trackpad pinch-zoom
 *    (ctrl+wheel), two-finger pan (wheel), drag-to-pan, double-click to fit. */
export type VideoCanvasMode = "fit" | "free";

export interface VideoCanvasView {
  /** Current display scale (1 = one CSS px per backing px = 100%). */
  scale: number;
  /** Scale at which the frame fits the container. */
  fitScale: number;
}

/**
 * A coordinate-mapped layer sitting exactly over the displayed video, in any
 * mode/zoom/pan. Reusable basis for viewport gizmos (analysis windows now,
 * spatial-property handles later). `rect` is the video's box in container-local
 * px; `toNorm` maps a pointer event's client coords to normalized [0..1]
 * content coords (handles letterboxing in fit mode and the transform in free).
 */
export interface GizmoSurface {
  rect: { x: number; y: number; width: number; height: number };
  toNorm: (clientX: number, clientY: number) => { x: number; y: number };
}

interface VideoCanvasProps {
  width?: number;
  height?: number;
  style?: React.CSSProperties;
  className?: string;
  mode?: VideoCanvasMode;
  /** Reports view changes in `"free"` mode (for an external zoom readout). */
  onViewChange?: (view: VideoCanvasView) => void;
  /** Bump this number to snap the `"free"` view back to fit-to-container. */
  resetSignal?: number;
  /** Render an overlay layer positioned exactly over the displayed video.
   *  The returned nodes live in a `pointer-events: none` box at the video's
   *  on-screen rect; interactive children opt back in with `pointerEvents`. */
  overlay?: (surface: GizmoSurface) => React.ReactNode;
}

const MIN_SCALE = 0.02;
const MAX_SCALE = 8;

interface FreeView {
  scale: number;
  tx: number;
  ty: number;
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

export default function VideoCanvas({
  width = DEFAULT_CANVAS_WIDTH,
  height = DEFAULT_CANVAS_HEIGHT,
  style,
  className,
  mode = "fit",
  onViewChange,
  resetSignal = 0,
  overlay,
}: VideoCanvasProps) {
  const ctx = useContext(TimelineCanvasContext);
  if (!ctx) {
    throw new Error("<VideoCanvas> must be used within a <Timeline>");
  }
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const overlayRef = useRef<HTMLDivElement>(null);

  // Backing-store registration is mode-independent: the GPU always renders at
  // the content resolution; only the CSS presentation differs.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    ctx.registerCanvas(canvas, width, height);
    return () => ctx.unregisterCanvas(canvas);
  }, [ctx, width, height]);

  const [containerSize, setContainerSize] = useState({ w: 0, h: 0 });
  const [view, setView] = useState<FreeView | null>(null);
  const viewRef = useRef<FreeView | null>(null);
  viewRef.current = view;

  const isFree = mode === "free";
  const needsGeometry = isFree || overlay != null;

  const fitScale = useCallback((): number => {
    const el = containerRef.current;
    if (!el) return 1;
    const cw = el.clientWidth;
    const ch = el.clientHeight;
    if (cw === 0 || ch === 0) return 1;
    return Math.min(cw / width, ch / height);
  }, [width, height]);

  const fitView = useCallback((): FreeView => {
    const el = containerRef.current;
    const cw = el?.clientWidth ?? 0;
    const ch = el?.clientHeight ?? 0;
    const s = fitScale();
    return { scale: s, tx: (cw - width * s) / 2, ty: (ch - height * s) / 2 };
  }, [fitScale, width, height]);

  const applyFit = useCallback(() => setView(fitView()), [fitView]);

  // Track container size (for fit-mode overlay geometry + free-mode auto-fit).
  useEffect(() => {
    if (!needsGeometry) return;
    const el = containerRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const measure = () => setContainerSize({ w: el.clientWidth, h: el.clientHeight });
    measure();
    const ro = new ResizeObserver(() => {
      measure();
      // Keep a freshly-fit view while the user hasn't zoomed away from fit.
      if (isFree) {
        const v = viewRef.current;
        if (!v) applyFit();
        else if (Math.abs(v.scale - fitScale()) < 1e-3) applyFit();
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [needsGeometry, isFree, applyFit, fitScale]);

  // Report scale upward whenever the free view changes.
  useEffect(() => {
    if (!isFree || !view) return;
    onViewChange?.({ scale: view.scale, fitScale: fitScale() });
  }, [view, isFree, onViewChange, fitScale]);

  // Initialise / reset to fit on entering free mode, content-size change, reset.
  useEffect(() => {
    if (!isFree) return;
    applyFit();
  }, [isFree, width, height, resetSignal, applyFit]);

  // Native (non-passive) wheel handler so we can preventDefault — needed to
  // stop the page from scrolling and, for ctrl+wheel, from browser-zooming.
  useEffect(() => {
    if (!isFree) return;
    const el = containerRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      const cx = e.clientX - rect.left;
      const cy = e.clientY - rect.top;
      setView((v) => {
        const cur = v ?? fitView();
        if (e.ctrlKey) {
          // Trackpad pinch / ctrl+wheel → zoom about the cursor.
          const factor = Math.exp(-e.deltaY * 0.01);
          const s2 = clamp(cur.scale * factor, MIN_SCALE, MAX_SCALE);
          const canvasX = (cx - cur.tx) / cur.scale;
          const canvasY = (cy - cur.ty) / cur.scale;
          return { scale: s2, tx: cx - canvasX * s2, ty: cy - canvasY * s2 };
        }
        // Two-finger scroll → pan.
        return { ...cur, tx: cur.tx - e.deltaX, ty: cur.ty - e.deltaY };
      });
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [isFree, fitView]);

  // Drag-to-pan (mouse / single-finger), tracked on window so a fast drag that
  // leaves the element keeps panning.
  const onPointerDown = (e: React.PointerEvent) => {
    if (!isFree || e.button !== 0) return;
    let last = { x: e.clientX, y: e.clientY };
    const move = (ev: PointerEvent) => {
      const dx = ev.clientX - last.x;
      const dy = ev.clientY - last.y;
      last = { x: ev.clientX, y: ev.clientY };
      setView((v) => (v ? { ...v, tx: v.tx + dx, ty: v.ty + dy } : v));
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  // The displayed video rect in container-local px (for overlay placement).
  let rect: GizmoSurface["rect"] | null = null;
  if (isFree) {
    if (view)
      rect = {
        x: view.tx,
        y: view.ty,
        width: width * view.scale,
        height: height * view.scale,
      };
  } else {
    const { w: cw, h: ch } = containerSize;
    if (cw > 0 && ch > 0) {
      const s = Math.min(cw / width, ch / height);
      const dw = width * s;
      const dh = height * s;
      rect = { x: (cw - dw) / 2, y: (ch - dh) / 2, width: dw, height: dh };
    }
  }

  const toNorm = useCallback((clientX: number, clientY: number) => {
    const el = overlayRef.current;
    if (!el) return { x: 0, y: 0 };
    const r = el.getBoundingClientRect();
    return {
      x: r.width > 0 ? (clientX - r.left) / r.width : 0,
      y: r.height > 0 ? (clientY - r.top) / r.height : 0,
    };
  }, []);

  const containerStyle: React.CSSProperties = isFree
    ? {
        flex: 1,
        position: "relative",
        overflow: "hidden",
        minHeight: 0,
        cursor: "grab",
        touchAction: "none",
        ...style,
      }
    : {
        flex: 1,
        position: "relative",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        overflow: "hidden",
        minHeight: 0,
        ...style,
      };

  const canvasStyle: React.CSSProperties = isFree
    ? {
        position: "absolute",
        left: 0,
        top: 0,
        width,
        height,
        transformOrigin: "0 0",
        transform: view
          ? `translate(${view.tx}px, ${view.ty}px) scale(${view.scale})`
          : undefined,
        background: "#000",
        imageRendering: view && view.scale > 1 ? "pixelated" : "auto",
      }
    : {
        maxWidth: "100%",
        maxHeight: "100%",
        background: "#000",
      };

  return (
    <div
      ref={containerRef}
      className={className}
      style={containerStyle}
      onPointerDown={onPointerDown}
      onDoubleClick={isFree ? applyFit : undefined}
    >
      <canvas ref={canvasRef} width={width} height={height} style={canvasStyle} />
      {overlay && rect && (
        <div
          ref={overlayRef}
          style={{
            position: "absolute",
            left: rect.x,
            top: rect.y,
            width: rect.width,
            height: rect.height,
            pointerEvents: "none",
          }}
        >
          {overlay({ rect, toNorm })}
        </div>
      )}
    </div>
  );
}

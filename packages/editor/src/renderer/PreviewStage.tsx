import React, { useCallback, useEffect, useRef, useState } from "react";
import { VideoCanvas, useTimeline } from "@seam/preview";
import type { VideoCanvasView } from "@seam/preview";
import { Scan, ZoomIn, Maximize, Minimize2, Play, Pause } from "lucide-react";
import { isTypingInEditableSurface } from "./keyboardGuards.js";

interface PreviewStageProps {
  contentWidth: number;
  contentHeight: number;
}

/**
 * The editor's preview viewport with three display modes:
 *  - **Fit** (default): canvas fits the pane (snap-back baseline).
 *  - **Zoom**: free pan/zoom for fine inspection — trackpad pinch + two-finger
 *    pan, drag-to-pan, double-click to re-fit.
 *  - **Fullscreen**: real OS/browser fullscreen of just the preview + a minimal
 *    transport. Implemented via the Fullscreen API on this container, so the
 *    surrounding editor panes (siblings) are hidden by the browser and the same
 *    <VideoCanvas> stays mounted (no WebGPU re-init).
 *
 * Fullscreen always presents fit-to-screen; Zoom is a non-fullscreen mode.
 * `f` toggles fullscreen (Esc exits, handled natively).
 */
export default function PreviewStage({
  contentWidth,
  contentHeight,
}: PreviewStageProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [mode, setMode] = useState<"fit" | "zoom">("fit");
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [scale, setScale] = useState(1);
  const [resetSignal, setResetSignal] = useState(0);

  // Mirror real fullscreen state so an OS/Esc exit updates our UI.
  useEffect(() => {
    const onChange = () =>
      setIsFullscreen(document.fullscreenElement === containerRef.current);
    document.addEventListener("fullscreenchange", onChange);
    return () => document.removeEventListener("fullscreenchange", onChange);
  }, []);

  const enterFullscreen = useCallback(() => {
    containerRef.current
      ?.requestFullscreen?.()
      .catch((err) => console.error("[preview] fullscreen request failed:", err));
  }, []);
  const exitFullscreen = useCallback(() => {
    if (document.fullscreenElement)
      document.exitFullscreen?.().catch(() => {});
  }, []);

  // `f` toggles fullscreen (when not typing / chord-free).
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (isTypingInEditableSurface(e)) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === "f" || e.key === "F") {
        e.preventDefault();
        if (document.fullscreenElement === containerRef.current)
          exitFullscreen();
        else enterFullscreen();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [enterFullscreen, exitFullscreen]);

  // Fullscreen forces fit; otherwise honour the selected mode.
  const canvasMode = isFullscreen ? "fit" : mode === "zoom" ? "free" : "fit";

  const onViewChange = useCallback((v: VideoCanvasView) => {
    setScale(v.scale);
  }, []);

  return (
    <div
      ref={containerRef}
      style={{
        position: "relative",
        flex: "1 1 0",
        minHeight: 0,
        display: "flex",
        flexDirection: "column",
        background: isFullscreen ? "#000" : "#111",
      }}
    >
      <VideoCanvas
        mode={canvasMode}
        width={contentWidth}
        height={contentHeight}
        onViewChange={onViewChange}
        resetSignal={resetSignal}
        style={{ background: isFullscreen ? "#000" : "#111" }}
      />

      {/* Mode overlay, top-right. */}
      <div
        style={{
          position: "absolute",
          top: 8,
          right: 8,
          display: "flex",
          alignItems: "center",
          gap: 6,
          padding: 4,
          borderRadius: 6,
          background: "rgba(20,20,20,0.7)",
          backdropFilter: "blur(4px)",
        }}
      >
        {isFullscreen ? (
          <IconButton
            label="Exit fullscreen (Esc)"
            active={false}
            onClick={exitFullscreen}
          >
            <Minimize2 size={15} />
          </IconButton>
        ) : (
          <>
            {mode === "zoom" && (
              <button
                onClick={() => setResetSignal((s) => s + 1)}
                title="Reset to fit (double-click preview)"
                style={READOUT_STYLE}
              >
                {Math.round(scale * 100)}%
              </button>
            )}
            <IconButton
              label="Fit to screen"
              active={mode === "fit"}
              onClick={() => setMode("fit")}
            >
              <Scan size={15} />
            </IconButton>
            <IconButton
              label="Zoom / pan (pinch · two-finger pan · drag · dbl-click fits)"
              active={mode === "zoom"}
              onClick={() => setMode("zoom")}
            >
              <ZoomIn size={15} />
            </IconButton>
            <IconButton
              label="Fullscreen (F)"
              active={false}
              onClick={enterFullscreen}
            >
              <Maximize size={15} />
            </IconButton>
          </>
        )}
      </div>

      {isFullscreen && <MiniTransport />}
    </div>
  );
}

function fmtTime(s: number): string {
  if (!isFinite(s)) return "0:00";
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${sec.toString().padStart(2, "0")}`;
}

/** Minimal transport shown only in fullscreen: scrub line + play + time. */
function MiniTransport() {
  const { currentTime, totalDuration, isPlaying, play, pause, seek } =
    useTimeline();
  const progress = totalDuration > 0 ? (currentTime / totalDuration) * 100 : 0;
  const onScrub = (e: React.MouseEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const pct = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
    seek(pct * totalDuration);
  };
  return (
    <div
      style={{
        position: "absolute",
        left: 0,
        right: 0,
        bottom: 0,
        background: "linear-gradient(to top, rgba(0,0,0,0.85), rgba(0,0,0,0))",
      }}
    >
      <div
        onClick={onScrub}
        style={{
          height: 6,
          margin: "0 16px",
          background: "#444",
          borderRadius: 3,
          cursor: "pointer",
          position: "relative",
        }}
      >
        <div
          style={{
            position: "absolute",
            height: "100%",
            width: `${progress}%`,
            background: "#4a9eff",
            borderRadius: 3,
          }}
        />
      </div>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 14,
          padding: "10px 18px 16px",
          color: "#fff",
        }}
      >
        <button
          onClick={isPlaying ? pause : play}
          title={isPlaying ? "Pause" : "Play"}
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            width: 34,
            height: 34,
            borderRadius: "50%",
            border: "none",
            background: "rgba(255,255,255,0.12)",
            color: "#fff",
            cursor: "pointer",
          }}
        >
          {isPlaying ? <Pause size={16} /> : <Play size={16} />}
        </button>
        <span
          style={{ fontSize: 13, fontVariantNumeric: "tabular-nums" }}
        >
          {fmtTime(currentTime)} / {fmtTime(totalDuration)}
        </span>
        <div style={{ flex: 1 }} />
        <span style={{ color: "#888", fontSize: 11 }}>Esc to exit</span>
      </div>
    </div>
  );
}

const READOUT_STYLE: React.CSSProperties = {
  background: "transparent",
  border: "none",
  color: "#bbb",
  fontSize: 11,
  fontVariantNumeric: "tabular-nums",
  cursor: "pointer",
  padding: "0 4px",
  fontFamily: "inherit",
};

function IconButton({
  label,
  active,
  onClick,
  children,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      title={label}
      aria-label={label}
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        width: 28,
        height: 28,
        borderRadius: 4,
        border: "none",
        background: active ? "#4a7eb8" : "transparent",
        color: active ? "#fff" : "#bbb",
        cursor: "pointer",
      }}
    >
      {children}
    </button>
  );
}

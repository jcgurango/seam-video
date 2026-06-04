import React, { useContext, useEffect, useRef } from "react";
import { DEFAULT_CANVAS_HEIGHT, DEFAULT_CANVAS_WIDTH } from "@seam/core";
import { TimelineCanvasContext } from "./TimelineContext.js";

interface VideoCanvasProps {
  width?: number;
  height?: number;
  style?: React.CSSProperties;
  className?: string;
}

export default function VideoCanvas({
  width = DEFAULT_CANVAS_WIDTH,
  height = DEFAULT_CANVAS_HEIGHT,
  style,
  className,
}: VideoCanvasProps) {
  const ctx = useContext(TimelineCanvasContext);
  if (!ctx) {
    throw new Error("<VideoCanvas> must be used within a <Timeline>");
  }
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    ctx.registerCanvas(canvas, width, height);
    return () => ctx.unregisterCanvas(canvas);
  }, [ctx, width, height]);

  return (
    <div
      className={className}
      style={{
        flex: 1,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        overflow: "hidden",
        minHeight: 0,
        ...style,
      }}
    >
      <canvas
        ref={canvasRef}
        width={width}
        height={height}
        style={{
          maxWidth: "100%",
          maxHeight: "100%",
          background: "#000",
        }}
      />
    </div>
  );
}

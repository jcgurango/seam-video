import React, { useRef, useEffect, useLayoutEffect } from "react";
import type { ResolvedClip } from "@seam/core";
import { useTimeline } from "./TimelineContext.js";
import { drawFrame } from "../media/drawFrame.js";

interface ClipProps {
  clip: ResolvedClip;
}

export default function Clip({ clip }: ClipProps) {
  const parent = useTimeline();
  const { currentTime } = parent;
  const { canvasWidth, canvasHeight, getFrame, getIntrinsicSize } = useTimeline();
  const canvasRef = useRef<HTMLCanvasElement>(null);

  const frame = getFrame(clip);
  const intrinsicSize = getIntrinsicSize(clip);

  const s = clip.spatial;
  const containerW = s ? s.width : canvasWidth;
  const containerH = s ? s.height : canvasHeight;
  const containerX = s ? s.x : 0;
  const containerY = s ? s.y : 0;
  const isActive =
    currentTime >= clip.timelineStart &&
    currentTime < clip.timelineEnd;

  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !frame) return;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    if (canvas.width !== containerW || canvas.height !== containerH) {
      canvas.width = containerW;
      canvas.height = containerH;
    }

    const videoW = intrinsicSize?.w ?? containerW;
    const videoH = intrinsicSize?.h ?? containerH;

    drawFrame(ctx, frame, containerW, containerH, videoW, videoH, clip.objectFit, clip.anchor);
  }, [canvasRef, frame]);

  if (!frame || !isActive) return null;

  return (
    <div
      style={{
        position: "absolute",
        left: containerX,
        top: containerY,
        width: containerW,
        height: containerH,
        overflow: "hidden",
      }}
    >
      <canvas
        ref={canvasRef}
        width={containerW}
        height={containerH}
        style={{
          position: "absolute",
          top: 0,
          left: 0,
          width: containerW,
          height: containerH,
        }}
      />
    </div>
  );
}

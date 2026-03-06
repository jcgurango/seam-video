import React, { useRef, useEffect, useState } from "react";
import type { ResolvedClip } from "@seam/core";
import { useTimeline } from "./TimelineContext.js";
import { resolveSource } from "./resolveSource.js";
import { shouldBeInDOM } from "./preload.js";
import Video from "./Video.js";

interface ClipProps {
  clip: ResolvedClip;
}

export default function Clip({ clip }: ClipProps) {
  const { currentTime, isPlaying, basePath, canvasWidth, canvasHeight } = useTimeline();
  const [intrinsicSize, setIntrinsicSize] = useState<{ w: number; h: number } | null>(null);

  const isInDOM = shouldBeInDOM(currentTime, clip.timelineStart, clip.timelineEnd);
  const isActive =
    currentTime >= clip.timelineStart && currentTime < clip.timelineEnd;

  const clipLocalTime = isActive ? currentTime - clip.timelineStart : 0;
  const sourceTime = clip.sourceIn + clipLocalTime * clip.speed;

  if (!isInDOM) return null;

  const src = resolveSource(clip.source, basePath);
  const s = clip.spatial;

  // Container dimensions: from spatial rect, or from parent canvas
  const containerW = s ? s.width : canvasWidth;
  const containerH = s ? s.height : canvasHeight;
  const containerX = s ? s.x : 0;
  const containerY = s ? s.y : 0;

  // Compute objectFit-based video sizing
  if (clip.objectFit && intrinsicSize) {
    const { w: videoW, h: videoH } = intrinsicSize;

    let scaledW: number;
    let scaledH: number;

    if (clip.objectFit === "center") {
      scaledW = videoW;
      scaledH = videoH;
    } else if (clip.objectFit === "fit") {
      const scale = Math.min(containerW / videoW, containerH / videoH);
      scaledW = videoW * scale;
      scaledH = videoH * scale;
    } else {
      // cover
      const scale = Math.max(containerW / videoW, containerH / videoH);
      scaledW = videoW * scale;
      scaledH = videoH * scale;
    }

    // Position within container based on anchor edges
    const a = clip.anchor;
    let offsetX: number;
    let offsetY: number;
    if (a?.right != null && a?.left == null) {
      offsetX = containerW - scaledW;
    } else if (a?.left != null && a?.right == null) {
      offsetX = 0;
    } else {
      offsetX = (containerW - scaledW) / 2;
    }
    if (a?.bottom != null && a?.top == null) {
      offsetY = containerH - scaledH;
    } else if (a?.top != null && a?.bottom == null) {
      offsetY = 0;
    } else {
      offsetY = (containerH - scaledH) / 2;
    }

    return (
      <div
        style={{
          position: "absolute",
          left: containerX,
          top: containerY,
          width: containerW,
          height: containerH,
          overflow: "hidden",
          opacity: isActive ? 1 : 0,
        }}
      >
        <Video
          src={src}
          playsInline
          preload="auto"
          onLoadedMetadata={(e) => {
            const v = e.currentTarget;
            setIntrinsicSize({ w: v.videoWidth, h: v.videoHeight });
          }}
          style={{
            position: "absolute",
            left: offsetX,
            top: offsetY,
            width: scaledW,
            height: scaledH,
          }}
          time={sourceTime}
          isPlaying={isActive && isPlaying}
          rate={clip.speed}
        />
      </div>
    );
  }

  // No objectFit or intrinsic size not yet known — render video directly
  return (
    <div
      style={{
        position: "absolute",
        left: containerX,
        top: containerY,
        width: containerW,
        height: containerH,
        overflow: "hidden",
        opacity: isActive ? 1 : 0,
      }}
    >
      <Video
        src={src}
        playsInline
        preload="auto"
        onLoadedMetadata={(e) => {
          const v = e.currentTarget;
          setIntrinsicSize({ w: v.videoWidth, h: v.videoHeight });
        }}
        style={{
          position: "absolute",
          top: 0,
          left: 0,
          width: containerW,
          height: containerH,
          objectFit: "fill",
        }}
        time={sourceTime}
        isPlaying={isActive && isPlaying}
        rate={clip.speed}
      />
    </div>
  );
}

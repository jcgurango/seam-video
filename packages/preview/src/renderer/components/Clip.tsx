import React, { useRef, useEffect, useState } from "react";
import type { ResolvedClip } from "@seam/core";
import { useTimeline } from "./TimelineContext.js";
import { resolveSource } from "./resolveSource.js";

interface ClipProps {
  clip: ResolvedClip;
}

export default function Clip({ clip }: ClipProps) {
  const { currentTime, isPlaying, basePath, canvasWidth, canvasHeight } = useTimeline();
  const [intrinsicSize, setIntrinsicSize] = useState<{ w: number; h: number } | null>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const wasPlayingRef = useRef(false);
  const wasActiveRef = useRef(false);

  const preloadStart = clip.timelineStart - 0.1;
  const isInDOM =
    currentTime >= preloadStart && currentTime < clip.timelineEnd;
  const isActive =
    currentTime >= clip.timelineStart && currentTime < clip.timelineEnd;

  const clipLocalTime = isActive ? currentTime - clip.timelineStart : 0;
  const sourceTime = clip.sourceIn + clipLocalTime * clip.speed;

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    const prevPlaying = wasPlayingRef.current;
    const prevActive = wasActiveRef.current;
    wasPlayingRef.current = isPlaying;
    wasActiveRef.current = isActive;

    if (isActive && isPlaying) {
      if (!prevActive || !prevPlaying) {
        // Play transition
        video.playbackRate = clip.speed;
        video.currentTime = sourceTime;
        video.play().catch(() => {});
      }
    } else if (isActive && !isPlaying) {
      if (prevPlaying) {
        // Pause transition
        video.pause();
      }
      // Scrubbing: sync video position
      video.currentTime = sourceTime;
    } else {
      // Not active — pause and pre-seek to first frame
      if (prevActive || prevPlaying) {
        video.pause();
      }
      video.currentTime = clip.sourceIn;
    }
  }, [isActive, isPlaying, currentTime, clip, sourceTime]);

  // Boundary check: pause at sourceOut
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    const onTimeUpdate = () => {
      if (video.currentTime >= clip.sourceOut - 0.02) {
        video.pause();
      }
    };

    video.addEventListener("timeupdate", onTimeUpdate);
    return () => video.removeEventListener("timeupdate", onTimeUpdate);
  }, [clip.sourceOut]);

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
        <video
          ref={videoRef}
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
      <video
        ref={videoRef}
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
      />
    </div>
  );
}

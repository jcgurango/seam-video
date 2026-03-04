import React, { useRef, useEffect } from "react";
import type { ResolvedClip } from "@seam/core";
import { useTimeline } from "./TimelineContext.js";
import { resolveSource } from "./resolveSource.js";

interface ClipProps {
  clip: ResolvedClip;
}

export default function Clip({ clip }: ClipProps) {
  const { currentTime, isPlaying, basePath } = useTimeline();
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
        console.log(clip.timelineStart, "SET", sourceTime, video.readyState);
        video.play().catch(() => {});
      }
    } else if (isActive && !isPlaying) {
      if (prevPlaying) {
        // Pause transition
        video.pause();
      }
      // Scrubbing: sync video position
      console.log(clip.timelineStart, "SET", sourceTime, video.readyState);
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

  return (
    <video
      ref={videoRef}
      src={src}
      playsInline
      preload="auto"
      style={{
        position: "absolute",
        inset: 0,
        width: "100%",
        height: "100%",
        objectFit: "contain",
        opacity: isActive ? 1 : 0,
      }}
    />
  );
}

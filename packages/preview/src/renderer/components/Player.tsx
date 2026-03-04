import React, { useRef, useState, useEffect, useCallback } from "react";
import type { ResolvedTimeline, ResolvedChild, ResolvedClip } from "@seam/core";

interface PlayerProps {
  timeline: ResolvedTimeline;
  basePath: string;
}

function resolveSource(source: string, basePath: string): string {
  if (source.startsWith("http://") || source.startsWith("https://")) {
    return source;
  }
  const fullPath = source.includes(":") ? source : `${basePath}/${source}`;
  return `seam-media://media/${encodeURIComponent(fullPath)}`;
}

/** Seek a video element and resolve once the seek completes. */
function seekTo(video: HTMLVideoElement, time: number): Promise<void> {
  return new Promise((resolve) => {
    const onSeeked = () => {
      video.removeEventListener("seeked", onSeeked);
      resolve();
    };
    video.addEventListener("seeked", onSeeked);
    video.currentTime = time;
  });
}

/** Load a source into a video element and resolve once metadata is ready. */
function loadSource(video: HTMLVideoElement, src: string): Promise<void> {
  return new Promise((resolve) => {
    const onReady = () => {
      video.removeEventListener("loadeddata", onReady);
      resolve();
    };
    video.addEventListener("loadeddata", onReady);
    video.src = src;
    video.load();
  });
}

export default function Player({ timeline, basePath }: PlayerProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  // Track the logical source currently loaded (not the browser-normalized URL)
  const loadedSourceRef = useRef<string | null>(null);

  const children = timeline.children;
  const current = children[currentIndex] as ResolvedChild | undefined;

  const playClip = useCallback(
    async (index: number) => {
      const child = children[index];
      if (!child) return;

      const video = videoRef.current;
      if (!video) return;

      if (child.type === "clip") {
        const clip = child as ResolvedClip;
        const src = resolveSource(clip.source, basePath);

        if (loadedSourceRef.current !== clip.source) {
          await loadSource(video, src);
          loadedSourceRef.current = clip.source;
        }

        await seekTo(video, clip.sourceIn);
        video.playbackRate = clip.speed;
        video.play().catch(() => {});
      } else {
        // Empty segment: show black, wait for duration
        video.pause();
        const duration = child.timelineEnd - child.timelineStart;
        setTimeout(() => {
          if (index + 1 < children.length) {
            setCurrentIndex(index + 1);
          } else {
            setIsPlaying(false);
          }
        }, duration * 1000);
      }
    },
    [children, basePath]
  );

  // Handle timeupdate to check clip boundaries
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    const onTimeUpdate = () => {
      const child = children[currentIndex];
      if (!child || child.type !== "clip") return;

      setCurrentTime(
        child.timelineStart + (video.currentTime - child.sourceIn) / child.speed
      );

      if (video.currentTime >= child.sourceOut - 0.05) {
        video.pause();
        if (currentIndex + 1 < children.length) {
          setCurrentIndex(currentIndex + 1);
        } else {
          setIsPlaying(false);
        }
      }
    };

    video.addEventListener("timeupdate", onTimeUpdate);
    return () => video.removeEventListener("timeupdate", onTimeUpdate);
  }, [children, currentIndex]);

  // When currentIndex changes and we're playing, play the next clip
  useEffect(() => {
    if (isPlaying) {
      playClip(currentIndex);
    }
  }, [currentIndex, isPlaying, playClip]);

  const handlePlayPause = () => {
    if (isPlaying) {
      setIsPlaying(false);
      videoRef.current?.pause();
    } else {
      setIsPlaying(true);
      playClip(currentIndex);
    }
  };

  const handleRestart = () => {
    setCurrentIndex(0);
    setCurrentTime(0);
    setIsPlaying(true);
  };

  const progress =
    timeline.duration > 0 ? (currentTime / timeline.duration) * 100 : 0;

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        height: "100vh",
        background: "#1a1a1a",
        color: "#fff",
        fontFamily: "sans-serif",
      }}
    >
      <div
        style={{
          flex: 1,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          overflow: "hidden",
        }}
      >
        <video
          ref={videoRef}
          style={{ maxWidth: "100%", maxHeight: "100%" }}
        />
      </div>

      {/* Transport controls */}
      <div
        style={{
          padding: "12px 20px",
          background: "#2a2a2a",
          borderTop: "1px solid #333",
        }}
      >
        {/* Scrub bar */}
        <div
          style={{
            height: 4,
            background: "#444",
            borderRadius: 2,
            marginBottom: 12,
            cursor: "pointer",
            position: "relative",
          }}
          onClick={async (e) => {
            const rect = e.currentTarget.getBoundingClientRect();
            const pct = (e.clientX - rect.left) / rect.width;
            const targetTime = pct * timeline.duration;
            for (let i = 0; i < children.length; i++) {
              if (
                targetTime >= children[i].timelineStart &&
                targetTime < children[i].timelineEnd
              ) {
                setCurrentIndex(i);
                setCurrentTime(targetTime);
                if (children[i].type === "clip") {
                  const clip = children[i] as ResolvedClip;
                  const offset = targetTime - clip.timelineStart;
                  const video = videoRef.current;
                  if (video) {
                    const src = resolveSource(clip.source, basePath);
                    if (loadedSourceRef.current !== clip.source) {
                      await loadSource(video, src);
                      loadedSourceRef.current = clip.source;
                    }
                    await seekTo(video, clip.sourceIn + offset * clip.speed);
                  }
                }
                break;
              }
            }
          }}
        >
          <div
            style={{
              position: "absolute",
              height: "100%",
              width: `${progress}%`,
              background: "#4a9eff",
              borderRadius: 2,
            }}
          />
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <button
            onClick={handlePlayPause}
            style={{
              background: "none",
              border: "1px solid #666",
              color: "#fff",
              padding: "6px 16px",
              borderRadius: 4,
              cursor: "pointer",
              fontSize: 14,
            }}
          >
            {isPlaying ? "Pause" : "Play"}
          </button>
          <button
            onClick={handleRestart}
            style={{
              background: "none",
              border: "1px solid #666",
              color: "#fff",
              padding: "6px 16px",
              borderRadius: 4,
              cursor: "pointer",
              fontSize: 14,
            }}
          >
            Restart
          </button>
          <span style={{ color: "#999", fontSize: 13 }}>
            {currentTime.toFixed(1)}s / {timeline.duration.toFixed(1)}s
          </span>
          <span style={{ color: "#666", fontSize: 12, marginLeft: "auto" }}>
            Clip {currentIndex + 1} / {children.length}
            {current?.type === "clip"
              ? ` - ${(current as ResolvedClip).source}`
              : current?.type === "empty"
                ? " - (empty)"
                : ""}
          </span>
        </div>
      </div>
    </div>
  );
}

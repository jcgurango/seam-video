import React from "react";
import { useTimeline } from "./TimelineContext.js";

export default function TransportControls() {
  const { currentTime, totalDuration, isPlaying, loop, play, pause, restart, seek, setLoop } =
    useTimeline();

  const progress =
    totalDuration > 0 ? (currentTime / totalDuration) * 100 : 0;

  const handleScrub = (e: React.MouseEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const pct = (e.clientX - rect.left) / rect.width;
    seek(pct * totalDuration);
  };

  return (
    <div
      style={{
        padding: "12px 20px",
        background: "#2a2a2a",
        borderTop: "1px solid #333",
      }}
    >
      {/* Scrub bar */}
      <div
        onClick={handleScrub}
        style={{
          height: 4,
          background: "#444",
          borderRadius: 2,
          marginBottom: 12,
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
            borderRadius: 2,
          }}
        />
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        <button
          onClick={isPlaying ? pause : play}
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
          onClick={restart}
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
        <button
          onClick={() => setLoop(!loop)}
          style={{
            background: loop ? "#4a9eff" : "none",
            border: `1px solid ${loop ? "#4a9eff" : "#666"}`,
            color: "#fff",
            padding: "6px 16px",
            borderRadius: 4,
            cursor: "pointer",
            fontSize: 14,
          }}
        >
          Loop
        </button>
        <span style={{ color: "#999", fontSize: 13 }}>
          {currentTime.toFixed(1)}s / {totalDuration.toFixed(1)}s
        </span>
      </div>
    </div>
  );
}

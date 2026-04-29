import React from "react";
import type { TranscribeProgress } from "./useTranscribe.js";

interface Props {
  progress: TranscribeProgress;
  onCancel: () => void;
}

export default function TranscribeProgressOverlay({
  progress,
  onCancel,
}: Props) {
  // `current` is 0-based; show the user a 1-based count, treating the
  // current item as "in flight".
  const display = Math.min(progress.current + 1, progress.total);
  const ratio = progress.total === 0 ? 0 : display / progress.total;
  const phaseLabel =
    progress.phase === "extract" ? "Extracting audio" : "Transcribing";

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.5)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 2100,
        fontFamily: "sans-serif",
        fontSize: 13,
      }}
    >
      <div
        style={{
          background: "#222",
          color: "#e0e0e0",
          border: "1px solid #333",
          borderRadius: 6,
          width: 420,
          maxWidth: "90vw",
          padding: 18,
          boxShadow: "0 12px 40px rgba(0,0,0,0.6)",
          display: "flex",
          flexDirection: "column",
          gap: 12,
        }}
      >
        <div style={{ fontWeight: 600 }}>Generating transcripts</div>
        <div style={{ color: "#aaa", fontSize: 12 }}>
          {phaseLabel} — {display} of {progress.total}
        </div>
        <div
          style={{
            width: "100%",
            height: 8,
            background: "#1a1a1a",
            borderRadius: 4,
            overflow: "hidden",
          }}
        >
          <div
            style={{
              width: `${Math.round(ratio * 100)}%`,
              height: "100%",
              background: "#4a7eb8",
              transition: "width 120ms linear",
            }}
          />
        </div>
        <div
          style={{
            color: "#888",
            fontSize: 11,
            fontFamily: "ui-monospace, monospace",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
          title={progress.label}
        >
          {progress.label}
        </div>
        <div style={{ display: "flex", justifyContent: "flex-end" }}>
          <button
            onClick={onCancel}
            style={{
              background: "#333",
              border: "1px solid #444",
              color: "#e0e0e0",
              padding: "6px 14px",
              borderRadius: 4,
              cursor: "pointer",
              fontSize: 13,
              fontFamily: "inherit",
            }}
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}

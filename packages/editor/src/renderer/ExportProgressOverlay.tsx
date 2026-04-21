import React from "react";
import type { ExportProgress } from "./platform/types.js";

interface Props {
  progress: ExportProgress;
}

// Phase weights used to blend the 3 phases into an overall 0..1 bar.
const PHASE_START: Record<ExportProgress["phase"], number> = {
  read: 0.0,
  zip: 0.5,
  write: 0.95,
};
const PHASE_SPAN: Record<ExportProgress["phase"], number> = {
  read: 0.5,
  zip: 0.45,
  write: 0.05,
};

const PHASE_LABEL: Record<ExportProgress["phase"], string> = {
  read: "Reading clips",
  zip: "Building archive",
  write: "Writing file",
};

export default function ExportProgressOverlay({ progress }: Props) {
  const overall =
    PHASE_START[progress.phase] +
    Math.max(0, Math.min(1, progress.progress)) * PHASE_SPAN[progress.phase];
  const pct = Math.round(overall * 100);

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.55)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 2000,
        fontFamily: "sans-serif",
        color: "#fff",
      }}
    >
      <div
        style={{
          background: "#1e1e1e",
          border: "1px solid #333",
          borderRadius: 8,
          padding: "20px 24px",
          minWidth: 360,
          maxWidth: 480,
          boxShadow: "0 20px 60px rgba(0,0,0,0.5)",
        }}
      >
        <div
          style={{
            fontSize: 14,
            fontWeight: 500,
            marginBottom: 4,
          }}
        >
          Exporting project…
        </div>
        <div
          style={{
            fontSize: 12,
            color: "#aaa",
            marginBottom: 14,
            minHeight: 16,
          }}
        >
          {PHASE_LABEL[progress.phase]}
          {progress.detail ? ` — ${progress.detail}` : ""}
        </div>
        <div
          style={{
            height: 6,
            background: "#333",
            borderRadius: 3,
            overflow: "hidden",
          }}
        >
          <div
            style={{
              height: "100%",
              width: `${pct}%`,
              background: "#4a9eff",
              transition: "width 150ms ease-out",
            }}
          />
        </div>
        <div
          style={{
            fontSize: 11,
            color: "#888",
            textAlign: "right",
            marginTop: 6,
          }}
        >
          {pct}%
        </div>
      </div>
    </div>
  );
}

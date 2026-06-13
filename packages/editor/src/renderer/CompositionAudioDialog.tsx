import React, { useEffect } from "react";
import type { CompositionAudioMode } from "./useTranscribe.js";

interface CompositionAudioDialogProps {
  /** Open when non-null; the count is shown so the user knows the choice
   *  applies to every selected composition. */
  open: boolean;
  compositionCount: number;
  onChoose: (mode: CompositionAudioMode) => void;
  onClose: () => void;
}

/**
 * Pops before a transcription job when the selection includes a composition,
 * letting the user pick which audio the composition mix should cover. The
 * chosen mode applies to every selected composition; plain clip/audio targets
 * transcribe from their own range regardless.
 */
export default function CompositionAudioDialog({
  open,
  compositionCount,
  onChoose,
  onClose,
}: CompositionAudioDialogProps) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  const noun =
    compositionCount === 1 ? "the composition" : `${compositionCount} compositions`;

  return (
    <div
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.5)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 2000,
      }}
    >
      <div
        style={{
          background: "#222",
          color: "#e0e0e0",
          border: "1px solid #333",
          borderRadius: 6,
          width: 440,
          maxWidth: "90vw",
          fontFamily: "sans-serif",
          fontSize: 13,
          boxShadow: "0 12px 40px rgba(0,0,0,0.6)",
        }}
      >
        <div
          style={{
            padding: "12px 16px",
            borderBottom: "1px solid #333",
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
          }}
        >
          <strong>Generate subtitles</strong>
          <button
            onClick={onClose}
            aria-label="Close"
            style={{
              background: "none",
              border: "none",
              color: "#888",
              fontSize: 18,
              cursor: "pointer",
              lineHeight: 1,
            }}
          >
            ×
          </button>
        </div>

        <div style={{ padding: 16, display: "flex", flexDirection: "column", gap: 14 }}>
          <span style={{ color: "#aaa" }}>
            Which audio should the mix for {noun} cover?
          </span>
          <Choice
            title="Children only"
            help="Render only the sequential children array."
            onClick={() => onChoose("children")}
          />
          <Choice
            title="Children and attachments"
            help="Render the children plus the composition's anchored attachments."
            onClick={() => onChoose("children-and-attachments")}
          />
        </div>

        <div
          style={{
            padding: 12,
            borderTop: "1px solid #333",
            display: "flex",
            justifyContent: "flex-end",
          }}
        >
          <button onClick={onClose} style={btnSecondary}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}

function Choice({
  title,
  help,
  onClick,
}: {
  title: string;
  help: string;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "flex-start",
        gap: 4,
        textAlign: "left",
        background: "#1a1a1a",
        border: "1px solid #444",
        borderRadius: 4,
        color: "#e0e0e0",
        padding: "10px 12px",
        cursor: "pointer",
        fontFamily: "inherit",
        fontSize: 13,
      }}
    >
      <span style={{ fontWeight: 500 }}>{title}</span>
      <span style={{ color: "#888", fontSize: 11 }}>{help}</span>
    </button>
  );
}

const btnSecondary: React.CSSProperties = {
  background: "#333",
  border: "1px solid #444",
  color: "#e0e0e0",
  padding: "6px 14px",
  borderRadius: 4,
  cursor: "pointer",
  fontSize: 13,
  fontFamily: "inherit",
};

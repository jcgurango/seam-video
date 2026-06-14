import React from "react";

interface ToastProps {
  /** One line per message. */
  messages: string[];
  /** "error" tints red, "info" neutral. */
  kind?: "error" | "info";
  onDismiss: () => void;
}

/**
 * Transient, dismissible notice anchored bottom-centre. Used for job-level
 * feedback (e.g. transcription warnings) that should NOT clear the editor the
 * way document validation errors do — those still render full-screen.
 */
export default function Toast({ messages, kind = "info", onDismiss }: ToastProps) {
  if (messages.length === 0) return null;
  const accent = kind === "error" ? "#b8434a" : "#4a7eb8";

  return (
    <div
      style={{
        position: "fixed",
        bottom: 72,
        left: "50%",
        transform: "translateX(-50%)",
        maxWidth: "min(560px, 90vw)",
        background: "#222",
        color: "#e0e0e0",
        border: `1px solid ${accent}`,
        borderLeft: `4px solid ${accent}`,
        borderRadius: 6,
        boxShadow: "0 8px 28px rgba(0,0,0,0.5)",
        fontFamily: "sans-serif",
        fontSize: 13,
        zIndex: 2500,
        display: "flex",
        alignItems: "flex-start",
        gap: 8,
        padding: "10px 12px",
      }}
    >
      <div style={{ display: "flex", flexDirection: "column", gap: 4, flex: 1 }}>
        {messages.map((m, i) => (
          <span key={i}>{m}</span>
        ))}
      </div>
      <button
        onClick={onDismiss}
        aria-label="Dismiss"
        style={{
          background: "none",
          border: "none",
          color: "#888",
          fontSize: 16,
          cursor: "pointer",
          lineHeight: 1,
          padding: 0,
        }}
      >
        ×
      </button>
    </div>
  );
}

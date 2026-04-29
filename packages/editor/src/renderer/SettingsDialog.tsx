import React, { useEffect, useState } from "react";
import { DEFAULT_SETTINGS, type Settings } from "./useSettings.js";

interface SettingsDialogProps {
  open: boolean;
  settings: Settings;
  onSave: (next: Partial<Settings>) => void;
  onReset: () => void;
  onClose: () => void;
}

export default function SettingsDialog({
  open,
  settings,
  onSave,
  onReset,
  onClose,
}: SettingsDialogProps) {
  // Local draft so we only commit on Save — typing into the field doesn't
  // immediately rewrite localStorage / re-render every consumer.
  const [draft, setDraft] = useState<Settings>(settings);

  useEffect(() => {
    if (open) setDraft(settings);
  }, [open, settings]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  const handleSave = () => {
    onSave(draft);
    onClose();
  };

  const handleReset = () => {
    setDraft(DEFAULT_SETTINGS);
  };

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
          width: 480,
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
          <strong>Settings</strong>
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
          <Field
            label="Generator Server URL"
            help="The Python backend used for transcription and audio enhancement."
            value={draft.generatorServerUrl}
            onChange={(v) =>
              setDraft((d) => ({ ...d, generatorServerUrl: v }))
            }
            placeholder="http://localhost:8000"
          />
        </div>

        <div
          style={{
            padding: 12,
            borderTop: "1px solid #333",
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            gap: 8,
          }}
        >
          <button
            onClick={() => {
              onReset();
              handleReset();
            }}
            style={btnSecondary}
          >
            Reset to defaults
          </button>
          <div style={{ display: "flex", gap: 8 }}>
            <button onClick={onClose} style={btnSecondary}>
              Cancel
            </button>
            <button onClick={handleSave} style={btnPrimary}>
              Save
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function Field({
  label,
  help,
  value,
  onChange,
  placeholder,
}: {
  label: string;
  help?: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
}) {
  return (
    <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <span style={{ fontWeight: 500 }}>{label}</span>
      <input
        type="text"
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        style={{
          background: "#1a1a1a",
          border: "1px solid #444",
          borderRadius: 4,
          color: "#e0e0e0",
          padding: "6px 8px",
          fontSize: 13,
          fontFamily: "ui-monospace, monospace",
        }}
      />
      {help && <span style={{ color: "#888", fontSize: 11 }}>{help}</span>}
    </label>
  );
}

const btnPrimary: React.CSSProperties = {
  background: "#4a7eb8",
  border: "none",
  color: "#fff",
  padding: "6px 14px",
  borderRadius: 4,
  cursor: "pointer",
  fontSize: 13,
  fontFamily: "inherit",
};

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

import React from "react";

/** Progress of a bulk media upload/download pass. */
export interface MediaSyncProgressState {
  /** "Uploading media" / "Downloading media". */
  title: string;
  done: number;
  total: number;
  /** The file currently in flight (or "" between/after items). */
  detail: string;
}

/** Modal progress bar for the Cloud menu's Upload/Download All Media (and the
 *  pre-export media download). Mirrors ExportProgressOverlay's look. */
export default function MediaSyncOverlay({
  progress,
}: {
  progress: MediaSyncProgressState;
}) {
  const { title, done, total, detail } = progress;
  const pct = total === 0 ? 0 : Math.round((done / total) * 100);

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
        <div style={{ fontSize: 14, fontWeight: 500, marginBottom: 4 }}>
          {title}…
        </div>
        <div
          style={{
            fontSize: 12,
            color: "#aaa",
            marginBottom: 14,
            minHeight: 16,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {total === 0
            ? "Preparing…"
            : `${Math.min(done + 1, total)} of ${total}${
                detail ? ` — ${detail}` : ""
              }`}
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

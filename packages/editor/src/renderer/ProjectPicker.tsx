import React, { useEffect, useState } from "react";
import type { WebPlatform, ProjectEntry } from "./platform/web.js";

type Props =
  | {
      platform: WebPlatform;
      mode: "open";
      onResolve: (result: { filePath: string; json: string } | null) => void;
      onClose: () => void;
    }
  | {
      platform: WebPlatform;
      mode: "save-as";
      onSavePath: (path: string | null) => void;
      onClose: () => void;
    };

export default function ProjectPicker(props: Props) {
  const { platform, mode, onClose } = props;
  const [projects, setProjects] = useState<ProjectEntry[]>([]);
  const [newName, setNewName] = useState("");
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    void platform.listProjects().then((list) => {
      setProjects(list);
      setLoaded(true);
    });
  }, [platform]);

  const handleOpen = async (name: string) => {
    if (mode !== "open") return;
    try {
      const json = await platform.readProject(name);
      props.onResolve({ filePath: `projects/${name}`, json });
    } catch (err) {
      alert(`Failed to open ${name}: ${err}`);
      props.onResolve(null);
    }
  };

  const handleSaveAs = () => {
    if (mode !== "save-as") return;
    const trimmed = newName.trim();
    if (!trimmed) return;
    const name = trimmed.endsWith(".seam") ? trimmed : `${trimmed}.seam`;
    props.onSavePath(`projects/${name}`);
  };

  return (
    <div
      onClick={onClose}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0, 0, 0, 0.6)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 1000,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: "#1e1e1e",
          color: "#fff",
          borderRadius: 8,
          padding: 20,
          minWidth: 360,
          maxWidth: 480,
          maxHeight: "80vh",
          display: "flex",
          flexDirection: "column",
          fontFamily: "sans-serif",
          boxShadow: "0 20px 60px rgba(0,0,0,0.5)",
        }}
      >
        <h3 style={{ margin: 0, marginBottom: 12, fontSize: 16 }}>
          {mode === "open" ? "Open Project" : "Save Project As"}
        </h3>

        {mode === "open" && (
          <div style={{ overflowY: "auto", flex: 1, marginBottom: 12 }}>
            {!loaded ? (
              <div style={{ color: "#999" }}>Loading…</div>
            ) : projects.length === 0 ? (
              <div style={{ color: "#999" }}>No projects yet. Create one via Save As.</div>
            ) : (
              <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
                {projects.map((p) => (
                  <li key={p.name}>
                    <button
                      onClick={() => handleOpen(p.name)}
                      style={{
                        width: "100%",
                        padding: "8px 12px",
                        background: "none",
                        border: "1px solid #333",
                        color: "#fff",
                        cursor: "pointer",
                        textAlign: "left",
                        marginBottom: 4,
                        borderRadius: 4,
                        fontSize: 13,
                      }}
                    >
                      {p.name}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}

        {mode === "save-as" && (
          <div style={{ marginBottom: 12 }}>
            <input
              type="text"
              autoFocus
              placeholder="Project name"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") handleSaveAs();
              }}
              style={{
                width: "100%",
                padding: "8px 12px",
                background: "#111",
                border: "1px solid #333",
                color: "#fff",
                borderRadius: 4,
                fontSize: 13,
                boxSizing: "border-box",
              }}
            />
          </div>
        )}

        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
          <button
            onClick={onClose}
            style={{
              padding: "6px 14px",
              background: "none",
              border: "1px solid #555",
              color: "#fff",
              cursor: "pointer",
              borderRadius: 4,
              fontSize: 13,
            }}
          >
            Cancel
          </button>
          {mode === "save-as" && (
            <button
              onClick={handleSaveAs}
              disabled={!newName.trim()}
              style={{
                padding: "6px 14px",
                background: "#3a6ea5",
                border: "1px solid #4a8ed0",
                color: "#fff",
                cursor: "pointer",
                borderRadius: 4,
                fontSize: 13,
                opacity: newName.trim() ? 1 : 0.5,
              }}
            >
              Save
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

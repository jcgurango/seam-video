import React, { useEffect, useState, useCallback } from "react";
import { Plus, FileText, Trash2 } from "lucide-react";
import type { WebPlatform, ProjectEntry } from "./platform/web.js";

interface ProjectBrowserProps {
  platform: WebPlatform;
  onOpen: (filePath: string, json: string) => void;
  onNew: () => void;
}

function formatRelative(ts: number): string {
  const diff = Date.now() - ts;
  const s = Math.floor(diff / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d}d ago`;
  return new Date(ts).toLocaleDateString();
}

function formatAbsolute(ts: number): string {
  return new Date(ts).toLocaleString();
}

export default function ProjectBrowser({
  platform,
  onOpen,
  onNew,
}: ProjectBrowserProps) {
  const [projects, setProjects] = useState<ProjectEntry[] | null>(null);

  const refresh = useCallback(() => {
    void platform.listProjects().then(setProjects);
  }, [platform]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const handleOpen = useCallback(
    async (name: string) => {
      try {
        const json = await platform.readProject(name);
        onOpen(`projects/${name}`, json);
      } catch (err) {
        alert(`Could not open ${name}: ${err}`);
      }
    },
    [platform, onOpen]
  );

  const handleDelete = useCallback(
    async (name: string) => {
      if (!confirm(`Delete "${name}"? This cannot be undone.`)) return;
      try {
        await platform.deleteProject(name);
        refresh();
      } catch (err) {
        alert(`Could not delete: ${err}`);
      }
    },
    [platform, refresh]
  );

  return (
    <div
      style={{
        flex: 1,
        minHeight: 0,
        background: "#1a1a1a",
        color: "#fff",
        fontFamily: "sans-serif",
        display: "flex",
        flexDirection: "column",
        overflow: "hidden",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "20px 28px",
          borderBottom: "1px solid #2a2a2a",
        }}
      >
        <h2 style={{ margin: 0, fontSize: 18, fontWeight: 500 }}>Projects</h2>
        <button
          onClick={onNew}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 6,
            background: "#3a6ea5",
            border: "1px solid #4a8ed0",
            color: "#fff",
            padding: "8px 14px",
            borderRadius: 6,
            cursor: "pointer",
            fontSize: 13,
            fontWeight: 500,
          }}
        >
          <Plus size={16} />
          New Project
        </button>
      </div>

      <div style={{ flex: 1, overflowY: "auto", padding: "16px 28px" }}>
        {projects === null ? (
          <div style={{ color: "#888", padding: 16 }}>Loading…</div>
        ) : projects.length === 0 ? (
          <div
            style={{
              padding: 48,
              textAlign: "center",
              color: "#888",
            }}
          >
            <FileText size={36} style={{ opacity: 0.4, marginBottom: 12 }} />
            <div style={{ fontSize: 14, marginBottom: 4 }}>
              No projects yet.
            </div>
            <div style={{ fontSize: 12 }}>
              Click "New Project" to get started.
            </div>
          </div>
        ) : (
          <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
            {projects.map((p) => (
              <li key={p.name}>
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 12,
                    padding: "12px 14px",
                    borderBottom: "1px solid #252525",
                    cursor: "pointer",
                  }}
                  onClick={() => handleOpen(p.name)}
                  onMouseEnter={(e) =>
                    (e.currentTarget.style.background = "#222")
                  }
                  onMouseLeave={(e) =>
                    (e.currentTarget.style.background = "transparent")
                  }
                >
                  <FileText size={18} style={{ color: "#6aa8e0" }} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div
                      style={{
                        fontSize: 14,
                        fontWeight: 500,
                        whiteSpace: "nowrap",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                      }}
                    >
                      {p.name.replace(/\.seam$/, "")}
                    </div>
                    <div
                      style={{
                        fontSize: 11,
                        color: "#888",
                        marginTop: 2,
                      }}
                      title={formatAbsolute(p.lastModified)}
                    >
                      Modified {formatRelative(p.lastModified)}
                    </div>
                  </div>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      handleDelete(p.name);
                    }}
                    title="Delete"
                    style={{
                      background: "none",
                      border: "none",
                      color: "#666",
                      cursor: "pointer",
                      padding: 6,
                      borderRadius: 4,
                      display: "flex",
                    }}
                    onMouseEnter={(e) =>
                      (e.currentTarget.style.color = "#ff6b6b")
                    }
                    onMouseLeave={(e) =>
                      (e.currentTarget.style.color = "#666")
                    }
                  >
                    <Trash2 size={16} />
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

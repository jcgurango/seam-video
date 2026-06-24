import React, { useEffect, useState, useCallback } from "react";
import { Plus, FileText, Trash2, Download } from "lucide-react";
import type { WebPlatform, ProjectEntry } from "./platform/web.js";
import MediaBrowser from "./MediaBrowser.js";
import { routePath, tabRoute } from "./webRouting.js";

type Tab = "projects" | "media";

interface ProjectBrowserProps {
  platform: WebPlatform;
  onOpen: (filePath: string, json: string) => void;
  onNew: () => void;
  /** Active landing tab (controlled by App, mirrored to the URL). */
  tab: Tab;
  onTabChange: (tab: Tab) => void;
}

/** A click that should open in a new tab / window — let the browser handle the
 *  anchor's href instead of doing in-app navigation. */
function isModifiedClick(e: React.MouseEvent): boolean {
  return e.metaKey || e.ctrlKey || e.shiftKey || e.altKey;
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
  tab,
  onTabChange,
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

  const handleDownload = useCallback(
    (name: string) => {
      void platform.downloadProject(name);
    },
    [platform]
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
        <div style={{ display: "flex", gap: 4 }}>
          <TabButton
            active={tab === "projects"}
            href={routePath(tabRoute("projects"))}
            onSelect={() => onTabChange("projects")}
          >
            Projects
          </TabButton>
          <TabButton
            active={tab === "media"}
            href={routePath(tabRoute("media"))}
            onSelect={() => onTabChange("media")}
          >
            Media
          </TabButton>
        </div>
        {tab === "projects" && (
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
        )}
      </div>

      {tab === "media" ? (
        <MediaBrowser platform={platform} variant="main" />
      ) : (
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
                <li
                  key={p.name}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    borderBottom: "1px solid #252525",
                  }}
                  onMouseEnter={(e) =>
                    (e.currentTarget.style.background = "#222")
                  }
                  onMouseLeave={(e) =>
                    (e.currentTarget.style.background = "transparent")
                  }
                >
                  {/* Real anchor so Ctrl/⌘/middle-click opens the project in a
                      new tab; a plain click navigates in-app. */}
                  <a
                    href={routePath({ kind: "project", name: p.name })}
                    onClick={(e) => {
                      if (isModifiedClick(e)) return;
                      e.preventDefault();
                      handleOpen(p.name);
                    }}
                    style={{
                      flex: 1,
                      minWidth: 0,
                      display: "flex",
                      alignItems: "center",
                      gap: 12,
                      padding: "12px 14px",
                      color: "inherit",
                      textDecoration: "none",
                      cursor: "pointer",
                    }}
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
                        style={{ fontSize: 11, color: "#888", marginTop: 2 }}
                        title={formatAbsolute(p.lastModified)}
                      >
                        Modified {formatRelative(p.lastModified)}
                      </div>
                    </div>
                  </a>
                  <div style={{ display: "flex", paddingRight: 14 }}>
                    <RowAction
                      title="Download"
                      onClick={() => handleDownload(p.name)}
                    >
                      <Download size={16} />
                    </RowAction>
                    <RowAction
                      title="Delete"
                      danger
                      onClick={() => handleDelete(p.name)}
                    >
                      <Trash2 size={16} />
                    </RowAction>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

function TabButton({
  active,
  href,
  onSelect,
  children,
}: {
  active: boolean;
  href: string;
  onSelect: () => void;
  children: React.ReactNode;
}) {
  return (
    <a
      href={href}
      onClick={(e) => {
        if (isModifiedClick(e)) return;
        e.preventDefault();
        onSelect();
      }}
      style={{
        background: active ? "#2e2e2e" : "transparent",
        border: "1px solid",
        borderColor: active ? "#3a3a3a" : "transparent",
        color: active ? "#fff" : "#999",
        padding: "6px 14px",
        borderRadius: 6,
        cursor: "pointer",
        fontSize: 14,
        fontWeight: 500,
        textDecoration: "none",
      }}
    >
      {children}
    </a>
  );
}

/** Trailing icon action on a project row (download / delete). */
function RowAction({
  title,
  onClick,
  danger,
  children,
}: {
  title: string;
  onClick: () => void;
  danger?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      title={title}
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
        (e.currentTarget.style.color = danger ? "#ff6b6b" : "#fff")
      }
      onMouseLeave={(e) => (e.currentTarget.style.color = "#666")}
    >
      {children}
    </button>
  );
}

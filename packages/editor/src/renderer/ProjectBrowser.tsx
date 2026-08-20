import React, { useEffect, useMemo, useState, useCallback } from "react";
import {
  Plus,
  FileText,
  Trash2,
  Download,
  UploadCloud,
  DownloadCloud,
  AlertTriangle,
  Check,
} from "lucide-react";
import "./monacoSetup.js";
import { DiffEditor } from "@monaco-editor/react";
import type {
  WebPlatform,
  ProjectEntry,
  ProjectSyncStatus,
  ImportFilesResult,
} from "./platform/web.js";
import { describeImportResult } from "./platform/web.js";
import type { CloudClient, CloudProject } from "./cloud/CloudClient.js";
import { useCloud } from "./cloud/useCloud.js";
import MediaBrowser from "./MediaBrowser.js";
import { routePath, tabRoute } from "./webRouting.js";

type Tab = "projects" | "media";

/** A project as shown in the merged local+cloud list. */
interface ProjectRow {
  name: string;
  lastModified: number;
  hasLocal: boolean;
  cloud: CloudProject | null;
}

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

/**
 * Files from a drop, expanding dropped folders. Entries must be grabbed
 * synchronously (DataTransferItems die when the event returns); the
 * directory traversal itself is async. `readEntries` hands back batches of
 * ≤100, so drain until an empty batch.
 */
async function filesFromDataTransfer(dt: DataTransfer): Promise<File[]> {
  const entries: FileSystemEntry[] = [];
  const plain: File[] = [];
  for (const item of Array.from(dt.items)) {
    if (item.kind !== "file") continue;
    const entry = item.webkitGetAsEntry?.() ?? null;
    if (entry) entries.push(entry);
    else {
      const f = item.getAsFile();
      if (f) plain.push(f);
    }
  }
  if (entries.length === 0) {
    return plain.length > 0 ? plain : Array.from(dt.files);
  }
  const out: File[] = [...plain];
  const walk = async (entry: FileSystemEntry): Promise<void> => {
    if (entry.isFile) {
      const f = await new Promise<File | null>((res) =>
        (entry as FileSystemFileEntry).file(res, () => res(null))
      );
      if (f) out.push(f);
    } else if (entry.isDirectory) {
      const reader = (entry as FileSystemDirectoryEntry).createReader();
      for (;;) {
        const batch = await new Promise<FileSystemEntry[]>((res) =>
          reader.readEntries(res, () => res([]))
        );
        if (batch.length === 0) break;
        for (const e of batch) await walk(e);
      }
    }
  };
  for (const e of entries) await walk(e);
  return out;
}

export default function ProjectBrowser({
  platform,
  onOpen,
  onNew,
  tab,
  onTabChange,
}: ProjectBrowserProps) {
  const cloud = platform.cloud;
  const cloudState = useCloud(cloud);
  const cloudAuthed = !!cloud && cloudState?.status === "authed";

  const [projects, setProjects] = useState<ProjectEntry[] | null>(null);
  const [states, setStates] = useState<Record<string, ProjectSyncStatus>>({});
  const [reloadKey, setReloadKey] = useState(0);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [outOfSync, setOutOfSync] = useState<ProjectRow | null>(null);

  // Page-wide file drop (both tabs): media lands in clips/, .seam files
  // become projects (batch-aware rename rewriting — see importFiles).
  const [dropDepth, setDropDepth] = useState(0);
  const [importing, setImporting] = useState(false);
  const [importNotice, setImportNotice] = useState<string | null>(null);
  const [mediaReloadKey, setMediaReloadKey] = useState(0);

  const handleImported = useCallback((res: ImportFilesResult) => {
    // Media-tab uploads can contain .seam files too — refresh both lists.
    if (res.projects.length > 0) setReloadKey((k) => k + 1);
  }, []);

  const runImport = useCallback(
    async (files: File[]) => {
      if (files.length === 0 || importing) return;
      setImporting(true);
      setImportNotice(null);
      try {
        const res = await platform.importFiles(files);
        setReloadKey((k) => k + 1);
        setMediaReloadKey((k) => k + 1);
        setImportNotice(describeImportResult(res));
      } catch (err) {
        setImportNotice(`Import failed: ${errMessage(err)}`);
      } finally {
        setImporting(false);
      }
    },
    [platform, importing]
  );

  const dragHasFiles = (e: React.DragEvent) =>
    Array.from(e.dataTransfer.types).includes("Files");

  useEffect(() => {
    void platform.listProjects().then(setProjects);
  }, [platform, reloadKey]);

  // Merge local + cloud projects into one list (by filename).
  const merged = useMemo<ProjectRow[]>(() => {
    const local = projects ?? [];
    const localNames = new Set(local.map((p) => p.name));
    const cloudProjects = cloudState?.projects ?? [];
    const cloudByName = new Map(cloudProjects.map((c) => [c.name, c]));
    const rows: ProjectRow[] = local.map((p) => ({
      name: p.name,
      lastModified: p.lastModified,
      hasLocal: true,
      cloud: cloudByName.get(p.name) ?? null,
    }));
    for (const c of cloudProjects) {
      if (!localNames.has(c.name)) {
        rows.push({ name: c.name, lastModified: c.lastModified, hasLocal: false, cloud: c });
      }
    }
    return rows.sort((a, b) => b.lastModified - a.lastModified);
  }, [projects, cloudState]);

  // Compute each project's sync status (three-way hash compare) off-thread of
  // render; recomputes whenever the merged set changes.
  useEffect(() => {
    if (projects === null) return;
    let cancelled = false;
    (async () => {
      const next: Record<string, ProjectSyncStatus> = {};
      for (const r of merged) {
        next[r.name] = (await platform.projectSyncState(r.name)).status;
      }
      if (!cancelled) setStates(next);
    })();
    return () => {
      cancelled = true;
    };
  }, [merged, platform, projects]);

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
      if (!confirm(`Delete the local copy of "${name}"?`)) return;
      try {
        await platform.deleteProject(name);
        setReloadKey((k) => k + 1);
      } catch (err) {
        alert(`Could not delete: ${err}`);
      }
    },
    [platform]
  );

  const handleDownload = useCallback(
    (name: string) => {
      void platform.downloadProject(name);
    },
    [platform]
  );

  const handleUpload = async (name: string) => {
    setBusy(name);
    setNotice(null);
    try {
      const r = await platform.uploadProjectToCloud(name);
      if (r.kind === "name-exists") setNotice(`Couldn't upload "${name}": ${r.message}`);
      setReloadKey((k) => k + 1);
    } catch (err) {
      setNotice(`Upload failed for "${name}": ${errMessage(err)}`);
    } finally {
      setBusy(null);
    }
  };

  const handleCloudDownload = async (row: ProjectRow) => {
    if (!row.cloud) return;
    setBusy(row.name);
    setNotice(null);
    try {
      await platform.downloadProjectFromCloud(row.cloud);
      setReloadKey((k) => k + 1);
    } catch (err) {
      setNotice(`Download failed for "${row.name}": ${errMessage(err)}`);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div
      onDragEnter={(e) => {
        if (!dragHasFiles(e)) return;
        e.preventDefault();
        setDropDepth((d) => d + 1);
      }}
      onDragOver={(e) => {
        if (!dragHasFiles(e)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = "copy";
      }}
      onDragLeave={(e) => {
        if (!dragHasFiles(e)) return;
        setDropDepth((d) => Math.max(0, d - 1));
      }}
      onDrop={(e) => {
        if (!dragHasFiles(e)) return;
        e.preventDefault();
        setDropDepth(0);
        void filesFromDataTransfer(e.dataTransfer).then(runImport);
      }}
      style={{
        flex: 1,
        minHeight: 0,
        background: "#1a1a1a",
        color: "#fff",
        fontFamily: "sans-serif",
        display: "flex",
        flexDirection: "column",
        overflow: "hidden",
        position: "relative",
      }}
    >
      {(dropDepth > 0 || importing) && (
        <div
          style={{
            position: "absolute",
            inset: 0,
            zIndex: 100,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            background: "rgba(26,26,26,0.85)",
            border: "2px dashed #4a8ed0",
            borderRadius: 8,
            margin: 8,
            pointerEvents: "none",
            fontSize: 15,
            color: "#cfe3f7",
          }}
        >
          {importing
            ? "Importing…"
            : "Drop media and .seam files to add them to Seam"}
        </div>
      )}
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

      {importNotice && (
        <div
          style={{
            display: "flex",
            gap: 8,
            margin: "10px 28px 0",
            padding: "8px 12px",
            fontSize: 12,
            color: "#ddd",
            background: "#222",
            border: "1px solid #3a3a3a",
            borderRadius: 6,
            flexShrink: 0,
          }}
        >
          <span style={{ flex: 1 }}>{importNotice}</span>
          <button
            onClick={() => setImportNotice(null)}
            style={{
              background: "none",
              border: "none",
              color: "#888",
              cursor: "pointer",
              padding: 0,
              fontSize: 14,
              lineHeight: 1,
            }}
          >
            ✕
          </button>
        </div>
      )}

      {tab === "media" ? (
        <MediaBrowser
          platform={platform}
          variant="main"
          externalReloadKey={mediaReloadKey}
          onImported={handleImported}
        />
      ) : (
        <div style={{ flex: 1, overflowY: "auto", padding: "16px 28px" }}>
          {notice && (
            <div
              style={{
                display: "flex",
                gap: 8,
                marginBottom: 12,
                padding: "8px 12px",
                fontSize: 12,
                color: "#ddd",
                background: "#222",
                border: "1px solid #3a3a3a",
                borderRadius: 6,
              }}
            >
              <span style={{ flex: 1 }}>{notice}</span>
              <button
                onClick={() => setNotice(null)}
                style={{ background: "none", border: "none", color: "#888", cursor: "pointer" }}
              >
                ✕
              </button>
            </div>
          )}
          {projects === null ? (
            <div style={{ color: "#888", padding: 16 }}>Loading…</div>
          ) : merged.length === 0 ? (
            <div style={{ padding: 48, textAlign: "center", color: "#888" }}>
              <FileText size={36} style={{ opacity: 0.4, marginBottom: 12 }} />
              <div style={{ fontSize: 14, marginBottom: 4 }}>No projects yet.</div>
              <div style={{ fontSize: 12 }}>Click "New Project" to get started.</div>
            </div>
          ) : (
            <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
              {merged.map((row) => (
                <ProjectRowItem
                  key={row.name}
                  row={row}
                  status={
                    states[row.name] ?? (row.hasLocal ? "local-only" : "cloud-only")
                  }
                  cloudAuthed={cloudAuthed}
                  busy={busy === row.name}
                  onOpen={handleOpen}
                  onBrowserDownload={handleDownload}
                  onDelete={handleDelete}
                  onUpload={handleUpload}
                  onCloudDownload={handleCloudDownload}
                  onResolve={() => setOutOfSync(row)}
                />
              ))}
            </ul>
          )}
        </div>
      )}

      {outOfSync && cloud && outOfSync.cloud && (
        <OutOfSyncDialog
          platform={platform}
          cloud={cloud}
          name={outOfSync.name}
          project={outOfSync.cloud}
          localModified={outOfSync.lastModified}
          onClose={() => setOutOfSync(null)}
          onResolved={() => {
            // Landing screen — no open document to reload, so the kept side
            // doesn't matter here.
            setOutOfSync(null);
            setReloadKey((k) => k + 1);
          }}
        />
      )}
    </div>
  );
}

// ── Project row + sync status ──────────────────────────────────────

interface StatusInfo {
  label: string;
  color: string;
}

function statusInfo(status: ProjectSyncStatus): StatusInfo {
  switch (status) {
    case "in-sync":
      return { label: "Synced", color: "#5ec98a" };
    case "local-only":
      return { label: "Local only", color: "#888" };
    case "cloud-only":
      return { label: "Cloud", color: "#6aa8e0" };
    case "local-ahead":
      return { label: "Local changes", color: "#d9a441" };
    case "remote-ahead":
      return { label: "Cloud changes", color: "#6aa8e0" };
    case "out-of-sync":
      return { label: "Out of sync", color: "#ff6b6b" };
  }
}

function ProjectRowItem({
  row,
  status,
  cloudAuthed,
  busy,
  onOpen,
  onBrowserDownload,
  onDelete,
  onUpload,
  onCloudDownload,
  onResolve,
}: {
  row: ProjectRow;
  status: ProjectSyncStatus;
  cloudAuthed: boolean;
  busy: boolean;
  onOpen: (name: string) => void;
  onBrowserDownload: (name: string) => void;
  onDelete: (name: string) => void;
  onUpload: (name: string) => void;
  onCloudDownload: (row: ProjectRow) => void;
  onResolve: () => void;
}) {
  const info = statusInfo(status);
  const face = (
    <>
      <FileText size={18} style={{ color: "#6aa8e0", flexShrink: 0 }} />
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
          {row.name.replace(/\.seam$/, "")}
        </div>
        <div
          style={{ fontSize: 11, color: "#888", marginTop: 2 }}
          title={formatAbsolute(row.lastModified)}
        >
          Modified {formatRelative(row.lastModified)}
        </div>
      </div>
    </>
  );

  const faceStyle: React.CSSProperties = {
    flex: 1,
    minWidth: 0,
    display: "flex",
    alignItems: "center",
    gap: 12,
    padding: "12px 14px",
    color: "inherit",
    textDecoration: "none",
  };

  return (
    <li
      style={{ display: "flex", alignItems: "center", borderBottom: "1px solid #252525" }}
      onMouseEnter={(e) => (e.currentTarget.style.background = "#222")}
      onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
    >
      {row.hasLocal ? (
        // Real anchor so Ctrl/⌘/middle-click opens in a new tab.
        <a
          href={routePath({ kind: "project", name: row.name })}
          onClick={(e) => {
            if (isModifiedClick(e)) return;
            e.preventDefault();
            onOpen(row.name);
          }}
          style={{ ...faceStyle, cursor: "pointer" }}
        >
          {face}
        </a>
      ) : (
        <div style={{ ...faceStyle, cursor: "default" }} title="Download to open">
          {face}
        </div>
      )}

      <div style={{ display: "flex", alignItems: "center", gap: 6, paddingRight: 14 }}>
        <span
          style={{
            fontSize: 11,
            color: info.color,
            border: `1px solid ${info.color}55`,
            borderRadius: 999,
            padding: "1px 8px",
            whiteSpace: "nowrap",
          }}
        >
          {info.label}
        </span>
        {cloudAuthed && status === "out-of-sync" && (
          <RowAction title="Reconcile — out of sync" onClick={onResolve}>
            <AlertTriangle size={16} color="#ff8a5b" />
          </RowAction>
        )}
        {cloudAuthed && (status === "local-only" || status === "local-ahead") && (
          <RowAction
            title="Upload to Seam Cloud"
            disabled={busy}
            onClick={() => onUpload(row.name)}
          >
            <UploadCloud size={16} />
          </RowAction>
        )}
        {cloudAuthed && (status === "cloud-only" || status === "remote-ahead") && (
          <RowAction
            title="Download from Seam Cloud"
            disabled={busy}
            onClick={() => onCloudDownload(row)}
          >
            <DownloadCloud size={16} />
          </RowAction>
        )}
        {cloudAuthed && status === "in-sync" && (
          <Check size={16} color="#5ec98a" style={{ opacity: 0.8 }} />
        )}
        {row.hasLocal && (
          <RowAction title="Download file" onClick={() => onBrowserDownload(row.name)}>
            <Download size={16} />
          </RowAction>
        )}
        {row.hasLocal && (
          <RowAction title="Delete local copy" danger onClick={() => onDelete(row.name)}>
            <Trash2 size={16} />
          </RowAction>
        )}
      </div>
    </li>
  );
}

/** Reconcile an out-of-sync project: side-by-side Monaco diff of cloud vs
 *  local, with Keep Remote (pull cloud) / Keep Local (push local). Surfaces
 *  each side's modification date to inform the choice. No manual merge.
 *  `onResolved` reports which side was kept so a caller editing the open
 *  project can reload it when the local copy was overwritten ("remote"). */
export function OutOfSyncDialog({
  platform,
  cloud,
  name,
  project,
  localModified,
  onClose,
  onResolved,
}: {
  platform: WebPlatform;
  cloud: CloudClient;
  name: string;
  project: CloudProject;
  localModified: number;
  onClose: () => void;
  onResolved: (side: "local" | "remote") => void;
}) {
  const [local, setLocal] = useState<string | null>(null);
  const [remote, setRemote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [l, r] = await Promise.all([
          platform.readProject(name),
          cloud.projectText(project.id),
        ]);
        if (!cancelled) {
          setLocal(l);
          setRemote(r);
        }
      } catch (err) {
        if (!cancelled) setError(errMessage(err));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [platform, cloud, name, project.id]);

  const resolve = async (
    side: "local" | "remote",
    fn: () => Promise<unknown>
  ) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      onResolved(side);
    } catch (err) {
      setError(errMessage(err));
      setBusy(false);
    }
  };

  const loaded = local !== null && remote !== null;

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.6)",
        display: "flex",
        flexDirection: "column",
        padding: 32,
        zIndex: 2000,
      }}
      onMouseDown={onClose}
    >
      <div
        style={{
          flex: 1,
          minHeight: 0,
          display: "flex",
          flexDirection: "column",
          background: "#1f1f1f",
          border: "1px solid #333",
          borderRadius: 10,
          overflow: "hidden",
        }}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div style={{ padding: "14px 18px", borderBottom: "1px solid #333" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 15, color: "#fff" }}>
            <AlertTriangle size={16} color="#ff8a5b" />
            Out of sync — {name.replace(/\.seam$/, "")}
          </div>
          <div style={{ fontSize: 12, color: "#888", marginTop: 4 }}>
            Changed both locally and on Seam Cloud since the last sync. Left = the
            cloud copy · Right = your local copy (matching the buttons below).
          </div>
        </div>

        {/* Per-side modification dates, aligned with the diff panels below. */}
        <div
          style={{
            display: "flex",
            fontSize: 12,
            color: "#aaa",
            borderBottom: "1px solid #333",
          }}
        >
          <div style={{ flex: 1, padding: "8px 18px", borderRight: "1px solid #333" }}>
            <strong style={{ color: "#6aa8e0" }}>Cloud</strong> · updated{" "}
            <span title={formatAbsolute(project.updatedAt)}>
              {formatRelative(project.updatedAt)}
            </span>
          </div>
          <div style={{ flex: 1, padding: "8px 18px" }}>
            <strong style={{ color: "#ddd" }}>Local</strong> · modified{" "}
            <span title={formatAbsolute(localModified)}>
              {formatRelative(localModified)}
            </span>
          </div>
        </div>

        <div style={{ flex: 1, minHeight: 0 }}>
          {error ? (
            <div style={{ color: "#ff6b6b", padding: 18 }}>{error}</div>
          ) : loaded ? (
            <DiffEditor
              original={remote ?? ""}
              modified={local ?? ""}
              language="json"
              theme="vs-dark"
              height="100%"
              options={{
                readOnly: true,
                renderSideBySide: true,
                minimap: { enabled: false },
                scrollBeyondLastLine: false,
              }}
            />
          ) : (
            <div style={{ color: "#888", padding: 18 }}>Loading diff…</div>
          )}
        </div>

        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            padding: "12px 18px",
            borderTop: "1px solid #333",
          }}
        >
          <span style={{ flex: 1, fontSize: 12, color: "#888" }}>
            Keep one side; the other is overwritten.
          </span>
          <button onClick={onClose} disabled={busy} style={dialogBtn(false)}>
            Cancel
          </button>
          <button
            onClick={() =>
              resolve("remote", () => platform.downloadProjectFromCloud(project))
            }
            disabled={busy || !loaded}
            style={dialogBtn(false)}
          >
            Keep Remote
          </button>
          <button
            onClick={() =>
              resolve("local", () => platform.uploadProjectToCloud(name))
            }
            disabled={busy || !loaded}
            style={dialogBtn(true)}
          >
            Keep Local
          </button>
        </div>
      </div>
    </div>
  );
}

function dialogBtn(primary: boolean): React.CSSProperties {
  return {
    background: primary ? "#3a6ea5" : "#2e2e2e",
    border: `1px solid ${primary ? "#4a8ed0" : "#3a3a3a"}`,
    color: "#fff",
    padding: "8px 16px",
    borderRadius: 6,
    cursor: "pointer",
    fontSize: 13,
  };
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
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

/** Trailing icon action on a project row (upload / download / delete). */
function RowAction({
  title,
  onClick,
  danger,
  disabled,
  children,
}: {
  title: string;
  onClick: () => void;
  danger?: boolean;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      disabled={disabled}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      title={title}
      style={{
        background: "none",
        border: "none",
        color: "#666",
        cursor: disabled ? "default" : "pointer",
        opacity: disabled ? 0.4 : 1,
        padding: 6,
        borderRadius: 4,
        display: "flex",
      }}
      onMouseEnter={(e) => {
        if (!disabled) e.currentTarget.style.color = danger ? "#ff6b6b" : "#fff";
      }}
      onMouseLeave={(e) => (e.currentTarget.style.color = "#666")}
    >
      {children}
    </button>
  );
}

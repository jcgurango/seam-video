import React, { useEffect, useRef, useState } from "react";
import {
  Cloud,
  RefreshCw,
  UploadCloud,
  DownloadCloud,
  FileDown,
  FileUp,
  AlertTriangle,
} from "lucide-react";
import type { SeamFile } from "@seam/core";
import type { WebPlatform, ProjectSyncStatus } from "../platform/web.js";
import type { CloudClient, CloudProject } from "./CloudClient.js";
import { useCloud } from "./useCloud.js";
import { OutOfSyncDialog } from "../ProjectBrowser.js";
import MediaSyncOverlay, {
  type MediaSyncProgressState,
} from "../MediaSyncOverlay.js";

interface CloudMenuProps {
  platform: WebPlatform;
  client: CloudClient;
  /** Filename of the open project (e.g. "intro.seam"), or null if unsaved. */
  projectName: string | null;
  /** The live document — read lazily when an action runs. */
  getDoc: () => SeamFile;
  /** Called after a project download replaces the open project on disk, so the
   *  app can reload it into the editor. */
  onProjectDownloaded?: () => void;
  /** Called after Import Remote .seam wrote a project into `projects/`, so the
   *  app can open it (same shape `openFromJson` takes). */
  onProjectImported?: (result: { filePath: string; json: string }) => void;
}

const STATUS_LABEL: Record<ProjectSyncStatus, string> = {
  "local-only": "Not uploaded",
  "cloud-only": "On cloud only",
  "in-sync": "In sync",
  "local-ahead": "Local changes",
  "remote-ahead": "Cloud changes",
  "out-of-sync": "Out of sync",
};

const STATUS_COLOR: Record<ProjectSyncStatus, string> = {
  "local-only": "#888",
  "cloud-only": "#6aa8e0",
  "in-sync": "#5ec98a",
  "local-ahead": "#d9a441",
  "remote-ahead": "#6aa8e0",
  "out-of-sync": "#ff6b6b",
};

interface ReconcileTarget {
  name: string;
  project: CloudProject;
  localModified: number;
}

/**
 * "Cloud" top-bar menu (web). Operates on the open project: sync the .seam
 * document, and bulk upload/download the media it references. Self-contained —
 * owns its progress modal, out-of-sync reconcile dialog, and a result toast.
 */
export default function CloudMenu({
  platform,
  client,
  projectName,
  getDoc,
  onProjectDownloaded,
  onProjectImported,
}: CloudMenuProps) {
  const state = useCloud(client);
  const authed = state?.status === "authed";

  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState<ProjectSyncStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [reconcile, setReconcile] = useState<ReconcileTarget | null>(null);
  // Blocking pre-Export-Remote upload pass (mirrors App's pre-export download).
  const [uploadProgress, setUploadProgress] =
    useState<MediaSyncProgressState | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const importRemoteInputRef = useRef<HTMLInputElement>(null);

  // Close on outside click / Escape.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  // Recompute the project's sync status whenever the menu is opened (and when
  // the cloud list refreshes underneath it).
  const refreshStatus = React.useCallback(async () => {
    if (!projectName || !authed) {
      setStatus(null);
      return;
    }
    try {
      setStatus((await platform.projectSyncState(projectName)).status);
    } catch {
      setStatus(null);
    }
  }, [platform, projectName, authed]);

  useEffect(() => {
    if (open) void refreshStatus();
  }, [open, refreshStatus, state]);

  const close = () => setOpen(false);

  const syncProject = async () => {
    close();
    if (!projectName) return;
    setBusy(true);
    setNotice(null);
    try {
      const st = (await platform.projectSyncState(projectName)).status;
      if (st === "in-sync") {
        setNotice("Project is already in sync.");
      } else if (st === "out-of-sync") {
        const project = client.projectByName(projectName);
        if (!project) {
          setNotice("Couldn't find the cloud copy to reconcile.");
        } else {
          const entry = (await platform.listProjects()).find(
            (p) => p.name === projectName
          );
          setReconcile({
            name: projectName,
            project,
            localModified: entry?.lastModified ?? Date.now(),
          });
        }
      } else if (st === "remote-ahead" || st === "cloud-only") {
        const project = client.projectByName(projectName);
        if (!project) {
          setNotice("Couldn't find the cloud copy to download.");
        } else {
          await platform.downloadProjectFromCloud(project);
          onProjectDownloaded?.();
          setNotice("Pulled the latest copy from Seam Cloud.");
        }
      } else {
        // local-only / local-ahead → push.
        const r = await platform.uploadProjectToCloud(projectName);
        setNotice(
          r.kind === "name-exists"
            ? `Couldn't upload: ${r.message}`
            : "Uploaded the project to Seam Cloud."
        );
      }
      await refreshStatus();
    } catch (err) {
      setNotice(errMessage(err));
    } finally {
      setBusy(false);
    }
  };

  // Media transfers go through the platform's persistent transfer queue —
  // the Media panel shows progress and offers cancel/retry.
  const queueMedia = async (
    op: (doc: SeamFile) => Promise<number>,
    noun: string,
    noneMessage: string
  ) => {
    close();
    setNotice(null);
    try {
      const queued = await op(getDoc());
      setNotice(
        queued === 0
          ? noneMessage
          : `Queued ${queued} ${noun}${queued === 1 ? "" : "s"} — see the Media panel for progress.`
      );
    } catch (err) {
      setNotice(errMessage(err));
    }
  };

  // Export Remote .seam: every source → its cloud streaming URL. Media the
  // cloud doesn't have yet must go up first (the URLs don't exist otherwise),
  // so offer to upload — declining aborts, like Export's download prompt.
  // Media that's in neither place can't be exported at all.
  const exportRemote = async () => {
    close();
    setNotice(null);
    setBusy(true);
    try {
      const doc = getDoc();
      const { localOnly, missing } = await platform.classifyProjectMedia(doc);
      if (missing.length > 0) {
        setNotice(
          `Couldn't export: ${describeList(missing)} ` +
            `${missing.length === 1 ? "isn't" : "aren't"} available locally or on Seam Cloud.`
        );
        return;
      }
      if (localOnly.length > 0) {
        const ok = window.confirm(
          `${describeList(localOnly)} ${localOnly.length === 1 ? "isn't" : "aren't"} ` +
            "on Seam Cloud yet. Upload now? (A remote .seam can only reference " +
            "media on the cloud.)"
        );
        if (!ok) return;
        setUploadProgress({ title: "Uploading media", done: 0, total: 0, detail: "" });
        let summary;
        try {
          summary = await platform.uploadProjectMedia(doc, (done, total, name) =>
            setUploadProgress({ title: "Uploading media", done, total, detail: name })
          );
        } finally {
          setUploadProgress(null);
        }
        if (summary.conflicts.length > 0) {
          setNotice(
            `Couldn't upload ${describeList(summary.conflicts.map((c) => c.name))}: ` +
              summary.conflicts[0].message
          );
          return;
        }
      }
      const { document, unresolved } = platform.buildRemoteDocument(doc);
      if (unresolved.length > 0) {
        setNotice(
          `Couldn't export: ${describeList(unresolved)} still ` +
            `${unresolved.length === 1 ? "has" : "have"} no cloud copy.`
        );
        return;
      }
      const stem = projectName
        ? projectName.replace(/\.seam$/, "")
        : "untitled";
      await platform.exportRemoteSeamFile(document, stem);
    } catch (err) {
      setNotice(errMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const triggerImportRemote = () => {
    close();
    importRemoteInputRef.current?.click();
  };

  // Import Remote .seam: cloud URLs → bare filenames (local copy if held, else
  // the cloud stream), then open it. Confirms before overwriting a project.
  const importRemote = async (file: File) => {
    setNotice(null);
    setBusy(true);
    try {
      const target = platform.remoteImportTargetName(file.name);
      if (await platform.projectExists(target)) {
        const ok = window.confirm(
          `"${target}" already exists in projects/. Importing will overwrite it. Continue?`
        );
        if (!ok) return;
      }
      const result = await platform.importRemoteSeamFile(file);
      onProjectImported?.(result);
      if (result.kept.length > 0) {
        setNotice(
          `Imported, but ${describeList(result.kept)} ` +
            `${result.kept.length === 1 ? "isn't" : "aren't"} on this cloud — kept as remote URL` +
            `${result.kept.length === 1 ? "" : "s"}.`
        );
      }
    } catch (err) {
      setNotice(errMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const items: MenuItem[] = [
    {
      label: "Sync Project",
      icon: <RefreshCw size={14} />,
      onClick: syncProject,
      disabled: busy || !authed || !projectName,
      badge:
        authed && status
          ? { text: STATUS_LABEL[status], color: STATUS_COLOR[status] }
          : undefined,
    },
    { separator: true },
    {
      label: "Download All Media",
      icon: <DownloadCloud size={14} />,
      onClick: () =>
        queueMedia(
          (doc) => platform.enqueueDownloadProjectMedia(doc),
          "download",
          "All project media is already local."
        ),
      disabled: busy || !authed,
    },
    {
      label: "Upload All Media",
      icon: <UploadCloud size={14} />,
      onClick: () =>
        queueMedia(
          (doc) => platform.enqueueUploadProjectMedia(doc),
          "upload",
          "All project media is already on the cloud."
        ),
      disabled: busy || !authed,
    },
    { separator: true },
    {
      // A .seam whose sources are all cloud streaming URLs (token attached),
      // for a final render that streams instead of downloading.
      label: "Export Remote .seam…",
      icon: <FileDown size={14} />,
      onClick: () => void exportRemote(),
      disabled: busy || !authed,
    },
    {
      label: "Import Remote .seam…",
      icon: <FileUp size={14} />,
      onClick: triggerImportRemote,
      disabled: busy || !authed,
    },
  ];

  const title = !authed
    ? "Sign in to Seam Cloud to sync"
    : undefined;

  return (
    <>
      <input
        ref={importRemoteInputRef}
        type="file"
        accept=".seam,application/json"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) void importRemote(file);
          e.target.value = "";
        }}
        style={{ display: "none" }}
      />
      <div ref={ref} style={{ position: "relative" }}>
        <button
          onClick={() => setOpen((v) => !v)}
          title={title}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 6,
            background: open ? "#2a2a2a" : "none",
            border: "none",
            color: "#e0e0e0",
            padding: "0 14px",
            height: "100%",
            cursor: "pointer",
            fontSize: 13,
          }}
        >
          <Cloud size={14} />
          Cloud
        </button>
        {open && (
          <div
            style={{
              position: "absolute",
              top: "100%",
              left: 0,
              background: "#2a2a2a",
              border: "1px solid #3a3a3a",
              borderRadius: 4,
              minWidth: 240,
              boxShadow: "0 8px 20px rgba(0,0,0,0.5)",
              zIndex: 1000,
              padding: "4px 0",
            }}
          >
            {items.map((item, i) =>
              item.separator ? (
                <div
                  key={i}
                  style={{ height: 1, background: "#3a3a3a", margin: "4px 0" }}
                />
              ) : (
                <button
                  key={i}
                  onClick={() => {
                    if (item.disabled) return;
                    item.onClick?.();
                  }}
                  disabled={item.disabled}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                    width: "100%",
                    padding: "6px 14px",
                    background: "none",
                    border: "none",
                    color: item.disabled ? "#666" : "#e0e0e0",
                    cursor: item.disabled ? "default" : "pointer",
                    fontSize: 13,
                    textAlign: "left",
                  }}
                  onMouseEnter={(e) => {
                    if (!item.disabled)
                      e.currentTarget.style.background = "#3a6ea5";
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.background = "transparent";
                  }}
                >
                  <span style={{ opacity: item.disabled ? 0.5 : 0.8, display: "flex" }}>
                    {item.icon}
                  </span>
                  <span style={{ flex: 1 }}>{item.label}</span>
                  {item.badge && (
                    <span
                      style={{
                        fontSize: 10,
                        color: item.badge.color,
                        border: `1px solid ${item.badge.color}55`,
                        borderRadius: 999,
                        padding: "1px 7px",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {item.badge.text}
                    </span>
                  )}
                </button>
              )
            )}
          </div>
        )}
      </div>

      {reconcile && (
        <OutOfSyncDialog
          platform={platform}
          cloud={client}
          name={reconcile.name}
          project={reconcile.project}
          localModified={reconcile.localModified}
          onClose={() => setReconcile(null)}
          onResolved={(side) => {
            setReconcile(null);
            if (side === "remote") onProjectDownloaded?.();
            setNotice(
              side === "remote"
                ? "Kept the cloud copy."
                : "Kept your local copy."
            );
            void refreshStatus();
          }}
        />
      )}

      {uploadProgress && <MediaSyncOverlay progress={uploadProgress} />}

      {notice && <CloudToast message={notice} onDismiss={() => setNotice(null)} />}
    </>
  );
}

/** `"a.mp4"` / `"a.mp4" and "b.mp4"` / `"a.mp4" and 3 more files`. */
function describeList(names: string[]): string {
  if (names.length === 1) return `"${names[0]}"`;
  if (names.length === 2) return `"${names[0]}" and "${names[1]}"`;
  return `"${names[0]}" and ${names.length - 1} more files`;
}

interface MenuItem {
  label?: string;
  icon?: React.ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  separator?: boolean;
  badge?: { text: string; color: string };
}

/** Bottom toast for a Cloud-menu result. Auto-dismisses after a while. */
function CloudToast({
  message,
  onDismiss,
}: {
  message: string;
  onDismiss: () => void;
}) {
  useEffect(() => {
    const t = setTimeout(onDismiss, 8000);
    return () => clearTimeout(t);
  }, [message, onDismiss]);

  const isWarn = /conflict|couldn't|fail|error/i.test(message);
  return (
    <div
      style={{
        position: "fixed",
        bottom: 20,
        left: "50%",
        transform: "translateX(-50%)",
        display: "flex",
        alignItems: "center",
        gap: 10,
        maxWidth: "70vw",
        background: "#1f1f1f",
        border: `1px solid ${isWarn ? "#7a4a3a" : "#3a3a3a"}`,
        borderRadius: 8,
        padding: "10px 14px",
        boxShadow: "0 10px 30px rgba(0,0,0,0.5)",
        zIndex: 2100,
        fontFamily: "sans-serif",
        fontSize: 13,
        color: "#e0e0e0",
      }}
    >
      {isWarn && <AlertTriangle size={15} color="#ff8a5b" style={{ flexShrink: 0 }} />}
      <span>{message}</span>
      <button
        onClick={onDismiss}
        style={{
          background: "none",
          border: "none",
          color: "#888",
          cursor: "pointer",
          fontSize: 13,
        }}
      >
        ✕
      </button>
    </div>
  );
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

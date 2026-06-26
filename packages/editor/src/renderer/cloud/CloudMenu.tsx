import React, { useEffect, useRef, useState } from "react";
import {
  Cloud,
  RefreshCw,
  UploadCloud,
  DownloadCloud,
  AlertTriangle,
} from "lucide-react";
import type { SeamFile } from "@seam/core";
import type {
  WebPlatform,
  ProjectSyncStatus,
  MediaSyncSummary,
} from "../platform/web.js";
import type { CloudClient, CloudProject } from "./CloudClient.js";
import { useCloud } from "./useCloud.js";
import MediaSyncOverlay, {
  type MediaSyncProgressState,
} from "../MediaSyncOverlay.js";
import { OutOfSyncDialog } from "../ProjectBrowser.js";

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
}: CloudMenuProps) {
  const state = useCloud(client);
  const authed = state?.status === "authed";

  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState<ProjectSyncStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [progress, setProgress] = useState<MediaSyncProgressState | null>(null);
  const [reconcile, setReconcile] = useState<ReconcileTarget | null>(null);
  const ref = useRef<HTMLDivElement>(null);

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

  const runMediaSync = async (
    title: string,
    op: (
      doc: SeamFile,
      onProgress: (done: number, total: number, name: string) => void
    ) => Promise<MediaSyncSummary>,
    verb: string
  ) => {
    close();
    setNotice(null);
    setProgress({ title, done: 0, total: 0, detail: "" });
    try {
      const summary = await op(getDoc(), (done, total, name) =>
        setProgress({ title, done, total, detail: name })
      );
      setNotice(summaryNotice(verb, summary));
      await refreshStatus();
    } catch (err) {
      setNotice(errMessage(err));
    } finally {
      setProgress(null);
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
        runMediaSync(
          "Downloading media",
          (doc, p) => platform.downloadProjectMedia(doc, p),
          "Downloaded"
        ),
      disabled: busy || !authed,
    },
    {
      label: "Upload All Media",
      icon: <UploadCloud size={14} />,
      onClick: () =>
        runMediaSync(
          "Uploading media",
          (doc, p) => platform.uploadProjectMedia(doc, p),
          "Uploaded"
        ),
      disabled: busy || !authed,
    },
  ];

  const title = !authed
    ? "Sign in to Seam Cloud to sync"
    : undefined;

  return (
    <>
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

      {progress && <MediaSyncOverlay progress={progress} />}

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

      {notice && <CloudToast message={notice} onDismiss={() => setNotice(null)} />}
    </>
  );
}

interface MenuItem {
  label?: string;
  icon?: React.ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  separator?: boolean;
  badge?: { text: string; color: string };
}

/** Build the result message after a bulk media pass. */
function summaryNotice(verb: string, s: MediaSyncSummary): string {
  if (s.done === 0 && s.conflicts.length === 0) {
    return `Nothing to ${verb.toLowerCase().replace(/ed$/, "")} — already in sync.`;
  }
  const parts = [`${verb} ${s.done} file${s.done === 1 ? "" : "s"}.`];
  if (s.conflicts.length > 0) {
    parts.push(
      `${s.conflicts.length} skipped due to a name conflict — rename to resolve: ` +
        s.conflicts.map((c) => c.name).join(", ")
    );
  }
  return parts.join(" ");
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

import React, { useCallback, useSyncExternalStore } from "react";
import {
  UploadCloud,
  DownloadCloud,
  X,
  RotateCcw,
  Check,
  Loader2,
} from "lucide-react";
import type {
  TransferQueue,
  TransferQueueState,
  TransferJob,
} from "./TransferQueue.js";

/** Subscribe a component to a TransferQueue's state (null when no queue). */
export function useTransferQueue(
  queue: TransferQueue | null
): TransferQueueState | null {
  const subscribe = useCallback(
    (cb: () => void) => (queue ? queue.subscribe(cb) : () => {}),
    [queue]
  );
  const getSnapshot = useCallback(
    () => (queue ? queue.getState() : null),
    [queue]
  );
  return useSyncExternalStore(subscribe, getSnapshot);
}

const STATUS_LABEL: Record<TransferJob["status"], string> = {
  queued: "Queued",
  active: "Transferring…",
  done: "Done",
  error: "Failed",
  canceled: "Canceled",
};

const STATUS_COLOR: Record<TransferJob["status"], string> = {
  queued: "#888",
  active: "#6aa8e0",
  done: "#5ec98a",
  error: "#ff6b6b",
  canceled: "#888",
};

/**
 * Transfer-queue section of the Media panel: every queued/running/finished
 * cloud transfer, with per-job cancel/retry and a clear button. Renders
 * nothing while the queue is empty. Sits inside the media grid's scroll
 * container, so it scrolls away with the content rather than pinning to the
 * top of the panel.
 */
export default function TransferQueuePanel({
  queue,
}: {
  queue: TransferQueue | null;
}) {
  const state = useTransferQueue(queue);
  if (!queue || !state || state.jobs.length === 0) return null;

  const jobs = state.jobs;
  const pending = jobs.filter(
    (j) => j.status === "queued" || j.status === "active"
  );
  const finished = jobs.length - pending.length;

  return (
    <div
      style={{
        borderBottom: "1px solid #2a2a2a",
        paddingBottom: 8,
        marginBottom: 10,
        display: "flex",
        flexDirection: "column",
        gap: 6,
      }}
    >
      <style>{"@keyframes seam-transfer-spin { to { transform: rotate(360deg); } }"}</style>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span style={{ fontSize: 12, color: "#aaa", flex: 1 }}>
          Transfers
          {pending.length > 0 && ` — ${pending.length} remaining`}
        </span>
        {pending.length > 0 && (
          <HeaderButton onClick={() => queue.cancelAll()}>
            Cancel all
          </HeaderButton>
        )}
        {finished > 0 && (
          <HeaderButton onClick={() => queue.clearFinished()}>
            Clear
          </HeaderButton>
        )}
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
        {jobs.map((job) => (
          <JobRow key={job.id} job={job} queue={queue} />
        ))}
      </div>
    </div>
  );
}

function JobRow({ job, queue }: { job: TransferJob; queue: TransferQueue }) {
  const Icon = job.kind === "upload" ? UploadCloud : DownloadCloud;
  const cancellable = job.status === "queued" || job.status === "active";
  const retryable = job.status === "error" || job.status === "canceled";

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        fontSize: 12,
        color: "#ccc",
        padding: "3px 4px",
        borderRadius: 4,
        background: job.status === "active" ? "#1d2430" : "transparent",
      }}
      title={job.error}
    >
      <Icon size={13} color="#888" style={{ flexShrink: 0 }} />
      <span
        style={{
          flex: 1,
          minWidth: 0,
          whiteSpace: "nowrap",
          overflow: "hidden",
          textOverflow: "ellipsis",
        }}
      >
        {job.filename}
      </span>
      <span
        style={{
          color: STATUS_COLOR[job.status],
          display: "flex",
          alignItems: "center",
          gap: 4,
          flexShrink: 0,
          maxWidth: "50%",
          overflow: "hidden",
        }}
      >
        {job.status === "active" && (
          <Loader2
            size={12}
            style={{ animation: "seam-transfer-spin 1s linear infinite" }}
          />
        )}
        {job.status === "done" && <Check size={12} />}
        <span
          style={{
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
          }}
        >
          {job.status === "error" && job.error
            ? job.error
            : STATUS_LABEL[job.status]}
        </span>
      </span>
      {cancellable && (
        <RowButton title="Cancel" onClick={() => queue.cancel(job.id)}>
          <X size={12} />
        </RowButton>
      )}
      {retryable && (
        <RowButton title="Retry" onClick={() => queue.retry(job.id)}>
          <RotateCcw size={12} />
        </RowButton>
      )}
    </div>
  );
}

function HeaderButton({
  onClick,
  children,
}: {
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      style={{
        background: "#2e2e2e",
        border: "1px solid #3a3a3a",
        color: "#ccc",
        padding: "2px 8px",
        borderRadius: 4,
        cursor: "pointer",
        fontSize: 11,
      }}
    >
      {children}
    </button>
  );
}

function RowButton({
  title,
  onClick,
  children,
}: {
  title: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      title={title}
      onClick={onClick}
      style={{
        background: "none",
        border: "none",
        color: "#888",
        cursor: "pointer",
        padding: 2,
        display: "flex",
        flexShrink: 0,
      }}
      onMouseEnter={(e) => (e.currentTarget.style.color = "#fff")}
      onMouseLeave={(e) => (e.currentTarget.style.color = "#888")}
    >
      {children}
    </button>
  );
}

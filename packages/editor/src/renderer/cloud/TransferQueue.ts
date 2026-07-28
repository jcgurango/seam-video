import type { CloudClient } from "./CloudClient.js";

/**
 * Unified queue for media transfers between local OPFS and Seam Cloud.
 *
 * Every upload/download the UI triggers (tile actions, Sync to Cloud, the
 * Cloud menu's Upload/Download All Media) is enqueued here instead of running
 * inline. Jobs execute one at a time once the cloud is authed, and the queue
 * persists to localStorage so a refresh mid-transfer resumes where it left
 * off (an in-flight job reverts to "queued" and re-runs).
 *
 * The queue doesn't know how to move bytes — the platform passes in
 * {@link TransferExecutors} bound to its own upload/download methods, keeping
 * OPFS/dedup logic in one place.
 */

export type TransferKind = "upload" | "download";

export type TransferStatus =
  | "queued"
  | "active"
  | "done"
  | "error"
  | "canceled";

export interface TransferJob {
  id: string;
  kind: TransferKind;
  filename: string;
  /** Cloud media id (downloads only). */
  cloudId?: string;
  /** Cloud content hash (downloads only, for local dedup checks). */
  contentHash?: string | null;
  status: TransferStatus;
  error?: string;
  createdAt: number;
}

export interface TransferQueueState {
  jobs: TransferJob[];
}

export interface TransferExecutors {
  /** Upload a local clip. Throws (with a user-facing message) on conflict. */
  upload(filename: string, signal: AbortSignal): Promise<void>;
  /** Download a cloud asset into local OPFS. Throws on conflict. */
  download(job: TransferJob, signal: AbortSignal): Promise<void>;
}

/** Finished (done/error/canceled) jobs kept for display before pruning. */
const MAX_FINISHED = 50;

export class TransferQueue {
  private jobs: TransferJob[] = [];
  private state: TransferQueueState = { jobs: [] };
  private listeners = new Set<() => void>();
  private doneListeners = new Set<(job: TransferJob) => void>();
  private controllers = new Map<string, AbortController>();
  private running = false;
  /** An upload finished since the queue last drained → refresh the cloud list
   *  once on idle instead of after every file. */
  private uploadedSinceIdle = false;

  constructor(
    private readonly cloud: CloudClient,
    private readonly storageKey: string,
    private readonly executors: TransferExecutors
  ) {
    this.restore();
    // Pump whenever cloud state changes — covers the boot flow (restore()
    // flips to authed after we're constructed) and re-auth after sign-in.
    this.cloud.subscribe(() => this.pump());
    this.pump();
  }

  // ── State / subscription ─────────────────────────────────────────

  getState(): TransferQueueState {
    return this.state;
  }

  subscribe(cb: () => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  /** Fires when a job reaches "done" — lets the media grid re-scan and the
   *  app re-resolve sources without diffing queue snapshots. */
  subscribeJobDone(cb: (job: TransferJob) => void): () => void {
    this.doneListeners.add(cb);
    return () => this.doneListeners.delete(cb);
  }

  private commit(): void {
    this.state = { jobs: [...this.jobs] };
    this.persist();
    for (const cb of this.listeners) cb();
  }

  // ── Queue operations ─────────────────────────────────────────────

  /** Add a job. A queued/active job for the same file+direction is reused
   *  instead of duplicated. Returns the job's id. */
  enqueue(input: {
    kind: TransferKind;
    filename: string;
    cloudId?: string;
    contentHash?: string | null;
  }): string {
    const existing = this.jobs.find(
      (j) =>
        j.kind === input.kind &&
        j.filename === input.filename &&
        (j.status === "queued" || j.status === "active")
    );
    if (existing) return existing.id;

    const job: TransferJob = {
      id: crypto.randomUUID(),
      kind: input.kind,
      filename: input.filename,
      cloudId: input.cloudId,
      contentHash: input.contentHash,
      status: "queued",
      createdAt: Date.now(),
    };
    this.jobs.push(job);
    this.prune();
    this.commit();
    this.pump();
    return job.id;
  }

  /** Cancel one job: a queued job is marked canceled, an active one aborted. */
  cancel(id: string): void {
    const job = this.jobs.find((j) => j.id === id);
    if (!job) return;
    if (job.status === "queued") {
      job.status = "canceled";
      this.commit();
    } else if (job.status === "active") {
      this.controllers.get(id)?.abort();
    }
  }

  /** Cancel everything still queued or active. */
  cancelAll(): void {
    for (const job of this.jobs) {
      if (job.status === "queued") job.status = "canceled";
    }
    for (const c of this.controllers.values()) c.abort();
    this.commit();
  }

  /** Re-queue a failed or canceled job. */
  retry(id: string): void {
    const job = this.jobs.find((j) => j.id === id);
    if (!job || (job.status !== "error" && job.status !== "canceled")) return;
    job.status = "queued";
    job.error = undefined;
    this.commit();
    this.pump();
  }

  /** Drop finished (done/error/canceled) jobs from the list. */
  clearFinished(): void {
    this.jobs = this.jobs.filter(
      (j) => j.status === "queued" || j.status === "active"
    );
    this.commit();
  }

  // ── Runner ───────────────────────────────────────────────────────

  private pump(): void {
    if (this.running) return;
    if (this.cloud.getState().status !== "authed") return;
    const job = this.jobs.find((j) => j.status === "queued");
    if (!job) {
      if (this.uploadedSinceIdle) {
        this.uploadedSinceIdle = false;
        void this.cloud.refreshMedia();
      }
      return;
    }
    this.running = true;
    void this.run(job).finally(() => {
      this.running = false;
      this.pump();
    });
  }

  private async run(job: TransferJob): Promise<void> {
    const controller = new AbortController();
    this.controllers.set(job.id, controller);
    job.status = "active";
    this.commit();
    try {
      if (job.kind === "upload") {
        await this.executors.upload(job.filename, controller.signal);
        this.uploadedSinceIdle = true;
      } else {
        await this.executors.download(job, controller.signal);
      }
      job.status = "done";
    } catch (err) {
      if (controller.signal.aborted) {
        job.status = "canceled";
      } else {
        job.status = "error";
        job.error = err instanceof Error ? err.message : String(err);
      }
    } finally {
      this.controllers.delete(job.id);
      this.commit();
      if (job.status === "done") {
        for (const cb of this.doneListeners) cb(job);
      }
    }
  }

  // ── Persistence ──────────────────────────────────────────────────

  private restore(): void {
    try {
      const raw = localStorage.getItem(this.storageKey);
      if (!raw) return;
      const jobs = JSON.parse(raw) as TransferJob[];
      // A job that was mid-flight when the page unloaded re-runs from scratch.
      this.jobs = jobs.map((j) =>
        j.status === "active" ? { ...j, status: "queued" as const } : j
      );
      this.state = { jobs: [...this.jobs] };
    } catch {
      /* corrupt/absent — start empty */
    }
  }

  private persist(): void {
    try {
      localStorage.setItem(this.storageKey, JSON.stringify(this.jobs));
    } catch {
      /* storage full / disabled — queue still works in-memory */
    }
  }

  /** Keep the finished tail bounded so the persisted list can't grow forever. */
  private prune(): void {
    const finished = this.jobs.filter(
      (j) => j.status !== "queued" && j.status !== "active"
    );
    if (finished.length <= MAX_FINISHED) return;
    const drop = new Set(
      finished
        .sort((a, b) => a.createdAt - b.createdAt)
        .slice(0, finished.length - MAX_FINISHED)
        .map((j) => j.id)
    );
    this.jobs = this.jobs.filter((j) => !drop.has(j.id));
  }
}

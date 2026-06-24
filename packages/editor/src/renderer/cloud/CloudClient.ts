import type { MediaKind } from "../useImport.js";

/**
 * Client for a Seam Cloud instance (the @seam/cloud backend). Web-editor-only.
 *
 * Auth is a **bearer token** — the session token better-auth returns from
 * sign-in. It's stored in localStorage (keyed by base URL) and sent as
 * `Authorization: Bearer …` on API calls, or as a `?token=` query param on
 * media URLs (so mediabunny's `UrlSource` / `<img>` can fetch a plain URL).
 * This sidesteps cross-site cookies entirely.
 *
 * The client owns the cloud media list (fetched + polled while signed in) and
 * exposes it synchronously via {@link mediaByName} so the platform's
 * `resolveSource` can fall back to a cloud stream without async work.
 */

export interface CloudMedia {
  id: string;
  filename: string;
  kind: MediaKind;
  contentType: string | null;
  size: number;
  contentHash: string | null;
  addedAt: number;
  lastUsedAt: number | null;
  captureDate: number | null;
  width: number | null;
  height: number | null;
  duration: number | null;
  hasThumb: boolean;
}

export interface CloudUser {
  id: string;
  email: string;
  name: string;
  role: string;
}

export type CloudStatus = "idle" | "authenticating" | "authed";

export interface CloudState {
  status: CloudStatus;
  user: CloudUser | null;
  media: CloudMedia[];
  /** True while a media-list refresh is in flight. */
  refreshing: boolean;
  lastError: string | null;
}

/** Outcome of an upload — mirrors the server's accept / 409 conflict rules. */
export type UploadResult =
  | { kind: "created"; media: CloudMedia }
  | { kind: "exists"; media: CloudMedia }
  | {
      kind: "conflict";
      reason: "filename-exists" | "content-exists" | "race";
      message: string;
      existing?: CloudMedia;
    };

const POLL_INTERVAL_MS = 60_000;
const PAGE_SIZE = 200;

/** What we persist between sessions so the list is instant on next page load. */
interface CloudCache {
  user: CloudUser | null;
  media: CloudMedia[];
}

export class CloudClient {
  readonly baseUrl: string;
  private readonly tokenKey: string;
  private readonly cacheKey: string;
  private token: string | null;

  private state: CloudState = {
    status: "idle",
    user: null,
    media: [],
    refreshing: false,
    lastError: null,
  };
  private byName = new Map<string, CloudMedia>();
  private listeners = new Set<(s: CloudState) => void>();
  private pollTimer: ReturnType<typeof setInterval> | null = null;

  constructor(baseUrl: string) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.tokenKey = `seam-cloud-token:${this.baseUrl}`;
    this.cacheKey = `seam-cloud-cache:${this.baseUrl}`;
    this.token =
      typeof localStorage !== "undefined"
        ? localStorage.getItem(this.tokenKey)
        : null;

    // Optimistic boot: if we have a token, show the last-known account + media
    // immediately (so resolveSource and the media grid work before the network
    // round-trip). restore() then validates the token and refreshes.
    if (this.token) {
      const cache = this.readCache();
      if (cache) {
        this.state = {
          status: "authed",
          user: cache.user,
          media: cache.media,
          refreshing: false,
          lastError: null,
        };
        this.byName = new Map(cache.media.map((m) => [m.filename, m]));
      }
    }
  }

  // ── State / subscription ─────────────────────────────────────────

  getState(): CloudState {
    return this.state;
  }

  /** Synchronous filename → cloud media lookup (for resolveSource). */
  mediaByName(name: string): CloudMedia | undefined {
    return this.byName.get(name);
  }

  subscribe(cb: (s: CloudState) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  private setState(patch: Partial<CloudState>): void {
    this.state = { ...this.state, ...patch };
    if ("media" in patch) {
      this.byName = new Map((patch.media ?? []).map((m) => [m.filename, m]));
    }
    for (const cb of this.listeners) cb(this.state);
  }

  // ── Auth ─────────────────────────────────────────────────────────

  hasToken(): boolean {
    return !!this.token;
  }

  /** Restore a prior session on boot: validate the stored token, refresh the
   *  list now, then poll. No-op (idle) if there's no token; a stale token logs
   *  out, but a network error keeps the optimistic (cached) session so a flaky
   *  connection doesn't sign the user out. */
  async restore(): Promise<void> {
    if (!this.token) return;
    let res: Response;
    try {
      res = await this.authedFetch("/api/auth/get-session");
    } catch (err) {
      // Offline / unreachable — keep the cached session and retry on the poll.
      console.warn("CloudClient.restore: cloud unreachable, using cache", err);
      this.startPolling();
      return;
    }
    // authedFetch already clears the token on 401.
    if (!res.ok) {
      this.clearToken();
      return;
    }
    const session = (await res.json()) as { user: CloudUser } | null;
    if (!session?.user) {
      this.clearToken();
      return;
    }
    this.setState({ status: "authed", user: session.user, lastError: null });
    this.persistCache();
    this.startPolling();
    void this.refreshMedia();
  }

  async login(email: string, password: string): Promise<void> {
    this.setState({ status: "authenticating", lastError: null });
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/api/auth/sign-in/email`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, password }),
      });
    } catch (err) {
      this.setState({ status: "idle", lastError: networkError(err) });
      throw err;
    }
    if (!res.ok) {
      const msg = await errorMessage(res, "Sign in failed");
      this.setState({ status: "idle", lastError: msg });
      throw new Error(msg);
    }
    const body = (await res.json()) as { token?: string; user: CloudUser };
    // Prefer the bearer token header better-auth's bearer plugin sets; fall
    // back to the body's token field.
    const token = res.headers.get("set-auth-token") || body.token;
    if (!token) {
      const msg = "Sign in succeeded but no token was returned.";
      this.setState({ status: "idle", lastError: msg });
      throw new Error(msg);
    }
    this.setToken(token);
    this.setState({ status: "authed", user: body.user, lastError: null });
    this.persistCache();
    this.startPolling();
    void this.refreshMedia();
  }

  async logout(): Promise<void> {
    this.stopPolling();
    try {
      await this.authedFetch("/api/auth/sign-out", { method: "POST" });
    } catch {
      // best-effort — clear locally regardless
    }
    this.clearToken();
  }

  private setToken(token: string): void {
    this.token = token;
    try {
      localStorage.setItem(this.tokenKey, token);
    } catch {
      /* private mode / disabled storage */
    }
  }

  private clearToken(): void {
    this.token = null;
    try {
      localStorage.removeItem(this.tokenKey);
      localStorage.removeItem(this.cacheKey);
    } catch {
      /* ignore */
    }
    this.stopPolling();
    this.setState({ status: "idle", user: null, media: [] });
  }

  // ── Persistent cache (account + media list) ──────────────────────

  private readCache(): CloudCache | null {
    try {
      const raw = localStorage.getItem(this.cacheKey);
      return raw ? (JSON.parse(raw) as CloudCache) : null;
    } catch {
      return null;
    }
  }

  private persistCache(): void {
    try {
      const cache: CloudCache = {
        user: this.state.user,
        media: this.state.media,
      };
      localStorage.setItem(this.cacheKey, JSON.stringify(cache));
    } catch {
      /* storage full / disabled — cache is best-effort */
    }
  }

  // ── Media list ───────────────────────────────────────────────────

  private startPolling(): void {
    if (this.pollTimer != null) return;
    this.pollTimer = setInterval(() => void this.refreshMedia(), POLL_INTERVAL_MS);
  }

  private stopPolling(): void {
    if (this.pollTimer != null) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  /** Fetch every page of the caller's cloud media into state. */
  async refreshMedia(): Promise<void> {
    if (this.state.status !== "authed") return;
    this.setState({ refreshing: true });
    try {
      const all: CloudMedia[] = [];
      for (let page = 1; ; page++) {
        const res = await this.authedFetch(
          `/api/media?page=${page}&pageSize=${PAGE_SIZE}&sort=added`
        );
        if (!res.ok) throw new Error(await errorMessage(res, "List failed"));
        const body = (await res.json()) as {
          items: CloudMedia[];
          total: number;
        };
        all.push(...body.items);
        if (all.length >= body.total || body.items.length === 0) break;
      }
      this.setState({ media: all, refreshing: false, lastError: null });
      this.persistCache();
    } catch (err) {
      console.warn("CloudClient.refreshMedia failed", err);
      this.setState({ refreshing: false, lastError: networkError(err) });
    }
  }

  // ── Media URLs (token-bearing, for streaming / thumbnails) ───────

  mediaFileUrl(id: string): string {
    return `${this.baseUrl}/api/media/${id}/file?token=${encodeURIComponent(
      this.token ?? ""
    )}`;
  }

  mediaThumbUrl(id: string): string {
    return `${this.baseUrl}/api/media/${id}/thumb?token=${encodeURIComponent(
      this.token ?? ""
    )}`;
  }

  /** Resolve a filename to a streaming URL, if the cloud has it. */
  fileUrlForName(name: string): string | null {
    const m = this.byName.get(name);
    return m ? this.mediaFileUrl(m.id) : null;
  }

  // ── Upload / download ────────────────────────────────────────────

  async uploadMedia(file: File): Promise<UploadResult> {
    const form = new FormData();
    form.append("file", file);
    const res = await this.authedFetch("/api/media", {
      method: "POST",
      body: form,
    });
    if (res.status === 409) {
      const body = (await res.json()) as {
        reason: "filename-exists" | "content-exists" | "race";
        message: string;
        existing?: CloudMedia;
      };
      return { kind: "conflict", ...body };
    }
    if (!res.ok) throw new Error(await errorMessage(res, "Upload failed"));
    const media = (await res.json()) as CloudMedia;
    const result: UploadResult =
      res.status === 200 ? { kind: "exists", media } : { kind: "created", media };
    return result;
  }

  /** Fetch a cloud media file's raw bytes (for download-to-local). */
  async downloadMedia(id: string): Promise<Blob> {
    const res = await this.authedFetch(`/api/media/${id}/file`);
    if (!res.ok) throw new Error(await errorMessage(res, "Download failed"));
    return res.blob();
  }

  // ── Internal ─────────────────────────────────────────────────────

  private async authedFetch(path: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers);
    if (this.token) headers.set("Authorization", `Bearer ${this.token}`);
    const res = await fetch(`${this.baseUrl}${path}`, { ...init, headers });
    // A stale/revoked token drops us back to signed-out.
    if (res.status === 401 && this.token) this.clearToken();
    return res;
  }
}

async function errorMessage(res: Response, fallback: string): Promise<string> {
  try {
    const body = await res.json();
    if (body && typeof body.message === "string") return body.message;
    if (body && typeof body.error === "string") return body.error;
  } catch {
    /* not JSON */
  }
  return `${fallback} (${res.status})`;
}

function networkError(err: unknown): string {
  return err instanceof Error ? err.message : "Network error";
}

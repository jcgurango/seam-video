import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  authClient,
  classifyByName,
  deleteMedia,
  listMedia,
  uploadMedia,
  type MediaRecord,
  type MediaSort,
} from "./api.js";

export function App() {
  const { data: session, isPending } = authClient.useSession();

  if (isPending) {
    return <div className="center muted">Loading…</div>;
  }
  if (!session) {
    return <Login />;
  }
  return <Dashboard email={session.user.email} role={(session.user as { role?: string }).role ?? "USER"} />;
}

function Login() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const { error } = await authClient.signIn.email({ email, password });
    setBusy(false);
    if (error) setError(error.message ?? "Sign in failed");
  };

  return (
    <div className="center">
      <form className="card login" onSubmit={submit}>
        <h1>Seam Cloud</h1>
        <label>
          Email
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            autoFocus
            required
          />
        </label>
        <label>
          Password
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
          />
        </label>
        {error && <div className="error">{error}</div>}
        <button type="submit" disabled={busy}>
          {busy ? "Signing in…" : "Sign in"}
        </button>
      </form>
    </div>
  );
}

const SORTS: { key: MediaSort; label: string }[] = [
  { key: "date", label: "Date" },
  { key: "added", label: "Date Added" },
  { key: "used", label: "Last Used" },
];

const PAGE_SIZE = 24;

function Dashboard({ email, role }: { email: string; role: string }) {
  const [sort, setSort] = useState<MediaSort>("added");
  const [page, setPage] = useState(1);
  const [items, setItems] = useState<MediaRecord[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await listMedia(page, PAGE_SIZE, sort);
      setItems(res.items);
      setTotal(res.total);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [page, sort]);

  useEffect(() => {
    void load();
  }, [load]);

  // Reset to page 1 when the sort changes.
  useEffect(() => setPage(1), [sort]);

  const onUpload = async (files: FileList | null) => {
    if (!files?.length) return;
    setError(null);
    try {
      for (const f of Array.from(files)) {
        if (!classifyByName(f.name)) continue;
        await uploadMedia(f);
      }
      setPage(1);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const onDelete = async (id: string) => {
    await deleteMedia(id);
    await load();
  };

  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <div className="app">
      <header>
        <h1>Seam Cloud</h1>
        <div className="user">
          <span>{email}</span>
          <span className={`badge ${role === "ADMIN" ? "admin" : ""}`}>{role}</span>
          <ImmichPanel />
          <button onClick={() => authClient.signOut()}>Sign out</button>
        </div>
      </header>

      <div className="toolbar">
        <label>
          Sort
          <select value={sort} onChange={(e) => setSort(e.target.value as MediaSort)}>
            {SORTS.map((s) => (
              <option key={s.key} value={s.key}>
                {s.label}
              </option>
            ))}
          </select>
        </label>
        <span className="muted">{total} item{total === 1 ? "" : "s"}</span>
        <div className="spacer" />
        <button onClick={() => fileInput.current?.click()}>Upload media</button>
        <input
          ref={fileInput}
          type="file"
          multiple
          hidden
          onChange={(e) => onUpload(e.target.files)}
        />
      </div>

      {error && <div className="error bar">{error}</div>}

      {loading && items.length === 0 ? (
        <div className="muted pad">Loading…</div>
      ) : items.length === 0 ? (
        <div className="muted pad">No media yet. Upload something to get started.</div>
      ) : (
        <div className="grid">
          {items.map((m) => (
            <MediaTile key={m.id} item={m} onDelete={() => onDelete(m.id)} />
          ))}
        </div>
      )}

      {pageCount > 1 && (
        <div className="pager">
          <button disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
            Prev
          </button>
          <span>
            Page {page} / {pageCount}
          </span>
          <button disabled={page >= pageCount} onClick={() => setPage((p) => p + 1)}>
            Next
          </button>
        </div>
      )}
    </div>
  );
}

function fmtDate(ts: number | null | undefined): string {
  if (!ts) return "—";
  return new Date(ts).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

function fmtDuration(s: number | null): string {
  if (!s) return "";
  const m = Math.floor(s / 60);
  const sec = Math.round(s % 60);
  return `${m}:${String(sec).padStart(2, "0")}`;
}

function fmtSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

const KIND_ICON: Record<string, string> = {
  video: "🎬",
  audio: "🎵",
  image: "🖼️",
  pmtiles: "🗺️",
};

function MediaTile({ item, onDelete }: { item: MediaRecord; onDelete: () => void }) {
  return (
    <div className="tile">
      <div className="thumb">
        {item.hasThumb ? (
          <img src={`/api/media/${item.id}/thumb`} alt={item.filename} loading="lazy" />
        ) : (
          <span className="icon">{KIND_ICON[item.kind] ?? "📄"}</span>
        )}
        {item.duration ? <span className="duration">{fmtDuration(item.duration)}</span> : null}
        <button className="del" title="Delete" onClick={onDelete}>
          ✕
        </button>
      </div>
      <div className="meta">
        <div className="name" title={item.filename}>
          {item.filename}
        </div>
        <div className="sub muted">
          {fmtDate(item.captureDate ?? item.addedAt)} · {fmtSize(item.size)}
        </div>
      </div>
    </div>
  );
}

interface ImmichStatus {
  connected: boolean;
  instanceUrl?: string;
  albumId?: string;
}

/** Header control to attach/detach a per-user Immich account via API key. */
function ImmichPanel() {
  const [status, setStatus] = useState<ImmichStatus | null>(null);
  const [open, setOpen] = useState(false);
  const [instanceUrl, setInstanceUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/api/immich", { credentials: "include" });
      if (res.ok) setStatus((await res.json()) as ImmichStatus);
    } catch {
      /* ignore */
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const connect = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/immich", {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ instanceUrl, apiKey }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? "Connect failed");
      setApiKey("");
      setOpen(false);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const disconnect = async () => {
    setBusy(true);
    try {
      await fetch("/api/immich", { method: "DELETE", credentials: "include" });
      await refresh();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="immich">
      <button onClick={() => setOpen((v) => !v)}>
        {status?.connected ? "Immich ✓" : "Connect Immich"}
      </button>
      {open && (
        <div className="immich-pop">
          {status?.connected ? (
            <>
              <div className="muted" style={{ wordBreak: "break-all" }}>
                Connected to {status.instanceUrl}
              </div>
              <button onClick={disconnect} disabled={busy}>
                Disconnect
              </button>
            </>
          ) : (
            <form onSubmit={connect}>
              <label>
                Instance URL
                <input
                  type="url"
                  placeholder="https://photos.example.com"
                  value={instanceUrl}
                  onChange={(e) => setInstanceUrl(e.target.value)}
                  required
                />
              </label>
              <label>
                API key
                <input
                  type="password"
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                  required
                />
              </label>
              {error && <div className="error">{error}</div>}
              <button type="submit" disabled={busy}>
                {busy ? "Connecting…" : "Connect"}
              </button>
            </form>
          )}
        </div>
      )}
    </div>
  );
}

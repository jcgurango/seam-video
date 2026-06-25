import {
  FINGERPRINT_SAMPLE,
  fingerprintParts,
  fingerprintRanges,
} from "../media/fingerprint.js";

/**
 * Thin client for a user's Immich instance. Auth is a per-user API key sent as
 * `x-api-key` (verified against the live instance — see the integration notes).
 *
 * Immich's own `checksum` is a full-file SHA-1, so it's useless for our
 * `(size ∥ head ∥ tail)` fingerprint — {@link computeAssetFingerprint}
 * recomputes our hash over HTTP Range reads instead.
 */
export interface ImmichConfig {
  /** Instance origin, e.g. https://photos.example.com (no trailing /api). */
  instanceUrl: string;
  apiKey: string;
}

export type ImmichAssetType = "IMAGE" | "VIDEO" | "AUDIO" | "OTHER";

export interface ImmichAsset {
  id: string;
  type: ImmichAssetType;
  originalFileName: string;
  /** Base64 full-file SHA-1 (NOT our fingerprint). */
  checksum: string;
  fileCreatedAt?: string;
  fileModifiedAt?: string;
  exifInfo?: { fileSizeInByte?: number | null } | null;
}

export interface ImmichAlbum {
  id: string;
  albumName: string;
  assetCount: number;
  assets: ImmichAsset[];
}

/** Normalize a user-entered instance URL to a bare origin (strip trailing
 *  slash and a trailing `/api` if they pasted the API root). */
export function normalizeInstanceUrl(url: string): string {
  return url.trim().replace(/\/+$/, "").replace(/\/api$/, "");
}

export class ImmichClient {
  private readonly base: string;
  private readonly apiKey: string;

  constructor(cfg: ImmichConfig) {
    this.base = normalizeInstanceUrl(cfg.instanceUrl);
    this.apiKey = cfg.apiKey;
  }

  private headers(extra?: Record<string, string>): Record<string, string> {
    return { "x-api-key": this.apiKey, ...extra };
  }

  private async json<T>(path: string, init?: RequestInit): Promise<T> {
    const res = await fetch(`${this.base}/api${path}`, {
      ...init,
      headers: this.headers({ accept: "application/json", ...(init?.headers as Record<string, string>) }),
    });
    if (!res.ok) {
      throw new Error(`Immich ${init?.method ?? "GET"} ${path} → ${res.status} ${await safeText(res)}`);
    }
    return res.json() as Promise<T>;
  }

  /** Validate the connection (and return the account it's scoped to). */
  async me(): Promise<{ id: string; email: string; name?: string }> {
    return this.json("/users/me");
  }

  // ── Albums ───────────────────────────────────────────────────────

  async createAlbum(albumName: string): Promise<ImmichAlbum> {
    return this.json("/albums", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ albumName }),
    });
  }

  async getAlbum(albumId: string): Promise<ImmichAlbum> {
    return this.json(`/albums/${albumId}`);
  }

  async findAlbumByName(albumName: string): Promise<ImmichAlbum | null> {
    const albums = await this.json<ImmichAlbum[]>("/albums");
    return albums.find((a) => a.albumName === albumName) ?? null;
  }

  async addAssetsToAlbum(albumId: string, ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    await this.json(`/albums/${albumId}/assets`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ids }),
    });
  }

  // ── Assets ───────────────────────────────────────────────────────

  async getAsset(id: string): Promise<ImmichAsset> {
    return this.json(`/assets/${id}`);
  }

  /**
   * Upload a file as a new Immich asset. Returns its id (and whether Immich
   * considered it a duplicate of an existing asset).
   */
  async uploadAsset(opts: {
    bytes: Buffer;
    filename: string;
    contentType: string;
    fileCreatedAt: Date;
    fileModifiedAt: Date;
    deviceId?: string;
  }): Promise<{ id: string; status: "created" | "duplicate" | string }> {
    const form = new FormData();
    form.append(
      "assetData",
      new Blob([new Uint8Array(opts.bytes)], { type: opts.contentType }),
      opts.filename
    );
    form.append("deviceAssetId", `${opts.filename}-${opts.bytes.length}`);
    form.append("deviceId", opts.deviceId ?? "seam-cloud");
    form.append("fileCreatedAt", opts.fileCreatedAt.toISOString());
    form.append("fileModifiedAt", opts.fileModifiedAt.toISOString());
    return this.json("/assets", { method: "POST", body: form });
  }

  /** Stream an asset's original bytes (pass-through), forwarding a Range. */
  fetchOriginal(id: string, range?: string | null): Promise<Response> {
    return fetch(`${this.base}/api/assets/${id}/original`, {
      headers: this.headers(range ? { range } : undefined),
    });
  }

  /** Stream an asset's thumbnail (pass-through). */
  fetchThumbnail(id: string, size: "preview" | "thumbnail" = "preview"): Promise<Response> {
    return fetch(`${this.base}/api/assets/${id}/thumbnail?size=${size}`, {
      headers: this.headers(),
    });
  }

  /**
   * Compute OUR content fingerprint for an Immich asset using HTTP Range reads
   * — the first 64KB and (for larger files) the last 64KB — so it matches the
   * hash we compute locally without downloading the whole file.
   */
  async computeAssetFingerprint(id: string): Promise<{ hash: string; size: number }> {
    // First read gets the head (first ≤64KB) and the total size (Content-Range).
    const first = await this.rangeRead(id, 0, FINGERPRINT_SAMPLE - 1);
    const size = first.size;
    const { headLen, tailStart } = fingerprintRanges(size);
    const head = first.head.subarray(0, headLen);
    const tail =
      tailStart < size
        ? (await this.rangeRead(id, tailStart, size - 1)).head
        : Buffer.alloc(0);
    return { hash: fingerprintParts(size, head, tail), size };
  }

  /** Read a byte range; returns the bytes plus the file's total size (parsed
   *  from the 206 Content-Range header). */
  private async rangeRead(
    id: string,
    start: number,
    end: number
  ): Promise<{ head: Buffer; size: number }> {
    const res = await fetch(`${this.base}/api/assets/${id}/original`, {
      headers: this.headers({ range: `bytes=${start}-${end}` }),
    });
    if (res.status !== 206 && res.status !== 200) {
      throw new Error(`Immich range read ${id} → ${res.status}`);
    }
    const bytes = Buffer.from(await res.arrayBuffer());
    const total = parseTotalSize(res.headers.get("content-range")) ?? bytes.length;
    return { head: bytes, size: total };
  }
}

/**
 * Relay an upstream Immich streaming response (original / thumbnail) back to
 * our client, preserving status (incl. 206) and the headers a media player
 * needs, while dropping Immich's auth/cookie headers.
 */
export function relayResponse(
  upstream: Response,
  fallbackContentType: string
): Response {
  if (upstream.status >= 400) {
    return new Response(null, { status: 502 });
  }
  const headers = new Headers();
  headers.set(
    "content-type",
    upstream.headers.get("content-type") ?? fallbackContentType
  );
  for (const h of ["content-length", "content-range", "accept-ranges"]) {
    const v = upstream.headers.get(h);
    if (v) headers.set(h, v);
  }
  return new Response(upstream.body, { status: upstream.status, headers });
}

/** Map an Immich asset type to our media kind (audio/other are non-canonical). */
export function immichTypeToKind(
  type: ImmichAssetType
): "video" | "image" | "audio" | null {
  if (type === "VIDEO") return "video";
  if (type === "IMAGE") return "image";
  if (type === "AUDIO") return "audio";
  return null;
}

function parseTotalSize(contentRange: string | null): number | null {
  // "bytes 0-65535/28733156"
  const m = contentRange ? /\/(\d+)\s*$/.exec(contentRange) : null;
  return m ? Number(m[1]) : null;
}

async function safeText(res: Response): Promise<string> {
  try {
    return (await res.text()).slice(0, 200);
  } catch {
    return "";
  }
}

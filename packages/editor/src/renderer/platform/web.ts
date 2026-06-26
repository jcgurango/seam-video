import JSZip from "jszip";
import { basename } from "../pathUtils.js";
import type { SeamFile } from "@seam/core";
import type {
  ActionName,
  ExportProgress,
  OpenResult,
  Platform,
} from "./types.js";
import { buildExportPlan, collectClipSources } from "../exportHelpers.js";
import { classifyByName, type MediaKind } from "../useImport.js";
import {
  CloudClient,
  type CloudProject,
  type UploadResult,
} from "../cloud/CloudClient.js";

/** Summary of a "sync all to cloud" pass. */
export interface SyncSummary {
  uploaded: number;
  /** Already present on the cloud (identical name + hash). */
  alreadyPresent: number;
  /** Skipped because the cloud copy is identical (no upload attempted). */
  skipped: number;
  /** Files the cloud rejected as conflicts — the user must rename to resolve. */
  conflicts: { name: string; message: string }[];
}

/** Summary of a per-project media upload/download pass (the Cloud menu's
 *  Upload/Download All Media). `done` counts files transferred (or already
 *  present); `conflicts` are the ones the dedup rules rejected. */
export interface MediaSyncSummary {
  done: number;
  conflicts: { name: string; message: string }[];
}

/** Sync relationship of a single project (local vs cloud, via the hash baseline). */
export type ProjectSyncStatus =
  | "local-only" // never uploaded (no cloud copy)
  | "cloud-only" // exists on cloud, not locally
  | "in-sync" // local and cloud content match
  | "local-ahead" // only the local copy changed since last sync → safe upload
  | "remote-ahead" // only the cloud copy changed → safe download
  | "out-of-sync"; // both changed since last sync → needs reconciliation

export interface ProjectSyncState {
  status: ProjectSyncStatus;
  /** The cloud project id, if this project has ever been synced / exists on cloud. */
  cloudId: string | null;
}

/** Outcome of uploading one project. */
export type ProjectUploadOutcome =
  | { kind: "uploaded" }
  | { kind: "name-exists"; message: string };

interface ProjectSyncEntry {
  cloudId?: string;
  lastSyncedHash?: string;
}
type ProjectSyncIndex = Record<string, ProjectSyncEntry>;

const PROJECTS_DIR = "projects";
const CLIPS_DIR = "clips";
const THUMBS_DIR = "thumbnails";
const MEDIA_META_DIR = "media-meta";
const MEDIA_INDEX_FILE = "index.json";
const PROJECT_SYNC_DIR = "project-sync";
const PROJECT_SYNC_FILE = "index.json";

export interface ProjectEntry {
  name: string;
  lastModified: number;
  size: number;
}

/** A media file in OPFS clips/, listed for the media browser. */
export interface ClipEntry {
  name: string;
  size: number;
  /** OPFS write time — doubles as the "date added" backfill. */
  lastModified: number;
}

/** Per-clip metadata persisted in media-meta/index.json. All fields beyond
 *  `kind`/`addedAt` are best-effort and filled lazily by the browser. */
export interface MediaMeta {
  kind: MediaKind;
  /** Epoch ms the clip entered OPFS. */
  addedAt: number;
  /** Epoch ms the clip was last added to a timeline. */
  lastUsedAt?: number;
  /** EXIF/container capture date (epoch ms). */
  captureDate?: number;
  width?: number;
  height?: number;
  /** Natural duration (s) for video/audio. */
  duration?: number;
  /** Set once the one-time decode pass (thumbnail + capture date + duration)
   *  has run, so the browser doesn't redo expensive decoding each open even
   *  when a field legitimately came back undefined. */
  probed?: boolean;
}

export type MediaIndex = Record<string, MediaMeta>;

/** Trigger a browser download of `data` under `filename` via a transient
 *  `<a download>`. Shared by every export/download path. */
function triggerDownload(data: Blob, filename: string): void {
  const url = URL.createObjectURL(data);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function getRoot(): Promise<FileSystemDirectoryHandle> {
  return await navigator.storage.getDirectory();
}

async function getDir(name: string): Promise<FileSystemDirectoryHandle> {
  const root = await getRoot();
  return await root.getDirectoryHandle(name, { create: true });
}

async function readFileFromDir(
  dirName: string,
  fileName: string
): Promise<File> {
  const dir = await getDir(dirName);
  const handle = await dir.getFileHandle(fileName);
  return await handle.getFile();
}

async function writeFileToDir(
  dirName: string,
  fileName: string,
  data: Blob | string
): Promise<void> {
  const dir = await getDir(dirName);
  const handle = await dir.getFileHandle(fileName, { create: true });
  const writable = await handle.createWritable();
  await writable.write(data);
  await writable.close();
}

async function listDir(dirName: string): Promise<string[]> {
  const dir = await getDir(dirName);
  const names: string[] = [];
  // @ts-expect-error: values() is supported in all target browsers
  for await (const entry of dir.values()) {
    if (entry.kind === "file") names.push(entry.name);
  }
  return names.sort();
}

/**
 * Return a filename inside `dirName` that doesn't yet exist. `extraBlocked`
 * lets a caller reserve additional names (e.g. Seam Cloud filenames that hold
 * different content) so an import doesn't pick a name that's bound to collide.
 */
async function uniqueName(
  dirName: string,
  originalName: string,
  extraBlocked?: (candidate: string) => boolean
): Promise<string> {
  const dir = await getDir(dirName);
  const dot = originalName.lastIndexOf(".");
  const base = dot >= 0 ? originalName.slice(0, dot) : originalName;
  const ext = dot >= 0 ? originalName.slice(dot) : "";
  let candidate = originalName;
  let i = 1;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const localTaken = await fileExists(dir, candidate);
    if (!localTaken && !extraBlocked?.(candidate)) return candidate;
    candidate = `${base}-${i}${ext}`;
    i++;
  }
}

async function fileExists(
  dir: FileSystemDirectoryHandle,
  name: string
): Promise<boolean> {
  try {
    await dir.getFileHandle(name);
    return true;
  } catch {
    return false;
  }
}

async function uniqueClipName(
  originalName: string,
  extraBlocked?: (candidate: string) => boolean
): Promise<string> {
  return uniqueName(CLIPS_DIR, originalName, extraBlocked);
}

async function uniqueProjectName(originalName: string): Promise<string> {
  return uniqueName(PROJECTS_DIR, originalName);
}

/**
 * Compute a lightweight content fingerprint of a blob: SHA-256 over
 * `(size ∥ first 64KB ∥ last 64KB)`. Cheap even for large videos; collisions
 * require matching byte length plus identical opening and trailing bytes.
 */
const FINGERPRINT_SAMPLE = 64 * 1024;
async function fingerprint(file: Blob): Promise<string> {
  const size = file.size;
  const headLen = Math.min(FINGERPRINT_SAMPLE, size);
  const tailStart = Math.max(headLen, size - FINGERPRINT_SAMPLE);

  const head = new Uint8Array(await file.slice(0, headLen).arrayBuffer());
  const tail =
    tailStart >= size
      ? new Uint8Array(0)
      : new Uint8Array(await file.slice(tailStart, size).arrayBuffer());

  const sizeBuf = new Uint8Array(8);
  new DataView(sizeBuf.buffer).setBigUint64(0, BigInt(size), true);

  const combined = new Uint8Array(sizeBuf.length + head.length + tail.length);
  combined.set(sizeBuf, 0);
  combined.set(head, sizeBuf.length);
  combined.set(tail, sizeBuf.length + head.length);

  const hash = await crypto.subtle.digest("SHA-256", combined);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** Recursively walk a parsed .seam document and rewrite clip.source fields. */
function rewriteClipSources(
  node: unknown,
  map: Map<string, string>
): void {
  if (!node || typeof node !== "object") return;
  const n = node as Record<string, unknown>;
  if (
    (n.type === "clip" || n.type === "audio") &&
    typeof n.source === "string"
  ) {
    const replaced = map.get(n.source);
    if (replaced) n.source = replaced;
  }
  if (Array.isArray(n.children)) {
    for (const child of n.children) rewriteClipSources(child, map);
  }
  if (Array.isArray(n.attachments)) {
    for (const att of n.attachments) rewriteClipSources(att, map);
  }
}

/**
 * Web (OPFS) platform. Stores projects under `projects/` and clip files under
 * `clips/`. Source references in .seam files are just filenames (like
 * "abc.mov") that resolve against clips/ at playback time.
 *
 * The "open" flow is a project picker modal rendered by the app. The Web
 * platform signals it via a subscription; see `onOpenRequested`/
 * `handleOpenRequest`. Similarly for "save-as", we surface a prompt UI via
 * the app.
 */
export class WebPlatform implements Platform {
  readonly kind = "web" as const;

  // Map from clip source filename → blob URL (lazily created).
  private blobUrlCache = new Map<string, string>();

  // In-memory media-meta index (lazily loaded from media-meta/index.json).
  // Persists are serialized through `indexWriteChain` so concurrent updates
  // (e.g. the browser building many entries at once) can't truncate-race.
  private mediaIndex: MediaIndex | null = null;
  private indexLoad: Promise<MediaIndex> | null = null;
  private indexWriteChain: Promise<void> = Promise.resolve();

  // Map from fingerprint → existing clip filename. Lazily built on first
  // import-like operation, then kept in sync as we add/remove clips.
  private fingerprintIndex: Map<string, string> | null = null;
  private indexBuild: Promise<void> | null = null;

  // Per-project sync sidecar (project-sync/index.json): filename → { cloudId,
  // lastSyncedHash }. The baseline for three-way conflict detection.
  private projectSyncIndex: ProjectSyncIndex | null = null;
  private projectSyncLoad: Promise<ProjectSyncIndex> | null = null;
  private projectSyncWriteChain: Promise<void> = Promise.resolve();

  // Optional Seam Cloud connection (web-editor-only). Configured at boot from
  // VITE_SEAM_CLOUD_URL. Owns the cloud media list + bearer token; consulted
  // by resolveSource (cloud fallback) and importClip (collision check).
  private _cloud: CloudClient | null = null;

  // Action callbacks registered by the app
  private actionHandlers = new Map<ActionName, () => void>();

  // "Open" and "Save As" UIs are driven by the app. The platform asks via
  // these promise-returning bridge functions, which the app wires up on mount.
  private openProjectFn: (() => Promise<OpenResult | null>) | null = null;
  private pickSavePathFn: (() => Promise<string | null>) | null = null;

  constructor() {
    this.installKeybindings();
  }

  /** Connect to a Seam Cloud instance (called at boot if a base URL is set).
   *  Restoring a prior session is the caller's job (await `cloud.restore()`). */
  configureCloud(baseUrl: string | undefined | null): CloudClient | null {
    const url = baseUrl?.trim();
    if (!url) return null;
    this._cloud = new CloudClient(url);
    return this._cloud;
  }

  /** The configured cloud client, or null when cloud isn't set up. */
  get cloud(): CloudClient | null {
    return this._cloud;
  }

  /** A cloud filename is "blocked" for a new import only when it holds
   *  *different* content (same name + same hash is the same file — keep it). */
  private cloudBlocksName(name: string, fingerprintHex: string): boolean {
    const m = this._cloud?.mediaByName(name);
    return !!m && m.contentHash !== fingerprintHex;
  }

  // ── Platform interface ───────────────────────────────────────────

  async getInitial(): Promise<{ filePath: string; json: string } | null> {
    // No auto-open on web: user picks a project via the UI.
    return null;
  }

  setTitle(title: string) {
    document.title = title;
  }

  async writeFile(filePath: string, json: string): Promise<void> {
    // filePath is of the form "projects/x.seam"
    const name = basename(filePath);
    await writeFileToDir(PROJECTS_DIR, name, json);
  }

  async openProject(): Promise<OpenResult | null> {
    if (!this.openProjectFn) {
      throw new Error(
        "WebPlatform: openProject UI handler not registered. Call setOpenProjectHandler() during app mount."
      );
    }
    return this.openProjectFn();
  }

  async pickSavePath(): Promise<string | null> {
    if (!this.pickSavePathFn) {
      throw new Error(
        "WebPlatform: pickSavePath UI handler not registered. Call setPickSavePathHandler() during app mount."
      );
    }
    return this.pickSavePathFn();
  }

  async importClip(file: File): Promise<string> {
    // pmtiles never need a blob URL — Map elements go through
    // openPmtilesSource() which reads byte ranges directly from the
    // OPFS file. Creating a blob URL would force the entire pmtiles
    // file into memory once for nothing.
    const isPmtiles = file.name.toLowerCase().endsWith(".pmtiles");
    const fp = await fingerprint(file);

    // Check if we already have an identical clip; reuse its filename if so.
    const index = await this.ensureFingerprintIndex();
    const existing = index.get(fp) ?? null;
    if (existing) {
      if (isPmtiles) return existing;
      if (!this.blobUrlCache.has(existing)) {
        try {
          const f = await readFileFromDir(CLIPS_DIR, existing);
          this.blobUrlCache.set(existing, URL.createObjectURL(f));
        } catch {
          // Fall through and write fresh if the existing file vanished
        }
      }
      if (this.blobUrlCache.has(existing)) return existing;
    }

    // Pick a name free both locally and in the Seam Cloud namespace we know
    // about (no extra request — just the cached list), so a later sync doesn't
    // immediately collide. A cloud file with the same name AND hash is the
    // same file, so it doesn't block.
    const name = await uniqueClipName(file.name, (c) =>
      this.cloudBlocksName(c, fp)
    );
    await writeFileToDir(CLIPS_DIR, name, file);
    if (!isPmtiles) {
      this.blobUrlCache.set(name, URL.createObjectURL(file));
    }

    // Keep the fingerprint index fresh
    index.set(fp, name);

    // Stamp the media-meta entry's "date added". Kind comes from the name;
    // the rest (thumbnail, capture date, duration) is filled lazily when the
    // media browser first sees the clip.
    const kind = classifyByName(name);
    if (kind) await this.updateMediaMeta(name, { addedAt: Date.now(), kind });

    return name;
  }

  /** Open a pmtiles file directly from OPFS as a File-backed pmtiles
   *  Source. Multi-GB pmtiles files stay on disk — File.slice() backs
   *  pmtiles' byte-range protocol, so only the requested ranges actually
   *  read into memory. */
  async openPmtilesSource(
    source: string,
    _basePath: string,
  ): Promise<unknown | null> {
    if (source.startsWith("http://") || source.startsWith("https://")) {
      // Remote pmtiles — let pmtiles' FetchSource handle it.
      const { FetchSource } = await import("pmtiles");
      return new FetchSource(source);
    }
    try {
      const file = await readFileFromDir(CLIPS_DIR, source);
      const { FileSource } = await import("pmtiles");
      return new FileSource(file);
    } catch (err) {
      console.warn(
        `WebPlatform.openPmtilesSource: ${source} not in OPFS clips/`,
        err,
      );
      return null;
    }
  }

  resolveSource(source: string, _basePath: string): string {
    if (source.startsWith("http://") || source.startsWith("https://")) {
      return source;
    }
    if (source.startsWith("blob:")) return source;
    // source is a filename inside clips/ — return a pre-created blob URL.
    // Local always wins.
    const cached = this.blobUrlCache.get(source);
    if (cached) return cached;
    // Not held locally — fall back to a Seam Cloud stream if a cloud asset has
    // this filename. The returned URL carries a ?token= and is byte-range
    // capable, so mediabunny's UrlSource streams it on demand (no download).
    const cloudUrl = this._cloud?.fileUrlForName(source);
    if (cloudUrl) return cloudUrl;
    // Neither local nor cloud. In practice the app should call
    // preloadBlobUrls() after opening a project for local sources.
    console.warn(
      `WebPlatform.resolveSource: no local blob URL or cloud asset for "${source}". ` +
        `Did you forget to preloadBlobUrls()?`
    );
    return source;
  }

  onAction(action: ActionName, cb: () => void): void {
    this.actionHandlers.set(action, cb);
  }

  // ── Web-specific helpers ─────────────────────────────────────────

  /** App-supplied UI for the "open" flow (project picker modal). */
  setOpenProjectHandler(fn: () => Promise<OpenResult | null>): void {
    this.openProjectFn = fn;
  }

  /** App-supplied UI for the "save as" flow. */
  setPickSavePathHandler(fn: () => Promise<string | null>): void {
    this.pickSavePathFn = fn;
  }

  /** List all projects under projects/ with metadata, sorted newest first. */
  async listProjects(): Promise<ProjectEntry[]> {
    const dir = await getDir(PROJECTS_DIR);
    const entries: ProjectEntry[] = [];
    // @ts-expect-error: values() is supported in all target browsers
    for await (const entry of dir.values()) {
      if (entry.kind !== "file" || !entry.name.endsWith(".seam")) continue;
      const file = await entry.getFile();
      entries.push({
        name: entry.name,
        lastModified: file.lastModified,
        size: file.size,
      });
    }
    entries.sort((a, b) => b.lastModified - a.lastModified);
    return entries;
  }

  /** Delete a project file from projects/. */
  async deleteProject(name: string): Promise<void> {
    const dir = await getDir(PROJECTS_DIR);
    await dir.removeEntry(name);
  }

  /** Read a specific project file's JSON. */
  async readProject(name: string): Promise<string> {
    const file = await readFileFromDir(PROJECTS_DIR, name);
    return await file.text();
  }

  /**
   * Create blob URLs for all clip sources referenced in a loaded document,
   * so resolveSource() can return them synchronously during playback.
   */
  async preloadBlobUrls(sources: string[]): Promise<void> {
    const unique = Array.from(new Set(sources));
    for (const source of unique) {
      if (this.blobUrlCache.has(source)) continue;
      if (source.startsWith("http") || source.startsWith("blob:")) continue;
      try {
        const file = await readFileFromDir(CLIPS_DIR, source);
        this.blobUrlCache.set(source, URL.createObjectURL(file));
      } catch (err) {
        console.warn(`preloadBlobUrls: failed to load "${source}"`, err);
      }
    }
  }

  // ── Media browser (clips listing, thumbnails, meta index) ────────

  /** List every file in clips/ with size + OPFS write time. */
  async listClips(): Promise<ClipEntry[]> {
    const dir = await getDir(CLIPS_DIR);
    const out: ClipEntry[] = [];
    // @ts-expect-error: values() is supported in all target browsers
    for await (const entry of dir.values()) {
      if (entry.kind !== "file") continue;
      const file = await entry.getFile();
      out.push({
        name: entry.name,
        size: file.size,
        lastModified: file.lastModified,
      });
    }
    return out;
  }

  /** The raw File for a clip — used to decode thumbnails / probe metadata. */
  async getClipFile(name: string): Promise<File> {
    return readFileFromDir(CLIPS_DIR, name);
  }

  /** Load (and cache) the media-meta index. Missing file → empty index. */
  async getMediaIndex(): Promise<MediaIndex> {
    if (this.mediaIndex) return this.mediaIndex;
    if (!this.indexLoad) {
      this.indexLoad = (async () => {
        try {
          const file = await readFileFromDir(MEDIA_META_DIR, MEDIA_INDEX_FILE);
          this.mediaIndex = JSON.parse(await file.text()) as MediaIndex;
        } catch {
          this.mediaIndex = {};
        }
        return this.mediaIndex;
      })();
    }
    return this.indexLoad;
  }

  /** Merge `patch` into a clip's meta entry and persist. Writes are chained
   *  so overlapping updates serialize. */
  async updateMediaMeta(
    name: string,
    patch: Partial<MediaMeta>,
  ): Promise<void> {
    const index = await this.getMediaIndex();
    index[name] = { ...index[name], ...patch } as MediaMeta;
    const snapshot = JSON.stringify(index);
    this.indexWriteChain = this.indexWriteChain.then(() =>
      writeFileToDir(MEDIA_META_DIR, MEDIA_INDEX_FILE, snapshot),
    );
    return this.indexWriteChain;
  }

  /** Bump a clip's "last used" timestamp (called when it lands on a timeline). */
  async markClipUsed(name: string): Promise<void> {
    await this.updateMediaMeta(name, { lastUsedAt: Date.now() });
  }

  /** A blob URL for a clip's cached thumbnail, or null if not generated yet. */
  async readThumbnailUrl(name: string): Promise<string | null> {
    try {
      const file = await readFileFromDir(THUMBS_DIR, `${name}.jpg`);
      return URL.createObjectURL(file);
    } catch {
      return null;
    }
  }

  /** Persist a generated thumbnail for a clip. */
  async writeThumbnail(name: string, blob: Blob): Promise<void> {
    await writeFileToDir(THUMBS_DIR, `${name}.jpg`, blob);
  }

  // ── Fingerprint index ────────────────────────────────────────────

  /**
   * Build (or reuse) the fingerprint → filename index by scanning clips/.
   * Concurrent calls share the same build Promise.
   */
  private async ensureFingerprintIndex(): Promise<Map<string, string>> {
    if (this.fingerprintIndex) return this.fingerprintIndex;
    if (!this.indexBuild) {
      this.indexBuild = (async () => {
        const dir = await getDir(CLIPS_DIR);
        const index = new Map<string, string>();
        // @ts-expect-error: values() is supported in all target browsers
        for await (const entry of dir.values()) {
          if (entry.kind !== "file") continue;
          try {
            const file = await entry.getFile();
            const fp = await fingerprint(file);
            // If two clips happen to share the same fingerprint, prefer the
            // lexicographically first so behaviour is deterministic.
            const prev = index.get(fp);
            if (!prev || entry.name < prev) index.set(fp, entry.name);
          } catch (err) {
            console.warn(`fingerprint scan: ${entry.name}`, err);
          }
        }
        this.fingerprintIndex = index;
      })();
    }
    await this.indexBuild;
    return this.fingerprintIndex!;
  }

  // ── Export / Import ──────────────────────────────────────────────

  async exportProject(
    doc: SeamFile,
    _basePath: string,
    defaultName: string,
    onProgress?: (p: ExportProgress) => void
  ): Promise<boolean> {
    const plan = buildExportPlan(doc);
    const seamName = `${defaultName}.seam`;

    const zip = new JSZip();
    zip.file(seamName, JSON.stringify(plan.document, null, 2));

    const total = plan.entries.length;
    for (let i = 0; i < plan.entries.length; i++) {
      const entry = plan.entries[i];
      onProgress?.({
        phase: "read",
        progress: total === 0 ? 1 : i / total,
        detail: entry.exportName,
      });
      try {
        const file = await readFileFromDir(CLIPS_DIR, entry.originalSource);
        zip.file(entry.exportName, file);
      } catch (err) {
        console.warn(
          `exportProject: skipping missing clip "${entry.originalSource}"`,
          err
        );
      }
    }
    onProgress?.({ phase: "read", progress: 1 });

    const blob = await zip.generateAsync({ type: "blob" }, (metadata) => {
      onProgress?.({
        phase: "zip",
        progress: metadata.percent / 100,
        detail: metadata.currentFile ?? undefined,
      });
    });

    onProgress?.({ phase: "write", progress: 1 });

    triggerDownload(blob, `${defaultName}.zip`);

    return true;
  }

  /** Trigger a browser download of just the document's JSON as a
   *  `.seam` file. No clips bundled — the user owns the asset side. */
  async exportSeamFile(doc: SeamFile, defaultName: string): Promise<void> {
    const json = JSON.stringify(doc, null, 2);
    triggerDownload(new Blob([json], { type: "application/json" }), `${defaultName}.seam`);
  }

  /** Download a stored project's `.seam` file verbatim (no clips). Used by the
   *  landing screen's per-project Download action. */
  async downloadProject(name: string): Promise<void> {
    const file = await readFileFromDir(PROJECTS_DIR, name);
    triggerDownload(file, name);
  }

  /** Download a stored clip's raw file. Used by the landing screen's media grid. */
  async downloadClip(name: string): Promise<void> {
    const file = await readFileFromDir(CLIPS_DIR, name);
    triggerDownload(file, name);
  }

  // ── Seam Cloud upload / download ─────────────────────────────────

  /** Upload one local clip to Seam Cloud. The server dedups by filename +
   *  content hash (identical → accepted, conflicting → reported). */
  async uploadClipToCloud(name: string): Promise<UploadResult> {
    if (!this._cloud) throw new Error("Seam Cloud is not connected.");
    const file = await readFileFromDir(CLIPS_DIR, name);
    // Send our content hash so the server can reject a conflict before
    // streaming the bytes.
    return this._cloud.uploadMedia(file, await fingerprint(file));
  }

  /** Upload every local media file not already on the cloud. Identical copies
   *  (same name + hash) are skipped; conflicts are collected, not thrown. */
  async syncAllToCloud(
    onProgress?: (done: number, total: number, name: string) => void
  ): Promise<SyncSummary> {
    const cloud = this._cloud;
    if (!cloud) throw new Error("Seam Cloud is not connected.");

    const clips = (await this.listClips()).filter((c) => classifyByName(c.name));
    const fpIndex = await this.ensureFingerprintIndex();
    const nameToFp = new Map<string, string>();
    for (const [fp, name] of fpIndex) nameToFp.set(name, fp);

    const summary: SyncSummary = {
      uploaded: 0,
      alreadyPresent: 0,
      skipped: 0,
      conflicts: [],
    };

    for (let i = 0; i < clips.length; i++) {
      const { name } = clips[i];
      onProgress?.(i, clips.length, name);

      // Already on the cloud with identical content — don't re-upload bytes.
      const cm = cloud.mediaByName(name);
      const localFp = nameToFp.get(name);
      if (cm && localFp && cm.contentHash === localFp) {
        summary.skipped++;
        continue;
      }

      const file = await readFileFromDir(CLIPS_DIR, name);
      const res = await cloud.uploadMedia(file, localFp ?? (await fingerprint(file)));
      if (res.kind === "created") summary.uploaded++;
      else if (res.kind === "exists") summary.alreadyPresent++;
      else summary.conflicts.push({ name, message: res.message });
    }

    onProgress?.(clips.length, clips.length, "");
    await cloud.refreshMedia();
    return summary;
  }

  /** Names of every file currently in OPFS clips/. */
  private async localClipNames(): Promise<Set<string>> {
    const dir = await getDir(CLIPS_DIR);
    const names = new Set<string>();
    // @ts-expect-error: values() is supported in all target browsers
    for await (const entry of dir.values()) {
      if (entry.kind === "file") names.add(entry.name);
    }
    return names;
  }

  /**
   * Categorize a document's media sources by where they live. `localOnly` are
   * held locally but not on the cloud (upload candidates); `cloudOnly` are on
   * the cloud but absent locally (download candidates). Remote (http) and blob
   * sources are ignored — they aren't cloud-syncable assets.
   */
  async classifyProjectMedia(
    doc: SeamFile
  ): Promise<{ localOnly: string[]; cloudOnly: string[] }> {
    const sources = Array.from(new Set(collectClipSources(doc))).filter(
      (s) =>
        !s.startsWith("http://") &&
        !s.startsWith("https://") &&
        !s.startsWith("blob:")
    );
    const local = await this.localClipNames();
    const localOnly: string[] = [];
    const cloudOnly: string[] = [];
    for (const s of sources) {
      const isLocal = local.has(s);
      const onCloud = !!this._cloud?.mediaByName(s);
      if (isLocal && !onCloud) localOnly.push(s);
      else if (!isLocal && onCloud) cloudOnly.push(s);
    }
    return { localOnly, cloudOnly };
  }

  /** The document's media sources that live only on the cloud — i.e. wouldn't
   *  be bundled by an Export Zip. Used to warn before exporting. */
  async cloudOnlyMediaSources(doc: SeamFile): Promise<string[]> {
    return (await this.classifyProjectMedia(doc)).cloudOnly;
  }

  /** Upload every media source this project references that the cloud doesn't
   *  already have. Conflicts (a different file with the same name on the cloud)
   *  are collected, not thrown — the user renames to resolve. */
  async uploadProjectMedia(
    doc: SeamFile,
    onProgress?: (done: number, total: number, name: string) => void
  ): Promise<MediaSyncSummary> {
    const cloud = this._cloud;
    if (!cloud) throw new Error("Seam Cloud is not connected.");
    const { localOnly } = await this.classifyProjectMedia(doc);
    const summary: MediaSyncSummary = { done: 0, conflicts: [] };
    for (let i = 0; i < localOnly.length; i++) {
      onProgress?.(i, localOnly.length, localOnly[i]);
      try {
        const res = await this.uploadClipToCloud(localOnly[i]);
        if (res.kind === "conflict") {
          summary.conflicts.push({ name: localOnly[i], message: res.message });
        } else {
          summary.done++;
        }
      } catch (err) {
        summary.conflicts.push({ name: localOnly[i], message: errMessage(err) });
      }
    }
    onProgress?.(localOnly.length, localOnly.length, "");
    await cloud.refreshMedia();
    return summary;
  }

  /** Download every media source this project references that exists on the
   *  cloud but not locally. Local dedup conflicts are collected, not thrown. */
  async downloadProjectMedia(
    doc: SeamFile,
    onProgress?: (done: number, total: number, name: string) => void
  ): Promise<MediaSyncSummary> {
    const cloud = this._cloud;
    if (!cloud) throw new Error("Seam Cloud is not connected.");
    const { cloudOnly } = await this.classifyProjectMedia(doc);
    const summary: MediaSyncSummary = { done: 0, conflicts: [] };
    for (let i = 0; i < cloudOnly.length; i++) {
      const name = cloudOnly[i];
      onProgress?.(i, cloudOnly.length, name);
      const m = cloud.mediaByName(name);
      if (!m) continue;
      try {
        await this.downloadClipFromCloud(m.id, m.filename, m.contentHash);
        summary.done++;
      } catch (err) {
        summary.conflicts.push({ name, message: errMessage(err) });
      }
    }
    onProgress?.(cloudOnly.length, cloudOnly.length, "");
    return summary;
  }

  /**
   * Download a cloud asset into local OPFS, enforcing the same dedup rules
   * locally: refuse if this content already exists locally (under any name) or
   * if the target filename is taken by *different* content. The user resolves
   * conflicts by renaming (a later pass).
   */
  async downloadClipFromCloud(
    cloudId: string,
    filename: string,
    contentHash: string | null
  ): Promise<void> {
    const cloud = this._cloud;
    if (!cloud) throw new Error("Seam Cloud is not connected.");

    const index = await this.ensureFingerprintIndex();

    // Content already present locally (possibly under a different name)?
    if (contentHash && index.has(contentHash)) {
      const existing = index.get(contentHash)!;
      if (existing === filename) return; // identical file already local — no-op
      throw new Error(
        `You already have this content locally as "${existing}". Rename to reconcile.`
      );
    }

    // Filename taken locally by different content?
    if (await this.clipExists(filename)) {
      const local = await readFileFromDir(CLIPS_DIR, filename);
      if (contentHash && (await fingerprint(local)) === contentHash) return;
      throw new Error(
        `A different local file named "${filename}" already exists. Rename to reconcile.`
      );
    }

    const blob = await cloud.downloadMedia(cloudId);
    await writeFileToDir(CLIPS_DIR, filename, blob);
    const fp = await fingerprint(blob);
    index.set(fp, filename);
    if (!filename.toLowerCase().endsWith(".pmtiles")) {
      this.blobUrlCache.set(filename, URL.createObjectURL(blob));
    }
    const kind = classifyByName(filename);
    if (kind) await this.updateMediaMeta(filename, { addedAt: Date.now(), kind });
  }

  private async clipExists(name: string): Promise<boolean> {
    const dir = await getDir(CLIPS_DIR);
    return fileExists(dir, name);
  }

  // ── Project sync (cloud) ─────────────────────────────────────────

  private async getProjectSyncIndex(): Promise<ProjectSyncIndex> {
    if (this.projectSyncIndex) return this.projectSyncIndex;
    if (!this.projectSyncLoad) {
      this.projectSyncLoad = (async () => {
        try {
          const file = await readFileFromDir(PROJECT_SYNC_DIR, PROJECT_SYNC_FILE);
          this.projectSyncIndex = JSON.parse(await file.text()) as ProjectSyncIndex;
        } catch {
          this.projectSyncIndex = {};
        }
        return this.projectSyncIndex;
      })();
    }
    return this.projectSyncLoad;
  }

  private async setProjectSyncEntry(
    name: string,
    entry: ProjectSyncEntry
  ): Promise<void> {
    const index = await this.getProjectSyncIndex();
    index[name] = { ...index[name], ...entry };
    const snapshot = JSON.stringify(index);
    this.projectSyncWriteChain = this.projectSyncWriteChain.then(() =>
      writeFileToDir(PROJECT_SYNC_DIR, PROJECT_SYNC_FILE, snapshot)
    );
    return this.projectSyncWriteChain;
  }

  /** Content fingerprint of a local project file (the same hash the cloud
   *  computes server-side, so the two are directly comparable). */
  private async projectHash(name: string): Promise<string | null> {
    try {
      const file = await readFileFromDir(PROJECTS_DIR, name);
      return fingerprint(file);
    } catch {
      return null;
    }
  }

  /**
   * Classify a project's local↔cloud relationship via the three-way hash
   * compare (local hash vs cloud hash vs last-synced baseline). `name` is the
   * project filename as it appears in either list.
   */
  async projectSyncState(name: string): Promise<ProjectSyncState> {
    const cloud = this._cloud?.projectByName(name) ?? null;
    const localHash = await this.projectHash(name);
    const localExists = localHash !== null;

    if (!localExists) {
      return { status: "cloud-only", cloudId: cloud?.id ?? null };
    }
    if (!cloud) {
      const entry = (await this.getProjectSyncIndex())[name];
      return { status: "local-only", cloudId: entry?.cloudId ?? null };
    }

    const cloudId = cloud.id;
    if (localHash === cloud.contentHash) {
      return { status: "in-sync", cloudId };
    }

    const base = (await this.getProjectSyncIndex())[name]?.lastSyncedHash ?? null;
    // No baseline (e.g. a local and cloud project that share a name but were
    // never synced together) → treat divergence as a conflict.
    const localChanged = base === null || localHash !== base;
    const remoteChanged = base === null || cloud.contentHash !== base;

    if (localChanged && remoteChanged) return { status: "out-of-sync", cloudId };
    if (localChanged) return { status: "local-ahead", cloudId };
    return { status: "remote-ahead", cloudId };
  }

  /**
   * Upload a local project to the cloud. First upload POSTs a new project
   * (may 409 on a name clash → the user renames); a previously-synced project
   * PUTs against its stored id (overwrites the cloud copy — also the
   * "keep local" conflict resolution). Advances the synced baseline on success.
   */
  async uploadProjectToCloud(name: string): Promise<ProjectUploadOutcome> {
    const cloud = this._cloud;
    if (!cloud) throw new Error("Seam Cloud is not connected.");

    const content = await this.readProject(name);
    const entry = (await this.getProjectSyncIndex())[name];

    if (entry?.cloudId) {
      const project = await cloud.updateProject(entry.cloudId, content);
      await this.setProjectSyncEntry(name, {
        cloudId: project.id,
        lastSyncedHash: project.contentHash ?? undefined,
      });
    } else {
      const result = await cloud.uploadProject(name, content);
      if (result.kind === "conflict") {
        return { kind: "name-exists", message: result.message };
      }
      await this.setProjectSyncEntry(name, {
        cloudId: result.project.id,
        lastSyncedHash: result.project.contentHash ?? undefined,
      });
    }
    await cloud.refresh();
    return { kind: "uploaded" };
  }

  /**
   * Download a cloud project into local OPFS, overwriting the local copy (also
   * the "keep remote" conflict resolution). Advances the synced baseline.
   */
  async downloadProjectFromCloud(project: CloudProject): Promise<void> {
    const cloud = this._cloud;
    if (!cloud) throw new Error("Seam Cloud is not connected.");

    const content = await cloud.projectText(project.id);
    await writeFileToDir(PROJECTS_DIR, project.name, content);
    await this.setProjectSyncEntry(project.name, {
      cloudId: project.id,
      lastSyncedHash: project.contentHash ?? undefined,
    });
  }

  /**
   * Delete a clip's local copy: the OPFS file, its cached thumbnail, its
   * media-meta entry, its fingerprint-index slot, and any live blob URL. This
   * only touches local storage — a Seam Cloud copy (if any) is untouched, which
   * is what makes deleting an already-synced clip recoverable.
   */
  async deleteClip(name: string): Promise<void> {
    const clips = await getDir(CLIPS_DIR);
    await clips.removeEntry(name).catch(() => {});

    const thumbs = await getDir(THUMBS_DIR);
    await thumbs.removeEntry(`${name}.jpg`).catch(() => {});

    // Drop the media-meta entry (persist through the serialized write chain).
    const index = await this.getMediaIndex();
    if (name in index) {
      delete index[name];
      const snapshot = JSON.stringify(index);
      this.indexWriteChain = this.indexWriteChain.then(() =>
        writeFileToDir(MEDIA_META_DIR, MEDIA_INDEX_FILE, snapshot),
      );
      await this.indexWriteChain;
    }

    // Remove the fingerprint slot pointing at this name.
    if (this.fingerprintIndex) {
      for (const [fp, n] of this.fingerprintIndex) {
        if (n === name) this.fingerprintIndex.delete(fp);
      }
    }

    const url = this.blobUrlCache.get(name);
    if (url) {
      URL.revokeObjectURL(url);
      this.blobUrlCache.delete(name);
    }
  }

  /** True if `projects/<name>` already exists. Lets the caller warn
   *  before `importSeamFile` overwrites it. */
  async projectExists(name: string): Promise<boolean> {
    const dir = await getDir(PROJECTS_DIR);
    try {
      await dir.getFileHandle(name);
      return true;
    } catch {
      return false;
    }
  }

  /** Import a bare `.seam` JSON file into `projects/`. Overwrites a
   *  project with the same filename if it exists (caller is responsible
   *  for confirming with the user first). Returns the loaded
   *  `{filePath, json}` ready to hand to `openFromJson`. */
  async importSeamFile(
    file: File,
  ): Promise<{ filePath: string; json: string }> {
    const json = await file.text();
    const name = file.name.endsWith(".seam") ? file.name : `${file.name}.seam`;
    await writeFileToDir(PROJECTS_DIR, name, json);
    return { filePath: `projects/${name}`, json };
  }

  async importProject(
    file: File
  ): Promise<{ filePath: string; json: string } | null> {
    const zip = await JSZip.loadAsync(file);

    // Find the (one expected) .seam entry
    let seamEntryName: string | null = null;
    for (const name of Object.keys(zip.files)) {
      if (zip.files[name].dir) continue;
      if (name.toLowerCase().endsWith(".seam")) {
        if (seamEntryName) {
          throw new Error(
            "Zip contains multiple .seam files; expected exactly one."
          );
        }
        seamEntryName = name;
      }
    }
    if (!seamEntryName) throw new Error("Zip contains no .seam file.");

    // Write each non-seam file into OPFS clips/. Track renames (for when we
    // had to disambiguate or when a fingerprint match found an existing
    // clip with a different name) so we can rewrite references in the .seam.
    const renameMap = new Map<string, string>();
    const index = await this.ensureFingerprintIndex();
    for (const name of Object.keys(zip.files)) {
      const entry = zip.files[name];
      if (entry.dir) continue;
      if (name === seamEntryName) continue;
      const clipName = basename(name);
      const blob = await entry.async("blob");

      // If an identical clip already exists, reuse it (skip the write)
      const fp = await fingerprint(blob);
      const existing = index.get(fp);
      if (existing) {
        if (existing !== clipName) renameMap.set(clipName, existing);
        continue;
      }

      const uniqueClip = await uniqueClipName(clipName);
      await writeFileToDir(CLIPS_DIR, uniqueClip, blob);
      index.set(fp, uniqueClip);
      if (uniqueClip !== clipName) renameMap.set(clipName, uniqueClip);
    }

    // Read + maybe rewrite the seam file
    const seamText = await zip.files[seamEntryName].async("string");
    let finalJson = seamText;
    if (renameMap.size > 0) {
      try {
        const parsed = JSON.parse(seamText);
        rewriteClipSources(parsed, renameMap);
        finalJson = JSON.stringify(parsed, null, 2);
      } catch (err) {
        console.warn(
          "importProject: seam file did not parse; storing as-is",
          err
        );
      }
    }

    // Write the seam file into OPFS projects/, using a unique name
    const rawSeamName = basename(seamEntryName);
    const finalSeamName = await uniqueProjectName(rawSeamName);
    await writeFileToDir(PROJECTS_DIR, finalSeamName, finalJson);

    return { filePath: `projects/${finalSeamName}`, json: finalJson };
  }

  /** Free blob URLs we're no longer using (called when loading a new project). */
  clearBlobUrlCache(): void {
    for (const url of this.blobUrlCache.values()) {
      URL.revokeObjectURL(url);
    }
    this.blobUrlCache.clear();
  }

  // ── Internal ─────────────────────────────────────────────────────

  private installKeybindings(): void {
    window.addEventListener("keydown", (e) => {
      const mod = e.metaKey || e.ctrlKey;
      if (!mod) return;
      const key = e.key.toLowerCase();
      if (key === "n") {
        e.preventDefault();
        this.actionHandlers.get("new")?.();
      } else if (key === "o") {
        e.preventDefault();
        this.actionHandlers.get("open")?.();
      } else if (key === "s" && !e.shiftKey) {
        e.preventDefault();
        this.actionHandlers.get("save")?.();
      } else if (key === "s" && e.shiftKey) {
        e.preventDefault();
        this.actionHandlers.get("save-as")?.();
      } else if (key === "e") {
        e.preventDefault();
        this.actionHandlers.get("export")?.();
      } else if (key === ",") {
        e.preventDefault();
        this.actionHandlers.get("settings")?.();
      }
    });
  }

}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

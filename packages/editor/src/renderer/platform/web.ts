import JSZip from "jszip";
import type { SeamFile } from "@seam/core";
import type {
  ActionName,
  ExportProgress,
  OpenResult,
  Platform,
} from "./types.js";
import { buildExportPlan } from "../exportHelpers.js";

const PROJECTS_DIR = "projects";
const CLIPS_DIR = "clips";

export interface ProjectEntry {
  name: string;
  lastModified: number;
  size: number;
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

/** Return a filename inside `dirName` that doesn't yet exist. */
async function uniqueName(dirName: string, originalName: string): Promise<string> {
  const dir = await getDir(dirName);
  const dot = originalName.lastIndexOf(".");
  const base = dot >= 0 ? originalName.slice(0, dot) : originalName;
  const ext = dot >= 0 ? originalName.slice(dot) : "";
  let candidate = originalName;
  let i = 1;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      await dir.getFileHandle(candidate);
      candidate = `${base}-${i}${ext}`;
      i++;
    } catch {
      return candidate;
    }
  }
}

async function uniqueClipName(originalName: string): Promise<string> {
  return uniqueName(CLIPS_DIR, originalName);
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
  if (n.type === "clip" && typeof n.source === "string") {
    const replaced = map.get(n.source);
    if (replaced) n.source = replaced;
  }
  if (Array.isArray(n.children)) {
    for (const child of n.children) rewriteClipSources(child, map);
  }
  if (Array.isArray(n.attachments)) {
    for (const att of n.attachments) rewriteClipSources(att, map);
  }
  if (n.refs && typeof n.refs === "object") {
    for (const def of Object.values(n.refs as Record<string, unknown>)) {
      rewriteClipSources(def, map);
    }
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

  // Map from fingerprint → existing clip filename. Lazily built on first
  // import-like operation, then kept in sync as we add/remove clips.
  private fingerprintIndex: Map<string, string> | null = null;
  private indexBuild: Promise<void> | null = null;

  // Action callbacks registered by the app
  private actionHandlers = new Map<ActionName, () => void>();

  // "Open" and "Save As" UIs are driven by the app. The platform asks via
  // these promise-returning bridge functions, which the app wires up on mount.
  private openProjectFn: (() => Promise<OpenResult | null>) | null = null;
  private pickSavePathFn: (() => Promise<string | null>) | null = null;

  constructor() {
    this.installKeybindings();
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
    // Check if we already have an identical clip; reuse its filename if so.
    const existing = await this.findExistingClip(file);
    if (existing) {
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

    const name = await uniqueClipName(file.name);
    await writeFileToDir(CLIPS_DIR, name, file);
    this.blobUrlCache.set(name, URL.createObjectURL(file));

    // Keep index fresh
    const fp = await fingerprint(file);
    const index = await this.ensureFingerprintIndex();
    index.set(fp, name);

    return name;
  }

  resolveSource(source: string, _basePath: string): string {
    if (source.startsWith("http://") || source.startsWith("https://")) {
      return source;
    }
    if (source.startsWith("blob:")) return source;
    // source is a filename inside clips/ — return a pre-created blob URL
    const cached = this.blobUrlCache.get(source);
    if (cached) return cached;
    // Not cached; return a placeholder the caller can notice. In practice
    // the app should call preloadBlobUrls() after opening a project.
    console.warn(
      `WebPlatform.resolveSource: no cached blob URL for "${source}". ` +
        `Did you forget to preloadBlobUrls()?`
    );
    return source;
  }

  onAction(action: ActionName, cb: () => void): void {
    this.actionHandlers.set(action, cb);
  }

  async isMobileLayout(): Promise<boolean> {
    return (
      typeof window !== "undefined" &&
      window.matchMedia("(pointer: coarse)").matches
    );
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

  /** Return an existing clip filename with the same fingerprint, or null. */
  private async findExistingClip(file: Blob): Promise<string | null> {
    const index = await this.ensureFingerprintIndex();
    const fp = await fingerprint(file);
    return index.get(fp) ?? null;
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

    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${defaultName}.zip`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);

    return true;
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
        this.exportHandler?.();
      }
    });
  }

  /** Registered by App for the export shortcut. */
  private exportHandler: (() => void) | null = null;
  setExportHandler(cb: () => void): void {
    this.exportHandler = cb;
  }
}

function basename(p: string): string {
  const i = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  return i < 0 ? p : p.slice(i + 1);
}

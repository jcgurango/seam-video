import type { SeamFile } from "@seam/core";

export type PlatformKind = "electron" | "web" | "mobile";
export type ActionName = "new" | "open" | "save" | "save-as";

export type OpenResult =
  | { filePath: string; json: string }
  | { error: string };

export interface ExportProgress {
  /** "read" = pulling clip bytes. "zip" = generating the archive. */
  phase: "read" | "zip" | "write";
  /** 0..1 within the current phase. */
  progress: number;
  /** Optional human-readable detail (e.g. current clip name). */
  detail?: string;
}

/**
 * Platform abstraction for the editor. Each host environment (Electron, Web,
 * Capacitor) provides an implementation. The React app code is platform-agnostic
 * and calls these methods instead of touching window.seamApi directly.
 */
export interface Platform {
  kind: PlatformKind;

  // ── Lifecycle ────────────────────────────────────────────────────

  /** Loaded on app start: returns the initial project (from CLI arg, last
   *  opened, etc.) or null if the app should start empty. */
  getInitial(): Promise<{ filePath: string; json: string } | null>;

  /** Update the window title (if supported). */
  setTitle(title: string): void;

  // ── File I/O ─────────────────────────────────────────────────────

  writeFile(filePath: string, json: string): Promise<void>;

  /**
   * "Open" flow: should surface the platform's native picker (Electron),
   * the project list modal (web), or similar. Returns the selected project
   * or null if the user cancelled.
   */
  openProject(): Promise<OpenResult | null>;

  /** "Save as" flow: ask the user where/what to save as; returns the
   *  chosen file path, or null if cancelled. */
  pickSavePath(): Promise<string | null>;

  // ── Import ────────────────────────────────────────────────────────

  /**
   * Copy/register a user-provided clip file so it can be referenced by the
   * document. Returns the source reference to store in the .seam file —
   * an absolute path on Electron, a relative filename (inside clips/) on
   * Web/Capacitor.
   */
  importClip(file: File): Promise<string>;

  // ── Media loading ────────────────────────────────────────────────

  /**
   * Convert a clip's `source` field (as stored in the .seam file) into a
   * URL mediabunny can load.
   */
  resolveSource(source: string, basePath: string): string;

  // ── Menu / keyboard actions ──────────────────────────────────────

  /** Register a callback to run when the platform fires an action (from
   *  menu clicks, keyboard shortcuts, or UI buttons). */
  onAction(action: ActionName, cb: () => void): void;

  // ── Export / Import ──────────────────────────────────────────────

  /**
   * Export the current document and its clips as a flat zip. On Desktop this
   * prompts for a save location; on Web this triggers a browser download.
   * `basePath` is the current project's directory (empty string on web).
   * `defaultName` is the suggested filename (without extension).
   *
   * `onProgress` is called as the export progresses. Returns true when the
   * user completed the export (wrote a file / downloaded), false if they
   * cancelled.
   */
  exportProject(
    doc: SeamFile,
    basePath: string,
    defaultName: string,
    onProgress?: (p: ExportProgress) => void
  ): Promise<boolean>;

  /**
   * Import a flat zip (produced by exportProject) into the platform's
   * storage. Returns the imported project's `filePath` + `json` so the app
   * can open it immediately. Web-only for now (Desktop just opens files
   * directly).
   */
  importProject?: (
    file: File
  ) => Promise<{ filePath: string; json: string } | null>;

  // ── Optional / platform-specific ─────────────────────────────────

  /** Electron only: whether mobile device emulation is active. */
  getMobileEmulation?(): Promise<boolean>;
}

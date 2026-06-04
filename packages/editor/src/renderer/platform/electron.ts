import { defaultResolveSource } from "@seam/preview";
import type { SeamFile } from "@seam/core";
import type {
  ActionName,
  ExportProgress,
  OpenResult,
  Platform,
} from "./types.js";
import { buildExportPlan } from "../exportHelpers.js";
import { isAbsolute } from "../pathUtils.js";

interface ElectronSeamApi {
  onMenuNew: (cb: () => void) => void;
  onMenuOpen: (cb: () => void) => void;
  onMenuSave: (cb: () => void) => void;
  onMenuSaveAs: (cb: () => void) => void;
  onMenuExport: (cb: () => void) => void;
  onMenuSettings: (cb: () => void) => void;
  getInitialFile: () => Promise<{ filePath: string; json: string } | null>;
  writeFile: (
    filePath: string,
    json: string
  ) => Promise<{ success: boolean } | { error: string }>;
  showOpenDialog: () => Promise<OpenResult | null>;
  showSaveDialog: () => Promise<string | null>;
  setTitle: (title: string) => void;
  getMobileEmulation: () => Promise<boolean>;
  getPathForFile: (file: File) => string;
  exportProject: (payload: {
    seamFileName: string;
    docJson: string;
    clips: Array<{ sourcePath: string; exportName: string }>;
    defaultName: string;
  }) => Promise<{ success: true } | { canceled: true } | { error: string }>;
  onExportProgress: (
    cb: (p: ExportProgress) => void
  ) => () => void;
}

declare global {
  interface Window {
    seamApi: ElectronSeamApi;
  }
}

export class ElectronPlatform implements Platform {
  readonly kind = "electron" as const;

  private exportHandler: (() => void) | null = null;

  constructor() {
    window.seamApi.onMenuExport(() => this.exportHandler?.());
  }

  getInitial() {
    return window.seamApi.getInitialFile();
  }

  setTitle(title: string) {
    window.seamApi.setTitle(title);
  }

  async writeFile(filePath: string, json: string) {
    const res = await window.seamApi.writeFile(filePath, json);
    if ("error" in res) throw new Error(res.error);
  }

  async openProject(): Promise<OpenResult | null> {
    return window.seamApi.showOpenDialog();
  }

  async pickSavePath(): Promise<string | null> {
    return window.seamApi.showSaveDialog();
  }

  async importClip(file: File): Promise<string> {
    return window.seamApi.getPathForFile(file);
  }

  resolveSource(source: string, basePath: string): string {
    return defaultResolveSource(source, basePath);
  }

  onAction(action: ActionName, cb: () => void) {
    switch (action) {
      case "new":
        window.seamApi.onMenuNew(cb);
        break;
      case "open":
        window.seamApi.onMenuOpen(cb);
        break;
      case "save":
        window.seamApi.onMenuSave(cb);
        break;
      case "save-as":
        window.seamApi.onMenuSaveAs(cb);
        break;
      case "settings":
        window.seamApi.onMenuSettings(cb);
        break;
    }
  }

  /**
   * Register an Export handler separate from onAction because Electron's
   * native menu has its own "Export…" item wired via onMenuExport.
   */
  onExportRequested(cb: () => void): void {
    this.exportHandler = cb;
  }

  async exportProject(
    doc: SeamFile,
    basePath: string,
    defaultName: string,
    onProgress?: (p: ExportProgress) => void
  ): Promise<boolean> {
    const plan = buildExportPlan(doc);
    const clips = plan.entries.map((entry) => {
      const p = entry.originalSource;
      const sourcePath = isAbsolute(p) ? p : `${basePath}/${p}`;
      return { sourcePath, exportName: entry.exportName };
    });

    const unsubscribe = onProgress
      ? window.seamApi.onExportProgress(onProgress)
      : null;

    try {
      const res = await window.seamApi.exportProject({
        seamFileName: `${defaultName}.seam`,
        docJson: JSON.stringify(plan.document, null, 2),
        clips,
        defaultName,
      });

      if ("error" in res) throw new Error(res.error);
      if ("canceled" in res) return false;
      return true;
    } finally {
      unsubscribe?.();
    }
  }

  isMobileLayout() {
    // On Electron the "mobile" layout follows the debug emulation toggle.
    return window.seamApi.getMobileEmulation();
  }
}

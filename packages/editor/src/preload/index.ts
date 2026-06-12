import { contextBridge, ipcRenderer, webUtils } from "electron";

contextBridge.exposeInMainWorld("seamApi", {
  // Menu events from main
  onMenuNew: (cb: () => void) => {
    ipcRenderer.on("menu-new", () => cb());
  },
  onMenuOpen: (cb: () => void) => {
    ipcRenderer.on("menu-open", () => cb());
  },
  onMenuSave: (cb: () => void) => {
    ipcRenderer.on("menu-save", () => cb());
  },
  onMenuSaveAs: (cb: () => void) => {
    ipcRenderer.on("menu-save-as", () => cb());
  },
  onMenuExport: (cb: () => void) => {
    ipcRenderer.on("menu-export", () => cb());
  },
  onMenuSettings: (cb: () => void) => {
    ipcRenderer.on("menu-settings", () => cb());
  },

  // File I/O
  getInitialFile: () =>
    ipcRenderer.invoke("get-initial-file") as Promise<{ filePath: string; json: string } | null>,
  readFile: (filePath: string) =>
    ipcRenderer.invoke("read-file", filePath) as Promise<{ json: string } | { error: string }>,
  writeFile: (filePath: string, json: string) =>
    ipcRenderer.invoke("write-file", filePath, json) as Promise<{ success: boolean } | { error: string }>,
  showOpenDialog: () =>
    ipcRenderer.invoke("show-open-dialog") as Promise<{ filePath: string; json: string } | { error: string } | null>,
  showSaveDialog: () =>
    ipcRenderer.invoke("show-save-dialog") as Promise<string | null>,
  setTitle: (title: string) => ipcRenderer.invoke("set-title", title),

  // Utilities
  getPathForFile: (file: File) => webUtils.getPathForFile(file),

  // Export
  exportProject: (payload: {
    seamFileName: string;
    docJson: string;
    clips: Array<{ sourcePath: string; exportName: string }>;
    defaultName: string;
  }) =>
    ipcRenderer.invoke("export-project", payload) as Promise<
      { success: true } | { canceled: true } | { error: string }
    >,
  onExportProgress: (
    cb: (p: { phase: "read" | "zip" | "write"; progress: number; detail?: string }) => void
  ) => {
    const handler = (
      _evt: unknown,
      p: { phase: "read" | "zip" | "write"; progress: number; detail?: string }
    ) => cb(p);
    ipcRenderer.on("export-progress", handler);
    return () => ipcRenderer.removeListener("export-progress", handler);
  },
});

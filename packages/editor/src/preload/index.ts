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
  getMobileEmulation: () =>
    ipcRenderer.invoke("get-mobile-emulation") as Promise<boolean>,
  getPathForFile: (file: File) => webUtils.getPathForFile(file),
});

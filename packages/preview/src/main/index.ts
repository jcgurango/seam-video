import { app, BrowserWindow, ipcMain, protocol, net } from "electron";
import { readFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { watch } from "chokidar";
import { parseSeamFile, resolveComposition } from "@seam/core";

let mainWindow: BrowserWindow | null = null;
let seamFilePath: string | null = null;

function loadAndSend() {
  if (!seamFilePath || !mainWindow) return;

  try {
    const json = readFileSync(seamFilePath, "utf-8");
    const result = parseSeamFile(json);
    if (result.success) {
      const timeline = resolveComposition(result.data);
      mainWindow.webContents.send("timeline-update", {
        timeline,
        basePath: dirname(seamFilePath),
      });
    } else {
      mainWindow.webContents.send("timeline-error", result.errors);
    }
  } catch (err) {
    mainWindow.webContents.send("timeline-error", [String(err)]);
  }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 720,
    webPreferences: {
      preload: join(__dirname, "../preload/index.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: false,
    },
  });

  if (process.env.ELECTRON_RENDERER_URL) {
    mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    mainWindow.loadFile(join(__dirname, "../renderer/index.html"));
  }

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

app.whenReady().then(() => {
  createWindow();

  // Get seam file path from args or SEAM_FILE env var
  const args = process.argv.slice(2);
  const fileArg = args[0] || process.env.SEAM_FILE;
  seamFilePath = fileArg ? resolve(fileArg) : null;

  if (seamFilePath) {
    loadAndSend();

    // Watch for changes
    const watcher = watch(seamFilePath, { persistent: true });
    watcher.on("change", () => {
      loadAndSend();
    });
  }

  ipcMain.handle("get-initial-timeline", () => {
    if (!seamFilePath) return null;
    try {
      const json = readFileSync(seamFilePath, "utf-8");
      const result = parseSeamFile(json);
      if (result.success) {
        return {
          timeline: resolveComposition(result.data),
          basePath: dirname(seamFilePath),
        };
      }
    } catch {}
    return null;
  });
});

app.on("window-all-closed", () => {
  app.quit();
});

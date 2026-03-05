import { app, BrowserWindow, ipcMain } from "electron";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
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

// Validate the seam file upfront before launching the window
function validateSeamFile(filePath: string): void {
  if (!existsSync(filePath)) {
    console.error(`Error: file not found: ${filePath}`);
    process.exit(1);
  }

  try {
    const json = readFileSync(filePath, "utf-8");
    const result = parseSeamFile(json);
    if (!result.success) {
      console.error(`Error: invalid .seam file: ${filePath}`);
      for (const err of result.errors) {
        console.error(`  ${err}`);
      }
      process.exit(1);
    }
  } catch (err) {
    console.error(`Error: could not read ${filePath}: ${err}`);
    process.exit(1);
  }
}

app.whenReady().then(() => {
  // Get seam file path from args or SEAM_FILE env var
  const args = process.argv.slice(2);
  const fileArg = args[0] || process.env.SEAM_FILE;
  seamFilePath = fileArg ? resolve(fileArg) : null;

  if (!seamFilePath) {
    console.error("Usage: SEAM_FILE=<path> electron-vite dev");
    process.exit(1);
  }

  validateSeamFile(seamFilePath);

  createWindow();

  loadAndSend();

  // Watch for changes (re-parse errors are sent to the renderer)
  const watcher = watch(seamFilePath, { persistent: true });
  watcher.on("change", () => {
    loadAndSend();
  });

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

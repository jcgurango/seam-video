import { app, BrowserWindow, dialog, ipcMain, Menu, protocol } from "electron";
import { createReadStream, existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { parseSeamFile, resolveComposition, resolveSpatial } from "@seam/core";
import type { SeamFile } from "@seam/core";

let mainWindow: BrowserWindow | null = null;
let seamFilePath: string | null = null;
let currentDocument: SeamFile = { type: "composition", children: [] };
let mobileEmulation = false;

const EMPTY_DOCUMENT: SeamFile = { type: "composition", children: [] };

function updateTitle() {
  if (!mainWindow) return;
  const title = seamFilePath
    ? `Seam Editor — ${seamFilePath}`
    : "Seam Editor — Untitled";
  mainWindow.setTitle(title);
}

function resolveAndSend() {
  if (!mainWindow) return;
  try {
    const temporal = resolveComposition(currentDocument);
    const timeline = resolveSpatial(temporal, 1920, 1080);
    const basePath = seamFilePath ? dirname(seamFilePath) : "";
    mainWindow.webContents.send("timeline-update", { timeline, basePath });
  } catch (err) {
    mainWindow.webContents.send("timeline-error", [String(err)]);
  }
}

function openFile(filePath: string) {
  if (!existsSync(filePath)) {
    dialog.showErrorBox("File not found", filePath);
    return;
  }
  try {
    const json = readFileSync(filePath, "utf-8");
    const result = parseSeamFile(json);
    if (!result.success) {
      dialog.showErrorBox("Invalid .seam file", result.errors.join("\n"));
      return;
    }
    seamFilePath = filePath;
    currentDocument = result.data;
    updateTitle();
    resolveAndSend();
  } catch (err) {
    dialog.showErrorBox("Could not read file", String(err));
  }
}

function newFile() {
  seamFilePath = null;
  currentDocument = { ...EMPTY_DOCUMENT, children: [] };
  updateTitle();
  resolveAndSend();
}

async function saveFile() {
  if (!seamFilePath) {
    return saveFileAs();
  }
  writeFileSync(seamFilePath, JSON.stringify(currentDocument, null, 2), "utf-8");
}

async function saveFileAs() {
  if (!mainWindow) return;
  const result = await dialog.showSaveDialog(mainWindow, {
    filters: [{ name: "Seam Files", extensions: ["seam"] }],
  });
  if (result.canceled || !result.filePath) return;
  seamFilePath = result.filePath;
  updateTitle();
  writeFileSync(seamFilePath, JSON.stringify(currentDocument, null, 2), "utf-8");
}

async function showOpenDialog() {
  if (!mainWindow) return;
  const result = await dialog.showOpenDialog(mainWindow, {
    filters: [{ name: "Seam Files", extensions: ["seam"] }],
    properties: ["openFile"],
  });
  if (result.canceled || result.filePaths.length === 0) return;
  openFile(result.filePaths[0]);
}

function buildMenu() {
  const isMac = process.platform === "darwin";
  const template: Electron.MenuItemConstructorOptions[] = [
    ...(isMac
      ? [{ role: "appMenu" as const }]
      : []),
    {
      label: "File",
      submenu: [
        {
          label: "New",
          accelerator: "CmdOrCtrl+N",
          click: () => newFile(),
        },
        {
          label: "Open…",
          accelerator: "CmdOrCtrl+O",
          click: () => showOpenDialog(),
        },
        {
          label: "Save",
          accelerator: "CmdOrCtrl+S",
          click: () => saveFile(),
        },
        {
          label: "Save As…",
          accelerator: "CmdOrCtrl+Shift+S",
          click: () => saveFileAs(),
        },
        { type: "separator" },
        isMac ? { role: "close" } : { role: "quit" },
      ],
    },
    { role: "editMenu" },
    {
      label: "View",
      submenu: [
        {
          label: "Mobile Emulation",
          type: "checkbox",
          checked: mobileEmulation,
          click: (menuItem) => {
            mobileEmulation = menuItem.checked;
            if (!mainWindow) return;
            if (mobileEmulation) {
              mainWindow.webContents.enableDeviceEmulation({
                screenPosition: "mobile",
                screenSize: { width: 390, height: 844 },
                viewSize: { width: 390, height: 844 },
                viewPosition: { x: 0, y: 0 },
                deviceScaleFactor: 3,
                scale: 1,
              });
              mainWindow.webContents.debugger.attach("1.3");
              mainWindow.webContents.debugger.sendCommand(
                "Emulation.setEmitTouchEventsForMouse",
                { enabled: true, configuration: "mobile" }
              );
              mainWindow.webContents.reload();
            } else {
              mainWindow.webContents.disableDeviceEmulation();
              try {
                mainWindow.webContents.debugger.sendCommand(
                  "Emulation.setEmitTouchEventsForMouse",
                  { enabled: false }
                );
                mainWindow.webContents.debugger.detach();
              } catch {}
              mainWindow.webContents.reload();
            }
          },
        },
      ],
    },
    { role: "windowMenu" },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
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

  mainWindow.webContents.openDevTools();

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

// Intercept file:// to add Content-Length (required by mediabunny's UrlSource)
protocol.registerSchemesAsPrivileged([
  { scheme: "file", privileges: { supportFetchAPI: true } },
]);

app.whenReady().then(() => {
  protocol.handle("file", (request) => {
    const url = new URL(request.url);
    const filePath = decodeURIComponent(url.pathname).replace(/^\/([A-Z]:)/i, "$1");

    let size: number;
    try {
      size = statSync(filePath).size;
    } catch {
      return new Response("Not found", { status: 404 });
    }

    const rangeHeader = request.headers.get("Range");
    if (rangeHeader) {
      const match = /bytes=(\d+)-(\d*)/.exec(rangeHeader);
      const start = match ? parseInt(match[1], 10) : 0;
      const end = match && match[2] ? parseInt(match[2], 10) : size - 1;
      const chunkSize = end - start + 1;

      const stream = createReadStream(filePath, { start, end });
      const body = new ReadableStream({
        start(controller) {
          stream.on("data", (chunk: Buffer) => controller.enqueue(chunk));
          stream.on("end", () => controller.close());
          stream.on("error", (err) => controller.error(err));
        },
        cancel() {
          stream.destroy();
        },
      });

      return new Response(body, {
        status: 206,
        statusText: "Partial Content",
        headers: {
          "Content-Range": `bytes ${start}-${end}/${size}`,
          "Content-Length": String(chunkSize),
          "Accept-Ranges": "bytes",
        },
      });
    }

    const stream = createReadStream(filePath);
    const body = new ReadableStream({
      start(controller) {
        stream.on("data", (chunk: Buffer) => controller.enqueue(chunk));
        stream.on("end", () => controller.close());
        stream.on("error", (err) => controller.error(err));
      },
      cancel() {
        stream.destroy();
      },
    });

    return new Response(body, {
      status: 200,
      headers: {
        "Content-Length": String(size),
        "Accept-Ranges": "bytes",
      },
    });
  });

  buildMenu();
  createWindow();

  // Load initial file from CLI arg or env var (optional — editor can start empty)
  const args = process.argv.slice(2);
  const fileArg = args[0] || process.env.SEAM_FILE;
  if (fileArg) {
    openFile(resolve(fileArg));
  } else {
    updateTitle();
  }

  ipcMain.handle("get-mobile-emulation", () => mobileEmulation);

  ipcMain.handle("get-initial-timeline", () => {
    try {
      const temporal = resolveComposition(currentDocument);
      const timeline = resolveSpatial(temporal, 1920, 1080);
      return {
        timeline,
        basePath: seamFilePath ? dirname(seamFilePath) : "",
      };
    } catch {
      return null;
    }
  });
});

app.on("window-all-closed", () => {
  app.quit();
});

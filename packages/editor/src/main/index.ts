import { app, BrowserWindow, dialog, ipcMain, Menu, protocol } from "electron";
import { createReadStream, existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import JSZip from "jszip";

let mainWindow: BrowserWindow | null = null;
let mobileEmulation = false;

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
          click: () => mainWindow?.webContents.send("menu-new"),
        },
        {
          label: "Open…",
          accelerator: "CmdOrCtrl+O",
          click: () => mainWindow?.webContents.send("menu-open"),
        },
        {
          label: "Save",
          accelerator: "CmdOrCtrl+S",
          click: () => mainWindow?.webContents.send("menu-save"),
        },
        {
          label: "Save As…",
          accelerator: "CmdOrCtrl+Shift+S",
          click: () => mainWindow?.webContents.send("menu-save-as"),
        },
        { type: "separator" },
        {
          label: "Export…",
          accelerator: "CmdOrCtrl+E",
          click: () => mainWindow?.webContents.send("menu-export"),
        },
        { type: "separator" },
        {
          label: "Settings…",
          accelerator: "CmdOrCtrl+,",
          click: () => mainWindow?.webContents.send("menu-settings"),
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

  // ── IPC: file I/O ────────────────────────────────────────────────

  ipcMain.handle("get-mobile-emulation", () => mobileEmulation);

  ipcMain.handle("set-title", (_event, title: string) => {
    mainWindow?.setTitle(title);
  });

  ipcMain.handle("read-file", (_event, filePath: string) => {
    if (!existsSync(filePath)) return { error: `File not found: ${filePath}` };
    try {
      return { json: readFileSync(filePath, "utf-8") };
    } catch (err) {
      return { error: String(err) };
    }
  });

  ipcMain.handle("write-file", (_event, filePath: string, json: string) => {
    try {
      writeFileSync(filePath, json, "utf-8");
      return { success: true };
    } catch (err) {
      return { error: String(err) };
    }
  });

  ipcMain.handle("show-open-dialog", async () => {
    if (!mainWindow) return null;
    const result = await dialog.showOpenDialog(mainWindow, {
      filters: [{ name: "Seam Files", extensions: ["seam"] }],
      properties: ["openFile"],
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    const filePath = result.filePaths[0];
    try {
      return { filePath, json: readFileSync(filePath, "utf-8") };
    } catch (err) {
      return { error: String(err) };
    }
  });

  ipcMain.handle("show-save-dialog", async () => {
    if (!mainWindow) return null;
    const result = await dialog.showSaveDialog(mainWindow, {
      filters: [{ name: "Seam Files", extensions: ["seam"] }],
    });
    if (result.canceled || !result.filePath) return null;
    return result.filePath;
  });

  ipcMain.handle(
    "export-project",
    async (
      _event,
      payload: {
        seamFileName: string;
        docJson: string;
        clips: Array<{ sourcePath: string; exportName: string }>;
        defaultName: string;
      }
    ): Promise<{ success: true } | { canceled: true } | { error: string }> => {
      if (!mainWindow) return { error: "No active window." };
      const result = await dialog.showSaveDialog(mainWindow, {
        title: "Export Project",
        defaultPath: `${payload.defaultName}.zip`,
        filters: [{ name: "Zip archive", extensions: ["zip"] }],
      });
      if (result.canceled || !result.filePath) return { canceled: true };

      const send = (
        phase: "read" | "zip" | "write",
        progress: number,
        detail?: string
      ) => {
        mainWindow?.webContents.send("export-progress", {
          phase,
          progress,
          detail,
        });
      };

      try {
        const zip = new JSZip();
        zip.file(payload.seamFileName, payload.docJson);

        const total = payload.clips.length;
        for (let i = 0; i < payload.clips.length; i++) {
          const clip = payload.clips[i];
          send("read", total === 0 ? 1 : i / total, clip.exportName);
          try {
            const bytes = await readFile(clip.sourcePath);
            zip.file(clip.exportName, bytes);
          } catch (err) {
            console.warn(
              `export-project: skipping missing clip "${clip.sourcePath}":`,
              err
            );
          }
        }
        send("read", 1);

        const buf = await zip.generateAsync(
          { type: "nodebuffer" },
          (metadata) => {
            send(
              "zip",
              metadata.percent / 100,
              metadata.currentFile ?? undefined
            );
          }
        );

        send("write", 0.5);
        writeFileSync(result.filePath, buf);
        send("write", 1);

        return { success: true };
      } catch (err) {
        return { error: String(err) };
      }
    }
  );

  // Initial file from CLI arg or env var
  ipcMain.handle("get-initial-file", () => {
    const args = process.argv.slice(2);
    const fileArg = args[0] || process.env.SEAM_FILE;
    if (!fileArg) return null;
    const filePath = resolve(fileArg);
    if (!existsSync(filePath)) return null;
    try {
      return { filePath, json: readFileSync(filePath, "utf-8") };
    } catch {
      return null;
    }
  });
});

app.on("window-all-closed", () => {
  app.quit();
});

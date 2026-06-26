import { app, BrowserWindow, ipcMain, protocol } from "electron";
import { createReadStream, existsSync, readFileSync, statSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { watch } from "chokidar";
import {
  DEFAULT_CANVAS_HEIGHT,
  DEFAULT_CANVAS_WIDTH,
  compileSeamFile,
  parseSeamFile,
  resolveComposition,
  resolveSpatial,
} from "@seam/core";

let mainWindow: BrowserWindow | null = null;
let seamFilePath: string | null = null;

function loadAndSend() {
  if (!seamFilePath || !mainWindow) return;

  try {
    const json = readFileSync(seamFilePath, "utf-8");
    const result = parseSeamFile(json);
    if (result.success) {
      const { doc: compiled } = compileSeamFile(result.data);
      const temporal = resolveComposition(compiled);
      const timeline = resolveSpatial(
        temporal,
        compiled.contentWidth ?? DEFAULT_CANVAS_WIDTH,
        compiled.contentHeight ?? DEFAULT_CANVAS_HEIGHT,
      );
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

// Intercept file:// to add Content-Length (required by mediabunny's UrlSource)
protocol.registerSchemesAsPrivileged([
  { scheme: "file", privileges: { supportFetchAPI: true } },
]);

// The custom file handler below replaces Electron's built-in file:// handling,
// which means it must supply Content-Type itself. Chromium enforces strict MIME
// checking for module scripts, so the renderer's `<script type="module">` fails
// to load (empty MIME) unless we set the type by extension here.
const MIME_BY_EXT: Record<string, string> = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".wasm": "application/wasm",
  ".map": "application/json",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mov": "video/quicktime",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".m4a": "audio/mp4",
};

function mimeForPath(filePath: string): string {
  const dot = filePath.lastIndexOf(".");
  const ext = dot >= 0 ? filePath.slice(dot).toLowerCase() : "";
  return MIME_BY_EXT[ext] ?? "application/octet-stream";
}

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
          "Content-Type": mimeForPath(filePath),
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
        "Content-Type": mimeForPath(filePath),
        "Content-Length": String(size),
        "Accept-Ranges": "bytes",
      },
    });
  });
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
        const { doc: compiled } = compileSeamFile(result.data);
      const temporal = resolveComposition(compiled);
        return {
          timeline: resolveSpatial(
        temporal,
        compiled.contentWidth ?? DEFAULT_CANVAS_WIDTH,
        compiled.contentHeight ?? DEFAULT_CANVAS_HEIGHT,
      ),
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

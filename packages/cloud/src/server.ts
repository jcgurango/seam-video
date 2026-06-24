import { Hono } from "hono";
import { serveStatic } from "@hono/node-server/serve-static";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { auth } from "./auth.js";
import { mediaRoutes } from "./routes/media.js";
import { projectRoutes } from "./routes/projects.js";

const here = path.dirname(fileURLToPath(import.meta.url));
// dist/server.js → ../web/dist ; src/server.ts (tsx) → ../web/dist too.
const CLIENT_DIR = path.resolve(here, "../web/dist");

export function createApp(): Hono {
  const app = new Hono();

  app.get("/api/health", (c) => c.json({ ok: true }));

  // better-auth owns everything under /api/auth/*.
  app.on(["POST", "GET"], "/api/auth/*", (c) => auth.handler(c.req.raw));

  app.route("/api/media", mediaRoutes);
  app.route("/api/projects", projectRoutes);

  // Static client (built by Vite into web/dist). Falls back to index.html so
  // the SPA handles its own routing.
  if (fs.existsSync(CLIENT_DIR)) {
    const root = path.relative(process.cwd(), CLIENT_DIR) || ".";
    app.use("/*", serveStatic({ root }));
    const indexHtml = path.join(CLIENT_DIR, "index.html");
    app.get("*", (c) => {
      if (c.req.path.startsWith("/api/")) return c.notFound();
      return c.html(fs.readFileSync(indexHtml, "utf8"));
    });
  } else {
    app.get("/", (c) =>
      c.text(
        "Seam Cloud API is running. Build the client with `pnpm --filter @seam/cloud build`."
      )
    );
  }

  return app;
}

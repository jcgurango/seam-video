import { defineConfig, type Connect, type PluginOption } from "vite";
import react from "@vitejs/plugin-react";

/**
 * SPA history fallback for the editor's client routes (`/media`,
 * `/projects/<name>.seam`). Vite's default fallback skips paths containing a
 * dot (the `.seam` extension), so a direct load / new tab of a project URL
 * would 404 — rewrite those HTML navigations to `/` so index.html boots and
 * the router opens the target. (Production hosts need the equivalent rule.)
 */
function spaFallback(): PluginOption {
  const middleware: Connect.NextHandleFunction = (req, _res, next) => {
    const path = (req.url ?? "").split("?")[0];
    const isAppRoute = path === "/media" || path.startsWith("/projects/");
    const wantsHtml = (req.headers.accept ?? "").includes("text/html");
    if (req.method === "GET" && isAppRoute && wantsHtml) req.url = "/";
    next();
  };
  return {
    name: "seam-spa-fallback",
    configureServer(server) {
      server.middlewares.use(middleware);
    },
    configurePreviewServer(server) {
      server.middlewares.use(middleware);
    },
  };
}

export default defineConfig({
  plugins: [spaFallback(), react()],
  server: {
    port: 5173,
    allowedHosts: true,
  },
  build: {
    outDir: "dist",
  },
});

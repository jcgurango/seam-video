import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dir = path.dirname(fileURLToPath(import.meta.url));

// Dev: the client runs on :5173 and proxies /api to the API server (default
// :8787) so cookies stay same-origin. Build: emits to web/dist, which the API
// server serves statically in production.
export default defineConfig({
  root: dir,
  plugins: [react()],
  build: {
    outDir: path.resolve(dir, "dist"),
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: process.env.API_TARGET ?? "http://localhost:8787",
        changeOrigin: false,
      },
    },
  },
});

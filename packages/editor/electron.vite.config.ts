import { defineConfig } from "electron-vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  main: {
    build: {
      outDir: "dist/main",
      lib: {
        entry: "src/main/index.ts",
      },
    },
  },
  preload: {
    build: {
      outDir: "dist/preload",
      lib: {
        entry: "src/preload/index.ts",
        fileName: () => "index.js",
      },
      rollupOptions: {
        output: {
          format: "cjs",
        },
      },
    },
  },
  renderer: {
    build: {
      outDir: "dist/renderer",
    },
    plugins: [react()],
  },
});

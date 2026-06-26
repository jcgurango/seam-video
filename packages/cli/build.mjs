// Build the publishable, self-contained CLI.
//
// All @seam/* workspace JS is bundled into dist/index.js (so those packages
// never need to be published). Third-party + native deps stay external and are
// declared as real `dependencies` of @seam-media/cli. The renderer's runtime assets
// (fonts, OSM Bright style) and the preview's prebuilt Electron app are vendored
// into dist/ so the package is self-contained on install.
import * as esbuild from "esbuild";
import { cp, rm, mkdir, chmod } from "node:fs/promises";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const root = dirname(fileURLToPath(import.meta.url));
const dist = resolve(root, "dist");
const rendererRoot = resolve(root, "../renderer");
const previewDist = resolve(root, "../preview/dist");

await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });

// Bundle @seam/* in; leave every bare (non-relative, non-@seam) specifier —
// third-party packages, native addons, and node builtins — external.
const externalizeThirdParty = {
  name: "externalize-third-party",
  setup(build) {
    build.onResolve({ filter: /.*/ }, (args) => {
      if (args.kind === "entry-point") return null;
      const p = args.path;
      if (p.startsWith(".") || p.startsWith("/")) return null; // relative: bundle
      if (p.startsWith("@seam/")) return null; // workspace: bundle
      return { path: p, external: true }; // everything else: external
    });
  },
};

await esbuild.build({
  entryPoints: [resolve(root, "src/index.ts")],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  outfile: resolve(dist, "index.js"),
  plugins: [externalizeThirdParty],
  logLevel: "info",
});

await chmod(resolve(dist, "index.js"), 0o755);

// Vendor the renderer's runtime assets (located at run time via
// SEAM_RENDERER_ASSETS, set in src/index.ts).
for (const name of ["fonts", "osm-bright"]) {
  await cp(resolve(rendererRoot, name), resolve(dist, name), { recursive: true });
}

// Vendor the preview's prebuilt Electron app (main/preload/renderer).
if (!existsSync(previewDist)) {
  throw new Error(
    `@seam/preview build not found at ${previewDist}. Build it first ` +
      `(pnpm --filter @seam/preview build).`,
  );
}
await cp(previewDist, resolve(dist, "preview"), { recursive: true });

console.log("CLI bundle + vendored assets written to dist/");

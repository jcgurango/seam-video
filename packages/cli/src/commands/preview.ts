import { resolve, dirname } from "node:path";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";

export function previewCommand(file: string) {
  const filePath = resolve(file);
  console.log(`Launching preview for ${filePath}...`);

  const require = createRequire(import.meta.url);
  try {
    // Published CLI: the preview's Electron build is vendored next to this
    // bundle at `dist/preview/`. Dev (tsx from source): fall back to the
    // workspace package's own build (resolve via its package.json, since the
    // package's `exports` map doesn't expose the dist subpath directly).
    const vendoredMain = resolve(
      dirname(fileURLToPath(import.meta.url)),
      "preview",
      "main",
      "index.js",
    );
    const previewMain = existsSync(vendoredMain)
      ? vendoredMain
      : resolve(
          dirname(require.resolve("@seam/preview/package.json")),
          "dist/main/index.js",
        );
    const electronPath = require.resolve("electron/cli.js");

    const child = spawn(
      process.execPath,
      [electronPath, previewMain, filePath],
      {
        stdio: "inherit",
        env: { ...process.env },
      },
    );

    child.on("close", (code) => {
      process.exit(code ?? 0);
    });
  } catch (err) {
    console.error(
      "Error: Could not launch preview. In dev, build it first " +
        "(pnpm --filter @seam/preview build); if installed, try reinstalling the CLI.",
    );
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}

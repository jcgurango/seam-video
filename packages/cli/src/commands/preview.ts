import { resolve } from "node:path";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";

export function previewCommand(file: string) {
  const filePath = resolve(file);
  console.log(`Launching preview for ${filePath}...`);

  // Find the @seam/preview package and launch electron with it
  try {
    const require = createRequire(import.meta.url);
    const previewPkg = require.resolve("@seam/preview/package.json");
    const previewDir = resolve(previewPkg, "..");
    const electronPath = require.resolve("electron/cli.js");

    const child = spawn(
      process.execPath,
      [electronPath, resolve(previewDir, "dist/main/index.js"), filePath],
      {
        stdio: "inherit",
        env: { ...process.env },
      }
    );

    child.on("close", (code) => {
      process.exit(code ?? 0);
    });
  } catch (err) {
    console.error(
      "Error: Could not launch preview. Make sure @seam/preview is built first."
    );
    console.error(`  Run: pnpm --filter @seam/preview build`);
    process.exit(1);
  }
}

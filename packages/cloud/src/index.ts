import { serve } from "@hono/node-server";
import { env } from "./env.js";
import { initDatabase } from "./bootstrap.js";
import { createApp } from "./server.js";

async function main(): Promise<void> {
  await initDatabase();

  const app = createApp();
  serve({ fetch: app.fetch, port: env.port }, (info) => {
    console.log(`[seam-cloud] Listening on http://localhost:${info.port}`);
    console.log(`[seam-cloud] Data directory: ${env.dataDir}`);
  });
}

main().catch((err) => {
  console.error("[seam-cloud] Fatal startup error:");
  console.error(err);
  process.exit(1);
});

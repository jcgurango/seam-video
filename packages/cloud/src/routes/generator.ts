import { Hono } from "hono";
import { env } from "../env.js";
import { requireAuth, type AuthVars } from "../middleware.js";

/**
 * Authenticated reverse proxy to the generator server (transcription / audio
 * enhancement). Enabled only when GENERATOR_SERVER_URL is set; otherwise the
 * capability reports unavailable and the proxy 503s. Lets the web editor reach
 * a generator it can't address directly, with Seam Cloud auth in front.
 */
export const generatorRoutes = new Hono<AuthVars>();
generatorRoutes.use("*", requireAuth);

/** GET /api/generator — capability probe (so the editor knows to use it). */
generatorRoutes.get("/", (c) =>
  c.json({ available: env.generatorServerUrl !== null })
);

/** ALL /api/generator/<path> — proxy to GENERATOR_SERVER_URL/<path>. */
generatorRoutes.all("/*", async (c) => {
  if (!env.generatorServerUrl) {
    return c.json({ error: "Generator server not configured" }, 503);
  }

  // Strip the mount prefix from the full path → the generator subpath.
  const subPath = c.req.path.replace(/^\/api\/generator\/?/, "");
  const search = new URL(c.req.url).search;
  const target = `${env.generatorServerUrl}/${subPath}${search}`;

  const method = c.req.method;
  const hasBody = method !== "GET" && method !== "HEAD";
  // Preserve the content-type so multipart boundaries survive. The bearer auth
  // was for us, not the generator, so it isn't forwarded.
  const headers: Record<string, string> = {};
  const contentType = c.req.header("content-type");
  if (contentType) headers["content-type"] = contentType;

  // Stream the request body straight through (no buffering) — large uploads
  // never sit in memory. Node's fetch requires `duplex: "half"` for a stream
  // body; we let it chunk rather than forwarding content-length.
  const init: RequestInit & { duplex?: "half" } = { method, headers };
  if (hasBody && c.req.raw.body) {
    init.body = c.req.raw.body;
    init.duplex = "half";
  }

  let upstream: Response;
  try {
    upstream = await fetch(target, init);
  } catch (err) {
    return c.json(
      { error: "Generator server unreachable", detail: msg(err) },
      502
    );
  }

  const outHeaders = new Headers();
  for (const h of ["content-type", "content-length", "cache-control"]) {
    const v = upstream.headers.get(h);
    if (v) outHeaders.set(h, v);
  }
  return new Response(upstream.body, { status: upstream.status, headers: outHeaders });
});

function msg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

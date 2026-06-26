import { Hono } from "hono";
import { z } from "zod";
import { requireAuth, type AuthVars } from "../middleware.js";
import { ImmichClient, normalizeInstanceUrl } from "../immich/client.js";
import {
  SEAM_ALBUM_NAME,
  deleteImmichAccount,
  getImmichAccount,
  upsertImmichAccount,
} from "../immich/account.js";

const connectSchema = z.object({
  instanceUrl: z.string().min(1),
  apiKey: z.string().min(1),
});

export const immichRoutes = new Hono<AuthVars>();
immichRoutes.use("*", requireAuth);

/** GET /api/immich — connection status (never returns the API key). */
immichRoutes.get("/", (c) => {
  const account = getImmichAccount(c.get("userId"));
  if (!account) return c.json({ connected: false });
  return c.json({
    connected: true,
    instanceUrl: account.instanceUrl,
    albumId: account.albumId,
  });
});

/**
 * POST /api/immich — attach (or re-attach) an Immich account. Validates the
 * API key against the instance, then finds-or-creates the "Seam Cloud" album
 * that groups this integration's assets.
 */
immichRoutes.post("/", async (c) => {
  const userId = c.get("userId");
  let body: z.infer<typeof connectSchema>;
  try {
    body = connectSchema.parse(await c.req.json());
  } catch (err) {
    return c.json({ error: "Invalid body", detail: msg(err) }, 400);
  }

  const instanceUrl = normalizeInstanceUrl(body.instanceUrl);
  const client = new ImmichClient({ instanceUrl, apiKey: body.apiKey });

  let me: { email: string };
  try {
    me = await client.me();
  } catch (err) {
    return c.json(
      { error: "Could not connect to Immich. Check the URL and API key.", detail: msg(err) },
      400
    );
  }

  let albumId: string;
  try {
    const existing = await client.findAlbumByName(SEAM_ALBUM_NAME);
    albumId = existing ? existing.id : (await client.createAlbum(SEAM_ALBUM_NAME)).id;
  } catch (err) {
    return c.json({ error: "Connected, but couldn't set up the Seam Cloud album.", detail: msg(err) }, 502);
  }

  upsertImmichAccount(userId, instanceUrl, body.apiKey, albumId);
  return c.json({ connected: true, instanceUrl, albumId, email: me.email });
});

/** DELETE /api/immich — disconnect (local only; leaves Immich data untouched). */
immichRoutes.delete("/", (c) => {
  deleteImmichAccount(c.get("userId"));
  return c.json({ ok: true });
});

function msg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

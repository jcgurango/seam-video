import { Hono } from "hono";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { db } from "../db.js";
import { requireAuth, pagination, type AuthVars } from "../middleware.js";
import {
  deleteMedia,
  fileResponse,
  mediaPath,
  saveMedia,
  saveThumb,
  thumbPath,
} from "../storage.js";
import { classifyByName, extractMediaInfo } from "../media/extract.js";
import type { MediaKind, MediaRecord, Page } from "../types.js";

const KINDS = ["video", "audio", "image", "pmtiles"] as const;

/**
 * Sidecar metadata accepted on upload. The server derives width/height/
 * duration/captureDate/thumbnail itself (see media/extract.ts), so every field
 * here is optional — the editor only needs to send what it already knows
 * (`kind`, `addedAt`, `lastUsedAt`). Client-supplied values seed the row and
 * are overwritten by anything extraction successfully derives.
 */
const metaSchema = z.object({
  kind: z.enum(KINDS).optional(),
  addedAt: z.number().optional(),
  lastUsedAt: z.number().nullable().optional(),
  captureDate: z.number().nullable().optional(),
  width: z.number().nullable().optional(),
  height: z.number().nullable().optional(),
  duration: z.number().nullable().optional(),
});

/** Partial metadata update — every field optional, `kind` immutable. */
const patchSchema = z.object({
  filename: z.string().min(1).optional(),
  lastUsedAt: z.number().nullable().optional(),
  captureDate: z.number().nullable().optional(),
  width: z.number().nullable().optional(),
  height: z.number().nullable().optional(),
  duration: z.number().nullable().optional(),
  probed: z.boolean().optional(),
});

interface MediaRow {
  id: string;
  userId: string;
  filename: string;
  kind: MediaKind;
  contentType: string | null;
  size: number;
  addedAt: number;
  lastUsedAt: number | null;
  captureDate: number | null;
  width: number | null;
  height: number | null;
  duration: number | null;
  probed: number;
  hasThumb: number;
  createdAt: number;
  updatedAt: number;
}

function toRecord(r: MediaRow): MediaRecord {
  return { ...r, probed: !!r.probed, hasThumb: !!r.hasThumb };
}

const ORDER: Record<string, string> = {
  date: "COALESCE(captureDate, addedAt) DESC",
  added: "addedAt DESC",
  used: "COALESCE(lastUsedAt, 0) DESC",
};

export const mediaRoutes = new Hono<AuthVars>();
mediaRoutes.use("*", requireAuth);

/** GET / — paginated, sortable list of the caller's media. */
mediaRoutes.get("/", (c) => {
  const userId = c.get("userId");
  const { page, pageSize } = pagination(c);
  const sort = c.req.query("sort") ?? "added";
  const orderBy = ORDER[sort] ?? ORDER.added;

  const total = (
    db
      .prepare("SELECT COUNT(*) AS c FROM media WHERE userId = ?")
      .get(userId) as { c: number }
  ).c;

  const rows = db
    .prepare(
      `SELECT * FROM media WHERE userId = ? ORDER BY ${orderBy}, createdAt DESC LIMIT ? OFFSET ?`
    )
    .all(userId, pageSize, (page - 1) * pageSize) as MediaRow[];

  const body: Page<MediaRecord> = {
    items: rows.map(toRecord),
    page,
    pageSize,
    total,
  };
  return c.json(body);
});

/**
 * POST / — upload media bytes. The server extracts the sidecar metadata
 * (thumbnail, dimensions, duration, capture date) itself, mirroring how the
 * web editor extracts it client-side. Client-supplied `meta` seeds the row;
 * anything extraction derives overrides it.
 */
mediaRoutes.post("/", async (c) => {
  const userId = c.get("userId");
  const body = await c.req.parseBody();

  const file = body["file"];
  if (!(file instanceof File)) {
    return c.json({ error: "Missing 'file'" }, 400);
  }

  const rawMeta = typeof body["meta"] === "string" ? body["meta"] : "{}";
  let meta: z.infer<typeof metaSchema>;
  try {
    meta = metaSchema.parse(JSON.parse(rawMeta));
  } catch (err) {
    return c.json(
      { error: "Invalid meta", detail: err instanceof Error ? err.message : err },
      400
    );
  }

  const filename = file.name || "untitled";
  const kind = meta.kind ?? classifyByName(filename);
  if (!kind) {
    return c.json({ error: `Unsupported media type for "${filename}"` }, 400);
  }

  const id = randomUUID();
  const now = Date.now();
  const bytes = Buffer.from(await file.arrayBuffer());
  await saveMedia(userId, id, bytes);

  // Headless extraction (mirrors the editor's mediaThumbs.ts). Best-effort —
  // a failure leaves `probed` true with whatever fields were derived, falling
  // back to client-supplied values.
  let probed = 0;
  const extracted = await extractMediaInfo(mediaPath(userId, id), kind, bytes).catch(
    (err) => {
      console.warn(`[seam-cloud] extraction failed for ${id}:`, err);
      return null;
    }
  );

  let hasThumb = 0;
  if (extracted) {
    probed = 1;
    if (extracted.thumb) {
      await saveThumb(userId, id, extracted.thumb);
      hasThumb = 1;
    }
  }

  const row: MediaRow = {
    id,
    userId,
    filename,
    kind,
    contentType: file.type || null,
    size: bytes.length,
    addedAt: meta.addedAt ?? now,
    lastUsedAt: meta.lastUsedAt ?? null,
    captureDate: extracted?.captureDate ?? meta.captureDate ?? null,
    width: extracted?.width ?? meta.width ?? null,
    height: extracted?.height ?? meta.height ?? null,
    duration: extracted?.duration ?? meta.duration ?? null,
    probed,
    hasThumb,
    createdAt: now,
    updatedAt: now,
  };

  db.prepare(
    `INSERT INTO media (id, userId, filename, kind, contentType, size, addedAt,
       lastUsedAt, captureDate, width, height, duration, probed, hasThumb,
       createdAt, updatedAt)
     VALUES (@id, @userId, @filename, @kind, @contentType, @size, @addedAt,
       @lastUsedAt, @captureDate, @width, @height, @duration, @probed, @hasThumb,
       @createdAt, @updatedAt)`
  ).run(row);

  return c.json(toRecord(row), 201);
});

function findRow(userId: string, id: string): MediaRow | undefined {
  return db
    .prepare("SELECT * FROM media WHERE id = ? AND userId = ?")
    .get(id, userId) as MediaRow | undefined;
}

/** GET /:id — the metadata record. */
mediaRoutes.get("/:id", (c) => {
  const row = findRow(c.get("userId"), c.req.param("id"));
  if (!row) return c.json({ error: "Not found" }, 404);
  return c.json(toRecord(row));
});

/** GET /:id/file — stream the raw media bytes. */
mediaRoutes.get("/:id/file", (c) => {
  const userId = c.get("userId");
  const row = findRow(userId, c.req.param("id"));
  if (!row) return c.json({ error: "Not found" }, 404);
  const res = fileResponse(
    mediaPath(userId, row.id),
    row.contentType ?? "application/octet-stream"
  );
  return res ?? c.json({ error: "File missing" }, 404);
});

/** GET /:id/thumb — stream the cached thumbnail. */
mediaRoutes.get("/:id/thumb", (c) => {
  const userId = c.get("userId");
  const row = findRow(userId, c.req.param("id"));
  if (!row || !row.hasThumb) return c.json({ error: "Not found" }, 404);
  const res = fileResponse(thumbPath(userId, row.id), "image/jpeg");
  return res ?? c.json({ error: "File missing" }, 404);
});

/** PATCH /:id — update sidecar metadata. */
mediaRoutes.patch("/:id", async (c) => {
  const userId = c.get("userId");
  const row = findRow(userId, c.req.param("id"));
  if (!row) return c.json({ error: "Not found" }, 404);

  let patch: z.infer<typeof patchSchema>;
  try {
    patch = patchSchema.parse(await c.req.json());
  } catch (err) {
    return c.json(
      { error: "Invalid body", detail: err instanceof Error ? err.message : err },
      400
    );
  }

  const fields = Object.keys(patch) as (keyof typeof patch)[];
  if (fields.length > 0) {
    // Build params that exactly match the generated SET clause — better-sqlite3
    // rejects both missing and unknown named parameters.
    const updates: Record<string, unknown> = {};
    for (const f of fields) {
      updates[f] = f === "probed" ? (patch.probed ? 1 : 0) : patch[f];
    }
    const sets = Object.keys(updates)
      .map((k) => `${k} = @${k}`)
      .join(", ");
    db.prepare(
      `UPDATE media SET ${sets}, updatedAt = @updatedAt WHERE id = @id AND userId = @userId`
    ).run({ ...updates, updatedAt: Date.now(), id: row.id, userId });
  }

  return c.json(toRecord(findRow(userId, row.id)!));
});

/** DELETE /:id — remove the row and its on-disk files. */
mediaRoutes.delete("/:id", async (c) => {
  const userId = c.get("userId");
  const row = findRow(userId, c.req.param("id"));
  if (!row) return c.json({ error: "Not found" }, 404);
  db.prepare("DELETE FROM media WHERE id = ? AND userId = ?").run(row.id, userId);
  await deleteMedia(userId, row.id);
  return c.json({ ok: true });
});

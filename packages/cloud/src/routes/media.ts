import { Hono, type Context } from "hono";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { db } from "../db.js";
import { requireAuth, pagination, type AuthVars } from "../middleware.js";
import {
  deleteMedia,
  fileResponse,
  mediaPath,
  saveMediaStream,
  saveThumb,
  thumbPath,
} from "../storage.js";
import { classifyByName, extractMediaInfo } from "../media/extract.js";
import { fingerprintFile } from "../media/fingerprint.js";
import { ImmichClient, relayResponse } from "../immich/client.js";
import { getImmichAccount } from "../immich/account.js";
import { kickImmichSweep } from "../immich/job.js";
import type { MediaKind, MediaRecord, Page } from "../types.js";

const KINDS = ["video", "audio", "image", "pmtiles"] as const;

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
  contentHash: string | null;
  immichAssetId: string | null;
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
  const { immichAssetId, ...rest } = r;
  const immichBacked = immichAssetId !== null;
  return {
    ...rest,
    probed: !!r.probed,
    // Immich-backed assets always have a thumbnail (served pass-through), even
    // though we keep no local thumb file — so report it as available.
    hasThumb: immichBacked || !!r.hasThumb,
    immichBacked,
  };
}

const ORDER: Record<string, string> = {
  date: "COALESCE(captureDate, addedAt) DESC",
  added: "addedAt DESC",
  used: "COALESCE(lastUsedAt, 0) DESC",
};

/**
 * Per-user duplicate check. Same filename + same hash = identical (idempotent
 * accept); only one matching = a conflict. Used both as a fail-early gate on a
 * client-supplied hash AND authoritatively on the real hash after streaming.
 */
type DedupResult =
  | { kind: "ok" }
  | { kind: "exists"; row: MediaRow }
  | { kind: "filename"; row: MediaRow }
  | { kind: "content"; row: MediaRow };

function checkDedup(userId: string, filename: string, hash: string): DedupResult {
  const byName = db
    .prepare("SELECT * FROM media WHERE userId = ? AND filename = ?")
    .get(userId, filename) as MediaRow | undefined;
  if (byName) {
    return byName.contentHash === hash
      ? { kind: "exists", row: byName }
      : { kind: "filename", row: byName };
  }
  const byHash = db
    .prepare("SELECT * FROM media WHERE userId = ? AND contentHash = ?")
    .get(userId, hash) as MediaRow | undefined;
  if (byHash) return { kind: "content", row: byHash };
  return { kind: "ok" };
}

/** Hono response for a non-`ok` dedup result (200 idempotent, or 409). */
function dedupResponse(
  c: Context,
  r: Exclude<DedupResult, { kind: "ok" }>,
  filename: string
): Response {
  if (r.kind === "exists") return c.json(toRecord(r.row), 200);
  if (r.kind === "filename") {
    return c.json(
      {
        error: "conflict",
        reason: "filename-exists",
        message: `A different file named "${filename}" already exists.`,
        existing: toRecord(r.row),
      },
      409
    );
  }
  return c.json(
    {
      error: "conflict",
      reason: "content-exists",
      message: `This file's content already exists as "${r.row.filename}".`,
      existing: toRecord(r.row),
    },
    409
  );
}

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
 * POST /?filename=…&kind=…&addedAt=… — upload media as a RAW body (the file
 * bytes), streamed straight to disk so large videos never sit in memory.
 * Metadata travels in the query string; the server derives the rest
 * (thumbnail, dimensions, duration, capture date) by extraction.
 */
mediaRoutes.post("/", async (c) => {
  const userId = c.get("userId");

  const filename = c.req.query("filename") || "untitled";
  const kindParam = c.req.query("kind") as MediaKind | undefined;
  const kind =
    kindParam && (KINDS as readonly string[]).includes(kindParam)
      ? kindParam
      : classifyByName(filename);
  if (!kind) {
    return c.json({ error: `Unsupported media type for "${filename}"` }, 400);
  }
  if (!c.req.raw.body) {
    return c.json({ error: "Missing request body" }, 400);
  }

  // Fail-early: if the client sent its content hash, reject a known conflict
  // (or accept a known duplicate) *before* streaming the bytes. This is just a
  // hint — the authoritative check below runs on the hash we compute ourselves.
  const claimedHash = c.req.query("contentHash");
  if (claimedHash) {
    const early = checkDedup(userId, filename, claimedHash);
    if (early.kind !== "ok") return dedupResponse(c, early, filename);
  }

  const id = randomUUID();
  const now = Date.now();

  // Stream the body to disk (no in-memory buffering), then hash it from its
  // head/tail. The id-keyed path is unique; we delete it again if the upload
  // turns out to be a duplicate/conflict.
  await saveMediaStream(userId, id, c.req.raw.body);
  const { hash: contentHash, size } = await fingerprintFile(mediaPath(userId, id));

  // Authoritative duplicate check on the real (server-computed) hash.
  const dedup = checkDedup(userId, filename, contentHash);
  if (dedup.kind !== "ok") {
    await deleteMedia(userId, id); // discard the just-streamed copy
    return dedupResponse(c, dedup, filename);
  }

  // Headless extraction (mirrors the editor's mediaThumbs.ts), reading the
  // file we just wrote. Best-effort.
  let probed = 0;
  const extracted = await extractMediaInfo(mediaPath(userId, id), kind).catch(
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

  const addedAtParam = Number(c.req.query("addedAt"));
  const row: MediaRow = {
    id,
    userId,
    filename,
    kind,
    contentType: c.req.header("content-type") || null,
    size,
    contentHash,
    immichAssetId: null, // uploads land in Seam Cloud first; handed off later
    addedAt: Number.isFinite(addedAtParam) ? addedAtParam : now,
    lastUsedAt: null,
    captureDate: extracted?.captureDate ?? null,
    width: extracted?.width ?? null,
    height: extracted?.height ?? null,
    duration: extracted?.duration ?? null,
    probed,
    hasThumb,
    createdAt: now,
    updatedAt: now,
  };

  try {
    db.prepare(
      `INSERT INTO media (id, userId, filename, kind, contentType, size, contentHash,
         addedAt, lastUsedAt, captureDate, width, height, duration, probed, hasThumb,
         createdAt, updatedAt)
       VALUES (@id, @userId, @filename, @kind, @contentType, @size, @contentHash,
         @addedAt, @lastUsedAt, @captureDate, @width, @height, @duration, @probed,
         @hasThumb, @createdAt, @updatedAt)`
    ).run(row);
  } catch (err) {
    // Backstop for the unique-index race (concurrent identical uploads): the
    // pre-check passed but another request inserted first. Roll back the bytes.
    await deleteMedia(userId, id);
    if (err instanceof Error && /UNIQUE constraint/.test(err.message)) {
      return c.json({ error: "conflict", reason: "race", message: err.message }, 409);
    }
    throw err;
  }

  // If this user has Immich connected, hand the new asset off in the background.
  kickImmichSweep(userId);

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

/** GET /:id/file — stream the raw media bytes (disk, or pass-through Immich). */
mediaRoutes.get("/:id/file", async (c) => {
  const userId = c.get("userId");
  const row = findRow(userId, c.req.param("id"));
  if (!row) return c.json({ error: "Not found" }, 404);

  if (row.immichAssetId) {
    const account = getImmichAccount(userId);
    if (!account) return c.json({ error: "Immich not connected" }, 502);
    const upstream = await new ImmichClient(account).fetchOriginal(
      row.immichAssetId,
      c.req.header("range")
    );
    return relayResponse(upstream, row.contentType ?? "application/octet-stream");
  }

  const res = fileResponse(
    mediaPath(userId, row.id),
    row.contentType ?? "application/octet-stream",
    c.req.header("range")
  );
  return res ?? c.json({ error: "File missing" }, 404);
});

/** GET /:id/thumb — cached thumbnail (disk, or pass-through Immich). */
mediaRoutes.get("/:id/thumb", async (c) => {
  const userId = c.get("userId");
  const row = findRow(userId, c.req.param("id"));
  if (!row) return c.json({ error: "Not found" }, 404);

  if (row.immichAssetId) {
    const account = getImmichAccount(userId);
    if (!account) return c.json({ error: "Immich not connected" }, 502);
    const upstream = await new ImmichClient(account).fetchThumbnail(
      row.immichAssetId
    );
    return relayResponse(upstream, "image/jpeg");
  }

  if (!row.hasThumb) return c.json({ error: "Not found" }, 404);
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

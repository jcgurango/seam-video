import { randomUUID } from "node:crypto";
import fs from "node:fs";
import { db } from "../db.js";
import { deleteMedia, mediaPath } from "../storage.js";
import {
  ImmichClient,
  immichTypeToKind,
  type ImmichAsset,
} from "./client.js";
import {
  getImmichAccount,
  listImmichAccounts,
  type ImmichAccount,
} from "./account.js";

/**
 * Background orchestration of the per-user Immich link. Each sweep, in order:
 *
 *   1. Handoff — push eligible disk-backed assets (image≠SVG, video) to Immich,
 *      add them to the Seam album, then delete the local file (Immich is now
 *      canonical). SVG/pmtiles/audio/projects are never pushed.
 *   2. Pull — import album assets we don't have yet, hashing via Range so the
 *      identity matches our local fingerprint, prefix-deduping filenames.
 *   3. Reconcile — drop Immich-backed rows whose asset has left the album.
 *
 * Handoff runs first so the album snapshot used for pull+reconcile already
 * reflects what we just pushed (otherwise reconcile could delete fresh links).
 */

const SWEEP_INTERVAL_MS = 120_000;
const running = new Set<string>(); // userIds with an in-flight sweep

interface MediaRow {
  id: string;
  userId: string;
  filename: string;
  kind: string;
  contentType: string | null;
  immichAssetId: string | null;
}

export function startImmichScheduler(): void {
  const tick = () => {
    for (const account of listImmichAccounts()) void sweepUser(account);
  };
  setInterval(tick, SWEEP_INTERVAL_MS);
  setTimeout(tick, 5_000); // first sweep shortly after boot
  console.log("[seam-cloud] Immich scheduler started.");
}

/** Fire-and-forget a sweep for one user (e.g. right after they upload). */
export function kickImmichSweep(userId: string): void {
  const account = getImmichAccount(userId);
  if (account) void sweepUser(account);
}

async function sweepUser(account: ImmichAccount): Promise<void> {
  if (!account.albumId) return;
  if (running.has(account.userId)) return; // don't overlap sweeps for a user
  running.add(account.userId);
  try {
    const client = new ImmichClient(account);
    await handoff(client, account);

    const album = await client.getAlbum(account.albumId);
    const albumIds = new Set(album.assets.map((a) => a.id));
    await pull(client, account, album.assets);
    reconcile(account.userId, albumIds);
  } catch (err) {
    console.warn(`[seam-cloud] Immich sweep failed for ${account.userId}:`, err);
  } finally {
    running.delete(account.userId);
  }
}

// ── 1. Handoff (push local → Immich) ───────────────────────────────

async function handoff(client: ImmichClient, account: ImmichAccount): Promise<void> {
  const rows = db
    .prepare(
      "SELECT id, userId, filename, kind, contentType, immichAssetId FROM media WHERE userId = ? AND immichAssetId IS NULL"
    )
    .all(account.userId) as MediaRow[];

  for (const row of rows) {
    if (!isImmichEligible(row)) continue;
    let bytes: Buffer;
    try {
      bytes = fs.readFileSync(mediaPath(account.userId, row.id));
    } catch {
      continue; // file already gone — nothing to hand off
    }
    try {
      const { id } = await client.uploadAsset({
        bytes,
        filename: row.filename,
        contentType: row.contentType ?? "application/octet-stream",
        fileCreatedAt: new Date(),
        fileModifiedAt: new Date(),
      });
      await client.addAssetsToAlbum(account.albumId!, [id]);
      db.prepare(
        "UPDATE media SET immichAssetId = ?, hasThumb = 0, updatedAt = ? WHERE id = ?"
      ).run(id, Date.now(), row.id);
      // Immich is canonical now — free the local bytes + thumbnail.
      await deleteMedia(account.userId, row.id);
    } catch (err) {
      console.warn(`[seam-cloud] handoff failed for ${row.filename}:`, err);
    }
  }
}

/** image (except SVG) and video are canonical in Immich; audio/pmtiles aren't. */
function isImmichEligible(row: MediaRow): boolean {
  if (row.kind === "video") return true;
  if (row.kind === "image") {
    const isSvg =
      row.filename.toLowerCase().endsWith(".svg") ||
      row.contentType === "image/svg+xml";
    return !isSvg;
  }
  return false;
}

// ── 2. Pull (import album → DB) ────────────────────────────────────

async function pull(
  client: ImmichClient,
  account: ImmichAccount,
  assets: ImmichAsset[]
): Promise<void> {
  const userId = account.userId;
  const existingImmich = new Set(
    (
      db
        .prepare(
          "SELECT immichAssetId FROM media WHERE userId = ? AND immichAssetId IS NOT NULL"
        )
        .all(userId) as { immichAssetId: string }[]
    ).map((r) => r.immichAssetId)
  );
  const names = new Set(
    (
      db.prepare("SELECT filename FROM media WHERE userId = ?").all(userId) as {
        filename: string;
      }[]
    ).map((r) => r.filename)
  );

  for (const asset of assets) {
    if (existingImmich.has(asset.id)) continue;
    const kind = immichTypeToKind(asset.type);
    if (kind !== "image" && kind !== "video") continue; // canonical kinds only

    let hash: string;
    let size: number;
    try {
      ({ hash, size } = await client.computeAssetFingerprint(asset.id));
    } catch (err) {
      console.warn(`[seam-cloud] hashing immich asset ${asset.id} failed:`, err);
      continue;
    }

    // Same content already in our DB?
    const byHash = db
      .prepare("SELECT id, immichAssetId FROM media WHERE userId = ? AND contentHash = ?")
      .get(userId, hash) as { id: string; immichAssetId: string | null } | undefined;
    if (byHash) {
      // A disk-backed local copy of this content → link it + free the bytes.
      if (!byHash.immichAssetId) {
        db.prepare(
          "UPDATE media SET immichAssetId = ?, hasThumb = 0, updatedAt = ? WHERE id = ?"
        ).run(asset.id, Date.now(), byHash.id);
        await deleteMedia(userId, byHash.id);
        existingImmich.add(asset.id);
      }
      continue; // already-linked or duplicate content → don't import twice
    }

    // New content → import as an Immich-backed row, prefix-deduping the name.
    const filename = uniqueName(asset.originalFileName || `${asset.id}`, names);
    names.add(filename);
    const now = Date.now();
    const captureDate = asset.fileCreatedAt ? Date.parse(asset.fileCreatedAt) : null;
    db.prepare(
      `INSERT INTO media (id, userId, filename, kind, contentType, size, contentHash,
         immichAssetId, addedAt, lastUsedAt, captureDate, width, height, duration,
         probed, hasThumb, createdAt, updatedAt)
       VALUES (@id, @userId, @filename, @kind, NULL, @size, @contentHash,
         @immichAssetId, @now, NULL, @captureDate, NULL, NULL, NULL,
         1, 0, @now, @now)`
    ).run({
      id: randomUUID(),
      userId,
      filename,
      kind,
      size,
      contentHash: hash,
      immichAssetId: asset.id,
      captureDate: Number.isFinite(captureDate) ? captureDate : null,
      now,
    });
    existingImmich.add(asset.id);
  }
}

/** A name not in `taken` — appends `-1`, `-2`, … before the extension. */
function uniqueName(original: string, taken: Set<string>): string {
  if (!taken.has(original)) return original;
  const dot = original.lastIndexOf(".");
  const base = dot >= 0 ? original.slice(0, dot) : original;
  const ext = dot >= 0 ? original.slice(dot) : "";
  let i = 1;
  let candidate = `${base}-${i}${ext}`;
  while (taken.has(candidate)) {
    i++;
    candidate = `${base}-${i}${ext}`;
  }
  return candidate;
}

// ── 3. Reconcile (drop departed assets) ────────────────────────────

function reconcile(userId: string, albumIds: Set<string>): void {
  const rows = db
    .prepare(
      "SELECT id, immichAssetId FROM media WHERE userId = ? AND immichAssetId IS NOT NULL"
    )
    .all(userId) as { id: string; immichAssetId: string }[];
  for (const row of rows) {
    if (albumIds.has(row.immichAssetId)) continue;
    db.prepare("DELETE FROM media WHERE id = ? AND userId = ?").run(row.id, userId);
    void deleteMedia(userId, row.id); // clean any local remnants (usually none)
  }
}

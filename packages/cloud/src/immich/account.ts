import { db } from "../db.js";

/** A user's stored Immich connection. */
export interface ImmichAccount {
  userId: string;
  instanceUrl: string;
  apiKey: string;
  albumId: string | null;
  createdAt: number;
  updatedAt: number;
}

/** The album the integration groups Seam Cloud assets under, on the Immich side. */
export const SEAM_ALBUM_NAME = "Seam Cloud";

export function getImmichAccount(userId: string): ImmichAccount | undefined {
  return db
    .prepare("SELECT * FROM immich_account WHERE userId = ?")
    .get(userId) as ImmichAccount | undefined;
}

/** All connected accounts — the background job iterates these. */
export function listImmichAccounts(): ImmichAccount[] {
  return db.prepare("SELECT * FROM immich_account").all() as ImmichAccount[];
}

export function upsertImmichAccount(
  userId: string,
  instanceUrl: string,
  apiKey: string,
  albumId: string | null
): void {
  const now = Date.now();
  db.prepare(
    `INSERT INTO immich_account (userId, instanceUrl, apiKey, albumId, createdAt, updatedAt)
     VALUES (@userId, @instanceUrl, @apiKey, @albumId, @now, @now)
     ON CONFLICT(userId) DO UPDATE SET
       instanceUrl = excluded.instanceUrl,
       apiKey      = excluded.apiKey,
       albumId     = excluded.albumId,
       updatedAt   = excluded.updatedAt`
  ).run({ userId, instanceUrl, apiKey, albumId, now });
}

export function setImmichAlbum(userId: string, albumId: string): void {
  db.prepare(
    "UPDATE immich_account SET albumId = ?, updatedAt = ? WHERE userId = ?"
  ).run(albumId, Date.now(), userId);
}

export function deleteImmichAccount(userId: string): void {
  db.prepare("DELETE FROM immich_account WHERE userId = ?").run(userId);
}

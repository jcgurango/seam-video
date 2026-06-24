import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { env } from "./env.js";

/**
 * Single SQLite connection shared by better-auth (its `user`/`session`/
 * `account`/`verification` tables) and our own app tables (`media`,
 * `project`). better-auth accepts a raw better-sqlite3 instance and drives it
 * through Kysely; our tables are plain DDL created on startup.
 */
fs.mkdirSync(env.dataDir, { recursive: true });

export const db = new Database(path.join(env.dataDir, "seam-cloud.db"));
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

/**
 * Create the app tables that mirror the web editor's sidecar metadata. Runs
 * AFTER better-auth's migrations so the `user(id)` foreign keys resolve.
 */
export function createAppTables(): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS media (
      id          TEXT PRIMARY KEY,
      userId      TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
      filename    TEXT NOT NULL,
      kind        TEXT NOT NULL,          -- video | audio | image | pmtiles
      contentType TEXT,
      size        INTEGER NOT NULL,
      -- sidecar metadata (mirrors @seam/editor MediaMeta) --
      addedAt     INTEGER NOT NULL,
      lastUsedAt  INTEGER,
      captureDate INTEGER,
      width       INTEGER,
      height      INTEGER,
      duration    REAL,
      probed      INTEGER NOT NULL DEFAULT 0,
      hasThumb    INTEGER NOT NULL DEFAULT 0,
      createdAt   INTEGER NOT NULL,
      updatedAt   INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_media_user ON media(userId);
    CREATE INDEX IF NOT EXISTS idx_media_filename ON media(userId, filename);

    CREATE TABLE IF NOT EXISTS project (
      id           TEXT PRIMARY KEY,
      userId       TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
      name         TEXT NOT NULL,         -- e.g. "MyProject.seam"
      size         INTEGER NOT NULL,
      lastModified INTEGER NOT NULL,
      createdAt    INTEGER NOT NULL,
      updatedAt    INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_project_user ON project(userId);
  `);
}

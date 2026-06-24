import fs from "node:fs";
import { getMigrations } from "better-auth/db/migration";
import { auth } from "./auth.js";
import { createAppTables, db } from "./db.js";
import { env } from "./env.js";
import { fingerprint } from "./media/fingerprint.js";
import { mediaPath } from "./storage.js";

/**
 * One-time startup sequence:
 *  1. Run better-auth's schema migrations (creates user/session/account/...).
 *  2. Create our app tables (media/project) — after auth so FKs resolve.
 *  3. Ensure an ADMIN user exists, creating one from ADMIN_USER/ADMIN_PASS
 *     when none is present. Startup fails if the admin can't be established.
 */
export async function initDatabase(): Promise<void> {
  const { runMigrations } = await getMigrations(auth.options);
  await runMigrations();
  createAppTables();
  backfillContentHashes();
  await ensureAdmin();
}

/**
 * Compute content hashes for any media rows that predate the contentHash
 * column (the file bytes are still on disk). One-time per legacy row, so
 * duplicate detection works for media uploaded before this migration.
 */
function backfillContentHashes(): void {
  const rows = db
    .prepare("SELECT id, userId FROM media WHERE contentHash IS NULL")
    .all() as { id: string; userId: string }[];
  if (rows.length === 0) return;

  console.log(`[seam-cloud] Backfilling content hashes for ${rows.length} media row(s)…`);
  const update = db.prepare("UPDATE media SET contentHash = ? WHERE id = ?");
  for (const r of rows) {
    try {
      const buf = fs.readFileSync(mediaPath(r.userId, r.id));
      update.run(fingerprint(buf), r.id);
    } catch (err) {
      console.warn(`[seam-cloud] could not hash media ${r.id}:`, err);
    }
  }
}

async function ensureAdmin(): Promise<void> {
  const row = db
    .prepare("SELECT COUNT(*) AS c FROM user WHERE role = 'ADMIN'")
    .get() as { c: number };

  if (row.c > 0) {
    console.log(`[seam-cloud] ${row.c} admin user(s) present.`);
    return;
  }

  console.log(
    `[seam-cloud] No admin user found — creating one for ${env.adminUser}.`
  );

  // If an account with this email already exists (as a plain USER), promote it
  // rather than failing on a duplicate-email signup.
  const existing = db
    .prepare("SELECT id FROM user WHERE email = ?")
    .get(env.adminUser) as { id: string } | undefined;

  if (!existing) {
    try {
      await auth.api.signUpEmail({
        body: {
          email: env.adminUser,
          password: env.adminPass,
          name: "Admin",
        },
      });
    } catch (err) {
      throw new Error(
        `Failed to create admin account for ${env.adminUser}: ${
          err instanceof Error ? err.message : String(err)
        }`
      );
    }
  }

  // Only touch the `role` column we own — leave better-auth's own date
  // columns (whatever serialization it chose) untouched.
  const result = db
    .prepare("UPDATE user SET role = 'ADMIN' WHERE email = ?")
    .run(env.adminUser);

  if (result.changes === 0) {
    throw new Error(
      `Admin account ${env.adminUser} could not be established — no matching user row to promote.`
    );
  }

  console.log(`[seam-cloud] Admin account ready: ${env.adminUser}`);
}

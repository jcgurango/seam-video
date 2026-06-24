import path from "node:path";

/**
 * Process configuration. Seam Cloud is a thin sync layer on top of the
 * local-first editor, so config is intentionally small and env-driven.
 *
 * Required:
 *   ADMIN_USER / ADMIN_PASS — the bootstrap admin account (email + password).
 *     Startup fails if these are absent (see {@link loadEnv}).
 *
 * Optional (with defaults):
 *   PORT (8787), DATA_DIR (./data), BETTER_AUTH_SECRET, BETTER_AUTH_URL.
 */
export interface Env {
  port: number;
  /** Absolute path to the directory holding the DB + on-disk media/projects. */
  dataDir: string;
  /** Bootstrap admin email. */
  adminUser: string;
  /** Bootstrap admin password. */
  adminPass: string;
  /** Secret used by better-auth to sign sessions/cookies. */
  authSecret: string;
  /** Public base URL the server is reachable at (cookies, trusted origins). */
  baseURL: string;
  /** Allowed CORS origins for the API: "*" (default) or an explicit list. */
  corsOrigins: string | string[];
}

const DEV_SECRET = "seam-cloud-insecure-dev-secret-change-me";

function required(name: string): string {
  const v = process.env[name];
  if (!v || v.trim() === "") {
    throw new Error(
      `Missing required environment variable ${name}. ` +
        `Seam Cloud needs ADMIN_USER and ADMIN_PASS to bootstrap the admin account.`
    );
  }
  return v.trim();
}

export function loadEnv(): Env {
  const adminUser = required("ADMIN_USER");
  const adminPass = required("ADMIN_PASS");

  const port = Number(process.env.PORT ?? 8787);
  if (!Number.isFinite(port) || port <= 0) {
    throw new Error(`Invalid PORT: ${process.env.PORT}`);
  }

  const dataDir = path.resolve(process.env.DATA_DIR ?? "./data");

  let authSecret = process.env.BETTER_AUTH_SECRET?.trim() || "";
  if (!authSecret) {
    authSecret = DEV_SECRET;
    console.warn(
      "[seam-cloud] BETTER_AUTH_SECRET is not set — using an insecure dev " +
        "secret. Set BETTER_AUTH_SECRET in production."
    );
  }

  const baseURL = (
    process.env.BETTER_AUTH_URL?.trim() || `http://localhost:${port}`
  ).replace(/\/$/, "");

  // CORS_ORIGIN: unset/"*" → allow any origin (auth is bearer, not cookies, so
  // a wildcard is safe); otherwise a comma-separated allowlist.
  const rawCors = process.env.CORS_ORIGIN?.trim();
  const corsOrigins: string | string[] =
    !rawCors || rawCors === "*"
      ? "*"
      : rawCors.split(",").map((o) => o.trim().replace(/\/$/, ""));

  return {
    port,
    dataDir,
    adminUser,
    adminPass,
    authSecret,
    baseURL,
    corsOrigins,
  };
}

export const env: Env = loadEnv();

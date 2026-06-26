import type { Context, MiddlewareHandler } from "hono";
import { auth, type Role } from "./auth.js";

/** Context variables attached by {@link requireAuth}. */
export type AuthVars = {
  Variables: {
    userId: string;
    userRole: Role;
  };
};

/**
 * Gate a route behind a valid session. Reads the better-auth session from the
 * request cookies and stashes the user id + role on the context. Responds 401
 * when there's no session.
 */
export const requireAuth: MiddlewareHandler<AuthVars> = async (c, next) => {
  const session = await auth.api.getSession({ headers: authHeaders(c) });
  if (!session) {
    return c.json({ error: "Unauthorized" }, 401);
  }
  c.set("userId", session.user.id);
  c.set("userRole", ((session.user as { role?: Role }).role ?? "USER") as Role);
  await next();
};

/**
 * Request headers to authenticate with. Passes the originals through (cookie
 * or `Authorization: Bearer …`), but if neither is present and a `?token=`
 * query param is, synthesizes a bearer header from it. That lets media
 * stream/thumbnail URLs self-authenticate — `UrlSource`/`<img>` fetch a plain
 * URL with no way to set headers.
 */
function authHeaders(c: Context): Headers {
  const headers = new Headers(c.req.raw.headers);
  if (!headers.has("authorization")) {
    const token = c.req.query("token");
    if (token) headers.set("authorization", `Bearer ${token}`);
  }
  return headers;
}

/** Gate a route behind ADMIN role. Assumes {@link requireAuth} ran first. */
export const requireAdmin: MiddlewareHandler<AuthVars> = async (c, next) => {
  if (c.get("userRole") !== "ADMIN") {
    return c.json({ error: "Forbidden" }, 403);
  }
  await next();
};

/** Parse `page`/`pageSize` query params with sane bounds. */
export function pagination(c: Context): { page: number; pageSize: number } {
  const page = Math.max(1, Number(c.req.query("page") ?? 1) || 1);
  const pageSize = Math.min(
    100,
    Math.max(1, Number(c.req.query("pageSize") ?? 24) || 24)
  );
  return { page, pageSize };
}

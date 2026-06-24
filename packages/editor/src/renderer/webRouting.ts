/**
 * URL routing for the web editor (web-only — Electron has no address bar).
 *
 *   /                      → projects landing
 *   /media                 → media landing tab
 *   /projects/<name>.seam  → a specific project, opened
 *
 * Pure path ↔ route mapping; the History API wiring lives in App. Honors a
 * non-root Vite base (`BASE_URL`) so the editor can be served under a subpath.
 */
export type Route =
  | { kind: "projects" }
  | { kind: "media" }
  | { kind: "project"; name: string };

const BASE = (
  (import.meta as { env?: Record<string, string | undefined> }).env?.BASE_URL ??
  "/"
).replace(/\/+$/, "");

export function routePath(route: Route): string {
  switch (route.kind) {
    case "projects":
      return `${BASE}/`;
    case "media":
      return `${BASE}/media`;
    case "project":
      return `${BASE}/projects/${encodeURIComponent(route.name)}`;
  }
}

export function parsePath(pathname: string): Route {
  let p = pathname;
  if (BASE && p.startsWith(BASE)) p = p.slice(BASE.length);
  if (!p.startsWith("/")) p = `/${p}`;

  if (p === "/" || p === "") return { kind: "projects" };
  if (p === "/media" || p === "/media/") return { kind: "media" };

  const m = /^\/projects\/(.+?)\/?$/.exec(p);
  if (m) {
    let name = m[1];
    try {
      name = decodeURIComponent(name);
    } catch {
      /* keep raw on malformed escapes */
    }
    return { kind: "project", name };
  }
  return { kind: "projects" };
}

/** The route for a landing tab. */
export function tabRoute(tab: "projects" | "media"): Route {
  return tab === "media" ? { kind: "media" } : { kind: "projects" };
}

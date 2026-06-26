# Seam web editor (static SPA). Build context is the repo root (see
# docker-compose.yml). Two stages: build the bundle with Node, then serve the
# static files with nginx.

# ---- build ----
FROM node:22-bookworm-slim AS build

# The web closure pulls in the editor/preview packages, which carry electron as
# a devDependency — but the web build only bundles their source, never the
# electron runtime, so skip the (large) electron binary download.
ENV ELECTRON_SKIP_BINARY_DOWNLOAD=1

RUN npm install -g pnpm@10

WORKDIR /repo
COPY . .

# Install just the web app's workspace closure (core/compositor/map/preview/
# editor + their deps). All pure JS/TS — no native compilation.
RUN pnpm install --frozen-lockfile --filter @seam/web...

# @seam/core, @seam/compositor and @seam/map resolve from their built dist, so
# compile them (tsc) before bundling. editor/preview are consumed as source by
# Vite, so they don't need an electron-vite build.
RUN pnpm --filter @seam/core --filter @seam/compositor --filter @seam/map build \
 && pnpm --filter @seam/web build

# ---- serve ----
FROM nginx:alpine

COPY --from=build /repo/packages/web/dist /usr/share/nginx/html
COPY packages/web/nginx.conf /etc/nginx/conf.d/default.conf
# Runs before nginx starts (nginx image convention) — writes /config.js from
# $SEAM_CLOUD_URL so the editor learns its cloud base URL at runtime.
COPY packages/web/docker-entrypoint.sh /docker-entrypoint.d/40-seam-config.sh
RUN chmod +x /docker-entrypoint.d/40-seam-config.sh

EXPOSE 80

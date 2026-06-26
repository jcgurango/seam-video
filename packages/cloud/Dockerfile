# Seam Cloud backend. Build context is the repo root (see docker-compose.yml).
#
# Single stage: the runtime needs the native addons (better-sqlite3,
# @napi-rs/canvas, @mediabunny/server/node-av), so we keep the built tree
# rather than trying to copy native modules between stages.
FROM node:22-bookworm-slim

# Build tools for any native addon that has to compile from source (most ship
# prebuilt binaries; better-sqlite3 falls back to node-gyp otherwise).
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
 && rm -rf /var/lib/apt/lists/*

RUN npm install -g pnpm@10

WORKDIR /repo
COPY . .

# @seam/cloud has no workspace dependencies, so a filtered install pulls in
# only its own dependency tree (not the editor/preview/electron toolchain).
RUN pnpm install --frozen-lockfile --filter @seam/cloud
RUN pnpm --filter @seam/cloud build

ENV NODE_ENV=production \
    PORT=8787 \
    DATA_DIR=/data
EXPOSE 8787
VOLUME ["/data"]

WORKDIR /repo/packages/cloud
# Env (ADMIN_USER/ADMIN_PASS/BETTER_AUTH_SECRET/…) is supplied by the container
# runtime, so run node directly rather than the .env-based `start` script.
CMD ["node", "dist/index.js"]

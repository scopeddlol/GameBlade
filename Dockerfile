# No "# syntax=" directive on purpose. Pinning an external frontend makes every
# build depend on Docker Hub being reachable (one CI run already failed on a 502
# from it) and counts against its anonymous pull limits. Everything used here —
# multi-stage builds and RUN --mount=type=cache — is supported by BuildKit's
# built-in frontend.

# ---------------------------------------------------------------------------
# Build stage: install the whole workspace, build shared -> server -> web, then
# prune to a production-only dependency tree with `pnpm deploy`.
# ---------------------------------------------------------------------------
FROM node:22-alpine AS builder

# better-sqlite3 ships prebuilt binaries, but keep a toolchain available so an
# architecture without a prebuild can still compile rather than failing the build.
RUN apk add --no-cache python3 make g++ libc6-compat

ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable

WORKDIR /app

# Copy manifests first so dependency installation caches independently of source.
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/

RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile

COPY tsconfig.base.json ./
COPY packages/shared packages/shared
COPY apps/server apps/server
COPY apps/web apps/web

RUN pnpm --filter @gameblade/shared build \
    && pnpm --filter @gameblade/server build \
    && pnpm --filter @gameblade/web build

# Produces /app/deploy with only the server's production dependencies, with
# workspace links resolved into real directories.
RUN pnpm --filter @gameblade/server deploy --prod --legacy /app/deploy

# ---------------------------------------------------------------------------
# Mesh agent: the QUIC side of a node, built once and carried into the runtime.
#
# Built once so the separately published Node and Coordinator images still use
# binaries from the exact same source revision. Each final image copies only
# the binary it actually runs.
# ---------------------------------------------------------------------------
FROM rust:1-alpine AS mesh
RUN apk add --no-cache musl-dev
WORKDIR /mesh/gameblade-mesh
COPY crates/gameblade-mesh .

# Cached like the pnpm store above, and for the same reason: without this every
# build re-downloads the registry and recompiles every dependency, which on a
# self-hosted runner is both slow and a steady drain on its disk.
#
# The binaries are copied out of the cache mount because a cache mount is not
# part of the resulting layer — anything left inside it is gone by the next
# stage.
RUN --mount=type=cache,id=cargo-registry,target=/usr/local/cargo/registry \
    --mount=type=cache,id=cargo-git,target=/usr/local/cargo/git \
    --mount=type=cache,id=mesh-target,target=/mesh/gameblade-mesh/target \
    cargo build --release --bins \
    && mkdir -p /out \
    && cp target/release/gameblade-node target/release/gameblade-relay \
          target/release/mesh-doctor /out/

# ---------------------------------------------------------------------------
# Shared runtime: each public image inherits only the binaries it actually runs.
# ---------------------------------------------------------------------------
FROM node:22-alpine AS runtime-base

# tini reaps zombies and forwards SIGTERM, so an in-flight download is closed
# cleanly instead of the process being killed outright.
RUN apk add --no-cache tini libc6-compat \
    && mkdir -p /data /library \
    && chown -R node:node /data

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8080 \
    DATA_DIR=/data \
    WEB_ROOT=/app/public

WORKDIR /app

COPY --from=builder --chown=node:node /app/deploy/node_modules ./node_modules
COPY --from=builder --chown=node:node /app/deploy/dist ./dist
COPY --from=builder --chown=node:node /app/deploy/package.json ./package.json
COPY --from=builder --chown=node:node /app/apps/web/dist ./public

# Never run the server as root: it has read access to the whole game library.
USER node

VOLUME ["/data"]

# Uses the app's own health route, so a locked or corrupt database reports unhealthy.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD node -e "const p=process.env.BASE_PATH||'';require('http').get({host:'127.0.0.1',port:process.env.PORT||8080,path:p+'/api/health'},r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "dist/index.js"]

# VPS control plane: web/API/Discord plus the optional UDP relay. No node agent
# and no game-library volume are present in this artifact.
FROM runtime-base AS coordinator
USER root
RUN apk add --no-cache caddy
COPY deploy/Caddyfile /etc/caddy/Caddyfile
RUN chown node:node /etc/caddy/Caddyfile
USER node
ENV ROLE=coordinator \
    PORT=3000 \
    CADDY_ENABLED=true \
    CADDY_ADDRESS=:8080 \
    XDG_DATA_HOME=/data/caddy \
    XDG_CONFIG_HOME=/data/caddy-config
COPY --from=mesh --chown=node:node /out/gameblade-relay /usr/local/bin/gameblade-relay
EXPOSE 8080 8443 47821/udp

# Storage appliance: local scanner/UI plus one supervised QUIC agent. The Node
# web UI is selected by ROLE; Coordinator/admin routes are not registered.
FROM runtime-base AS node
ENV ROLE=node
COPY --from=mesh --chown=node:node /out/gameblade-node /usr/local/bin/gameblade-node
COPY --from=mesh --chown=node:node /out/mesh-doctor /usr/local/bin/mesh-doctor
EXPOSE 8080 47820-47839/udp

# Legacy all-in-one server. This is the final stage intentionally, preserving
# `docker build .` and older local workflows while GHCR publishes it as AIO.
FROM runtime-base AS aio
ENV ROLE=aio
COPY --from=mesh --chown=node:node /out/gameblade-relay /usr/local/bin/gameblade-relay
EXPOSE 8080 47821/udp

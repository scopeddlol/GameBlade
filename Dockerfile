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
# In the same image as the server rather than an image of its own, because a
# coordinator and its nodes have to agree about the catalog they exchange and
# separate artifacts are how they quietly stop agreeing. It is a few megabytes
# and only a node ever runs it.
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
# Runtime: everything, in every role.
#
# One build, three images. The role is baked in rather than declared, because
# `docker pull …/gameblade-coordinator` has already said which one it is and
# saying it a second time in a compose file is a thing to get wrong. The role
# stages below are metadata on top of this one shared filesystem, so pulling two
# of them to the same host pulls the layers once.
# ---------------------------------------------------------------------------
FROM node:22-alpine AS runtime

# tini reaps zombies and forwards SIGTERM, so an in-flight download is closed
# cleanly instead of the process being killed outright.
RUN apk add --no-cache tini libc6-compat \
    && mkdir -p /data /library /libraries \
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
COPY --from=mesh --chown=node:node /out/gameblade-node /usr/local/bin/gameblade-node
COPY --from=mesh --chown=node:node /out/gameblade-relay /usr/local/bin/gameblade-relay
COPY --from=mesh --chown=node:node /out/mesh-doctor /usr/local/bin/mesh-doctor

# Never run the server as root: it has read access to the whole game library.
USER node

EXPOSE 8080
VOLUME ["/data"]

# Uses the app's own health route, so a locked or corrupt database reports unhealthy.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD node -e "const p=process.env.BASE_PATH||'';require('http').get({host:'127.0.0.1',port:process.env.PORT||8080,path:p+'/api/health'},r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "dist/index.js"]

# ---------------------------------------------------------------------------
# The roles.
#
# `--target` picks one. Each sets only what its role means, so nothing has to be
# passed at run time for an image to be the thing its name says it is; anything
# here can still be overridden in a compose file by an operator who wants to.
# ---------------------------------------------------------------------------

# Everything on one machine, reading games off local disk. The default, and what
# GameBlade has always been.
FROM runtime AS standalone
ENV ROLE=standalone

# The database, the panel, the landing page and the API. No game files, so
# nothing to scan and nothing to mount but its own data directory.
FROM runtime AS coordinator
ENV ROLE=coordinator

# The games. Two processes — the scanner that reports what is here and the agent
# that serves it — under one entrypoint, so a node is one container rather than
# a pair somebody has to keep in step.
#
# There is deliberately no LIBRARY_PATHS here. A node reads its own mounts:
# /library is one library, and every directory under /libraries is one more, so
# a machine holding two drives says so with two mounts rather than with a
# variable listing paths that also have to be mounted. Setting LIBRARY_PATHS in
# a compose file still overrides all of it.
FROM runtime AS node
ENV ROLE=node \
    GAMEBLADE_STATE=/data/node-state.json

COPY --chown=node:node docker/node-entrypoint.sh /usr/local/bin/gameblade-node-entrypoint
USER root
RUN chmod +x /usr/local/bin/gameblade-node-entrypoint
USER node

# UDP, for the agent. Published only if this host is directly reachable — see
# the mesh documentation; the connection is outbound-initiated either way.
EXPOSE 47820/udp

CMD ["/usr/local/bin/gameblade-node-entrypoint"]

# The relay: a public UDP address that pastes two connections together. It runs
# beside a coordinator and holds nothing, so it needs no data directory and no
# library — just the coordinator's public key.
FROM runtime AS relay
EXPOSE 47821/udp
HEALTHCHECK NONE
CMD ["gameblade-relay"]

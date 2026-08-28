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
RUN apk add --no-cache musl-dev cmake make g++ perl
WORKDIR /mesh
COPY crates/gameblade-mesh ./gameblade-mesh
RUN cd gameblade-mesh \
    && cargo build --release --bins \
    && mkdir -p /out \
    && cp target/release/gameblade-node target/release/mesh-doctor /out/

# ---------------------------------------------------------------------------
# Runtime stage
# ---------------------------------------------------------------------------
FROM node:22-alpine AS runtime

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
COPY --from=mesh --chown=node:node /out/gameblade-node /usr/local/bin/gameblade-node
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

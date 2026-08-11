# syntax=docker/dockerfile:1
# Loxep application image (ADR-0013/ADR-0018): one image, one Node.js process,
# `loxep migrate` / `loxep start [--mode=all|web|worker]` via bin/loxep.ts.
# Build from the repository root:  docker build -f docker/Dockerfile .

# ---------------------------------------------------------------------------
# Build stage: full workspace install + apps/web production build (Vite+Nitro)
# ---------------------------------------------------------------------------
FROM oven/bun:1.3.14 AS build
WORKDIR /app

# Workspace manifests first so the install layer caches across source edits.
# NOTE: every workspace package.json must be listed here (both stages) or the
# frozen-lockfile install fails from a fresh clone. Update when adding workspaces.
COPY package.json bun.lock ./
COPY apps/web/package.json apps/web/package.json
COPY apps/docs/package.json apps/docs/package.json
COPY packages/config/package.json packages/config/package.json
COPY packages/db/package.json packages/db/package.json
COPY packages/domain/package.json packages/domain/package.json
COPY packages/jobs/package.json packages/jobs/package.json
COPY packages/observability/package.json packages/observability/package.json
COPY packages/runtime/package.json packages/runtime/package.json
COPY packages/auth/package.json packages/auth/package.json
COPY packages/market/package.json packages/market/package.json
COPY packages/notifications/package.json packages/notifications/package.json
COPY packages/storage/package.json packages/storage/package.json
RUN bun install --frozen-lockfile

COPY . .
# Force the Node.js server output: building under Bun would otherwise make
# Nitro auto-detect a Bun.serve entry, which the node:24 runtime cannot run.
ENV SERVER_PRESET=node-server
RUN bun run build

# ---------------------------------------------------------------------------
# Deps stage: production-only node_modules for the runtime image.
# Workspace packages resolve through node_modules/@loxep/* symlinks that Bun
# creates; the runtime stage copies them verbatim. --linker=hoisted forces the
# classic flat layout — Bun 1.3's default isolated linker scatters
# per-workspace node_modules under packages/*, which this image does not carry.
# ---------------------------------------------------------------------------
FROM oven/bun:1.3.14 AS deps
WORKDIR /app

COPY package.json bun.lock ./
COPY apps/web/package.json apps/web/package.json
COPY apps/docs/package.json apps/docs/package.json
COPY packages/config/package.json packages/config/package.json
COPY packages/db/package.json packages/db/package.json
COPY packages/domain/package.json packages/domain/package.json
COPY packages/jobs/package.json packages/jobs/package.json
COPY packages/observability/package.json packages/observability/package.json
COPY packages/runtime/package.json packages/runtime/package.json
COPY packages/auth/package.json packages/auth/package.json
COPY packages/market/package.json packages/market/package.json
COPY packages/notifications/package.json packages/notifications/package.json
COPY packages/storage/package.json packages/storage/package.json
RUN bun install --frozen-lockfile --production --linker=hoisted

# ---------------------------------------------------------------------------
# Runtime stage: Node.js 24 runs bin/ and packages/ TypeScript natively via
# type stripping; the web runtime is the prebuilt Nitro output.
# ---------------------------------------------------------------------------
FROM node:24-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app

# Production node_modules (COPY preserves the relative @loxep/* symlinks,
# which resolve because packages/ lands at the same relative location).
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY bin ./bin
COPY packages ./packages
COPY apps/web/package.json apps/web/package.json
COPY --from=build /app/apps/web/.output apps/web/.output

# Default LOXEP_MEDIA_ROOT volume target, writable by the non-root user.
RUN mkdir -p /data/media && chown -R node:node /data

USER node
EXPOSE 3020

# Readiness per ADR-0018; node fetch because slim images ship no curl/wget.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch(`http://127.0.0.1:${process.env.LOXEP_PORT ?? 3020}/health/ready`).then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]

ENTRYPOINT ["node", "bin/loxep.ts"]
CMD ["start"]

# syntax=docker/dockerfile:1
# Loxep application image (ADR-0013/ADR-0018): one image, one Node.js process,
# `loxep migrate` / `loxep start [--mode=all|web|worker]` via bin/loxep.ts.
# Build from the repository root:  docker build -f docker/Dockerfile .

# ---------------------------------------------------------------------------
# Manifests stage: structurally collect EVERY workspace manifest + lockfile so
# the install layers can never drift when a new package is added. The stage
# re-runs on any context change, but its output only contains manifests, so
# downstream install layers stay cached until a manifest actually changes.
# ---------------------------------------------------------------------------
FROM oven/bun:1.4.0 AS manifests
WORKDIR /src
COPY . .
RUN mkdir -p /manifests \
 && find . -name node_modules -prune -o \( -name package.json -o -name bun.lock \) -print \
    | tar cf - -T - | tar xf - -C /manifests

# ---------------------------------------------------------------------------
# Build stage: full workspace install + apps/web production build (Vite+Nitro)
# ---------------------------------------------------------------------------
FROM oven/bun:1.4.0 AS build
WORKDIR /app

# Workspace manifests first so the install layer caches across source edits.
COPY --from=manifests /manifests ./
RUN bun install --frozen-lockfile

COPY . .
# Force the Node.js server output: building under Bun would otherwise make
# Nitro auto-detect a Bun.serve entry, which the node:24 runtime cannot run.
ENV SERVER_PRESET=node-server
# Bound the vite/nitro build's V8 heap: unbounded, it peaks ~9.5 GB RSS and
# has OOMed a 16 GB host. CI's 7 GB runners prove the build completes when
# V8 is forced to collect earlier; 6 GB keeps headroom without risking that.
ENV NODE_OPTIONS=--max-old-space-size=6144
RUN bun run build

# ---------------------------------------------------------------------------
# Deps stage: production-only node_modules for the runtime image.
# Workspace packages resolve through node_modules/@loxep/* symlinks that Bun
# creates; the runtime stage copies them verbatim. --linker=hoisted forces the
# classic flat layout — Bun 1.3's default isolated linker scatters
# per-workspace node_modules under packages/*, which this image does not carry.
#
# --filter '!./apps/*' installs root + packages/* only. The runtime executes
# bin/loxep.ts, which imports packages/* from source (Node type stripping), so
# those production deps must be real files on disk. apps/web is NOT imported
# from source — it is served from the prebuilt Nitro bundle copied below, which
# already has its dependencies bundled in — so installing apps/web's deps here
# ships ~575MB of unreachable code (react-dom, recharts, faker, fonts, ...).
# apps/docs is likewise build-time only.
#
# --omit=peer additionally drops packages that only entered the tree to
# satisfy an *optional* peerDependency (better-auth declares drizzle-kit,
# @tanstack/react-start, prisma, etc. as optional peers; bun auto-installs
# any of those it can resolve elsewhere in the lockfile — e.g. from apps/web
# or packages/db's devDependencies — even under --production/--filter). None
# of the survivors (pg, drizzle-orm, better-auth, graphile-worker, pino, zod,
# ebay-api, the 18 @loxep/* workspace symlinks) are peer-only, and a grep of
# the installed better-auth/drizzle-orm/graphile-worker/@loxep trees for
# require()/import of typescript, tsx, drizzle-kit, prettier, lightningcss,
# or rolldown/@rolldown found none — those are dev/build tooling, unreachable
# at runtime. Verified end-to-end (migrate + start --mode=all + /health/ready
# with worker ok + a cron task executing) against the pruned tree; see
# loxep-8un notes for the full recipe. 375 -> 189 packages, ~307M -> ~97M.
#
# The full manifest set is still copied above so the workspace graph resolves
# and the untouched bun.lock still satisfies --frozen-lockfile; the filter
# selects which workspaces get *installed*, it does not rewrite any manifest.
# Negation (rather than listing packages/*) keeps this correct for free when a
# new workspace package is added — including packages/integrations/*, which an
# explicit './packages/*' glob silently misses.
# ---------------------------------------------------------------------------
FROM oven/bun:1.4.0 AS deps
WORKDIR /app

COPY --from=manifests /manifests ./
RUN bun install --frozen-lockfile --production --omit=peer --linker=hoisted --filter '!./apps/*'

# ---------------------------------------------------------------------------
# Runtime stage: Node.js 24 runs bin/ and packages/ TypeScript natively via
# type stripping; the web runtime is the prebuilt Nitro output.
# ---------------------------------------------------------------------------
FROM node:24-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app

# poppler-utils supplies pdftotext, the PDF text-layer extractor
# (@loxep/documents pdf-text-layer.ts, loxep-cd3.4 M4): a digital invoice's
# existing text layer is lifted directly instead of OCRing a rendering of
# it. Without the binary the code path degrades honestly to available:false
# — this line is what makes it real in the shipped image. ~30MB apt delta;
# the WASM OCR engine itself ships in node_modules and needs no apt package.
RUN apt-get update \
 && apt-get install -y --no-install-recommends poppler-utils \
 && rm -rf /var/lib/apt/lists/*

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

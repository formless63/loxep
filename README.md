# Loxep

**Loxep** is an open-source, self-hosted platform for marketplace intelligence, multichannel commerce operations, services, inventory, billing, and financial visibility.

It starts with a practical first vertical slice: continuously observe eBay listings/watchlists, retain useful history, detect meaningful changes, and notify the user. The architecture is deliberately broad enough to grow into commerce, inventory, projects/services, billing, accounting, tax, documents/media, and operational integrations without turning into a collection of unrelated tools.

The name combines **loxodrome** and **ephemeris**: navigation and observation over time.

## Current implementation direction

Loxep has moved from architecture-only planning into foundation buildout. Current accepted direction includes:

- TanStack Start + React with TanStack Router/Query/Table/Form;
- Kiranism's TanStack Start dashboard integrated as the initial UI/theme/reference donor;
- `/dashboard/*` as the real Loxep dashboard workspace and `/starter/*` as preserved donor/reference routes;
- workspace-aware sidebar switching and Cmd+K navigation, with future major product areas as peer route roots rather than children of `/dashboard`;
- shadcn/ui over Radix/Base UI primitives + Tailwind (donor components are mostly Radix today; standardization is incremental, per ADR-0015);
- Recharts, DnD, and narrowly-owned Zustand available for credible product/UI uses; ECharts when dense analytics justify it;
- Node.js current supported LTS runtime and Bun workspaces/tooling;
- PostgreSQL + TimescaleDB;
- Drizzle + first-class SQL;
- Graphile Worker for durable jobs;
- Better Auth with OIDC + magic links and no password login initially;
- Better Auth-owned `admin`/`member` deployment roles with installation-wide ordinary product access initially;
- minimal economic-entity records for personal/business/operating attribution, separate from users, provider connections, workspaces, counterparties, and future accounting books;
- database-backed normal runtime/application settings and application-encrypted provider/runtime secrets;
- bootstrap environment/mounted-secret configuration only for pre-database/pre-login/runtime-topology facts;
- local filesystem media by default with generic S3-compatible storage available from the same abstraction;
- RustFS as the initial recommended/tested optional self-hosted S3 companion;
- resumable local-to-S3 storage migration as a product feature;
- generic external-resource links for integrations with knowledge, task, billing, backup, and other companion systems.

The normal minimal deployment target is intentionally small:

```text
loxep
postgres-timescale
```

The same Loxep image supports `LOXEP_MODE=all|web|worker`, so workers can later scale independently without requiring a different application architecture. RustFS can be added as an optional separate service/profile when shared object storage is desired.

## Run with Docker

The default deployment is the repo-root Compose stack: Loxep (`LOXEP_MODE=all`) plus PostgreSQL/TimescaleDB, with a one-shot migration step — application startup never migrates the schema.

```bash
cp .env.example .env
# Generate real secrets (see .env.example comments):
head -c 32 /dev/urandom | base64    # -> keyring key inside LOXEP_KEYRING
head -c 32 /dev/urandom | base64    # -> LOXEP_AUTH_SECRET
docker compose up -d
```

Loxep is then available at `http://localhost:3020` (readiness: `/health/ready`). Add the optional S3-compatible object-storage companion with `docker compose --profile rustfs up -d`. For scale-out, the same image runs `LOXEP_MODE=web` and `LOXEP_MODE=worker` replicas against the shared PostgreSQL, so background processing can scale independently of web traffic without any architectural change.

Note: the bundled database image is TimescaleDB **Community** (Timescale License), deliberately chosen because Loxep's observation hypertable uses TSL-licensed columnstore capabilities — see [ADR-0002](apps/docs/src/content/docs/decisions/0002-postgresql-timescaledb.md). Self-hosting is fine under the TSL; offering TimescaleDB itself as a hosted database service is what the license restricts.

## Documentation

Public project documentation: **https://formless63.github.io/loxep/**

Source documentation lives in `apps/docs` and is currently published with Astro Starlight on GitHub Pages. The documentation renderer is intentionally replaceable; product architecture is not coupled to Starlight.

Useful starting points:

- [Vision](apps/docs/src/content/docs/overview/vision.md)
- [Master Domain Map](apps/docs/src/content/docs/product/master-domain-map.md)
- [Workspaces & Navigation](apps/docs/src/content/docs/product/workspaces.md)
- [Roadmap](apps/docs/src/content/docs/product/roadmap.md)
- [System Overview](apps/docs/src/content/docs/architecture/system-overview.md)
- [Domain Boundaries](apps/docs/src/content/docs/architecture/domain-boundaries.md)
- [Configuration & Secrets](apps/docs/src/content/docs/architecture/configuration-and-secrets.md)
- [Phase 0 Foundation](apps/docs/src/content/docs/architecture/phase-0-foundation.md)
- [Foundational Data Model](apps/docs/src/content/docs/architecture/foundational-data-model.md)
- [Foundation Schema](apps/docs/src/content/docs/architecture/foundation-schema.md)
- [Implementation Contract](apps/docs/src/content/docs/development/implementation-contract.md)
- [Project Surfaces & Future Sites](apps/docs/src/content/docs/development/project-surfaces.md)
- [Companion Services](apps/docs/src/content/docs/product/companion-services.md)
- [Dependency & Version Policy](apps/docs/src/content/docs/development/dependency-policy.md)
- [Architecture Decision Records](apps/docs/src/content/docs/decisions/)

The Implementation Contract is the short load-bearing guide intended for contributors and coding agents; accepted ADRs and current architecture documents remain authoritative where deeper detail is needed.

## Dependency freshness

Before adding or pinning a runtime, framework, library, container image, or GitHub Action, verify the newest viable current upstream release. Starter templates and remembered/model-training versions are not authoritative. Loxep uses reproducible pins/lockfiles plus automated update tooling rather than either stale pins or floating `latest` dependencies.

## License

MIT
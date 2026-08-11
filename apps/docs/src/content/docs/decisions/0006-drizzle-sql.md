---
title: "ADR-0006: Drizzle with first-class SQL"
---

**Status:** Accepted

## Context

Loxep needs conventional type-safe CRUD as well as PostgreSQL-heavy analytics: window functions, CTEs, partial indexes, JSONB, materialized/continuous aggregates, Timescale functions, and potentially sophisticated accounting/reporting queries.

Prisma provides a strong application ORM, but Loxep benefits from keeping PostgreSQL concepts visible rather than treating SQL as an implementation detail.

## Decision

Use Drizzle ORM/Kit for schema definitions, migrations, type-safe common queries, and application database access.

Treat SQL as a first-class implementation language. Complex analytical/reporting/database-native operations may use parameterized SQL directly rather than forcing every query through ORM abstractions.

Database migrations are reviewed artifacts and must not rely on runtime auto-sync behavior.

## Consequences

- Application code receives strong TypeScript integration without hiding PostgreSQL.
- Timescale/PostgreSQL-specific capabilities remain accessible.
- Contributors must maintain SQL quality and tests rather than assuming the ORM guarantees query correctness.

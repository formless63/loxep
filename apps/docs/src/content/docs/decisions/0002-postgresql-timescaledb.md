---
title: "ADR-0002: PostgreSQL with TimescaleDB from the initial deployment"
---

**Status:** Accepted; physical observation policy refined by later foundational decisions.

## Context

Loxep combines transactional relational data with high-frequency marketplace observations and later analytical time series. Running separate transactional and time-series datastores would increase operational burden for self-hosters and complicate joins between observations and business objects.

## Decision

Use PostgreSQL as the primary durable datastore and install TimescaleDB from the initial supported deployment.

Use ordinary PostgreSQL tables for transactional/domain data. Use Timescale hypertables only for genuinely temporal, append-heavy datasets such as listing observations.

For observation storage, the current initial direction is:

- seven-day chunks as a starting point;
- recent data in rowstore;
- current Timescale columnstore capabilities for older data, initially around a 30-day policy boundary;
- no automatic deletion/retention policy by default;
- continuous aggregates added only when real query patterns justify them.

These are starting policies, not frozen tuning values. Exact Timescale APIs/syntax and recommended physical settings must be verified against the current supported release immediately before implementation. In particular, the experimental "Hypercore" table access method was deprecated and then removed in newer TimescaleDB releases while columnstore functionality remains; implementations must use the current columnstore syntax and must not resurrect the removed TAM terminology or APIs from older examples.

Graphile Worker shares the PostgreSQL deployment.

### Supported image

The supported development/deployment image is **`timescale/timescaledb-ha`** (currently `pg18.4-ts2.29.2-all`): Timescale's recommended production image, which additionally ships PostGIS, pgvector/pgvectorscale, and the TimescaleDB Toolkit. Adopting it early keeps those capabilities available without a later image migration, at the cost of a larger image. Timescale's current HA/all build still uses PostgreSQL 18.4; Loxep tracks the first compatible HA/all image on a current PostgreSQL 18 patch rather than silently switching image families.

Discipline: bundled extensions are **not** enabled speculatively. `CREATE EXTENSION` happens in a reviewed migration only when a concrete feature earns it — candidates already visible in the roadmap include PostGIS for inventory locations/sites and pgvector for counterparty dedupe or listing matching. The `-ha` image keeps PGDATA under `/home/postgres/pgdata/data`, which the Compose volumes account for.

### Extension upgrades

Replacing a TimescaleDB container image does not change the extension version installed in an existing database. Every supported TimescaleDB version bump therefore lands with an append-only Loxep migration marker and a matching exact version in the migration runner. The explicit `loxep migrate` command keeps its advisory lock, inspects the installed version on a disposable connection, runs `ALTER EXTENSION timescaledb UPDATE TO '<supported-version>'` as the first command on a new connection, and only then starts the ordinary schema migrator on another fresh connection. A fresh database still creates TimescaleDB in migration 0000.

The separate connections are load-bearing. Timescale requires `ALTER EXTENSION` to be the first command in its session, and it invalidates sessions that loaded the previous extension generation. The marker makes readiness fail until an operator runs the explicit migration command after updating the image, while its version assertion prevents a migration ledger from claiming success against an image that cannot provide Loxep's supported version. This follows Timescale's [current Docker upgrade procedure](https://docs.timescale.com/self-hosted/latest/upgrades/upgrade-docker/), including its requirement to update every database that has the extension installed.

Database-backed tests create scratch databases from PostgreSQL's pristine `template0`, not the HA image's extension-bearing `template1`. That keeps the test's zero-state honest, lets migration 0000 own extension creation, and prevents a persisted development volume's stale template extension from leaking into concurrent test databases.

### Licensing

TimescaleDB ships in two editions: Apache-2.0 licensed core, and the Community edition whose additional features — including the columnstore/compression capabilities this decision relies on — are governed by the Timescale License (TSL). The TSL permits self-hosted/internal use and distribution as part of a value-added product under its stated conditions, while restricting offering TimescaleDB itself as a database service.

Consequences for Loxep: the Loxep application remains MIT, but the recommended full TimescaleDB Community deployment contains separately licensed TSL components. Deployment/backup documentation and the recommended Compose stack must state this rather than claiming everything deployed is MIT/Apache. Verify current edition/feature licensing against upstream when pinning the database image.

## Consequences

- One database can support transactional and time-series workloads.
- The initial schema can model observations correctly without a later datastore migration.
- Timescale-specific features remain deliberate rather than becoming the default for ordinary tables.
- Physical chunk/columnstore settings can be tuned from actual ingestion/query behavior.
- Backup/restore and supported deployment documentation must account for the Timescale extension.

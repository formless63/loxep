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

The supported development/deployment image is **`timescale/timescaledb-ha`** (currently `pg18.4-ts2.29.1-all`): Timescale's recommended production image, which additionally ships PostGIS, pgvector/pgvectorscale, and the TimescaleDB Toolkit. Adopting it early keeps those capabilities available without a later image migration, at the cost of a larger image.

Discipline: bundled extensions are **not** enabled speculatively. `CREATE EXTENSION` happens in a reviewed migration only when a concrete feature earns it — candidates already visible in the roadmap include PostGIS for inventory locations/sites and pgvector for counterparty dedupe or listing matching. The `-ha` image keeps PGDATA under `/home/postgres/pgdata/data`, which the Compose volumes account for.

### Licensing

TimescaleDB ships in two editions: Apache-2.0 licensed core, and the Community edition whose additional features — including the columnstore/compression capabilities this decision relies on — are governed by the Timescale License (TSL). The TSL permits self-hosted/internal use and distribution as part of a value-added product under its stated conditions, while restricting offering TimescaleDB itself as a database service.

Consequences for Loxep: the Loxep application remains MIT, but the recommended full TimescaleDB Community deployment contains separately licensed TSL components. Deployment/backup documentation and the recommended Compose stack must state this rather than claiming everything deployed is MIT/Apache. Verify current edition/feature licensing against upstream when pinning the database image.

## Consequences

- One database can support transactional and time-series workloads.
- The initial schema can model observations correctly without a later datastore migration.
- Timescale-specific features remain deliberate rather than becoming the default for ordinary tables.
- Physical chunk/columnstore settings can be tuned from actual ingestion/query behavior.
- Backup/restore and supported deployment documentation must account for the Timescale extension.

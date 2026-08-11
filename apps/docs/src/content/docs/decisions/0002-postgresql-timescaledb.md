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
- current Timescale Hypercore/columnstore capabilities for older data, initially around a 30-day policy boundary;
- no automatic deletion/retention policy by default;
- continuous aggregates added only when real query patterns justify them.

These are starting policies, not frozen tuning values. Exact Timescale APIs/syntax and recommended physical settings must be verified against the current supported release immediately before implementation.

Graphile Worker shares the PostgreSQL deployment.

## Consequences

- One database can support transactional and time-series workloads.
- The initial schema can model observations correctly without a later datastore migration.
- Timescale-specific features remain deliberate rather than becoming the default for ordinary tables.
- Physical chunk/columnstore settings can be tuned from actual ingestion/query behavior.
- Backup/restore and supported deployment documentation must account for the Timescale extension.

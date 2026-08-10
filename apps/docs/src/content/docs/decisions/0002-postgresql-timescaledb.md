---
title: "ADR-0002: PostgreSQL and TimescaleDB"
---

# ADR-0002: PostgreSQL with TimescaleDB from the initial deployment

**Status:** Accepted

## Context

Loxep combines transactional relational data with high-frequency marketplace observations and later analytical time series. Running separate transactional and time-series datastores would increase operational burden for self-hosters and complicate joins between observations and business objects.

## Decision

Use PostgreSQL as the primary durable datastore and install TimescaleDB from the initial supported deployment.

Use ordinary PostgreSQL tables for transactional/domain data. Use Timescale hypertables only for genuinely temporal, append-heavy datasets such as listing observations. Continuous aggregates/retention/compression are introduced based on actual query and volume needs.

Graphile Worker shares the PostgreSQL deployment.

## Consequences

- One database can support transactional and time-series workloads.
- The initial schema can model observations correctly without a later datastore migration.
- Timescale-specific features must remain deliberate rather than becoming the default for ordinary tables.
- Backup/restore and supported deployment documentation must account for the Timescale extension.

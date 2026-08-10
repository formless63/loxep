---
title: "ADR-0003: Graphile Worker"
---

# ADR-0003: Graphile Worker for durable background work

**Status:** Accepted; deployment topology clarified by ADR-0013.

## Context

Loxep needs recurring polling, adaptive rescheduling, retries/backoff, webhook processing, normalization, notifications, synchronization, storage migrations, imports, analytics refreshes, and later financial processing. PostgreSQL is already required.

Alternatives considered include pg-boss and Redis-backed queues such as BullMQ.

## Decision

Use Graphile Worker as the initial durable job system.

Use job identifiers/keys, database constraints, and source-event identities to make consequential jobs idempotent. Do not use in-memory pub/sub for work whose loss would alter user-visible or financial state.

Polling schedules should be data-driven. A dispatcher can enqueue due monitor work rather than creating a permanent cron definition for every observed item.

Graphile Worker is a logical runtime responsibility, not a requirement for a second container. The default Loxep image runs web + worker together under `LOXEP_MODE=all`; the same image can later run `worker` replicas independently.

## Consequences

- No Redis dependency is required solely for queueing.
- Jobs and application transactions can coordinate through PostgreSQL.
- The smallest deployment remains one Loxep application container plus PostgreSQL/TimescaleDB.
- Worker processes/hosts can later scale separately from web traffic.
- Job payloads should contain identifiers/references rather than large copies of canonical domain state.
- A future queue replacement remains possible because domain logic must not live inside Graphile-specific task plumbing.

---
title: "ADR-0003: Graphile Worker"
---

# ADR-0003: Graphile Worker for durable background work

**Status:** Accepted

## Context

Loxep needs recurring polling, adaptive rescheduling, retries/backoff, webhook processing, normalization, notifications, synchronization, imports, analytics refreshes, and later financial processing. PostgreSQL is already required.

Alternatives considered include pg-boss and Redis-backed queues such as BullMQ.

## Decision

Use Graphile Worker as the initial durable job system.

Use job identifiers/keys, database constraints, and source-event identities to make consequential jobs idempotent. Do not use in-memory pub/sub for work whose loss would alter user-visible or financial state.

Polling schedules should be data-driven. A dispatcher can enqueue due monitor work rather than creating a permanent cron definition for every observed item.

## Consequences

- No Redis dependency is required solely for queueing.
- Jobs and application transactions can coordinate through PostgreSQL.
- Workers can be scaled separately from the web process.
- Job payloads should contain identifiers/references rather than large copies of canonical domain state.
- A future queue replacement remains possible because domain logic must not live inside Graphile-specific task plumbing.

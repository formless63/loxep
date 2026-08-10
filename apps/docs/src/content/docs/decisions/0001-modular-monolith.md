---
title: "ADR-0001: Modular Monolith"
---

# ADR-0001: Modular monolith with separable web and worker runtimes

**Status:** Accepted; deployment topology clarified by ADR-0013.

## Context

Loxep is expected to span marketplace intelligence, commerce, inventory, projects/services, billing, accounting, tax, and integrations. These domains need strong boundaries, but the initial deployment does not justify distributed-system complexity.

## Decision

Build Loxep as a modular monolith in one repository, one application image, and one primary PostgreSQL/TimescaleDB database. Domain boundaries are enforced in code ownership, modules/services, data ownership, and documented mutation rules.

Loxep has two logical runtime responsibilities:

- web/application runtime;
- Graphile Worker runtime.

They are **separable, not mandatorily separate containers**. ADR-0013 defines one image with:

```text
LOXEP_MODE=all      # default: web + worker in one Loxep deployment
LOXEP_MODE=web
LOXEP_MODE=worker
```

Introduce additional deployment boundaries only for measured scaling, isolation, security, or dependency reasons.

## Consequences

- Cross-domain transactions remain practical.
- The smallest self-hosted deployment remains `loxep + postgres-timescale`.
- Web and worker load can later scale independently without changing application architecture.
- Modules can evolve independently without requiring network APIs between them.
- Contributors must resist bypassing domain services merely because all tables are locally reachable.

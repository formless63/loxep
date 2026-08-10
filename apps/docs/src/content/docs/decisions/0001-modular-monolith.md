---
title: "ADR-0001: Modular Monolith"
---

# ADR-0001: Modular monolith with separate web and worker processes

**Status:** Accepted

## Context

Loxep is expected to span marketplace intelligence, commerce, inventory, projects/services, billing, accounting, tax, and integrations. These domains need strong boundaries, but the initial deployment does not justify distributed-system complexity.

## Decision

Build Loxep as a modular monolith in one repository and one primary PostgreSQL database. Domain boundaries are enforced in code ownership, schemas/modules, services, and documented mutation rules.

Run at least two application processes from the same codebase:

- web/application process;
- Graphile Worker process.

Introduce additional deployment boundaries only for measured scaling, isolation, security, or dependency reasons.

## Consequences

- Cross-domain transactions remain practical.
- Self-hosting remains simple.
- Modules can evolve independently without requiring network APIs between them.
- Contributors must resist bypassing domain services merely because all tables are locally reachable.

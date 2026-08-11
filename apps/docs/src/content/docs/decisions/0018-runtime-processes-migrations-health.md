---
title: "ADR-0018: Runtime Processes, Migration Ownership, and Health"
---

**Status:** Accepted for foundation implementation.

## Context

ADR-0001 and ADR-0013 establish one Loxep image with `LOXEP_MODE=all|web|worker`, but three operational questions were left open:

1. How `LOXEP_MODE=all` combines web and worker capability inside one container. The system overview previously allowed "sibling Node processes or another clean lifecycle arrangement," while ADR-0014 rejected combining RustFS with Loxep specifically because of process-supervision, health-entanglement, and restart-coupling concerns. Those objections apply equally to supervising multiple application processes in one container.
2. Which runtime applies database migrations. With one `all` container the answer is implicit; with later `web`×N plus `worker`×N replicas, migrate-on-start would race and couple schema mutation to routine process restarts.
3. What `/health` means per mode, and whether worker conditions such as a large backlog make a container "unhealthy."

## Decision

### One process per container

`LOXEP_MODE=all` runs **one Node.js process** hosting both the web runtime and Graphile Worker. Graphile Worker explicitly supports running embedded in the same Node process as a server, so no in-container process supervisor, sibling-process arrangement, or multi-process lifecycle management is introduced.

`LOXEP_MODE=web` runs the same process without starting the worker runset; `LOXEP_MODE=worker` runs it without binding the web listener. The mode selects which capabilities the single process initializes — it never selects a different image or entrypoint architecture.

The product requirement remains one easy default application container. If a genuinely event-loop-hostile workload appears later, the answer is worker replicas via `LOXEP_MODE=worker`, not an in-container supervisor.

### Explicit migration command; startup never migrates

Schema migration is an **explicit invocation of the same Loxep image**, conceptually:

```text
loxep migrate
loxep start --mode=all
loxep start --mode=web
loxep start --mode=worker
```

`LOXEP_MODE` remains the deployment-facing environment interface; the command form above is the conceptual contract for entrypoints/CLI, not a rename of that interface.

Rules:

- Normal `web`/`worker`/`all` startup **never mutates schema**. Startup verifies that the database is at the expected migration state and fails readiness with a clear diagnostic when it is behind.
- The default Compose stack runs a one-shot migration service/step (same image, migrate command) before the application service starts.
- Migration invocations take a PostgreSQL advisory lock so two concurrent invocations cannot interleave; the second waits or exits cleanly with "already migrated."
- Reviewed, version-controlled Drizzle migrations remain the artifact per ADR-0006. Exact Drizzle migrator/advisory-lock mechanics are verified against current upstream documentation at implementation time.

This keeps schema mutation an operator-visible deployment step and scales unchanged to multiple web/worker replicas, which simply never migrate.

### Health contract

Two distinct probes per runtime, in every mode:

- **Liveness** — the process and its event loop are functioning. It carries no dependency checks.
- **Readiness** — the mode's required dependencies are initialized and usable:
  - `web`: database reachable + web runtime initialized;
  - `worker`: database reachable + worker runtime initialized;
  - `all`: both.

Degraded-but-operational conditions — for example a large worker backlog, stalled jobs, or a failing storage backend — are exposed as **observable health information** (health detail endpoints, logs, admin diagnostics), not as automatic unreadiness. A backlogged worker that stops being "ready" only makes the backlog worse.

An unmigrated database is a readiness failure, not a liveness failure.

## Consequences

- No process supervisor, PID-1 forwarding logic, or multi-process signal handling inside the Loxep container.
- Restart/crash semantics are trivial: one process, one container lifecycle, standard orchestrator restart policy.
- Deployments gain one explicit migration step; in exchange, application restarts are schema-safe and replica startup cannot race migrations.
- Shell-level admin/recovery tooling gains a natural home: the same image/CLI entrypoint that provides `migrate` can host first-admin bootstrap/recovery commands required by ADR-0016.
- `/health` semantics are uniform across modes, so orchestrators and Compose healthchecks can be written once against liveness/readiness rather than per-mode special cases.

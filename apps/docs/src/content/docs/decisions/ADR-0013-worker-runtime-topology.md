---
title: ADR-0013 — Worker Runtime and Deployment Topology
---

# ADR-0013 — Worker Runtime and Deployment Topology

**Status:** Accepted

## Context

Loxep uses Graphile Worker for durable polling, ingestion, synchronization, notification, migration, and derived-processing jobs. A logically independent worker runtime improves fault isolation and allows background processing to scale separately from HTTP traffic.

That does not imply a mandatory separate worker container for small installations.

## Decision

Loxep ships one application image with multiple runtime modes:

```text
LOXEP_MODE=all      # default: web + worker in one application deployment
LOXEP_MODE=web      # HTTP/web runtime only
LOXEP_MODE=worker   # Graphile Worker runtime only
```

The default Compose installation uses `all`, so a minimal deployment needs only:

```text
loxep
postgres-timescale
```

plus optional external services such as S3-compatible storage.

## Scaling path

Because Graphile Worker coordinates work through PostgreSQL, an installation can later move to:

```text
loxep-web-1
loxep-web-2
loxep-worker-1
loxep-worker-2
loxep-worker-3
postgres-timescale
object-storage
```

without changing the domain model or queue technology.

Workers may run on separate physical servers or VMs as long as they can securely reach PostgreSQL and any required provider/object-storage endpoints.

## What this enables

Separate worker processes/hosts allow:

- polling and ingestion load to scale independently of web/UI traffic;
- CPU/memory-heavy derived work to be isolated from interactive requests;
- worker restarts/upgrades without taking the UI offline;
- different worker concurrency on machines with different resources;
- distributed processing across multiple servers using the same durable PostgreSQL queue;
- later routing of specialized job classes to dedicated worker pools if required.

## What this does not mean

Loxep is not a microservices system merely because it can run multiple worker processes.

All runtimes use the same codebase, image, database, domain services, migrations, and job definitions. Runtime topology is an operational choice.

Do not introduce Redis, Kafka, or a separate orchestration layer merely to support multiple workers.

## Local storage interaction

`local` media storage is supported for single-node/default deployments. Once an installation runs workers or web processes on multiple physical hosts, local filesystem media becomes operationally unsafe unless the path is provided by genuinely shared storage.

Loxep should detect or clearly warn about this topology. The recommended expansion path is to migrate media to S3-compatible object storage before or while adding remote worker/web nodes.

---
title: ADR-0014 — RustFS as Initial Object Storage Companion
---

# ADR-0014 — RustFS as Initial Object Storage Companion

## Status

Accepted.

## Context

Loxep needs durable storage for images, receipts, PDFs, contracts, product media, installation photos, exports, and other binary content. The application must support a small installation that starts with local filesystem storage and later migrates to S3-compatible object storage without changing domain references.

The project previously identified Garage as the preferred S3-compatible companion. For the initial Loxep implementation, RustFS will instead be the primary recommended and tested self-hosted object-storage companion. Garage remains a valid compatible backend and an easy future pivot because Loxep's contract is S3 compatibility rather than a RustFS-specific API.

## Decision

1. Loxep's storage abstraction supports at least:
   - `local` filesystem storage;
   - generic S3-compatible object storage.
2. Local filesystem storage remains the zero-extra-service default for the smallest deployment.
3. RustFS is the initial recommended/tested self-hosted S3 implementation for Loxep.
4. RustFS remains a separate process/service from Loxep. Loxep does not embed the RustFS server binary or runtime inside the application process/container.
5. The official Loxep deployment examples may include RustFS as an optional Compose service/profile so users can manage Loxep, PostgreSQL, and RustFS as one stack even though they remain independent containers.
6. Loxep must not persist RustFS-specific URLs or identifiers as domain identity. Media records reference a storage backend and opaque object key; the S3 endpoint/bucket are deployment configuration.
7. Migration from local storage to any S3-compatible backend is a supported, resumable application workflow with copy, checksum/size verification, metadata cutover, retry, and optional delayed source cleanup.
8. If an installation enables remote/multiple web or worker hosts while still using local storage, Loxep should surface a health/configuration warning because local files are not shared between hosts.

## Why RustFS is not embedded in the Loxep container

RustFS is itself a storage server with its own data directory, networking, health, security, upgrade cadence, console, and scaling model. Technically, a Docker image could contain both the Loxep Node application and the RustFS binary, but doing so would create unnecessary coupling:

- restarting/upgrading Loxep would restart the storage server;
- process supervision becomes Loxep's responsibility;
- storage health and application health become entangled;
- resource limits cannot be managed independently;
- later scaling RustFS or Loxep independently becomes harder;
- security boundaries and filesystem ownership become less clear;
- the combined image grows and must track two unrelated release lifecycles.

The deployment goal is therefore **one easy stack**, not **one process containing everything**.

A typical small deployment remains:

```text
loxep
postgres-timescale
```

with local media storage.

A recommended object-storage deployment becomes:

```text
loxep
postgres-timescale
rustfs
```

All may be launched from the same Loxep-provided Compose project.

## Future distributed topology

RustFS and Loxep workers are independent distributed systems. A future operator may choose to co-locate a RustFS node and Loxep worker on the same host, but Loxep must not assume this topology.

Workers require network access to PostgreSQL and the configured object-storage endpoint. RustFS determines its own storage cluster membership and replication/erasure layout.

## Portability

The following should remain valid without schema redesign:

```text
local filesystem -> RustFS
RustFS -> Garage
RustFS -> SeaweedFS S3 gateway
RustFS -> AWS S3 / Cloudflare R2 / Backblaze B2 / other compatible service
```

Provider-specific capabilities may be added later behind optional capability detection, but the common application path must remain portable S3 semantics.

## Consequences

- The smallest Loxep installation does not require RustFS.
- Loxep's recommended Compose stack can add RustFS with minimal operational friction.
- RustFS can be replaced later without rewriting the media domain.
- Storage migration is treated as a product feature rather than an operator-only manual procedure.
- Garage remains a supported/recommended alternative where its distributed/multi-site design is preferred.

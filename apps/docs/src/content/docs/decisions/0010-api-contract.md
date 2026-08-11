---
title: "ADR-0010: Framework-native internal calls plus versioned HTTP/OpenAPI integration API"
---

**Status:** Accepted

## Context

The first-party web application benefits from framework-native typed server interactions. Loxep is also expected to grow sidecars, automation, integrations, and potentially non-TypeScript consumers. Making tRPC or framework server functions the sole application API would optimize for the first UI at the expense of future interoperability.

## Decision

Use TanStack Start server functions where appropriate for first-party UI interactions.

Keep domain services independent of those handlers.

Expose a versioned HTTP API with an OpenAPI contract as external integration use cases arrive. Do not add tRPC initially.

## Consequences

- The first-party UI remains productive without requiring every internal interaction to traverse a public REST API.
- External consumers receive a language-neutral contract.
- Some operations may eventually have both a server-function adapter and an HTTP adapter over the same domain service.
- API versioning and backward compatibility become explicit product responsibilities once the external API is published.

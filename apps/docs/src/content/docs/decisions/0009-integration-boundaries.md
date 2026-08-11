---
title: "ADR-0009: Provider adapters, maintained clients, and retained source facts"
---

**Status:** Accepted

## Context

Loxep will integrate with APIs whose authentication, pagination, signing, serialization, webhook, and rate-limit behavior can be tedious and provider-specific. Reimplementing mature protocol clients wastes effort, but allowing SDK response types to spread through the application makes providers impossible to replace cleanly.

## Decision

Use maintained provider libraries when they materially reduce protocol work, while wrapping them in Loxep integration adapters.

For eBay, begin with `hendt/ebay-api` and bypass/augment it with direct official API calls where necessary.

For every provider:

1. credentials and provider identity live in the connection model;
2. provider calls live inside the integration package/module;
3. important source events/raw objects are retained when useful for audit/replay;
4. integration code maps provider payloads into Loxep domain commands/facts;
5. provider SDK types do not become canonical domain types.

## Consequences

- Loxep avoids rebuilding OAuth/signing/protocol machinery without coupling its domain to one library.
- Provider libraries can be upgraded or replaced endpoint-by-endpoint.
- Raw source retention consumes storage but materially improves debugging, reconciliation, and replay.

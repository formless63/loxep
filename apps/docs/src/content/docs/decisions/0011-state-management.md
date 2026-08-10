---
title: "ADR-0011: Client State Management"
---

# ADR-0011: Do not add a global client-state library until required

**Status:** Accepted

## Context

Loxep already has natural owners for most application state: PostgreSQL for durable state, TanStack Query for server/cache state, Router for URL/navigation state, Form for form state, and React for local UI state.

Adding Zustand by default risks creating a second home for data that belongs in one of those layers.

## Decision

Do not include Zustand or another global client-state library in the initial foundation.

Add Zustand later if concrete cross-component ephemeral/workspace state emerges that is not naturally server, URL, form, or local component state.

## Consequences

- Fewer overlapping state models initially.
- Zustand remains an approved likely addition rather than a rejected technology.
- New state must be classified by ownership before introducing a global store.

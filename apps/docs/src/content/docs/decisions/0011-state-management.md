---
title: "ADR-0011: Client State Management"
---

# ADR-0011: Do not add a global client-state model until required

**Status:** Accepted; applies to starter adoption in ADR-0015.

## Context

Loxep already has natural owners for most application state: PostgreSQL for durable state, TanStack Query for server/cache state, Router for URL/navigation state, Form for form state, and React for local UI state.

Kiranism's TanStack Start dashboard currently includes Zustand. Adopting that project as a UI donor does not make Zustand part of Loxep's architecture automatically.

## Decision

Do not use Zustand or another global client-state store merely because the starter includes it.

During starter adaptation, remove Zustand if no retained feature genuinely requires it. Add or retain Zustand only for concrete cross-component ephemeral/workspace state that is not naturally server, URL, form, or local component state.

Examples that may eventually justify it include temporary dashboard customization, multi-step workspace state, or persisted UI selections that do not belong in the URL/server.

## Consequences

- Fewer overlapping state models initially.
- Starter dependencies are evaluated rather than inherited blindly.
- Zustand remains an approved possible tool rather than a rejected technology.
- New state must be classified by ownership before introducing a global store.

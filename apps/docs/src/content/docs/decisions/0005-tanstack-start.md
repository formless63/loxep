---
title: "ADR-0005: TanStack Start"
---

# ADR-0005: TanStack Start for the application UI

**Status:** Accepted with maturity caveat

## Context

Loxep is primarily an authenticated, data-dense application: tables, filters, charts, forms, URL state, mutations, background-refresh state, and administrative workflows. It is not primarily a content/SEO application.

Next.js, Nuxt, and SvelteKit were considered. React has the broadest relevant component/contributor ecosystem for this project, and TanStack's Router/Query/Table/Form family aligns closely with the expected UI workload.

At the time of this decision, TanStack Start is documented as Release Candidate: feature-complete and API-stable, but not yet a final stable release. This is an intentional accepted risk and must be revisited before the first production-oriented release if its status has not advanced.

## Decision

Use TanStack Start with React for the first-party web application.

Use TanStack Router, Query, Table, and Form where they provide clear value. Use server functions for first-party application interactions, while preserving domain services independently of framework handlers.

Do not make TanStack-specific server functions the only external integration surface; a versioned HTTP/OpenAPI API is expected as external consumers emerge.

## Consequences

- Strong fit for data-heavy application UX and URL/query state.
- Avoids adopting Next.js conventions merely for ecosystem popularity.
- Carries framework maturity risk that is explicitly acknowledged.
- Domain/business logic must remain outside framework route/server-function modules to preserve migration options.

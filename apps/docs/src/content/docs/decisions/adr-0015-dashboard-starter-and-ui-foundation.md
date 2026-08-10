---
title: ADR-0015 — Dashboard Starter and UI Foundation
---

# ADR-0015 — Dashboard Starter and UI Foundation

## Status

Accepted for initial implementation.

## Context

Loxep is a data-heavy operational application. Building the entire dashboard shell, theme system, responsive navigation, table patterns, command palette, form layouts, notifications UI, and other common admin application primitives from scratch would spend early implementation time on solved presentation problems.

A starter is useful only if it aligns closely enough with Loxep's chosen frontend stack and does not dictate the domain/data architecture.

## Decision

Use **Kiranism/tanstack-start-dashboard** as the initial UI/dashboard foundation and donor for Loxep's web application.

The starter currently aligns with Loxep on the important presentation stack:

- TanStack Start;
- React;
- TanStack Router;
- TanStack Query;
- TanStack Table;
- TanStack Form + Zod;
- shadcn/ui and Base UI;
- Tailwind CSS;
- Bun-compatible workflow;
- responsive dashboard/navigation shell;
- multi-theme support and theme switching;
- feature-oriented application organization.

The repository is MIT licensed.

## Adopt, do not inherit blindly

Loxep is not a fork whose architecture is governed by the starter. During scaffolding:

### Keep/adapt

- dashboard shell and responsive sidebar/header;
- theme provider and multi-theme/tweakcn system;
- useful shadcn component composition;
- layout primitives;
- TanStack Table patterns;
- TanStack Form patterns;
- route/layout organization where it remains idiomatic for current TanStack Start;
- command palette/navigation patterns;
- notification UI patterns;
- useful loading, empty, error, and not-found states;
- feature-folder organization where it maps cleanly to Loxep domains.

### Replace or evaluate

- demo/mock data and example products/users;
- authentication implementation/pages with Loxep's Better Auth + OIDC + magic-link design;
- backend/server examples with Loxep domain services and database layer;
- deployment-specific assumptions;
- charting library: Loxep may use Apache ECharts for dense time-series/analytics even if the starter uses Recharts;
- Zustand usage: retain only for genuine cross-client UI/workspace state, not server/domain state;
- demo Kanban/chat features unless a Loxep use case arrives;
- any dependencies that are unnecessary for Loxep.

## Version policy

The starter's package manifest is not authoritative for versions.

Before importing or pinning dependencies, verify current viable upstream versions under Loxep's dependency/version policy. A starter may supply code patterns and styling while its package versions are independently upgraded, removed, or replaced.

## Alternative/reference starters

The official TanStack CLI and shadcn TanStack Start template remain the reference for current framework conventions. Better Auth's official TanStack Start integration is authoritative for authentication wiring.

Minimal starters combining TanStack Start, Drizzle/PostgreSQL, Better Auth, and shadcn may be consulted for backend/auth patterns, but Loxep should avoid merging multiple starter architectures wholesale.

## Consequences

- Loxep begins with a polished, proven dashboard vocabulary instead of a blank UI.
- The theme-switching capability is available early and remains easy to customize because shadcn components live in the project.
- Backend architecture remains governed by Loxep ADRs, not by the starter.
- Starter dependencies are deliberately pruned rather than becoming permanent merely because they were present on day one.

---
title: "ADR-0015: Dashboard Starter and UI Foundation"
---

## Status

Accepted and implemented as the initial web scaffold.

## Context

Loxep is a data-heavy operational application. Building the entire dashboard shell, theme system, responsive navigation, table patterns, command palette, form layouts, notifications UI, DnD patterns, and other common admin application primitives from scratch would spend early implementation time on solved presentation problems.

A starter is useful only if it accelerates presentation without dictating Loxep's domain/data architecture.

## Decision

Use **Kiranism/tanstack-start-dashboard** as the initial UI/dashboard foundation and donor for Loxep's web application.

The donor has now been integrated into `apps/web` rather than remaining a future plan.

### Workspace adaptation

The donor's former `/dashboard/*` demo surface is preserved under:

```text
/starter/*
```

Loxep's real dashboard occupies:

```text
/dashboard/*
```

The shared application shell is workspace-aware. The top of the sidebar switches between workspace roots, while sidebar navigation and Cmd+K derive from the active workspace's navigation configuration.

Future major product areas are peers of `/dashboard`, not descendants of one giant dashboard route tree. See [Workspaces & Navigation](../../product/workspaces/).

## Preserve useful reference material

The Starter Reference workspace is intentionally retained while the application is young. Working examples are useful reference for contributors and coding agents, including:

- responsive shell/sidebar/header behavior;
- theme provider and tweakcn theme system;
- shadcn/Base UI composition;
- tables;
- forms;
- Recharts dashboard charts;
- DnD/Kanban interactions;
- notifications;
- command/search patterns;
- loading/empty/error patterns.

Demo content is not product-domain truth, but there is no requirement to delete useful reference code merely to minimize the repository on day one.

A later production build may hide/omit the Starter Reference workspace while keeping its source available to contributors.

## Adopt, do not inherit blindly

Loxep remains independent of donor architectural assumptions.

### Keep/adapt

- application shell and responsive sidebar/header;
- multi-theme system;
- useful shadcn/Base UI components;
- TanStack Table/Form/Query patterns;
- command palette/navigation patterns;
- notifications UI patterns;
- useful loading/empty/error states;
- DnD primitives where product workflows use them;
- Recharts for normal dashboard/business charts;
- Zustand as an available narrowly-owned UI-state tool under ADR-0011.

### Replace/isolate

- donor authentication with Loxep's Better Auth + OIDC + magic-link design;
- demo backend/server/data assumptions with Loxep domain services and PostgreSQL;
- donor branding from actual Loxep product surfaces;
- fake entities/APIs wherever they would leak into real product routes;
- deployment-specific assumptions that conflict with Loxep self-hosting;
- unused dependencies once they are truly unused.

Apache ECharts remains an approved addition for dense time-series/analytical interfaces when Recharts is not the right tool. It does not need to replace every ordinary Recharts visualization.

## Current primitive/form-library reality

The donor composition as integrated actually uses **Radix UI as the dominant primitive layer** (via the `radix-ui` umbrella package), with a small number of components on Base UI (`@base-ui/react`) and `@shadcn/react`. Donor form components likewise still use react-hook-form alongside Loxep's accepted TanStack Form.

Standardization onto a single primitive/form layer is incremental and happens only where there is concrete benefit (e.g. when a component is rewritten for a real product surface). A mass migration is explicitly **not** Phase 0 work.

## State policy

Zustand is not a second server-state store. TanStack Query owns server/cache state; Router owns URL state; TanStack Form owns form state; PostgreSQL owns durable product state and durable user preferences.

Zustand may own immediate cross-component editing/workspace state such as dashboard layout editing, chart configuration, or complex UI selections. Durable preferences should normally be saved to PostgreSQL.

See ADR-0011 and the [Implementation Contract](../../development/implementation-contract/).

## Version policy

The donor's package manifest and lockfile are reference inputs, not permanent authority.

Before a dependency is added, changed, or pinned, verify the current viable upstream release and compatibility under Loxep's dependency/version policy. The Loxep lockfile is authoritative for a given repository revision.

## Consequences

- Loxep begins with a polished dashboard vocabulary instead of a blank UI.
- The useful donor demos remain inspectable without occupying Loxep's real product route namespace.
- Major feature areas can grow as top-level workspaces without making one sidebar unmanageable.
- Backend/domain architecture remains governed by Loxep documentation and ADRs.
- Recharts, DnD, and Zustand are retained when useful rather than removed reflexively and re-added later.
- Starter code accelerates implementation but does not define product behavior, persistence, auth, provider models, or version policy.

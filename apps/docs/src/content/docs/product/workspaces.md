---
title: Workspaces & Navigation
---

Workspaces are Loxep's **top-level user-interface navigation surfaces**. They prevent one enormous sidebar from accumulating every feature in the product while allowing each major area to present navigation that fits the task at hand.

A workspace is **not** a database schema, microservice, tenancy boundary, permission boundary, economic entity, or domain-ownership boundary. Backend ownership remains defined by [Domain Boundaries](../../architecture/domain-boundaries/). A workspace may compose data and operations from several domains.

## Current shell

The repository already has the first workspace roots:

```text
/dashboard/*    real Loxep dashboard workspace
/market/*       market workspace — monitors, watched items, market events
/settings/*     settings workspace — administration & diagnostics
/starter/*      preserved UI-donor/reference workspace
```

The shared shell owns the application frame:

```text
Loxep application shell
├── workspace switcher
├── workspace-aware sidebar
├── header / breadcrumbs
├── command palette
├── theme controls
└── account controls

active workspace
└── supplies its own navigation tree and content routes
```

The active workspace is derived from the current route. Sidebar navigation and Cmd+K use the same workspace configuration so they cannot drift into different navigation models.

## Routing rule

Major product areas are peers of `/dashboard`, not descendants of it.

Good:

```text
/dashboard/overview
/market/watchlist
/commerce/orders
/inventory/stock
/projects/jobs
/finance/reconciliation
/settings/connections
```

Avoid:

```text
/dashboard/market/...
/dashboard/commerce/...
/dashboard/inventory/...
```

`/dashboard` is a workspace, not a namespace for the entire application.

## Proposed workspace map

The exact split can evolve as real workflows appear. The initial UX map should be treated as a strong working proposal rather than a frozen domain model.

| Workspace | Route root | Likely contents |
| --- | --- | --- |
| **Dashboard** | `/dashboard` | cross-domain overview, alerts, recent activity, integration/job health, user-configured widgets |
| **Market** | `/market` | monitor targets, watchlists, explicit items, saved searches, sellers, observations, market events, price/availability history, opportunity rules |
| **Commerce** | `/commerce` | catalog/SKUs, channel listings, orders, returns, fulfillment state, channel views, shipping workflow entry points |
| **Inventory** | `/inventory` | stock, locations, movements, acquisitions, purchasing, vendors, receiving, cost basis, landed cost |
| **Customers** | `/customers` | people, organizations, contacts, addresses/sites, operational history, terms/tax metadata |
| **Projects** | `/projects` | jobs/projects, tasks/milestones, time, materials, expenses, service delivery, subscriptions/recurring services |
| **Finance** | `/finance` | billing/AR, expenses/AP, payments, marketplace payouts/fees, banking, reconciliation, accounting, tax-oriented reporting |
| **Settings** | `/settings` | users/admin, economic entities, connections/integrations, notifications, storage, application settings, secret status/rotation, health/diagnostics |
| **Starter Reference** | `/starter` | preserved donor demos and UI patterns; development/reference use rather than product data |

Not every proposed workspace needs to be implemented during Phase 0. The value of defining the map now is to keep route structure and future deep links from assuming that Dashboard owns everything.

## Cross-cutting capabilities

Some concerns should not be forced into a dedicated workspace merely because they are distinct backend domains.

### Documents and media

Documents/media are cross-cutting infrastructure and business evidence. Attachments should appear in the owning workflows, while a dedicated document browser/search workspace can be added later if usage justifies it.

### Reporting and analytics

Derived reporting belongs close to the workflow it explains when practical: market analytics in Market, inventory valuation in Inventory, project profitability in Projects, financial statements in Finance. A global reporting workspace remains possible later.

### Notifications and search

Notifications, global search, command palette actions, and health indicators may span workspaces. They should use shared shell services rather than being duplicated per workspace.

## Workspace switcher behavior

The top of the sidebar is the primary workspace switcher. It should present application identity separately from active workspace identity:

```text
Loxep
Dashboard  ▾
```

Switching workspaces navigates to that workspace's configured default route. Deep-linking directly into a workspace must select the correct workspace automatically from the URL.

The initial `admin`/`member` model does not require workspace filtering: trusted members have ordinary product access across the installation. The switcher can later filter/disable workspaces if real authorization/capability rules are introduced, but it must never equate a workspace with a provider connection, economic entity, or accounting book.

## Navigation configuration

Workspace definitions should remain data-driven. The current implementation establishes the pattern with `src/config/workspaces.ts` and per-workspace navigation modules.

Conceptually:

```ts
{
  id: 'market',
  label: 'Market',
  root: '/market',
  defaultPath: '/market/overview',
  navGroups: marketNavGroups
}
```

The shared sidebar and command palette consume the active workspace's `navGroups`. Product pages should not hardcode their own unrelated copy of the main navigation tree.

## Dashboard customization and state

Dashboard/view customization is a legitimate future use for Zustand and drag-and-drop state, but state ownership matters:

```text
user edits layout/chart/table view
            |
            v
     immediate UI state
        (Zustand)
            |
            v
       save/debounce
            |
            v
 durable user preference
      (PostgreSQL)
```

Examples include widget position/size, visible table columns, column order, chart configuration, saved filters, default date ranges, and collapsed panels.

Zustand may own the live client editing experience. PostgreSQL should normally own preferences that must survive browser/device changes. TanStack Query remains the owner of server/cache state; Router owns URL state; TanStack Form owns form state.

## Starter Reference workspace

The Kiranism donor content is intentionally preserved under `/starter` rather than deleted immediately. It is useful working reference material for:

- tables;
- forms;
- charts;
- DnD/Kanban interactions;
- notifications;
- themes;
- command/search UI;
- responsive shell behavior;
- component composition.

It must not become a source of product-domain truth. Demo APIs, fake entities, auth assumptions, and donor branding remain reference material only.

A later production build may hide or omit the Starter Reference workspace while retaining the source for contributors.

## Implementation constraints

1. Do not nest new major product workspaces beneath `/dashboard`.
2. Do not treat workspace boundaries as backend/domain ownership, permission, economic-entity, or accounting-book boundaries.
3. Sidebar and command palette must derive from the same active-workspace configuration.
4. Preserve stable route roots once real product deep links are in use.
5. Keep the workspace switcher independent of application user identity, provider account identity, economic-entity identity, and accounting-book identity.
6. Persist durable user customization in PostgreSQL rather than relying only on browser-local state.
7. Keep `/starter` isolated from production data and Loxep domain services unless a demo is deliberately converted into a real product feature.
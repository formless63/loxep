---
title: Workspaces & Navigation
---

Workspaces are Loxep's **top-level user-interface navigation surfaces**. They prevent one enormous sidebar from accumulating every feature in the product while allowing each major area to present navigation that fits the task at hand.

A workspace is **not** a database schema, microservice, tenancy boundary, permission boundary, economic entity, or domain-ownership boundary. Backend ownership remains defined by [Domain Boundaries](../../architecture/domain-boundaries/). A workspace may compose data and operations from several domains.

## Current shell

The repository already has the first workspace roots:

```text
/dashboard/*    the product home — money, market, operations, and the ledger
/market/*       market workspace — monitors, watched items, market events
/inventory/*    inventory workspace — stock, locations, acquisitions, movements, and the
               /market handoff live (M2), reading real data; writes (intake, lot
               creation, cost allocation) are validated but blocked pending one
               apps/web dependency add; enrichment and intake review's other two
               producers arrive in later milestones
/commerce/*     commerce workspace — catalog and manual/offline channel listings live
               (M6, loxep-dgf.6): overview, listings list + detail, the read-only
               catalog, an item-detail listings panel (the /inventory ↔ /commerce
               weave), and manual sale recording (design open question 7,
               PROVISIONAL — see the flipping design doc). Connector-synced
               listings and orders have no surface yet — a later milestone
/finance/*      finance workspace — expense capture, receipts, and expense reports live
               (M1); books/chart-of-accounts/fiscal-period administration
               (`/finance/books`) lives too — create a book, link entities, generate
               fiscal years, open/close/reopen periods, and read the trial balance;
               CSV import and the acquisition seam arrive in a later milestone
/settings/*     settings workspace — administration & diagnostics
/starter/*      preserved UI-donor/reference workspace
```

`/account/*` also exists but is **not** a workspace — see [Account surfaces](#account-surfaces) below.

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
| **Dashboard** | `/dashboard` | cross-domain overview: money from ingested orders, market pulse, operations health, financial statements — see [Dashboard workspace](#dashboard-workspace) below; user-configured widgets remain a future addition |
| **Market** | `/market` | monitor targets, watchlists, explicit items, saved searches, sellers, observations, market events, price/availability history, opportunity rules |
| **Commerce** | `/commerce` | catalog/SKUs, channel listings, orders, returns, fulfillment state, channel views, shipping workflow entry points |
| **Inventory** | `/inventory` | stock, locations, movements, acquisitions, purchasing, vendors, receiving, cost basis, landed cost |
| **Customers** | `/customers` | people, organizations, contacts, addresses/sites, operational history, terms/tax metadata |
| **Projects** | `/projects` | jobs/projects, tasks/milestones, time, materials, expenses, service delivery, subscriptions/recurring services |
| **Finance** | `/finance` | billing/AR, expenses/AP, payments, marketplace payouts/fees, banking, reconciliation, accounting, tax-oriented reporting |
| **Infrastructure** | `/infrastructure` | the installation's own operational estate: domains and their DNS desired-versus-actual state, delegation status, mail-provider state, hosting targets/fleet, reconciler run history, and — later — the container, metrics, and uptime layers Loxep links rather than owns |
| **Settings** | `/settings` | users/admin, economic entities, integrations (the catalog of supported services and their set-up: eBay keyset, WooCommerce, Medusa, notification transports), connections (accounts added under a chosen service), notifications, storage, application settings, secret status/rotation, health/diagnostics |
| **Starter Reference** | `/starter` | preserved donor demos and UI patterns; development/reference use rather than product data |

Not every proposed workspace needs to be implemented during Phase 0. The value of defining the map now is to keep route structure and future deep links from assuming that Dashboard owns everything.

### The three workspaces Phase 9 fills

`/inventory`, `/commerce`, and `/finance` were reserved in the map above long before anything rendered in them. [Phase 9](../roadmap/#phase-9--the-flipping-loop) fills them, and the reason they arrive together is that they are three views of one loop rather than three unrelated areas: an acquisition in `/inventory` is caused by spend recorded in `/finance` and produces a listing in `/commerce`.

Two placements are worth stating because they are easy to get wrong:

- **Expenses live in `/finance`, not `/inventory`**, even though a reseller records most spend while standing next to a lot they just bought. The workspace map already composes billing, expenses, payments, banking, accounting, and tax there; expenses are its first tenant, not its definition. Quick entry is reachable from the command palette and from acquisition detail so the operator never has to navigate to record a spend.
- **Intake review lives in `/inventory`**, and it is one surface serving three producers — hand entry, an ingested marketplace purchase, and a parsed receipt. Unifying them means the operator learns one review screen rather than three.

`/dashboard` gains nothing from this phase, deliberately — Phase 9 built the three workspaces above and left the dashboard untouched on purpose. Expenses already reach it through the Financial band, which reads the ledger. *(Update: COGS posting from inventory depletion has since shipped, outside this phase's own scope — see [Phase 5](../roadmap/#phase-5--financial-foundation) — so acquisitions now reach the ledger too. The dashboard's own blindness to the six domains that shipped after it has since been closed by `loxep-9m2`, which is where the band table below now reflects; this section describes what Phase 9 itself did, not the current dashboard.)*

### Infrastructure is a future peer root, and it is about the installation itself

`/infrastructure` is reserved now and built later. It is the odd one out in the table above, and the difference is worth stating so it is not mistaken for a Settings page or for a new commercial domain.

Every other workspace presents facts about **the business Loxep runs** — items observed, goods sold, money moved, people billed. Infrastructure presents facts about **the machines and names Loxep and its owner's other services run on**. Those facts have no counterparty, no economic entity, and no place in any accounting book; see [Domain Boundaries](../../architecture/domain-boundaries/#infrastructure) for the ownership rules that follow from that.

It is the meeting point for capability that arrives in layers:

```text
now (designed)   domains, DNS desired-vs-actual state, delegation, mail provider,
                 hosting targets/fleet, reconciler runs and drift
later (designed) container/stack management, host and container metrics, uptime and
                 endpoint monitoring — surfaced as links plus one current-status
                 health row per subject, never reimplemented and never stored as a
                 metric series, per the companion-services guiding rule
```

The second layer is designed in [Fleet Observability Design (Phase 8)](../../architecture/fleet-observability-design/). It adds one shared health table and no other schema: companion tools are linked through the generic external-resource model, a deep link opens the real tool rather than a Loxep copy of it, and infrastructure alerts continue to be delivered by the tools themselves — because Loxep runs on the fleet it observes and cannot alert on its own outage.

It is **not** `/settings`. `/settings` configures Loxep — its users, connections, secrets, storage, and application behavior. `/infrastructure` is a working surface over external estate that Loxep observes and reconciles, with its own tables, its own jobs, and its own daily use. The credentials that reach those external systems still live where every other provider credential lives: connections and encrypted secrets administered under `/settings`. The physical design is [Infrastructure Control Plane Design](../../architecture/infrastructure-control-design/).

## Dashboard workspace

`/dashboard/overview` is the product home and is now filled. It answers one question — *how is my operation doing right now* — as four bands, in the order an operator cares about them:

| Band | Reads | Owning surface |
| --- | --- | --- |
| **Money** | ingested `orders` and `order_fees`: revenue, order count (naming the manual/offline subset rather than burying it), seller-charge fees, net proceeds, refunds, a daily revenue/order series, a 7-day-versus-prior-7-day trend, and the `channel_listings` draft→active→ended→sold funnel | `/settings/connections` (order sync is enabled per connection), `/commerce/listings` |
| **Market pulse** | derived `market_events` over the trailing 24h, the highest-scoring rule-stamped opportunity, and the biggest price movers | `/market/*` |
| **Operations health** | provider connections by status **and by health status** (failing, degraded, and unknown counted distinctly — "Loxep could not determine" is not "healthy"), the market-monitor fleet, purchase-sync and DNS-reconcile freshness, infrastructure counts (hosting targets, unresolved DNS drift, reconcile failures, domains), the fleet-tool signal chips, and notification delivery success over 7 days | `/settings/*`, `/market/monitors`, `/infrastructure/*` |
| **Financial** | the income statement for the fiscal period covering today, from the installation's default accounting book, plus its largest expense accounts — and the two upstream-of-ledger backlogs (draft acquisitions awaiting intake, documents awaiting confirmation), which render whether or not a book exists | `/finance/books` (create/archive a book, link entities, generate fiscal years, open/close/reopen periods, trial balance), `/inventory`, `/finance/documents` |

Which target types count as the **market-monitor fleet** is derived, not
listed: every `MonitorTargetType` maps to its owning domain through a
`satisfies Record<MonitorTargetType, …>` map, so a new registrant in
`@loxep/market` breaks the typecheck until it is classified. That replaced a
hand-maintained exclusion list which had been counting `ebay_purchases` and
`infrastructure_domain_reconcile` as market monitors — inflating the fleet,
rendering a stuck DNS reconcile as a monitor error, and letting a healthy
non-monitor target mask a stale discovery fleet through the freshness
`Math.max`.

A backlog is deliberately **not** an Operations tile. That band answers "is
anything broken right now", and draft acquisitions or unconfirmed documents
are work waiting, not faults — they belong with the ledger facts they precede.

Three rules the composition exists to enforce, all checkable:

- **Real data only.** No band fabricates a series, a trend, or a baseline. A tile with a genuine derived series gets a sparkline; a tile without one gets a chart-token icon medallion. A missing prior period renders *no* trend badge rather than `+0.00%`, and an absent figure renders an em dash rather than a zero. This is the same rule [Frontend Standards](../../development/frontend-standards/#kpi-and-stat-cards) states for KPI cards, applied to a whole page.
- **Each band is its own data source.** Four server functions, four queries, four `Suspense` + error boundaries. The route loader warms all four but lets any one of them fail on its own: a broken band degrades to a retryable alert in place while the other three render.
- **Domain rules survive the trip to the UI.** The money band reports one currency and names the others rather than converting (there is no FX), labels its net figure contribution *before* cost of goods rather than margin, and excludes duplicate-marked orders. The financial band shows only `posted`/`reversed` entries and refuses to widen a missing fiscal period into an "all time" statement.

The dashboard consumes existing read models wherever they exist. Where they do not, the read lives with the domain that owns it — the "biggest movers" read is in `@loxep/market` alongside the other observation analytics, not in the web app.

## Cross-cutting capabilities

Some concerns should not be forced into a dedicated workspace merely because they are distinct backend domains.

### Documents and media

Documents/media are cross-cutting infrastructure and business evidence. Attachments should appear in the owning workflows, while a dedicated document browser/search workspace can be added later if usage justifies it.

### Reporting and analytics

Derived reporting belongs close to the workflow it explains when practical: market analytics in Market, inventory valuation in Inventory, project profitability in Projects, financial statements in Finance. A global reporting workspace remains possible later.

### Account surfaces

The signed-in user's own account lives at `/account/*` — today `/account/profile`, which owns full name, display name, and avatar. It is an **account control of the shared shell**, not a workspace: it has no entry in the workspace configuration, does not appear in the workspace switcher, and keeps whatever sidebar the user already had. That follows from the rule below that the switcher stays independent of application user identity.

Self-service and administration are separate surfaces on purpose. `/account/profile` edits only the caller's own record; `/settings/users` is the admin directory over everyone's. They must not be merged, and the self-service page is never placed under `/settings`.

Profile values arrive pre-filled where the identity provider supplies them — a generic OIDC issuer's `name` and `picture` claims become the user's name and avatar, and `nickname`/`preferred_username` seeds the display name. Provider values apply only when the account is created: an in-app edit is permanent and is never overwritten by a later sign-in. Wherever Loxep names a person it resolves display name, then full name, then email.

Avatars are either an absolute http(s) URL (the identity provider's `picture` claim, or one typed in by hand) or an uploaded image file, stored through `@loxep/storage`'s media service against the installation's default storage backend and served back from `/api/media/avatar/:mediaId`. Uploading replaces the previous avatar: if the prior `user.image` was itself a Loxep-stored avatar, that media object is deleted; an external URL is left untouched. There is no per-avatar ACL — `media_objects.created_by_user_id` records who uploaded it as an attribution fact, and any signed-in user may fetch any avatar by id, matching how a plain image URL already worked. Uploading is unavailable until an admin registers a storage backend under `/settings/storage`.

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

The shipped dashboard is a **fixed composition** — the four bands above, in that order, with no per-user layout. Customization is still a legitimate future addition, and when it arrives state ownership matters:

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
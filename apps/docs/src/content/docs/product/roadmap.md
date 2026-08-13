---
title: Roadmap
---

The [Master Domain Map](../master-domain-map/) describes the territory. This roadmap deliberately does not attempt to build all of it at once.

## Phase 0 — Foundation and decisions

Goal: finish the platform foundation required for the first useful vertical slice without prematurely implementing future domains.

Already established:

- Bun workspace/monorepo with `apps/web` and `apps/docs`;
- Kiranism TanStack Start dashboard integrated as the UI donor/reference;
- `/starter/*` preserved for working UI examples;
- real `/dashboard/*` workspace;
- workspace-aware sidebar switcher and Cmd+K navigation;
- product/architecture documentation and ADR process;
- PostgreSQL + TimescaleDB, Drizzle, Graphile Worker, Better Auth, local/S3 storage, and runtime topology decisions;
- minimal economic-entity model distinct from users, provider connections, workspaces, and future accounting books;
- initial installation-wide `admin`/`member` access model with no speculative resource ACL layer.

**Phase 0 is complete.** The formal [exit criteria](../../architecture/phase-0-foundation/#exit-criteria) were validated by a fresh-clone walkthrough — see the [Phase 0 Exit Walkthrough](../../development/phase-0-exit-walkthrough/) record (16/17 on first pass; the one finding was fixed and re-verified at head). Implemented:

- the PostgreSQL + TimescaleDB development/Compose environment;
- Drizzle migrations and database conventions;
- the Graphile Worker runtime and job conventions;
- one Loxep image with `LOXEP_MODE=all|web|worker`, with `all` as the default deployment;
- Better Auth with generic OIDC, magic links, no passwords, and deployment roles;
- concrete first-admin bootstrap and shell-level recovery;
- minimal `economic_entities` plus nullable connection attribution;
- database-backed application settings plus application-encrypted runtime secrets;
- the generic connection/credential model;
- source-event/raw-provider-object conventions;
- media metadata, storage-backend records, and the `local`/generic-`s3` abstraction;
- resumable local-to-S3 migration with RustFS as the initial S3 conformance target;
- generic external-resource links;
- structured logging, health/readiness, redacted auditing, and tests (package vitest suites against real PostgreSQL/TimescaleDB plus Playwright critical-flow e2e coverage);
- generic Docker Compose deployment and optional companion profiles;
- continuous validation of both application and documentation builds, including internal docs links.

Normal runtime/provider settings should be configured in-app and stored in PostgreSQL. Environment/mounted-secret configuration is reserved for bootstrap facts required before DB-backed administration or login is possible. See [Configuration & Secrets](../../architecture/configuration-and-secrets/).

The normal minimal deployment target is:

```text
loxep                    # web + Graphile Worker capability
postgres-timescale
```

A media-heavy or expansion-ready deployment can add:

```text
rustfs                   # optional S3-compatible companion
```

The exact future product workspace split is documented separately in [Workspaces & Navigation](../workspaces/). Major areas should be peer workspace roots rather than one enormous `/dashboard/*` tree.

## Phase 1 — Useful eBay monitor

Goal: Loxep replaces manual checking and creates immediate daily value.

- Create/manage an eBay connection in-app through supported authentication — implemented: `/settings/connections` is provider-aware for `ebay` (environment/keyset admin form, "Connect eBay account" full-page-navigation consent flow per the CSRF cookie design, credential-status display, and a "Validate" action running a cheap authenticated call reported through the integration's error taxonomy).
- Optionally attribute the connection to an economic entity where the account clearly belongs to one.
- Import/synchronize watchlist membership — implemented; live-exercised 2026-08-12 against the sandbox with a consented user token: the `ebay_watchlist` poll executor authenticates, pages, syncs membership, and deactivates absent members on cadence with zero errors. Caveat: the eBay **sandbox's** `GetMyeBayBuying` returned an empty watchlist even after `AddToWatchList` calls acknowledged `Success`, so live watchlist *content* is unverified against sandbox data — a sandbox-side quirk (the same token's other Trading and Browse calls work), not an adapter defect; production verification happens when a real account connects.
- Monitor watched listings around a configurable 60-second baseline within API constraints — implemented: cadence is the operator's `interval_seconds` adjusted by the adaptive policy and clamped by the per-connection rate-budget interval floor the executor injects. The installation-wide defaults are registered application settings — `monitors.defaults` (the 60-second baseline), `monitors.observation_caps`, and `integration.ebay.rate_budget`, whose refill rate derives that floor — so cadence, per-poll observation cost, and the provider budget are operator-editable without a restart.
- Monitor explicit item IDs — implemented and exercised against the live eBay sandbox (application-token Browse path).
- Store listing observations in TimescaleDB — implemented: one observation batch per poll, minted once at fetch time and retry-safe.
- Detect price, availability, quantity, and listing-state changes — implemented: derived per poll from the previous observation and bridged into opportunity-rule attribution and notification delivery.
- Configure ntfy in-app — implemented and live-verified: endpoint (with write-only token), routing rule, and delivery all created/exercised through the product UI.
- Deliver useful notifications with direct listing links — implemented and live-verified end to end 2026-08-12: a real sandbox listing's price revision produced `price_dropped`/`price_changed` events on the next poll and two delivered ntfy pushes carrying the working sandbox listing URL (delivery rows recorded provider message ids on the first attempt).
- Market workspace UI for connections/monitors, watched items, current state, event history, and price/availability history where available.
- Dashboard/Settings surfaces for runtime, job, storage, and integration health.

## Phase 2 — Search, sellers, and market intelligence

Goal: move from watchlist alerts to a personal market dataset.

- Persistent eBay search rules — implemented and exercised against the live eBay sandbox: an `ebay_search` target runs Browse search through the worker's poll executor, bounded by its `maxItems` cost knob, and links every result into `monitor_items`.
- New-listing detection — implemented: a discovery poll diffs the fetched page against known items *before* upserting it and derives `new_listing` *after* linking, so exactly one event fires per marketplace item on its first global discovery, however many monitors match it.
- Seller monitoring — implemented: an `ebay_seller` target enumerates one seller through the Browse `sellers` filter and feeds the same pipeline; a page eBay returned by silently dropping the seller filter is refused outright rather than ingested as that seller's inventory.
- Adaptive scheduling/backoff.
- Historical price and stock charts.
- Restock and sellout metrics.
- Seller/search dashboards — implemented: `/market/searches` (per-monitor discovered-item counts and recent new-listing events for `ebay_search`/`ebay_seller` monitors) and `/market/opportunities` (recent rule-stamped events with score/rule/link-out), plus two `/market/overview` cards (new listings 24h, top opportunity). The monitor create/edit dialog and constants now cover all four `MonitorTargetType` values.
- Opportunity rules and scoring.
- Timescale continuous aggregates where justified by measured volume and real queries.

## Phase 3 — Commerce ingestion

Goal: connect market intelligence to actual selling outcomes while preserving explicit economic ownership.

- normalize eBay sales/orders and related fee/fulfillment facts — implemented PROVISIONALLY, pending the same [Commerce Schema Design](../../architecture/commerce-schema-design/#provisional-implementation-decisions) review: the eBay adapter reads the **Sell Fulfillment API** (`GET /sell/fulfillment/v1/order`) through the existing keyset/user-token/rate-budget foundation, an `ebay_orders` monitor target is claimed by the same dispatcher, and the worker's poll executor runs the incremental `lastmodifieddate` sync into orders, lines, fees, refunds, fulfillments, and retained provider payloads. Unlike WooCommerce, eBay reports a real **seller-side** fee (`totalMarketplaceFee`), so `orders.fee_amount` is populated and profitability actually subtracts something; `partially_fulfilled` is reachable; and `buyer_display_name` holds the eBay username. Order ingestion needs the `sell.fulfillment.readonly` OAuth scope, which the watchlist consent set does not include, so an existing eBay connection must be re-consented before it can sync orders. **Mapping is fixture-verified against the installed client's bundled OpenAPI types, not yet live-verified**: the Sell Fulfillment status vocabularies and the `filter` range grammar are design-derived until the sandbox live leg runs. `ebay_orders` shipped registered in `@loxep/market`'s `MONITOR_TARGET_TYPES`/`monitorTargetConfigSchemas` and labeled in the market UI's monitor table/dialog (loxep-itn, closing a narrow follow-up left by this issue — `createMonitorService` CRUD did not cover these rows at first, though claim/poll/sync always did) — like `woo_orders`, it is excluded from the monitor create dialog's type dropdown because these rows come from `@loxep/commerce`'s connection-bound sync bootstrap, not manual creation;
- add WooCommerce connection and order ingestion — implemented PROVISIONALLY, pending the [Commerce Schema Design](../../architecture/commerce-schema-design/#provisional-implementation-decisions) review: a `woo_orders` monitor target registered against the shared scheduling model is claimed by the existing dispatcher, and the worker's poll executor runs the incremental `modified_after` sync into orders, lines, fees, refunds, fulfillments, and retained provider payloads. A store's connection keeps its URL as non-secret `connections.config` and its REST key pair as an encrypted `woo_credentials` bundle. Exercised against a live production store with read-only credentials;
- add Medusa connection and order ingestion;
- establish internal catalog/SKU and channel-listing relationships;
- attribute owned commerce activity to the appropriate economic entity rather than inferring ownership from the user/workspace/connection alone;
- preserve provider-native source data;
- initial cross-channel order and profitability views;
- begin using media storage for product/listing assets where useful.

The economic-entity foundation is already decided by ADR-0017. Accounting books remain deliberately separate and are not required for Phase 3 ingestion.

The physical schema for this phase — orders, lines, fees, refunds, fulfillment, catalog items, and channel listings, plus what Phase 3 deliberately does not create — is designed in [Commerce Schema Design (Phase 3)](../../architecture/commerce-schema-design/).

## Phase 4 — Inventory, acquisition, and fulfillment

Goal: follow physical goods from acquisition through sale.

- Acquisitions and inventory movements. *(implemented provisionally: `acquisitions`, `acquisition_costs`, and the append-only `inventory_movements` ledger.)*
- Cost basis. *(implemented provisionally: specific identification, with the item row as the cost layer and basis frozen at first depletion.)*
- Inventory locations. *(implemented provisionally: a location tree with a cached `path`, not a WMS.)*
- Economic-entity ownership/context for stock and acquisition workflows where needed. *(implemented provisionally: stored attribution on both `acquisitions` and `inventory_items`, immutable on items — a change of owner is a paired transfer, never an `UPDATE`.)*
- Purchasing/vendors/receiving foundation where acquisition workflows need them. *(**not built**, deliberately: acquisitions carry a denormalized `vendor_name` only. Vendor records, purchase orders, AP, and receiving-against-a-PO are explicit non-goals — see [contradiction 2](../../architecture/inventory-schema-design/#contradictions-and-tensions-found-in-existing-documentation) in the Phase 4 design.)*
- Order allocations/depletion. *(implemented provisionally: `inventory_allocations` against Phase 3 `order_lines`, depletion on fulfillment, idempotent under re-ingestion.)*
- Shipments and tracking. *(implemented provisionally: `shipments` and `shipment_items`, referencing `order_fulfillments` rather than replacing them.)*
- Actual outbound shipping costs. *(implemented provisionally, including carrier post-audit `adjustment_amount`.)*
- Marketplace/payment fees. *(**narrowed**: Phase 3 already owns order-attached fees and Phase 5 owns payout/processor-level ones, so what remained here is reconciling shipping-label fees against actual postage — implemented as `shipments.order_fee_id` plus an unlinked-fee report. See [contradiction 1](../../architecture/inventory-schema-design/#contradictions-and-tensions-found-in-existing-documentation) in the Phase 4 design.)*
- Per-item/order realized profitability. *(implemented provisionally as read models in `@loxep/inventory`; the figure is labelled "contribution after goods, fees, and shipping", never "profit".)*
- Begin connecting market opportunities to historical realized resale outcomes. *(implemented provisionally: the `acquisition_opportunity_links` table and the realized-contribution read model — the raw material. The correlation study itself is deliberately unscheduled.)*

The physical schema for this phase — acquisitions and lot costs, inventory items and locations, append-only movements, allocation and depletion against Phase 3 order lines, outbound shipments, and the opportunity-to-outcome link — is designed in [Inventory & Acquisition Schema Design (Phase 4)](../../architecture/inventory-schema-design/), and is now implemented **provisionally**: every open question in that design was resolved per its own documented recommendation under an owner directive, pending review. What shipped and what diverged is recorded in that document's [Provisional implementation decisions](../../architecture/inventory-schema-design/#provisional-implementation-decisions).

Inventory **valuation** is not in this phase and is not the same thing as cost basis. Phase 4 stores what was paid for a specific unit — a historical fact; forming a judgement about what stock is worth now requires a reporting date, a policy, and a book to post the adjustment to, all of which are Phase 5.

## Phase 5 — Financial foundation

Goal: create trustworthy financial facts without making the ledger the only representation of operational reality.

- Expenses and flexible cost attribution. *(implemented provisionally: `expenses` plus `expense_allocations`, with entity attribution on the expense and orthogonal allocation targets — entity, acquisition, catalog item, channel — for the targets that exist today. Over-allocation is refused; under-allocation is a draft and a named report.)*
- Receipt/document attachments through the media layer. *(implemented provisionally: `media_links` rows with `resource_type = 'expense'`, no new table, idempotent under the natural key migration 0004 added.)*
- Payouts and clearing-account model.
- Bank transaction ingestion/import path.
- Reconciliation foundation.
- Explicit `accounting_books` model separate from economic entities. *(implemented provisionally: `accounting_books` with no `economic_entity_id`, ever — ownership points inward from `book_entity_links`. A book carries its functional currency, accounting basis, fiscal-year start, and a gapless entry-number counter.)*
- Book-to-economic-entity relationship that supports multiple economic entities/operating identities sharing one book. *(implemented provisionally: `book_entity_links`, effective-dated, with `posting_primary`/`reporting_only` roles and an exclusion constraint permitting at most one primary book per entity per day. Routing walks the entity and then its ancestors, so an assumed name's activity lands in its parent company's book while staying separately reportable — the owner's answer, enforced in both directions.)*
- Chart of accounts and any required accounting dimensions/classes/departments. *(implemented provisionally: one `ledger_accounts` chart per book, seeded from a code-owned template with stable `system_key` handles; `accounting_dimensions` and their values ship EMPTY, because the economic entity is the primary separation mechanism and it is a column on the line.)*
- Double-entry journal. *(implemented provisionally: `journal_entries` and `journal_lines` with signed amounts, composite same-book foreign keys, gapless per-book numbering, a deferred per-currency balance constraint trigger, posted-entry immutability, soft-close period enforcement, and reversal-and-repost as the only correction path.)*
- Declarative posting-rule model. *(implemented provisionally: `posting_rules` plus immutable `posting_rule_versions` and their `posting_rule_lines` templates, resolved first-match-wins by priority. A rule is a selector plus a line template and deliberately not an expression language — every predicate is an AND, a `remainder` plug line makes an unbalanceable template unauthorable, and a template is validated against the fact type at save time rather than silently never firing. The engine reads orders, order fees, order refunds, and expenses; posts through the existing journal service; detects a re-synced unchanged fact by `source_fact_fingerprint` and does nothing; and corrects a changed fact by reversal plus a new entry under the current version. `journal_entry_source_links` records the facts an entry touched, and a version referenced by any entry is frozen at the database.)*
- Core financial statements/reports. *(implemented provisionally: the income statement and the balance sheet ship as read models over the same `sum(functional_amount)` partition the trial balance uses, so the three cannot disagree. Retained earnings is computed from prior fiscal years rather than stored, there are no closing entries, and an entity-filtered balance sheet is offered only for a book that requires the entity dimension AND whose coverage is complete — the entity-filtered income statement, which is ADR-0017's actual promise, is always available.)*
- Sales-tax fact model and marketplace-facilitator handling.
- Inventory valuation, revaluation, and COGS posting, plus the aging/turnover/carrying-cost reporting derived from Phase 4's cost basis. Phase 4 stores what was paid; forming a judgement about what stock is worth requires a reporting date, a policy, and a book to post to.
- The expense model that consumes Phase 4's non-capitalized `acquisition_costs` rows. *(the mechanism is decided and the reader is not built: such a row posts DIRECTLY through a rule with `match_capitalize = false` rather than being copied into `expenses`, and the `acquisition_cost` source-fact reader is the one piece missing.)*

Do not assume one economic entity equals one accounting book. An LLC and several assumed-name operations may intentionally share one chart of accounts/ledger while remaining separately attributable operationally.

The physical schema for this phase — books and the effective-dated book-to-entity link, the per-book chart of accounts and dimensions, fiscal periods and closing semantics, the double-entry journal, declarative posting rules, payouts and clearing accounts, expenses, bank ingestion and reconciliation, sales-tax facts, and the statement read models — is designed in [Financial Foundation Schema Design (Phase 5)](../../architecture/financial-schema-design/).

**Three milestones of that design are implemented provisionally — expenses and receipts, then the financial core, then posting rules and statements: thirteen of its twenty-two tables.** The second was blocked until the owner answered all three OWNER-REVIEW-CRITICAL questions on 2026-08-12, because each is unrecoverable after a single entry posts. The answers: books are toggleable per economic entity with a child entity's postings rolling up into its parent's book; corrections are always reversal plus repost, never mutation; and the build is USD-only with the per-line conversion seam kept in the schema so another currency can be wired in later without restating anything.

The ledger stays **downstream of reality** and the seam between them is unchanged: a fact's link to its entry is a source-fact identity (`('expense', expenses.id)`), deliberately without a foreign key, so a posted entry survives the deletion of its source and `expenses` gains no `journal_entry_id`. Facts now post automatically through the rule engine, and a fact that cannot post — no entity with a book, no matching rule, no generated period — is a visible backlog rather than a guess or a rejected ingestion. What still does not exist is COGS posting from inventory depletion, plus payouts, banking, reconciliation, and tax facts. What shipped and what diverged is recorded in that document's [Provisional implementation decisions](../../architecture/financial-schema-design/#provisional-implementation-decisions).

## Phase 6 — Customers, projects, services, and billing

Goal: support non-e-commerce business activity coherently.

- Customer/organization/counterparty model distinct from installation-owned economic entities. *(implemented provisionally: `counterparties`, `counterparty_contacts`, `contact_channels`, and `counterparty_entity_roles`. The distinction is physical, not a comment — no `economic_entity_id` on a counterparty, no `counterparty_id` on an economic entity, a `CHECK` that refuses a tax identifier on a person, and roles as the single one-directional meeting point. Customer and vendor are relationship rows scoped to one of our entities, never flags on the party. Merge is a survivor pointer with one resolver; dedupe is exact-normalized and never automatic.)*
- Projects/jobs/sites. *(**implemented provisionally**: `counterparty_sites` ships with a full service — `@loxep/counterparties`'s `sites.ts` (create/update/deactivate/reactivate/list) — because sites are a Counterparties-domain table under open question 14's own package rule, and that package already exists. `projects` now ships a service too: `@loxep/work`'s `projects.ts` — create/get/update/updateStatus/reattributeEntity/list/listWithChildren — enforcing hierarchy-lite (depth ≤ 1), the billing-method consistency checks, and three of the design's four entity-attribution ladder rungs (`manual`, `counterparty_role_default`, `unattributed`; `installation_default` is accepted only as an explicit caller-supplied value, since resolving the installation's default-entity setting needs `@loxep/domain`, which `@loxep/work` deliberately does not depend on).)*
- Time and billable work. *(**implemented provisionally**: `@loxep/work`'s `time.ts` records time entries and resolves `bill_rate_amount`/`cost_rate_amount` through the design's six-scope-plus-manual-plus-unresolved precedence ladder (`rates.ts`), frozen on the entry at record time and never silently rewritten by a later rate change; `billing-rates.ts` is the rate-card CRUD the resolver reads. Derived billable amounts are exact `numeric(20,6)` decimal-string arithmetic (`decimal.ts`), never JS floats.)*
- Materials and expenses attributed to jobs. *(**partially implemented**: `@loxep/work`'s `materials.ts` records `project_material_uses` against a project, snapshotting cost from `inventory_items.landed_cost_amount` for the `inventory_basis` case and computing a markup-derived charge — but it writes no `inventory_movements` row itself (`@loxep/work` does not depend on `@loxep/inventory`; a caller holding both packages composes the consumption-movement write and the material-use insert in one transaction). The `expenses`/`expense_allocations` ALTERs this design promised are still **not** made in this slice.)*
- Service plans and subscriptions.
- Recurring service periods/billing facts.
- External-resource links to knowledge/task platforms.
- Outline/AFFiNE/Vikunja-style integrations where current APIs make them worthwhile.
- Invoice Ninja integration as an initial delivery/payment surface where useful. *(adapter and connection UX implemented: `packages/integrations/invoiceninja` (`@loxep/integration-invoiceninja`) is a source-verified, fixtures-tested boundary over the self-hosted API (`X-API-TOKEN` auth, client/invoice read+write mappings, the Fractal `ArraySerializer` pagination envelope), registered in the integrations catalog and connections UI with an `invoiceninja_credentials` bundle. **Not yet wired**: the on-demand push server function, the invoices tables it would round-trip against (still design-only — see below), and live write verification. See [Connecting Invoice Ninja](../../guides/connecting-invoice-ninja/).)*
- Quotes/invoices/AR model where owning those capabilities provides value.
- Project and subscription profitability.

The physical schema for this phase — counterparties and their contacts, channels, sites, identifiers, and per-entity roles, projects with time entries and rate resolution, materials consumed on jobs, service plans and subscriptions with generated service periods, the minimal owned invoice and receivable model that round-trips with Invoice Ninja, and the profitability read models — is designed in [Counterparty, Project, Service, and Billing Schema Design (Phase 6)](../../architecture/services-billing-schema-design/).

**Two milestones of that design are implemented provisionally — the counterparty core, then projects, time, rates, materials, and sites: nine of its nineteen tables.** The second milestone's shape was decided by open question 14, the domain-to-package mapping rule this same design proposes: applied to Phase 6, it recommends a NEW `@loxep/work` package for the Projects-and-Work domain (projects, time, rates, materials, services, subscriptions, periods). That package (`loxep-nw0`) now exists and owns `projects`, `billing_rates`, `time_entries`, and `project_material_uses`'s services, plus the **unbilled-work read model** — the design's core Phase 6 capability. `@loxep/work`'s version of that read model can only ever cover the time-and-materials half of the design's four-source join (`service_periods` is design-only and `expenses.project_id` is one of the deferred Phase-5-table ALTERs, so neither is reachable), and the "billed" side is an injectable `BilledResolver` seam rather than a real `invoice_line_sources` anti-join, because that table does not exist yet. `counterparty_sites` remains the one table in this domain area with a service in `@loxep/counterparties` rather than `@loxep/work`, because sites are a Counterparties-domain table under the same rule and that package already exists. Open question 1 (own-versus-integrate invoicing) — resolved Ninja-first, nothing native ships yet — is the reason everything past this milestone (services, subscriptions, service periods, invoices, payments) is still design only, independent of the package question. **No table owned by an earlier phase was altered** — `orders` gains no `counterparty_id`, and `expenses` still carries a denormalized `payee_name` even though counterparties now exist in an earlier migration in this same phase. What shipped and what diverged is recorded in that document's [Provisional implementation decisions (partial)](../../architecture/services-billing-schema-design/#provisional-implementation-decisions-partial).

## Cross-cutting companion integrations

Companion services are not confined to a late roadmap phase. When they accelerate a current vertical slice without becoming architectural dependencies, Loxep can add integrations earlier.

Examples include:

- ntfy for notifications;
- RustFS or another S3-compatible backend for media;
- Databasus backup-health webhooks;
- Vikunja task/project links;
- Outline/AFFiNE knowledge links;
- Invoice Ninja billing delivery;
- Beszel/Gatus operational links or health context — designed in [Fleet Observability Design (Phase 8)](../../architecture/fleet-observability-design/).

## Later directions

Potential later work includes fine-grained per-resource/per-entity access controls if real shared-install workflows require them, richer purchasing/AP, landed-cost automation, shipping integrations, document/OCR workflows, fixed assets and mileage, direct listing synchronization, additional commerce providers, customer portals, deeper tax/reporting integrations, native task/project capabilities, and richer operational-health integrations.

These should be pulled forward only when actual use exposes the need. The domain map is territory, not a requirement to prebuild every subsystem.

## Phase 7 — Infrastructure control plane

Goal: give the installation a working surface over its own operational estate — the domain names, DNS state, mail hosting, and hosting targets Loxep and its owner's surrounding services depend on — modeled as desired state plus a reconciler rather than as provisioning scripts.

This phase is deliberately sequenced last among the designed phases and is **not a prerequisite for any earlier one**. It shares the foundation (connections, encrypted credentials, the scheduling model, audit events, provider adapters) and touches no commerce, inventory, financial, or counterparty table. Its records are installation-scoped and carry no economic-entity attribution; see [Domain Boundaries](../../architecture/domain-boundaries/#infrastructure).

It also runs against an explicit non-goal — the [Master Domain Map](../master-domain-map/#what-loxep-is-not) says Loxep should not become an infrastructure management platform, and [Principle 18](../../architecture/principles/#18-integrate-before-rebuilding-mature-specialist-products) says integrate before rebuilding. The design reconciles the two by drawing a narrow line: Loxep owns the **declared intent and its reconciliation** for names and DNS, which no companion tool owns on the owner's behalf, and continues to *link and observe* rather than replace container management, metrics, and uptime tooling. That reconciliation is the design document's first section and should be read before any code is written.

### Milestone 1 — schema, Cloudflare DNS reconciler, and drift detection

**Implemented and PROVISIONAL (loxep-lmy.1).** Migration `0012` creates the seven milestone-1 tables and no existing table gained a column; `@loxep/integration-cloudflare` covers zones and DNS records, verified against Cloudflare's current documentation and published OpenAPI schema; `@loxep/infrastructure` carries the materializer, the pure diff, the reconcile run, drift persistence, and the idempotency ledger. Two gaps remain: that package's workspace manifest and aggregate registration are still owed, which blocks the `@loxep/app` executor wiring, and **no Cloudflare token exists yet**, so every live verification is owner-gated. The owner-review gates (CAA policy content, never auto-deleting unexpected records, pending-operation recovery, and cadence ownership) are resolved provisionally per each recommendation — the CAA setting ships deliberately empty and materializes nothing until an operator reviews it. Divergences and corrected provider assumptions are recorded in the [design document's implementation-status header](../../architecture/infrastructure-control-design/).

- The infrastructure tables: domains and their provisioning state, DNS desired state with ownership markers, hosting targets, provider-operation idempotency, and the reconciler run/step ledger.
- A DNS-provider adapter at the integration boundary, with the same error taxonomy and per-connection rate-budget shapes the commerce adapters use, and its credential held as an ordinary encrypted connection credential created in-app.
- The record materializer as a pure, separately tested function from intent to desired records.
- The diff-and-apply reconciler as idempotent worker tasks registered against the shared scheduling model, with transactional enqueue so an intent change and its sync job commit together.
- Drift detection as the **same code path with apply disabled**, its findings persisted so a drifted record is a durable, reviewable row rather than a log line.
- Delegation polling with bounded backoff, and an explicit give-up state that surfaces in the UI instead of retrying forever. *Deferred within the milestone:* zone creation and delegation polling need the `provider_operations` read-back path against a live account, so they ship with the token the owner has yet to create.

### Milestone 2 — mail hosting

- A mail-provider adapter at the same boundary, gated on delegation being confirmed before ownership verification is ever attempted.
- Mailbox/alias templates so standard addresses are data-driven rather than hardcoded, and generated mailbox passwords stored as ordinary encrypted secrets.
- The provider's required DNS record set materialized through the milestone 1 pipeline, with the never-proxy constraint enforced in both the materializer and the schema.

### Milestone 3 — fleet, hosting targets, and the Infrastructure workspace

- Hosting-target records including tunnel-fronted hosts, and the resolution hop the materializer walks to find the address a name should actually point at.
- Reverse-proxy/tunnel provider integration where a target's control surface has an API worth driving.
- Token scope intent as an editable set, distinguishing a cheap scope change from a deliberate credential roll.
- The `/infrastructure` workspace: domain list and detail with the delegation, DNS diff, mail, and hosting panels; fleet list and detail; and the run history with per-step retry — the meeting point [Workspaces & Navigation](../workspaces/#infrastructure-is-a-future-peer-root-and-it-is-about-the-installation-itself) reserves for the later container, metrics, and uptime layers.

The physical schema for this phase — the intent tables, the materialization rules, the reconciler job graph, drift persistence, and the credential and scheduling reuse that keeps it inside existing conventions — is designed in [Infrastructure Control Plane Design (Phase 7)](../../architecture/infrastructure-control-design/). That document is **design only**, and several of its open questions are marked OWNER-REVIEW-CRITICAL because they are unrecoverable once a zone, a token, or a mailbox has been created against a live provider.
## Phase 8 — Fleet observability and management

Goal: make the installation's surrounding operational tooling — container management, host metrics, uptime monitoring, host consoles — visible inside Loxep without reimplementing any of it.

This phase is the **observe and link** layer [Phase 7](#phase-7--infrastructure-control-plane) named and deferred. It owns nothing new: companion tools are linked through the generic external-resource model, their reachability and status roll into one shared health table, and their alerts continue to be delivered by the tools themselves. It adds **one table** and alters none.

Two rules make the boundary checkable rather than aspirational. Loxep stores the **latest observed status** of a subject and never a metric sample — one row per subject, overwritten in place — so a hypertable of host metrics would be a visible violation rather than a judgement call. And Loxep **never calls a mutating endpoint** on a fleet tool: a deep link opens the real product, with the operator's own session and the tool's own permissions.

The phase's central argument is that Loxep runs on the fleet it would observe, so it cannot alert on its own outage — and every candidate tool already delivers to ntfy, which the operator already runs for Loxep. Loxep therefore stays out of the infrastructure alert path and, in the one integration that runs the other way, **publishes its own health into the operator's uptime monitor** so something independent can raise the alarm when Loxep is the thing that broke.

### Milestone 1 — the shared health model

- `integration_health` as shared foundation: one current-state row per subject, keyed `(subject_type, subject_id)`, covering connections, notification endpoints, and storage backends first. It is a derived rollup for display and never drives retry or backoff.
- One recurring probe sweep, with due-ness and backoff computed from columns the row already carries — no scheduling table and no per-subject cron.
- The Dashboard's Operations health band and a health summary surface read it.

### Milestone 2 — publish Loxep's own health outward

- An outbound push of Loxep-only facts — worker backlog, sync freshness, drift count, readiness — into an operator's existing uptime monitor, so a stalled push becomes an alert Loxep could not have raised itself.

### Milestone 3 — companion links and the fleet tools panel

- Companion tools linked through `external_resources`/`resource_links` against hosting targets and domains, with a typed known-tool registry in code rather than a per-provider column or table.
- A tools panel on each fleet record showing every linked tool's latest status, its provenance, and its age, with "unreachable from Loxep" as a distinct state from "failing".

### Milestone 4 and beyond — selective adapters

- Read-only adapters only where an API genuinely merits one, each with the standard error taxonomy, rate budget, and Loxep-owned fact types; link-and-probe everywhere else; and alert evidence ingestion only if the installation is to expose an inbound webhook surface at all.

The verdict for each candidate tool, the upstream evidence behind it, and the questions that must be answered before any of it starts are in [Fleet Observability Design (Phase 8)](../../architecture/fleet-observability-design/). Five of its open questions are marked OWNER-REVIEW-CRITICAL.

## Phase 9 — The flipping loop

Goal: close the operator's core loop — money out, goods in, goods described, goods listed — over the domain layer phases 3 through 6 already built.

This phase is different in kind from those before it. Phases 3, 4, 5, and 6 shipped **headless**: schema, services, and tests, with no product surface. There is no `/inventory`, `/commerce`, or `/finance` workspace, `@loxep/inventory` has no runtime consumer, and `channel_listings` is fully constrained and never written. Phase 9 is therefore roughly 70% first product surfaces over services that already exist and are tested, 20% additive schema, and 10% one new provider ingestion path. Its first milestone writes no migration.

- Expense capture from anywhere: quick entry, receipt attachment, and CSV import. Bank/OFX ingestion stays Phase 5 — a bank transaction is a settlement fact, not an expense.
- The acquisition seam: money spent on goods becomes an `acquisition_costs` row and cost basis, never an `expenses` row. Recording both would deduct the same dollar twice.
- Acquisition import from a connector: eBay buy-side purchase history through Trading `GetMyeBayBuying`'s `WonList` container. It needs no new OAuth scope, no re-consent, and no adapter change, because the traditional Trading APIs authorize on the IAF token rather than on scopes and `tradingCall` is already generic. It cannot be sandbox-verified — the sandbox returns no `GetMyeBayBuying` container at all — so the mapping ships marked unverified until a production account runs it, exactly as the watchlist vertical did.
- Receipt and invoice parsing as a defined **parser interface** with pluggable backends, shipping manual-assisted only. No parse ever becomes a domain record without a human confirming it, enforced structurally rather than by convention.
- The **Documents** domain gains its first tables and its package, serving both the receipt parser and the CSV importer through one review queue.
- Inventory enrichment: images through the media layer, how-it's-sold, package dimensions and weight, description, and typed product specifics — every field chosen because a listing needs it.
- Offline and local listings (Facebook Marketplace, Craigslist, in person) as first-class `channel_listings` with no connection, and the declared bridge to Loxep-managed listing authoring. Per-provider publish stays with each integration.

The physical design — the expense-to-acquisition seam, the Documents tables and the parser contract, the `inventory_items` enrichment columns and the specifics table, the `channel_listings` relaxations, and the full map of how the surfaces meet — is in [Flipping Lifecycle Design (Phase 9)](../../architecture/flipping-lifecycle-design/). That document is **design only**, and three of its open questions are marked OWNER-REVIEW-CRITICAL.

Two things this phase deliberately does not close. **COGS posting from inventory depletion remains Phase 5 work**, so money spent on goods still does not reach the ledger — `posting_rules.source_fact_type` already admits `acquisition_cost` and `inventory_movement`, and the readers are the missing half. And **a manual listing cannot yet record its sale**, because `orders.connection_id` is `not null` and Phase 3 declined to create the manual-order path; that decision is the design's open question 7.

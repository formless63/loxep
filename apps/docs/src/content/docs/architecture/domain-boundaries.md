---
title: Domain Boundaries and Ownership
---

Loxep is a modular monolith. Modules are ownership boundaries, not deployment boundaries. Each domain owns its canonical records and exposes operations/events to other domains rather than allowing presentation code or unrelated modules to mutate arbitrary tables.

## Workspaces are not domain boundaries

The application's top-level workspaces organize navigation and workflows. They do **not** define database schemas, package boundaries, services, or tenancy.

For example, the proposed Finance workspace may compose Billing, Payments, Banking, Accounting, Tax, and Reporting domains. Those domains keep distinct ownership even if the user experiences them in one navigation surface.

See [Workspaces & Navigation](../../product/workspaces/) for the UX map.

## Shared foundation

The shared foundation owns infrastructural concepts rather than commercial business logic:

- application identity references and profile data;
- minimal economic-entity identity/attribution;
- external connections/accounts and credentials;
- database-backed application settings and encrypted application/runtime secrets;
- source/provider events and retained raw provider objects;
- durable jobs and job conventions;
- media identity/storage abstraction and storage-migration state;
- generic external-resource links;
- audit metadata and integration health state. `integration_health` is shared foundation keyed by `(subject_type, subject_id)` across connections, notification endpoints, storage backends, external resources, and — where a later phase adds them — hosting targets and domains. It is a **derived rollup for display and attention**, and it never drives retry or backoff: the owning table's own error and backoff columns stay authoritative for that subject's behavior. Any domain may project into it; none may read another's subject rows as its own state. See [Fleet Observability Design (Phase 8)](../fleet-observability-design/);
- stable identifiers and cross-domain references.

Better Auth owns application authentication/session state and deployment-level `admin`/`member` roles. The initial access model is installation-wide for ordinary product data; Phase 0 does not create connection/entity/workspace ACL relations.

Bootstrap environment/mounted-secret configuration remains outside this domain where it must exist before PostgreSQL-backed administration or login can work. Normal runtime/provider settings belong in PostgreSQL. See [Configuration & Secrets](../configuration-and-secrets/).

Shared foundation must not become a dumping ground for unrelated business logic.

### Scheduling is shared foundation infrastructure

**PROVISIONAL — implemented ahead of review; see [Commerce Schema Design](../commerce-schema-design/#provisional-implementation-decisions).**

The polling/due-work scheduling model (`monitor_targets` and its `interval_seconds`, `next_poll_at`, `priority`, `backoff_until`, `consecutive_errors`, and namespaced `config` state) is **shared foundation infrastructure that any domain may register a target type against**, not a Market Intelligence-owned table. Market Intelligence owns the discovery target types (`ebay_watchlist`, `ebay_item`, `ebay_search`, `ebay_seller`) and everything they observe; it does not own the mechanism — `ebay_orders` shares the `ebay_` name but is a Commerce-owned order-sync type, exactly like `woo_orders` below. The claim/backoff/adaptive-cadence primitives are deliberately target-type-agnostic and operate on any row.

This resolves the tension between this document's earlier placement of monitor targets under Market Intelligence and the [Foundational Data Model](../foundational-data-model/)'s presentation of scheduling as the general due-work mechanism. The alternative — a second scheduling table per domain — would duplicate claim semantics, adaptive cadence, and rate-budget handling for no gain, and is rejected.

The rules that keep this from becoming a shared dumping ground:

- a domain registers a **target type** and a Zod schema for that type's `config`; it does not add columns to `monitor_targets`;
- transient per-type state lives under a **namespaced `config` key** owned by the registering domain (`adaptive` for the scheduler, `commerceSync` for Commerce's order cursor). No domain reads or writes another's namespace;
- the **executor** for a target type belongs to the domain that registered it, wired in the composition root — never in the scheduling package.

Phase 3 registers `woo_orders` and `ebay_orders` (Commerce order polling, one per provider) this way, and they are the worked example of all three rules:

- **target type + config schema:** `woo_orders` and `ebay_orders` join `MONITOR_TARGET_TYPES` and `monitorTargetConfigSchemas` in `@loxep/market`; no column is added to `monitor_targets`. Because the scheduler must not depend on a domain that registers against it, the Zod shape is *re-declared structurally* there rather than imported from `@loxep/commerce`, which keeps the authoritative copy — the same treatment the eBay search-filter shape already gets, guarded by a test that round-trips one config through both. (`ebay_orders` registered after `woo_orders` — `@loxep/commerce`'s `ensureEbayOrderSyncTarget` worked end to end before the type was in `@loxep/market`'s list, because the claim/backoff primitives never consulted it; only `createMonitorService` CRUD needed the follow-up registration, loxep-itn.)
- **namespaced state:** the incremental order cursor lives under `config.commerceSync` (watermark, last sync time, last order count, page overrides) — the same shape for both providers. The scheduler writes only `config.adaptive`; Commerce writes only `config.commerceSync`; neither reads the other's.
- **executor in the composition root:** `@loxep/app` builds one poll executor per registering domain and routes by `target_type` — the discovery `ebay_*` types to the eBay discovery executor, `woo_orders`/`ebay_orders` to branches that call `@loxep/commerce`'s sync services. `market.poll-target` still sees one executor, `@loxep/market` still contains no commerce code, and `@loxep/commerce` still contains no scheduling code.

The payoff is that a `woo_orders` or `ebay_orders` row is claimed, backed off, and adaptively re-cadenced by the same machinery as an `ebay_item` row, and Commerce ships no cron entry and no second scheduler.

## Economic entities

The foundation owns the minimal identity of people, businesses, and operating identities whose activity Loxep represents.

Examples include:

- personal/individual activity;
- sole proprietorships;
- LLCs, partnerships, and corporations;
- assumed names/DBAs and operating units beneath another entity.

An economic entity is neither a tenant nor an authorization container. A parent relation may express an assumed name beneath an LLC without implying that it is a separate legal person.

Provider connections and later operational records may reference an economic entity when ownership/context is meaningful.

Economic entities are also distinct from accounting books. The Accounting domain may later associate multiple economic entities/operating identities with one book and chart of accounts. Do not force one accounting ledger per economic entity.

See ADR-0017.

## Market Intelligence

Owns observations about things Loxep does not necessarily own or sell:

- monitor targets;
- marketplace searches;
- watched listings/items;
- sellers being observed;
- time-series listing observations;
- detected market events;
- market-derived metrics such as price history, restock timing, and sellout estimates;
- opportunity rules/scores.

It does not own internal inventory, orders, customers, or accounting records.

Marketplace listings/observations are generally entity-neutral public facts. A monitor or authenticated observation may still carry connection context that indirectly identifies the interested economic entity.

## Integrations

Each provider adapter owns protocol-specific behavior, authentication mechanics, rate-limit handling, pagination, provider identifiers, mapping, and webhook/poll ingestion.

Examples include eBay, WooCommerce, Medusa, Invoice Ninja, ntfy, task/knowledge systems, shipping providers, banks, backup-health sources, and other companions.

Provider SDK response types stop at this boundary. Integration code emits provider/source facts or calls domain services using Loxep-owned types.

An external application's object identity may be represented through `external_resources` and linked to Loxep objects without creating provider-specific columns throughout the schema.

Provider credentials are obtained through the shared credential/secret service rather than read from arbitrary environment variables or serialized into provider config JSON.

## Media and storage foundation

Media identity is cross-domain infrastructure rather than something each domain reimplements.

Owns:

- configured storage backends;
- `media_objects` metadata and stable Loxep media IDs;
- `media_links` between media and domain resources;
- local/S3 storage-driver contract;
- resumable storage-migration state and verification.

The storage foundation does not own the business meaning of an attachment. Accounting may know that an image is receipt evidence; Media knows how that file is identified, stored, verified, and retrieved.

Attachment is a `media_links` row keyed `(media_object_id, resource_type, resource_id, purpose)`. Where a resource holds several ordered objects — an item's listing gallery, a lot's photographs — the ordering is `sort_order`, and the primary object is the lowest `sort_order`, **not** a distinct `purpose` value. `purpose` is in the unique key and `sort_order` deliberately is not, so a `primary` purpose would let one object be both primary and gallery as two rows for one fact, and re-choosing a primary would become a purpose rewrite rather than a reorder.

RustFS is an initial deployment recommendation, not a domain dependency. Storage semantics remain generic local/S3.

## Catalog and Listings

Owns Loxep's internal description of products/services and their channel representations:

- products/SKUs/variants where an internal catalog is required;
- listing-to-item mappings;
- channel listing metadata/publication state;
- bundles/kits/assemblies at the commercial-definition level.

Provider-native listing fields may remain in provider-specific extensions when normalization would be lossy. Product/listing media references the shared media foundation.

## Commerce

Owns sales transactions originating from commerce channels:

- orders;
- order lines;
- order-level adjustments/discount facts;
- refunds/returns as commercial facts;
- order status lifecycle;
- channel/customer references associated with the sale.

Commerce does not directly create journal lines or mutate inventory quantities. It requests/causes inventory movements and emits economic facts consumed downstream.

Commerce facts that represent owned activity should carry explicit economic-entity attribution rather than inferring it from the logged-in user or workspace.

A channel listing does not require a provider connection. Selling on a surface Loxep has no integration with — Facebook Marketplace, Craigslist, in person — is an ordinary owned publication and is recorded as one, with `provider = 'manual'`, a null `connection_id`, and a Loxep-minted listing code in place of a provider identifier. A synthetic "manual connection" is not an acceptable alternative: a connection has a credential, a health state, and a synchronization posture, and a manual listing has none of the three, so the synthetic row would sit permanently unknown in every connection diagnostic. A listing Loxep authored but has not yet published to a channel has the same shape, which is a good sign the shape is right.

## Inventory and Acquisition

Owns physical ownership and movement of goods:

- inventory items/stock units;
- locations;
- acquisitions;
- receipts;
- inventory movements;
- allocations/reservations;
- cost layers/cost basis;
- landed-cost allocations;
- serial/lot information where needed.

An order line can reference inventory, but Commerce does not own stock state.

Inventory ownership/location design must allow entity attribution where required rather than assuming all stock in an installation belongs to one business.

Inventory also owns the **physical description of a held unit** — its condition, its free-text description, its package weight and dimensions, its images, its typed product specifics, and how it is intended to be sold (as a unit, as a lot, as a set, or parted out). These are facts about a physical thing, not about a SKU: a catalog item describing a model cannot have one condition, one weight, or one photograph, and `inventory_items.catalog_item_id` is nullable precisely because intake usually precedes identification. Catalog may later hold SKU-level *defaults* for the same attributes; the unit's own values remain Inventory's.

Package weight and dimensions on a stock unit are the operator's own measurement of the thing as it will ship. They are distinct from what the outbound package actually weighed, which is a Shipping fact on `shipments` and legitimately differs.

## Purchasing

Owns intent and obligations to vendors before inventory is received:

- vendors in purchasing context;
- purchase orders/lines;
- expected receipts;
- vendor bills/credits where AP functionality is implemented.

Receipt of physical goods produces Inventory facts. Financial obligations produce Financial/Accounting facts.

## Shipping and Fulfillment

Owns movement from seller to buyer after a sale and shipping-related operational facts:

- shipments;
- packages;
- labels;
- tracking;
- carrier/service;
- actual postage, insurance, surcharges, adjustments, and refunds;
- links from shipment to order/order lines.

Customer-paid shipping is a Commerce fact; actual carrier cost is a Shipping/Cost fact. They remain distinguishable.

## Customers and counterparties

Owns the reusable party/contact model for people and organizations Loxep economic entities do business with:

- people/organizations;
- contacts;
- addresses/sites;
- customer preferences/terms;
- tax/exemption metadata belonging to the customer identity.

Domains may reference customers/counterparties but should not duplicate party identity records.

An external organization is not automatically an installation-owned economic entity. The same real-world company could be an economic entity in one Loxep installation and merely a customer/vendor/payer in another.

## Projects and Work

Owns non-commerce work execution:

- projects/jobs;
- sites;
- work status;
- time entries;
- project tasks/milestones where implemented;
- billable work facts;
- project attribution for materials, expenses, and services.

Physical materials remain Inventory-owned and may be allocated/consumed by a project.

External task/project systems such as Vikunja may be linked through the generic external-resource model without becoming canonical project data unless an explicit synchronization/import design says otherwise.

## Services and Subscriptions

Owns recurring or continuing service obligations independent of invoice generation:

- service definitions/plans;
- subscriptions/items;
- service periods;
- billing cadence/renewal schedule;
- operational metadata for hosted/managed services where useful.

A subscription can generate billable facts but is not itself an invoice.

## Billing and Receivables

Owns amounts requested from customers outside or above channel-native order billing:

- quotes/estimates when implemented;
- invoices/lines;
- credit notes;
- receivable state;
- recurring invoice generation as a billing concern;
- mappings/links to an external billing surface such as Invoice Ninja.

Invoice Ninja may initially deliver invoices and customer portal/payment UX without becoming Loxep's canonical operational model.

## Payments, Payouts, and Banking

Owns movement/settlement facts involving payment processors, marketplaces, and financial accounts:

- payments and allocations;
- processor/marketplace fees as source financial facts;
- payout batches;
- clearing relationships;
- imported bank transactions;
- reconciliation state.

This domain records financial reality; Accounting determines how those facts post to a book/ledger.

## Costs and Expenses

Owns costs not already represented as inventory acquisition or another specialized source fact, plus flexible attribution of costs to operational objects.

A cost may reference customer, project, order, shipment, acquisition, product/SKU, channel, service, economic entity, or other supported dimensions.

Cost attribution is operational metadata and must survive changes to accounting classification.

## Accounting

Owns accounting interpretation, not source business facts:

- accounting books;
- relationships between books and economic entities/operating identities;
- chart of accounts;
- fiscal periods;
- journal entries/lines;
- posting rules;
- accounting dimensions/classes/departments where justified;
- reconciliation links needed by the ledger;
- trial balance and financial statements.

The ledger is downstream of operational facts. Journal entries generated from rules should retain references back to source facts and be reproducible where practical.

An accounting book is **not** synonymous with an economic entity. Multiple economic entities/operating identities may share one book and be separated by chart-of-accounts structure or accounting dimensions. Conversely, the eventual book/entity cardinality should be chosen from real accounting needs rather than encoded prematurely in the Phase 0 foundation.

## Tax

Owns tax facts, obligations, classifications, and reporting support, but Loxep does not initially attempt to become a tax-rate/calculation authority.

Owns/designs for:

- sales-tax facts by jurisdiction;
- marketplace-facilitator treatment;
- exemptions/taxability classifications;
- filing-period summaries;
- income-tax-oriented reports/exports;
- external tax-provider mappings where used.

Tax calculations supplied by marketplaces/processors/providers are preserved as source facts.

## Documents

Owns **document semantics and extracted content**, while the shared Media foundation owns underlying binary storage.

Examples include receipts, bills, customer POs, contracts, quotes, invoices, packing slips, shipping documents, and tax records.

Documents may own OCR text, structured extraction, matching status, document type, and business relationships while referencing one or more shared media objects.

Documents owns the **candidate** stage of extraction and nothing beyond it. A parsed receipt, an uploaded invoice, and an imported CSV all produce candidate lines with a disposition and, where a parser produced them, a confidence — and Documents may never write an expense, an acquisition, or an inventory item. Confirmation is inverted: each consuming domain owns a confirm function that takes candidates and writes its own records, and Documents only stamps which record a confirmation produced. That inversion is what keeps the dependency edges acyclic, and it is also the enforcement mechanism for the rule that **no extraction becomes a fact without a human**: a confirm function requires an actor, and a background job has none.

The parser itself is a pluggable backend behind one interface, selected by application setting. A backend that reaches an external service is an ordinary provider integration with an encrypted credential reached through the credential service, never an environment variable, and never on by default.

## Reporting and Analytics

Owns derived read models, aggregates, dashboards, and metrics. It does not become the canonical owner of underlying operational data.

Timescale continuous aggregates, materialized views, and analytical SQL belong here when they represent derived views rather than source observations.

Reporting may aggregate or segment by economic entity independently of how Accounting groups those entities into books.

## Infrastructure

Owns the **desired and observed state of the installation's own operational estate** — the domain names, DNS zones, mail-hosting registration, and hosting targets that Loxep and its owner's surrounding services run on.

Owns:

- domain records and their provisioning state, including registrar and delegation facts;
- DNS desired state per domain, its materialization rules, and the record-ownership marker that says which rows a reconciler may rewrite and which are hand-authored;
- observed provider state and the diff between desired and observed, including drift findings;
- mail-hosting registration and ownership-verification state for a domain, plus the mailbox/alias intent derived from a template;
- hosting targets (nodes, tunnels, and the relationship between a tunnel-connected host and the node that fronts it);
- **proxy resource desired state and its rule intent** — the resources, targets, and access rules an identity/reverse-proxy control-plane provider (Pangolin) fronts for a hosting target, including the per-row ownership marker (`template` | `manual` | `dynamic_ip`) that says which rules a reconciler may rewrite, the same shape `dns_records.owner` already gives DNS. See [Pangolin Integration & Chain-Provisioning Templates](../pangolin-chain-design/);
- provider-token *scope intent* — which zones a produced credential should cover — as distinct from the credential value itself;
- reconciler run and step history for every apply and every read-only drift check.

Does **not** own:

- credential material. Provider API tokens, keys, generated mailbox passwords, and a provider connection's *write-authorization tier* (`infrastructure.provider_write_policy` — a registered setting, not a credential, keyed by connection id, gating whether Infrastructure may apply anything beyond a read) are shared-foundation `connections` / `connection_credentials` / `application_secrets` records or shared-foundation settings, reached through the credential/settings service exactly as every other provider's are. Infrastructure stores the *reference*, the *scope intent*, and the *write-policy tier*, never ciphertext of its own;
- the scheduling mechanism. Due-work discovery, claim, backoff, and cadence remain the shared scheduling foundation described above; Infrastructure registers target types against it rather than building a second scheduler;
- container orchestration, host metrics, or uptime probing. Those remain independently deployed companion applications; Infrastructure may hold links and health state for them under the generic external-resource and integration-health models, and must not grow into a reimplementation of them. The observe-and-link layer that does this is designed in [Fleet Observability Design (Phase 8)](../fleet-observability-design/), and it draws two rules that make the boundary checkable: Loxep stores the latest observed status of a subject and never a metric sample, and Loxep never calls a mutating endpoint on a fleet tool. **Pangolin is not one of these tools, and cross-domain rule 13 does not govern it.** Rule 13 governs *companion tooling Loxep links and observes* — Beszel, Gatus, Dockhand, Termix, Netdata — read-only fleet companions Loxep was never meant to drive. Pangolin, Cloudflare, and Purelymail are **control-plane providers**: ordinary integration-boundary adapters Infrastructure writes to by design, behind the write-policy tier above and the [write-risk model](../pangolin-chain-design/#the-write-risk-model)'s own gates. The surface reading — "Pangolin is another tool on the fleet page, so rule 13 forbids writing to it" — is wrong for a right-sounding reason, and worth stating explicitly here because it is the mistake a reader who only skims rule 13 will make;
- anything commercial. There are no prices, no invoices, and no cost attribution here. A hosting bill is an Expense, attributed like any other expense, and it reaches this domain's records — if ever — as a reference, not as a column.

**Infrastructure records are installation-scoped and carry no economic-entity attribution.** A server, a zone, or a nameserver delegation is a fact about the installation, not about which operating identity's activity it supports; several entities' work commonly runs on one host, and inventing a per-record owner would create exactly the entity-as-container semantics ADR-0017 forbids. If cross-entity cost allocation for infrastructure is ever wanted, it belongs to the Costs and Expenses domain's allocation model, which already exists for that purpose.

Provider protocol shapes stop at the Integrations boundary as usual: DNS, mail, and hosting providers get adapters under `packages/integrations/*` and this domain consumes Loxep-owned types.

## Cross-domain rules

1. A domain may reference another domain's stable ID but should not mutate another domain's canonical tables directly from presentation code.
2. Cross-domain workflows run through domain services and/or durable events/jobs.
3. Raw provider data is retained at the integration/source boundary; normalized business facts are stored by the owning domain.
4. Derived state identifies the source facts from which it was computed where practical.
5. Avoid shared tables containing unrelated optional columns from many domains merely to reduce table count.
6. Do not create generic abstractions until concrete workflows show the abstraction is real; media, settings/secrets, economic-entity attribution, and external-resource links are early exceptions because they solve already-known cross-cutting needs.
7. Financial and tax interpretations must not overwrite operational history.
8. External companion applications remain independently authoritative for data Loxep has not deliberately chosen to own.
9. UI workspace placement does not transfer backend ownership between domains.
10. Application users, provider connections, economic entities, counterparties, and accounting books are distinct concepts.
11. Economic entities classify owned/operated activity; they do not define who may access data in the installation.
12. Records describing the installation's own operational estate are installation-scoped. They take no economic-entity attribution and are never a substitute for an expense, a counterparty, or an accounting fact.
13. Loxep links and observes mature companion tooling; it does not reimplement it. A companion's latest observed status may be stored; its metric history may not, and no Loxep code may call a companion's mutating endpoints.

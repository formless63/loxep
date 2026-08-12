---
title: Counterparty, Project, Service, and Billing Schema Design (Phase 6)
---

This document is the physical schema design for [Phase 6 — Customers, projects, services, and billing](../../product/roadmap/#phase-6--customers-projects-services-and-billing). It stands in the same relationship to Phase 6 that [Commerce Schema Design (Phase 3)](../commerce-schema-design/) stands in to Phase 3, [Inventory & Acquisition Schema Design (Phase 4)](../inventory-schema-design/) to Phase 4, and [Financial Foundation Schema Design (Phase 5)](../financial-schema-design/) to Phase 5: a concrete migration target with table sketches, constraints, and the reasoning behind them, written before any migration exists.

It **extends** the foundation and all three prior designs. Where an existing table, convention, or ADR already answers a question, that answer is reused rather than restated differently.

**Implementation status: ONE MILESTONE of this design is implemented, PROVISIONALLY — the counterparty core, and nothing else.** Migration `0006_expenses_and_counterparties.sql`, `packages/db/src/schema/counterparties.ts`, and `packages/counterparties` exist and create **four of this document's nineteen tables**. Projects, time entries, billing rates, material uses, service plans, subscriptions, service periods, invoices, invoice lines, invoice sources, and payments remain **design only** — as do `counterparty_sites` and `counterparty_identifiers` — because the first [OWNER-REVIEW-CRITICAL open question](#open-questions) decides whether most of them should exist at all. **No table this document does not own was altered**: `orders` gains no `counterparty_id` in this slice. See [Provisional implementation decisions (partial)](#provisional-implementation-decisions-partial).

This milestone was separable exactly as this document predicted: *"Migration A depends on nothing beyond the foundation and Phase 3, which means the counterparty milestone can ship even if Phases 4 and 5 slip."*

The original preamble is retained for the record: *Design work only. No migration, Drizzle schema, or projects/billing service code is authorized by this page; the exact column types and constraints must be re-verified against the current PostgreSQL/Drizzle behavior immediately before implementation, per the [dependency policy](../../development/dependency-policy/).*

**Phase 6's migration cannot run before Phase 4's and Phase 5's.** `project_material_uses` carries foreign keys into `inventory_items`, `inventory_allocations`, and `inventory_movements`; `invoice_payments` references `financial_accounts`; the AR posting path consumes Phase 5's `posting_rules` and `journal_entries`; and Phase 6 alters `expenses` and `expense_allocations`, which Phase 5 owns. There is an honesty problem here that Phases 4 and 5 did not have: **Phase 3 is implemented (provisionally), Phase 4 and Phase 5 are designs on paper.** This document can therefore state its Phase 3 references as facts against a migration and must state its Phase 4/Phase 5 references as requirements against documents. Every one of the latter must be re-verified against the applied migration before a single foreign key is written — see [Before implementing this schema](#before-implementing-this-schema).

Nineteen tables, and — for the first time in four phases — **Phase 6 alters tables it does not own.** That is not a lapse in discipline; it is the whole nature of this phase. Phases 3, 4, and 5 each deliberately left a party as denormalized text (`orders.buyer_external_id`, `acquisitions.vendor_name`, `expenses.payee_name`) and each promised in writing that Phase 6 would add the nullable identifier. Phase 6 is the phase that keeps those promises. The alterations are enumerated exhaustively in [Which existing tables gain columns](#which-existing-tables-gain-columns-and-why-phase-6-is-the-first-that-does), and every one of them is a nullable column or a widened `CHECK`, never a rewrite.

It should ship in the four milestones the phase naturally divides into — counterparties first, then projects with time and materials, then services and subscriptions, then invoicing and the Invoice Ninja round-trip — rather than as one migration.

## Scope

Phase 6 adds the physical tables required to run service and project work for named outside parties, and to bill it:

- `counterparties` — a person or organization Loxep's entities do business with;
- `counterparty_contacts` — named humans inside an organization;
- `contact_channels` — email, phone, handles, attached to a counterparty or a contact;
- `counterparty_sites` — addresses and places where work happens;
- `counterparty_identifiers` — the matching evidence that connects a channel-native buyer to a party;
- `counterparty_entity_roles` — which of *our* entities has which relationship with this party, and on what terms;
- `projects` — a project, job, or engagement, with hierarchy-lite;
- `time_entries` — who worked, how long, and whether it is billable;
- `billing_rates` — the rate card, scoped and effective-dated;
- `project_material_uses` — stock consumed on a job, bridging Phase 4;
- `service_plans` — the definition of a recurring service;
- `subscriptions` — one counterparty's instance of a plan;
- `subscription_items` — the priced components of a subscription;
- `service_periods` — the recurring billing **fact**, generated whether or not it is ever invoiced;
- `service_period_charges` — usage, one-off, proration, and credit charges inside a period;
- `invoices` — the owned billing document, including credit notes;
- `invoice_lines` — what is being charged;
- `invoice_line_sources` — which owned facts a line consumed, and the constraint that prevents double-billing;
- `invoice_payments` — money received against an invoice.

Nineteen new tables, plus eight nullable columns and two widened `CHECK`s on tables owned by Phases 3 and 5.

The domains involved are **Customers and counterparties**, **Projects and Work**, **Services and Subscriptions**, and **Billing and Receivables**, which remain four distinct ownership boundaries per [Domain Boundaries](../domain-boundaries/#customers-and-counterparties) even though they land in one phase and surface across two workspaces (`/customers` and `/projects`) plus part of a third (`/finance`). Workspace UX is not domain ownership. Whether four domains become four packages, three, or one is an [open question](#open-questions) — and this document proposes the **general rule** for that mapping that [Phase 5's open question 14](../financial-schema-design/#open-questions) asked for after the same question came up for the third time.

## What Phase 6 does not create

Phase 6 stops at owning the facts that only Loxep can own. It deliberately does not create:

```text
payroll, wages, withholding, employees, 1099s   Never in this shape — a compliance domain, not a time sheet
personal tax identifiers (SSN/ITIN/NINO)        Never — the schema physically refuses them; see counterparties
CRM pipelines, leads, stages, campaigns         Never — the domain map says "operational context, not a CRM"
scheduling, dispatch, routing, crew calendars   Later — needs availability, travel, and a planning model
customer portal / self-service login            Later — Invoice Ninja provides one; Loxep has no external auth
native tasks, kanban, dependencies, Gantt       Later — Vikunja is the answer today; see external resources
contracts, e-signature, change orders           Later (Documents) — media_links only in Phase 6
quotes / estimates as owned documents           Not owned — projects.estimate_amount + an Invoice Ninja link
AR aging engine, dunning, reminders, statements Not owned — Invoice Ninja's job; see the own-vs-integrate line
PDF rendering, templates, branding, email       Not owned — same
payment gateways, links, tokenization           Not owned — same; no card data ever touches Loxep
tax rate calculation on an invoice line         Never — providers calculate; Loxep records (Phase 5's rule)
deferred revenue / recognition schedules        Later — needs a policy; the periods exist to make it possible
credit control, credit limits enforced at sale  Later — the term is recorded, nothing blocks on it
vendor bills / AP / purchase orders             Still unowned by ANY phase — see contradictions
price lists, discount engines, promotions       Later — a rate card is not a pricing engine
resource capacity planning and utilization      Later (Reporting) — derived from time entries, not stored
timesheet approval chains and lock periods      Minimal only — one approved_at stamp, no workflow engine
address validation, normalization, geocoding    Never in this shape — free text plus optional lat/long
per-project or per-counterparty ACLs            Still none (ADR-0017); membership remains installation-wide
```

Four of these deserve emphasis because they are the most likely to be smuggled in during implementation:

- **A rate card is not a pricing engine.** `billing_rates` answers one question — what hourly figure applies to this hour of work — through a fixed six-level precedence ladder. It has no formulas, no volume tiers, no currency conversion, and no customer-specific product pricing. The moment someone wants "10% off all labour for this client in Q3", that is a discount line on an invoice, not a new rate scope.
- **Recording a payment is not being a payment processor.** `invoice_payments` records that money arrived. No card number, token, gateway response, or PAN fragment is stored anywhere, per ADR-0019. When Invoice Ninja collects a payment, Loxep learns the amount, the date, and an external reference, and nothing else.
- **A time entry is not payroll.** It records that work happened and optionally what it costs the business, which is a costing fact. It does not record wages, hours worked for employment-law purposes, overtime, or anything a payroll system needs. `time_entries.cost_rate_amount` is an internal costing rate an operator sets, not a wage.
- **Generating a service period is not billing it.** This is the single most important restraint in the phase and it gets [its own section](#service-plans-subscriptions-and-service-periods). A period exists because time passed and an obligation was live; whether it is ever invoiced is a separate column with a separate lifecycle.

## Conventions inherited from the foundation

Nothing below invents a convention. From the [Foundational Data Model](../foundational-data-model/), the [Foundation Schema Draft](../foundation-schema/), the [Implementation Contract](../../development/implementation-contract/), and the three prior designs:

- UUID primary keys with `defaultRandom()`; provider and external identifiers are stored separately as text and never become Loxep keys;
- money is `numeric(20,6)` plus an ISO currency code; no persisted arithmetic in JavaScript `number`;
- quantities are `numeric(20,6)`, matching `order_lines.quantity` and Phase 4's movements;
- state columns are `text` with application-owned TypeScript unions, never PostgreSQL enums;
- `CHECK` constraints only for genuinely closed sets. Almost every closed set in this design is **Loxep-owned** — no provider invents a project status or a role — so Phase 6 uses `CHECK`s at roughly the Phase 4/Phase 5 density. The exceptions (`projects.status`, `time_entries.activity_code`, `service_plans.plan_kind`) are called out where they occur;
- no `payload` or free-form attribute `jsonb` column on any table below. The only `jsonb` Phase 6 touches is `external_resources.metadata`, which is a provenance boundary the foundation already owns;
- user-reference columns follow [ADR-0020](../../decisions/0020-better-auth-schema-ownership/): nullable FK to the Better Auth user id with `ON DELETE SET NULL`. Phase 6 also uses the ADR's **second** permitted form for the first time in a domain table — see [who worked](#who-worked-and-why-a-nullable-fk-is-not-enough);
- no credentials, tokens, or secret material appear in any of these tables (ADR-0019). Invoice Ninja, Vikunja, and Outline credentials stay in `connection_credentials`;
- idempotent write paths use a deterministic key column with a unique constraint, reusing the `market_events` / `inventory_movements.deduplication_key` mechanism verbatim. `service_periods.generation_key` is this phase's instance.

Projects, services, and billing are ordinary transactional relational data. **No table in this design is a Timescale hypertable.** Time entries look like a time series and are not: a self-hosted operator writes a few thousand a year, they carry foreign keys, they are edited before they are locked, and hypertable partitioning would cost referential integrity for nothing. Utilization and recurring-revenue *snapshots* over time are Reporting work.

### Dates versus instants, inherited from Phase 5

Phase 5 introduced a [deliberate divergence](../financial-schema-design/#two-deliberate-divergences-from-foundation-convention): accounting dates are `date`, not `timestamptz`, because they are calendar dates in a book's frame of reference rather than instants. Phase 6 adopts the same rule wherever a value is a business date rather than a moment: `time_entries.worked_on`, `project_material_uses.consumed_on`, `service_periods.period_start_on` / `period_end_on`, `invoices.issue_on` / `due_on`, `invoice_payments.received_on`, and every `effective_from` / `effective_to`.

Genuine instants keep `timestamptz` with semantic names: `started_at`, `ended_at`, `issued_at`, `locked_at`, `generated_at`, `linked_at`, `created_at`. `time_entries` carries both — an optional instant pair for timer-driven entry and a required `worked_on` date — and the date is the authority. A stopwatch that ran past midnight produced one day's work, not two, and the operator decides which day.

## Counterparties are not economic entities, and the schema must say so physically

This is the load-bearing decision of Phase 6, and every other choice in the document is downstream of it.

[ADR-0017](../../decisions/0017-installation-entities-books-and-access/) states the rule in a section of its own: *"An organization may appear in one installation as an entity whose activity Loxep is operating, and in another installation merely as a customer, vendor, payer, or other counterparty. Do not use the future customer/vendor/party model as a substitute for installation-owned economic entities, and do not assume every organization record represents books owned by this installation."* The [Implementation Contract](../../development/implementation-contract/#economic-entities-counterparties-and-accounting-books), [Domain Boundaries](../domain-boundaries/#customers-and-counterparties) (*"An external organization is not automatically an installation-owned economic entity"*), the [Foundational Data Model](../foundational-data-model/), [cross-domain rule 10](../domain-boundaries/#cross-domain-rules), and [Master Domain Map section 6](../../product/master-domain-map/#6-customers-and-operational-crm) all repeat it.

Repetition in prose has not so far been tested by a schema, because until this phase no counterparty table existed. Phase 6 is where the prohibition either becomes physical or becomes a comment.

### The test

The question is not "is this an organization?" — both concepts are usually organizations. It is:

```text
Does Loxep attribute this party's activity as OURS, and would that
activity land in one of OUR accounting books as our own revenue,
expense, asset, or liability?

   yes  ->  economic_entity      (installation-owned; ADR-0017; Phase 0)
   no   ->  counterparty         (an outside party; Phase 6)
```

Three sharper forms of the same question, for the cases where the first one is not obvious:

1. **Whose side of the transaction is it?** An economic entity is the party Loxep is keeping score *for*. A counterparty is the party on the other side of the table. "Acme LLC" as your own single-member LLC is an entity. "Acme Roofing" who pays you for a website is a counterparty. Both may be called Acme.
2. **Would deleting this record orphan a book?** Economic entities appear in `book_entity_links` and route postings ([Phase 5](../financial-schema-design/#books-and-entities-the-cardinality-that-decides-everything)). Counterparties never appear there and never route anything.
3. **Whose data is it if this installation is shut down?** An economic entity's history is the operator's own business records. A counterparty's history is a record *about someone else* that the operator happens to hold.

The failure this prevents is specific and expensive. An operator who records their own DBA as a customer so that they can invoice it will produce revenue in a book with no matching expense anywhere, an entity-filtered P&L that overstates income by the intercompany amount, and a receivable that can never be collected because it is owed by themselves. That is not a reporting inconvenience; it is a set of books that does not describe reality.

### How the schema enforces it

Four physical rules, all cheap:

- **There is no shared party table and no subtype relationship.** `economic_entities` and `counterparties` are two tables with two lifecycles. There is no `parties` supertype, no `party_kind in ('entity','counterparty')` discriminator, and no view that unions them. The rejected alternative is seductive because both tables carry a name and a kind, and it is wrong because the two records answer different questions and are governed by different documents.
- **`counterparties` has no `economic_entity_id` column, and `economic_entities` gains no `counterparty_id`.** Neither record owns the other. The **only** place the two concepts meet is `counterparty_entity_roles`, whose row reads in exactly one direction: *our entity E has relationship R with outside party C*. There is no row shape that can be read the other way.
- **`counterparties.tax_identifier` is permitted only on organizations**, by `CHECK`. A person's tax number is a payroll artefact, payroll is a permanent non-goal, and the database refuses to hold one. This is the smallest possible expression of the boundary and it is worth having.
- **An installation-owned entity that must appear as a counterparty declares it.** `counterparties.mirrors_economic_entity_id` is a nullable FK to `economic_entities`. It exists for the honest intercompany case — an LLC that genuinely does bill its own sibling DBA for shared services — and its purpose is that the mirror is *visible*. Every profitability and receivable read model can exclude or separately label rows whose counterparty mirrors an entity, and the "revenue that is really intercompany" figure becomes a query instead of a surprise.

The `mirrors_economic_entity_id` column is the one part of this that a reviewer should push on, because it is a door in a wall the documentation built deliberately. The argument for it is that the door exists anyway — an operator who needs to invoice their own DBA will create the counterparty with or without a column — and an undeclared mirror is indistinguishable from a real customer while a declared one is a filter. Listed as an [open question](#open-questions).

## The counterparty record

```text
counterparties
id                            uuid primary key
reference_code                text not null
kind                          text not null
display_name                  text not null
legal_name                    text null
normalized_name               text not null
status                        text not null default 'active'
default_currency              char(3) null
tax_identifier_kind           text null
tax_identifier                text null
notes                         text null
mirrors_economic_entity_id    uuid null references economic_entities(id)
merged_into_counterparty_id   uuid null references counterparties(id)
merged_at                     timestamptz null
merged_by_user_id             text null references user(id) on delete set null
created_by_user_id            text null references user(id) on delete set null
created_at                    timestamptz not null
updated_at                    timestamptz not null
unique(reference_code)
check(kind in ('person','organization'))
check(status in ('active','inactive','archived'))
check(tax_identifier is null or kind = 'organization')
check((tax_identifier is null) = (tax_identifier_kind is null))
check(tax_identifier_kind is null or
      tax_identifier_kind in ('vat','gst','abn','ein','company_number','other'))
check(merged_into_counterparty_id is distinct from id)
check((merged_into_counterparty_id is null) = (merged_at is null))
```

Notes:

- **There is no `is_customer` / `is_vendor` pair and no `kind = 'customer'` member.** Customer and vendor are not properties of a party; they are properties of a *relationship* with one of our entities, and the same party is routinely both. See [Roles](#roles-how-a-counterparty-becomes-a-customer-of-an-entity).
- `kind` is a two-member closed set with a `CHECK` because the distinction is structural: a person has no contacts of their own, an organization does. Everything richer (prospect, supplier, agency, landlord) is a role or a note, not a kind.
- `reference_code` is a short human identifier (`CP-2026-0117`), for the same reason `acquisitions.reference_code`, `inventory_items.item_code`, and `expenses.reference_code` exist: people label things and a UUID is not a label.
- `normalized_name` is case-folded, punctuation-stripped, and suffix-normalized (`Ltd`/`Limited`, `Inc`/`Incorporated`, leading `The`). It is a **matching aid, not an identity** — it carries no unique constraint, because two genuinely different "Smith Plumbing" businesses are a real thing. It is what the duplicate-candidate report groups by.
- `default_currency` is a preference, not a constraint. An invoice's currency is its own column, and a customer normally billed in GBP can receive one USD invoice without a schema change.
- `status = 'inactive'` means "we no longer do business with them"; `archived` means "hide from every picker". Neither deletes anything, and a counterparty is never hard-deleted in normal operation — history points at it.

## Contacts, channels, and sites

Three small tables, deliberately shallow.

```text
counterparty_contacts
id                    uuid primary key
counterparty_id       uuid not null references counterparties(id) on delete cascade
display_name          text not null
role_title            text null
is_primary            boolean not null default false
status                text not null default 'active'
notes                 text null
created_at            timestamptz not null
updated_at            timestamptz not null
unique(counterparty_id) where is_primary
check(status in ('active','inactive'))
```

```text
contact_channels
id                        uuid primary key
counterparty_id           uuid null references counterparties(id) on delete cascade
counterparty_contact_id   uuid null references counterparty_contacts(id) on delete cascade
channel_kind              text not null
value                     text not null
normalized_value          text not null
label                     text null
is_primary                boolean not null default false
verified_at               timestamptz null
opted_out_at              timestamptz null
created_at                timestamptz not null
updated_at                timestamptz not null
check(num_nonnulls(counterparty_id, counterparty_contact_id) = 1)
check(channel_kind in ('email','phone','mobile','fax','website',
                       'marketplace_handle','messaging','other'))
unique nulls not distinct
  (counterparty_id, counterparty_contact_id, channel_kind, normalized_value)
unique nulls not distinct
  (counterparty_id, counterparty_contact_id, channel_kind) where is_primary
```

```text
counterparty_sites
id                    uuid primary key
counterparty_id       uuid not null references counterparties(id) on delete cascade
site_code             text not null
name                  text not null
site_kind             text not null
address_line1         text null
address_line2         text null
locality              text null
region                text null
postal_code           text null
country               char(2) null
latitude              numeric(9,6) null
longitude             numeric(9,6) null
access_notes          text null
primary_contact_id    uuid null references counterparty_contacts(id)
active                boolean not null default true
notes                 text null
created_at            timestamptz not null
updated_at            timestamptz not null
unique(site_code)
check(site_kind in ('billing','shipping','service','remote','other'))
check((latitude is null) = (longitude is null))
```

- **`contact_channels` is one table for every channel kind, not `emails` plus `phones`.** The alternative multiplies tables by three to gain nothing: every channel has the same four questions (what is it, whose is it, is it primary, may we contact it). The `num_nonnulls = 1` check is the same discriminator-consistency pattern `order_fees.fee_scope` established and Phase 4 used three times.
- **A channel belongs to a counterparty *or* a contact, never both.** `billing@acme.example` is the organization's; Jane's mobile is Jane's. Allowing both would make "which email do we send the invoice to" ambiguous in exactly the case that matters.
- `opted_out_at` exists because a communication channel that must not be used is a fact worth storing, and deleting the row loses the fact and invites re-adding it. Nothing in Phase 6 sends email; the column is there so that when something does, the answer is already recorded.
- **`unique nulls not distinct` requires PostgreSQL 15+**, which the `timescale/timescaledb-ha:pg18.4-ts2.29.1-all` target provides. The precedent and the portable fallback are the same as [`channel_listings`](../commerce-schema-design/#channel_listings): a unique expression index over `coalesce(...)`.
- **`counterparty_sites` is where Phase 3's and Phase 4's deferred address model lands, and it is deliberately smaller than they implied.** Both prior designs said "no address normalization before Phase 6" while storing `destination_country` and `destination_region`. Phase 6 owns an address model *for parties and places of work* — free text lines plus the same `country`/`region` pair, so grouping stays consistent with Phase 4 shipping analysis and Phase 5 tax context. It does **not** retroactively normalize buyer shipping addresses out of retained `provider_objects`, and it adds no validation, no postal-service lookup, and no geocoder. `latitude`/`longitude` are operator-entered or absent.
- A site is owned by the counterparty, not by a project, and a project points at it. That resolves a documentation split recorded in [contradictions](#contradictions-and-tensions-found-in-existing-documentation): the roadmap's "Projects/jobs/sites" reads as Projects owning sites, while Domain Boundaries assigns addresses/sites to Customers. The customer's warehouse survives the job.

## Roles: how a counterparty becomes a customer of an entity

The roadmap asks for a counterparty model "distinct from installation-owned economic entities". The sharper question this phase must answer is where *customer-of* and *vendor-of* live, and there are three genuinely different answers.

```text
(a) A COLUMN ON THE PARTY          (b) DERIVED FROM ACTIVITY         (c) A RELATIONSHIP ROW
--------------------------------   -------------------------------   ---------------------------
counterparties.kind = 'customer'   "a customer is a party with an    counterparty_entity_roles
or is_customer / is_vendor flags    invoice attributed to entity E"   (counterparty, entity, role)

one party, one label               no configuration to maintain      one party, many relationships
cannot express both at once        cannot exist before first sale    terms live on the relationship
says nothing about WHICH entity    entity comes free, from the fact  entity is explicit
```

Option (a) fails on the first estate-sale dealer who both sells you pallets and buys a repaired lamp back. It also fails ADR-0017 sideways: a bare `is_customer` flag says a party is a customer *of the installation*, and an installation is not a party to anything — its entities are.

Option (b) is more interesting than it looks, and it fails for two specific reasons. A customer exists before their first transaction: you take a deposit, you set net-30 terms, you agree a rate — all before an invoice exists, and all of it needs somewhere to live. And a *vendor* relationship in this installation may generate no Loxep-owned document at all (Phase 4 keeps `vendor_name` as text on purpose), so a derived vendor set would be empty for exactly the parties Phase 4 was told to expect.

### Recommendation: a relationship row, with the entity nullable

```text
counterparty_entity_roles
id                        uuid primary key
counterparty_id           uuid not null references counterparties(id) on delete cascade
economic_entity_id        uuid null references economic_entities(id)
role                      text not null
status                    text not null default 'active'
since_on                  date null
until_on                  date null
payment_terms_days        integer null
default_currency          char(3) null
tax_treatment             text null
billing_contact_id        uuid null references counterparty_contacts(id)
billing_site_id           uuid null references counterparty_sites(id)
note                      text null
created_by_user_id        text null references user(id) on delete set null
created_at                timestamptz not null
updated_at                timestamptz not null
unique nulls not distinct (counterparty_id, economic_entity_id, role)
check(role in ('customer','vendor','payer','payee','consignor',
               'subcontractor','partner','other'))
check(status in ('active','inactive'))
check(until_on is null or since_on is null or until_on >= since_on)
check(payment_terms_days is null or payment_terms_days >= 0)
```

Why each part:

- **`role` is a Loxep-owned closed set with a `CHECK`.** No provider invents a relationship type, the billing and posting paths branch on `customer`, and an open set here would let a typo (`Customer`) silently create a party nobody can invoice.
- **`economic_entity_id` is nullable**, and this is the part most likely to be argued with. Making it `not null` would be tidier and would break the single most common Phase 6 case: an operator who has not attributed anything yet, whose orders are `unattributed` under Phase 3's ladder, and who nonetheless has customers. A null entity reads as *"this relationship holds for the installation generally"* — the same reading `orders.economic_entity_id is null` already has. `unique nulls not distinct` makes the null a real value for uniqueness so a party cannot hold two installation-wide `customer` rows.
- **Terms live on the relationship, not the party.** Net-30 with the LLC and cash-on-delivery with the personal side is a real arrangement, and putting `payment_terms_days` on `counterparties` would force one of them to be wrong. This is the same reasoning that put `dimension_label` on [`book_entity_links`](../financial-schema-design/#book_entity_links) rather than renaming the entity.
- **The role is not effective-dated the way `book_entity_links` is.** `since_on`/`until_on` are descriptive, and there is no exclusion constraint, because nothing *routes* on a role the way postings route on a book link. A lapsed customer relationship does not need to make historical invoices unexplainable; the invoice already carries its own counterparty and entity.
- `tax_treatment` is nullable free text with a TypeScript union and no `CHECK` (`standard`, `exempt`, `reverse_charge`, `zero_rated`, `out_of_scope`). It records what the operator was told; it calculates nothing. Phase 5's rule holds unchanged: providers calculate, Loxep records.

**A counterparty with no role rows is valid and useful.** A party you have only ever noted down is a party; the role is what makes them billable.

## Identity, matching, and merge

Phase 3 promised that `orders.buyer_external_id` would gain a nullable `counterparty_id` "backfilled by matching". Phase 4 and Phase 5 made the same promise for `vendor_name` and `payee_name`. Matching needs somewhere to keep its evidence, and merges need a posture.

```text
counterparty_identifiers
id                    uuid primary key
counterparty_id       uuid not null references counterparties(id) on delete cascade
identifier_kind       text not null
provider              text null
value                 text not null
normalized_value      text not null
confidence            text not null default 'confirmed'
evidence_note         text null
first_seen_at         timestamptz not null
created_by_user_id    text null references user(id) on delete set null
created_at            timestamptz not null
check(identifier_kind in ('marketplace_buyer','marketplace_seller','vendor_name',
                          'email','external_client','website','other'))
check(confidence in ('confirmed','candidate'))
unique nulls not distinct (identifier_kind, provider, normalized_value)
  where confidence = 'confirmed'
```

- **The partial unique on confirmed identifiers is what makes matching deterministic.** One eBay username maps to at most one counterparty installation-wide, so backfilling `orders.counterparty_id` is a lookup rather than a judgement, and a second party claiming the same handle fails loudly at the point a human made the mistake.
- `candidate` rows are the machine's guesses and carry no uniqueness. Promotion to `confirmed` is an operator action that writes `audit_events`.
- `identifier_kind = 'external_client'` with `provider = 'invoiceninja'` is *not* how the Invoice Ninja link is stored — that is `external_resources`, and putting it here too would create two answers to one question. The member exists for providers that expose a customer number with no resource URL to link to.

### Merge: a survivor pointer, never a rewrite

```text
counterparties.merged_into_counterparty_id  ->  the survivor
```

**Recommendation: mark the loser, never delete it, and never rewrite the foreign keys on history.**

Every read model resolves through the pointer (`coalesce(merged_into_counterparty_id, id)`) and excludes merged rows from pickers. The alternative — reassign `orders.counterparty_id`, `invoices.counterparty_id`, `projects.counterparty_id`, and every other reference to the survivor and delete the loser — is what most systems do, and it is wrong here for three reasons that compound:

1. **It destroys the evidence of what was matched.** After the rewrite, nothing records that these two records were ever separate, which is precisely the information you need when the merge turns out to have been wrong.
2. **An unmerge becomes impossible.** With a pointer, unmerge is clearing one column. With a rewrite, it is reconstructing which of four hundred rows used to point where.
3. **It is the precedent already set twice.** Phase 3 marks a cross-connection duplicate with [`orders.duplicate_of_order_id`](../commerce-schema-design/#the-multi-connection-duplication-problem-and-why-it-is-not-solved-by-the-key) and excludes it in reporting rather than deleting the row; Phase 5 corrects a ledger by [reversing, never mutating](../financial-schema-design/#re-post-on-fact-change-reversal-and-re-post-never-mutation). The rule in both cases is that evidence is never destroyed to make a report tidier.

The cost is real and should be stated: every counterparty read path has to resolve the pointer, and a path that forgets to will under-count. The mitigations are that the resolution belongs in one function in the owning package, that merged rows are excluded from every picker so new references cannot accumulate on a loser, and that a named report — "references pointing at a merged counterparty" — makes a forgotten path visible.

**Merges are never automatic.** Matching produces a duplicate-candidate read model grouped by `normalized_name`, shared confirmed identifiers, and shared normalized channel values. A human merges. This is the same posture Phase 5 took for [reconciliation](../financial-schema-design/#reconciliation-foundation) — ship the state, not the matcher — and for the same reason: an automatic merge of two customers is far more expensive to undo than an unmatched pair is to leave sitting in a queue.

## Projects, jobs, and sites

```text
projects
id                            uuid primary key
reference_code                text not null
parent_project_id             uuid null references projects(id)
counterparty_id               uuid null references counterparties(id)
counterparty_site_id          uuid null references counterparty_sites(id)
economic_entity_id            uuid null references economic_entities(id)
entity_attribution_source     text not null
entity_attributed_at          timestamptz null
entity_attributed_by_user_id  text null references user(id) on delete set null
name                          text not null
description                   text null
project_kind                  text not null
status                        text not null default 'lead'
billing_method                text not null
currency                      char(3) not null
estimate_amount               numeric(20,6) null
budget_amount                 numeric(20,6) null
fixed_price_amount            numeric(20,6) null
not_to_exceed_amount          numeric(20,6) null
depth                         integer not null default 0
starts_on                     date null
target_end_on                 date null
completed_on                  date null
closed_at                     timestamptz null
created_by_user_id            text null references user(id) on delete set null
created_at                    timestamptz not null
updated_at                    timestamptz not null
unique(reference_code)
check(parent_project_id is distinct from id)
check(depth between 0 and 1)
check(entity_attribution_source in
      ('manual','counterparty_role_default','installation_default','unattributed'))
check(billing_method in ('time_and_materials','fixed_price','milestone',
                         'subscription','non_billable','internal'))
check((billing_method = 'fixed_price') = (fixed_price_amount is not null))
check(billing_method <> 'internal' or counterparty_id is null)
check(billing_method in ('internal','non_billable') or counterparty_id is not null)
check(target_end_on is null or starts_on is null or target_end_on >= starts_on)
```

### Hierarchy-lite means two levels and no path cache

`depth between 0 and 1`. A project may have child jobs; a child job may not have children. This is a modeling claim, not a guardrail, and it differs from Phase 4's [six-level location tree with a `path` cache](../inventory-schema-design/#locations) on purpose:

- the useful shape is *engagement → job* (a client relationship with three site visits under it, a retainer with quarterly deliverables), and every level past that is a task, which Phase 6 does not own;
- with a maximum depth of one, "everything under this project" is `where parent_project_id = $1 or id = $1`. A `path` column would be a cache with nothing to cache, and a cache that can drift for no benefit is worse than a join;
- a deeper tree invites work breakdown structures, and a WBS is a planning subsystem this phase has declared out of scope.

`depth` is stored anyway — a single integer maintained on insert and re-parent — so the constraint is expressible at all. Cycles are impossible at depth 1 given the self-reference check, which is the second reason not to allow depth 6: Phase 4 needed [a service-level recursive walk](../inventory-schema-design/#locations) to prevent cycles and Phase 6 does not.

### Status is open, billing method is closed

`status` (`lead | quoted | approved | active | on_hold | completed | cancelled | closed`) is a TypeScript union with **no** `CHECK`. It is a workflow label that will grow with real practice, and nothing branches on unknown members — the identical treatment `acquisitions.status` gets.

`billing_method` **does** get a `CHECK`, because the billing engine branches on it: a `time_and_materials` project bills its unbilled time entries and material uses, a `fixed_price` project bills its `fixed_price_amount` on a schedule the operator chooses, a `subscription` project bills nothing itself (its subscription does), and `non_billable` and `internal` bill nothing at all. An unknown member here is not a cosmetic gap; it is a project whose money nobody can compute. Same rule as `acquisitions.cost_allocation_status`.

The three consistency checks are worth reading together: a fixed-price project must name its price, an internal project may not name a customer, and a billable project must. That last one is the one that prevents the most common data error in service businesses — a job that accumulates forty hours and has nobody to send them to.

**`not_to_exceed_amount` is recorded and enforced nowhere.** It is what the operator told the client, and surfacing "this T&M job has passed its NTE" is a read model. A constraint that refused the forty-first hour would fail a time entry over a commercial conversation, which is the same category of mistake as Phase 4 refusing an oversell.

### Entity attribution on a project

The [Master Domain Map](../../product/master-domain-map/#7-projects-jobs-service-work-and-subscriptions) asks for "economic-entity attribution for the party providing the service", which is exactly the Phase 3/Phase 4/Phase 5 pattern applied to work rather than goods. The ladder gains one rung the earlier phases did not have:

```text
1. explicit value chosen by the operator            'manual'
2. the customer relationship's entity, from
   counterparty_entity_roles where role='customer'  'counterparty_role_default'
3. the installation's default entity setting        'installation_default'
4. no attribution available                         'unattributed'
```

Rung 2 earns its place because it is the only rung that is usually right without being asked. A counterparty who is a customer of the LLC produces projects belonging to the LLC; that is what the relationship row *means*. Where the party has customer relationships with two entities, rung 2 does not fire and the operator chooses — a deterministic no-answer, not a coin flip.

**Attribution is immutable once the project has an issued invoice**, and freely editable (audited) before. This is the middle position between Phase 3's write-once rule for orders and Phase 4's transfer-only rule for stock, and it fits what a project is: an in-flight thing until money changes hands, a historical fact afterwards. Moving a project between entities after billing is not an `UPDATE`; it is a new project with a link to the old one, for the same reason Phase 4 makes an entity change of stock [a paired transfer](../inventory-schema-design/#entity-attribution-on-an-item-is-immutable-a-change-of-owner-is-a-transfer-not-an-update).

## Time entries and billable work

```text
time_entries
id                            uuid primary key
project_id                    uuid null references projects(id)
counterparty_id               uuid null references counterparties(id)
economic_entity_id            uuid null references economic_entities(id)
worked_by_user_id             text null references user(id) on delete set null
worked_by_counterparty_id     uuid null references counterparties(id)
worked_by_label               text not null
activity_code                 text null
description                   text null
worked_on                     date not null
started_at                    timestamptz null
ended_at                      timestamptz null
minutes                       integer not null
billable                      boolean not null default true
billable_minutes              integer not null default 0
currency                      char(3) null
bill_rate_amount              numeric(20,6) null
bill_rate_source              text not null default 'unresolved'
cost_rate_amount              numeric(20,6) null
cost_rate_source              text not null default 'unresolved'
billing_rate_id               uuid null references billing_rates(id)
approved_at                   timestamptz null
approved_by_user_id           text null references user(id) on delete set null
locked_at                     timestamptz null
created_by_user_id            text null references user(id) on delete set null
created_at                    timestamptz not null
updated_at                    timestamptz not null
check(minutes > 0)
check(billable_minutes >= 0)
check(billable or billable_minutes = 0)
check(billable = false or num_nonnulls(project_id, counterparty_id) >= 1)
check(num_nonnulls(worked_by_user_id, worked_by_counterparty_id) <= 1)
check(ended_at is null or started_at is null or ended_at >= started_at)
check((started_at is null) = (ended_at is null))
check(bill_rate_source in ('manual','project_person','project','counterparty',
                           'person','activity','installation','unresolved'))
check(cost_rate_source in ('manual','project_person','project','counterparty',
                           'person','activity','installation','unresolved'))
check((bill_rate_amount is null) = (bill_rate_source = 'unresolved'))
check((cost_rate_amount is null) = (cost_rate_source = 'unresolved'))
check((currency is null) = (bill_rate_amount is null and cost_rate_amount is null))
```

### Who worked, and why a nullable FK is not enough

[ADR-0020](../../decisions/0020-better-auth-schema-ownership/) permits two forms of user reference: a nullable FK with `ON DELETE SET NULL`, or an intentional non-FK historical identity reference where "the original identifier itself is the historical fact and must survive user deletion verbatim". Every prior phase used only the first form, because a null `created_by_user_id` on an order degrades provenance and nothing more.

A time entry is different. **Who did the work is not provenance; it is part of the billable fact.** An invoice line that reads "12.5 hours, senior engineering" was justified by named people doing named work, and a customer query six months later asks who. If the only record is a FK that went null when someone left, the answer is gone and the invoice is unexplainable.

So `time_entries` carries **both**:

- `worked_by_user_id` — nullable FK, `ON DELETE SET NULL`, per ADR-0020 form 1. It is what joins to a live user for filtering, "my timesheet", and utilization;
- `worked_by_label text not null` — a snapshot of the worker's display name at entry time, per ADR-0020 form 2. It never changes and never nulls.

This is the same denormalized-text-plus-opportunistic-id shape as `acquisitions.vendor_name`, `orders.buyer_display_name`, and `expenses.payee_name`, applied to a user instead of an external party, and it is the first place in the schema where ADR-0020's second form is used in a domain table rather than an audit payload. It is also what makes the third case work: **a subcontractor is not a user.** `worked_by_counterparty_id` covers hours worked by an outside party with a `subcontractor` role, and the `num_nonnulls(...) <= 1` check keeps the two references from disagreeing while allowing both to be null for a label-only entry ("Dave, 3 hours" typed from a paper note).

### Duration: minutes are the authority, instants are optional evidence

`minutes integer not null` is the value everything computes from. `started_at`/`ended_at` are a nullable, all-or-nothing pair for timer-driven entry.

The alternative — instants as the authority with duration derived — was rejected because it forces a fiction. Most entries in a small service business are typed after the fact ("two hours on the Wednesday site visit"), and a start/end-only model makes the operator invent 09:00–11:00 to record a true fact about duration. Storing the fiction and computing from it is worse than storing the truth. Where a timer *did* run, both are stored and the read model can show the window; nothing recomputes `minutes` from the instants, so a stopwatch left running over lunch is corrected by editing one number.

There is deliberately **no `CHECK` tying `minutes` to the instant pair.** A timer that ran 09:00–11:15 for two billable-hours-of-actual-work is an ordinary correction, and a constraint would reject it.

**`billable_minutes` is separate from `minutes`, and this is not redundancy.** Actual time worked and time charged routinely differ: rounding to a 15-minute increment, a courtesy write-down, a fixed-price job where hours are tracked for costing and billed at zero. Collapsing them loses the one number a service business most needs to see — the gap between what was done and what was charged — and produces utilization figures that quietly launder every write-down. The default is that `billable_minutes` is set to `minutes` rounded per the installation's increment setting at save time; the operator may then reduce it.

### Freezing, approval, and correction

`locked_at` is set the moment the entry is attached to an issued invoice line, and a locked entry is immutable. This is [Phase 4's `cost_basis_locked_at`](../inventory-schema-design/#cost-basis-freezes-at-first-depletion) rule applied to labour, for the identical reason: the number has been reported to someone outside the business, and rewriting it retroactively changes an invoice that has already been read. A locked entry is corrected by a credit note plus a new entry, never by an edit.

`approved_at` is one nullable stamp and one nullable user, not a workflow. A single-operator installation never sets it; a two-person installation uses it as a filter. There is no approval chain, no rejection state, and no lock period, because a workflow engine for a two-person business is a cost with no payer.

## Rate resolution

```text
billing_rates
id                        uuid primary key
scope_kind                text not null
project_id                uuid null references projects(id)
counterparty_id           uuid null references counterparties(id)
subject_user_id           text null references user(id) on delete set null
subject_counterparty_id   uuid null references counterparties(id)
activity_code             text null
economic_entity_id        uuid null references economic_entities(id)
rate_kind                 text not null
currency                  char(3) not null
amount                    numeric(20,6) not null
unit                      text not null default 'hour'
effective_from            date not null
effective_to              date null
note                      text null
created_by_user_id        text null references user(id) on delete set null
created_at                timestamptz not null
updated_at                timestamptz not null
check(rate_kind in ('bill','cost'))
check(unit in ('hour','day','fixed'))
check(amount >= 0)
check(scope_kind in ('project_person','project','counterparty',
                     'person','activity','installation'))
check((scope_kind in ('project_person','project')) = (project_id is not null))
check((scope_kind = 'counterparty') = (counterparty_id is not null))
check((scope_kind in ('project_person','person')) =
      (num_nonnulls(subject_user_id, subject_counterparty_id) = 1))
check((scope_kind = 'activity') = (activity_code is not null))
check(effective_to is null or effective_to >= effective_from)
```

The `scope_kind` discriminator plus per-scope consistency checks is the `order_fees.fee_scope` pattern for the fifth time across four phases. It is the right shape whenever a set of nullable references must agree with a kind column, and using it here means an invalid rate row cannot be inserted rather than being caught by a service that someone will forget to call.

### The resolution order

Resolved at the moment a time entry is saved, then **stored on the entry**, never joined at read time:

```text
0. time_entries.bill_rate_amount set explicitly by the operator   'manual'
1. billing_rates scope_kind = 'project_person'   (this project, this worker)
2. billing_rates scope_kind = 'project'          (this project, anyone)
3. billing_rates scope_kind = 'counterparty'     (this client, anyone)
4. billing_rates scope_kind = 'person'           (this worker, anywhere)
5. billing_rates scope_kind = 'activity'         (this activity code, anywhere)
6. billing_rates scope_kind = 'installation'     (the shop rate)
7. nothing matched                               'unresolved'
```

Within a level, the row whose `[effective_from, effective_to]` range contains `worked_on` wins; where two rows at the same level both cover the date, the later `effective_from` wins and the overlap is a reconciliation finding rather than an error. This is deliberately the same **first-match-wins by declared precedence** model as [`market_events` opportunity rules](../foundational-data-model/#detected-market-events) and [Phase 5 posting rules](../financial-schema-design/#declarative-posting-rules), and it deliberately has no overlap-prevention constraint, because an exclusion constraint over a six-shape nullable tuple is both hard to write and easy to get wrong for a problem a report solves.

Two rules make the ladder trustworthy:

- **`unresolved` is a real state and never becomes zero.** A billable entry with no rate is a visible backlog — "billable work with no rate" is a named read model — exactly as an unattributed order and an unpostable fact are. Defaulting to zero would produce an invoice that silently omits work, which is the worst possible failure of a billing system. Operational facts before accounting, one layer up.
- **The rate is frozen on the entry, with its source.** `bill_rate_source` records which rung fired, so "why is this hour $95" is answerable without replaying configuration that has since changed. This is the same argument that made [entity attribution a stored column](../commerce-schema-design/#attribution-is-a-stored-column-on-orders-not-a-join) rather than a join, that snapshots `acquisition_opportunity_links.score_at_link`, and that freezes `journal_lines.fx_rate`. Three phases, three mutable inputs, one conclusion. Raising the shop rate in July must not rewrite what June's hours were worth.

### Cost rates are the same table with `rate_kind = 'cost'`

Project profitability needs what an hour *cost*, not only what it billed, and the two resolve through the identical ladder against separate rows. Keeping them in one table with a two-member discriminator rather than two tables is worth it because every scope, effective-dating, and precedence rule is shared, and the alternative is maintaining the same ladder twice.

**A cost rate is not a wage.** It is an internal figure an operator sets to make margin meaningful — often loaded to include overhead. Payroll remains a permanent non-goal, and nothing in Phase 6 computes what anyone is owed.

## Materials consumed on jobs

Phase 4 left two hooks and no way to use them: `inventory_movements.movement_kind = 'consumption'` is documented as "used internally or by a project (a cheap Phase 6 hook)", and `inventory_allocations.allocation_kind = 'project'` exists with no project column to point at. Phase 6 has to connect them without breaking the append-only movement ledger and without altering a Phase 4 table.

```text
project_material_uses
id                        uuid primary key
project_id                uuid not null references projects(id)
inventory_item_id         uuid null references inventory_items(id)
catalog_item_id           uuid null references catalog_items(id)
inventory_allocation_id   uuid null references inventory_allocations(id)
inventory_movement_id     uuid null references inventory_movements(id)
description               text not null
quantity                  numeric(20,6) not null
consumed_on               date not null
currency                  char(3) not null
unit_cost_amount          numeric(20,6) not null default 0
cost_basis_source         text not null
billable                  boolean not null default true
markup_percent            numeric(10,4) null
unit_charge_amount        numeric(20,6) null
locked_at                 timestamptz null
created_by_user_id        text null references user(id) on delete set null
created_at                timestamptz not null
updated_at                timestamptz not null
check(quantity > 0)
check(cost_basis_source in ('inventory_basis','manual','purchased_for_job','none'))
check((cost_basis_source = 'inventory_basis') = (inventory_item_id is not null))
check(billable or unit_charge_amount is null)
check(markup_percent is null or markup_percent >= -100)
unique(inventory_movement_id) where inventory_movement_id is not null
```

### The link points inward, and Phase 4 gains no columns

The tempting alternative is `inventory_movements.project_id` plus `inventory_allocations.project_id`. Both are rejected:

1. **Movements are append-only and immutable** ([Phase 4's rule](../inventory-schema-design/#append-only-means-append-only), enforced by a trigger). A material use has attributes that are legitimately edited right up until it is billed — `billable`, `markup_percent`, `unit_charge_amount`, the description that will appear on the invoice. Putting them on a row that cannot be updated is not a trade-off; it is a contradiction.
2. **The movement is a physical fact; the use is a commercial one.** Stock left the shelf either way. Whether it was for a job, for whom, at what markup, and whether the customer pays for it are Projects questions about an Inventory fact. This is exactly the direction rule Phase 4 applied when it refused to put "we bought because of this" on `marketplace_items` and pointed [`acquisition_opportunity_links`](../inventory-schema-design/#opportunity-to-outcome-linkage) inward instead.
3. **It keeps the phase's alteration budget honest.** Phase 6 already has to alter `orders` and `expenses`; adding two more columns to a design that has not shipped is how a phase's blast radius grows without anyone deciding it should.

`unique(inventory_movement_id) where not null` is the idempotency probe: a consumption movement backs at most one material use, so a retried job cannot double-charge a customer for one physical item.

### Cost is snapshotted at consumption

`unit_cost_amount` is copied from `inventory_items.landed_cost_amount` at the moment of use, and `cost_basis_source = 'inventory_basis'` records where it came from. It is not a read-time join.

This is the third instance of the same rule and it matters most here. Phase 4 [freezes cost basis at first depletion](../inventory-schema-design/#cost-basis-freezes-at-first-depletion) precisely so a later lot re-allocation cannot rewrite a reported margin — but a project's margin is reported to a *customer*, on an invoice, and a job costed in March must not change because a lot was finalized in April. Snapshotting also makes the other three `cost_basis_source` values expressible without special cases: `manual` for stock never tracked in inventory, `purchased_for_job` for something bought and consumed the same day (whose cost is a Phase 5 `expenses` row attributed to the project rather than an inventory item), and `none` for a free part.

`markup_percent` and `unit_charge_amount` are two columns because both practices are real: a shop that bills cost plus 20% and a shop with a fixed price list. When both are set, `unit_charge_amount` wins and `markup_percent` is documentation of how it was derived.

### What Phase 6 does not do to inventory

Phase 6 does not write `inventory_movements` rows itself. Consuming stock on a job calls the Phase 4 inventory service, which writes the `consumption` movement with its own deterministic deduplication key, in the same transaction as the `project_material_uses` insert. Cross-domain rule 1 holds: Projects references Inventory's stable ids and does not mutate Inventory's canonical tables.

## Expenses attributed to projects

Phase 5 was explicit about this seam. [`expense_allocations`](../financial-schema-design/#expenses-and-receipts) "ships only the targets that exist. Entity, ledger account, dimension value, acquisition, catalog item, and channel all have real referents today. Customer, project, shipment, and service do not — Domain Boundaries lists them, and Phase 6 adds them as additive nullable columns. A column pointing at a table that does not exist is worse than no column." Phase 5's own relationship overview records the expected shape as `Phase 6: expenses --> project_id, counterparty_id (additive columns)`.

Phase 6 adds exactly what was promised, and nothing else:

```text
expenses            + project_id             uuid null references projects(id)
                    + payee_counterparty_id  uuid null references counterparties(id)
                    + client_billable        boolean not null default false

expense_allocations + project_id             uuid null references projects(id)
                    + counterparty_id        uuid null references counterparties(id)
                    + subscription_id        uuid null references subscriptions(id)
```

- **`expenses.project_id` and `expense_allocations.project_id` both exist, and that is not duplication.** The header column is the common case — one receipt, one job — and is what the expense-entry UI sets. The allocation column is for the receipt that spans two jobs, which is the entire reason `expense_allocations` exists. The invariant is the one Phase 5 already stated for amounts: allocations refine the header, and a disagreement is a reconciliation finding rather than a constraint. An expense with a header project and no allocations is fully attributed to that project.
- **`payee_counterparty_id` sits alongside `payee_name`, which stays.** Phase 5 said the backfill would be "the identical treatment Phase 3 gave `buyer_external_id` and Phase 4 gave `vendor_name`", and in both of those the text column is retained as the matching evidence. Deleting `payee_name` after a backfill would destroy the input to re-matching.
- **`client_billable` is a third column Phase 5 did not name, and it needs its own justification.** Phase 5 already has `reimbursable boolean`, which means "someone owes this back to the person who paid" — an employee-expense concept with no consumer in a phase that has no employees. `client_billable` means something different: this cost is rebilled to the customer on their invoice. A travel charge can be one, the other, both, or neither. Collapsing them would make "expenses to rebill" and "expenses to reimburse" the same query, and they are different piles of money. See [contradictions](#contradictions-and-tensions-found-in-existing-documentation) on `reimbursable`'s still-absent consumer.
- **`expense_allocations.subscription_id`, not `service_id`.** Phase 5's prose says "service"; the physical thing a cost attaches to is one customer's subscription (the hosting account whose server this bill pays for), not the plan definition. A cost against a *plan* would be an overhead allocation, which is a Reporting judgement, not a stored attribution.

Nothing else on Phase 5's tables changes. In particular there is **no `expenses.invoice_line_id`**: the fact that an expense has been rebilled lives in `invoice_line_sources` with everything else, so there is exactly one place to ask "has this been billed".

## Service plans, subscriptions, and service periods

### `service_plans`

```text
service_plans
id                    uuid primary key
code                  text not null
name                  text not null
plan_kind             text not null
catalog_item_id       uuid null references catalog_items(id)
economic_entity_id    uuid null references economic_entities(id)
currency              char(3) not null
default_amount        numeric(20,6) not null default 0
default_cadence       text not null
default_term_months   integer null
billing_timing        text not null default 'advance'
description           text null
status                text not null default 'active'
created_by_user_id    text null references user(id) on delete set null
created_at            timestamptz not null
updated_at            timestamptz not null
unique(code)
check(default_cadence in ('weekly','monthly','quarterly','semiannual','annual','one_time'))
check(billing_timing in ('advance','arrears'))
check(status in ('draft','active','retired'))
```

`plan_kind` (`hosting`, `maintenance`, `support`, `retainer`, `license`, `monitoring`, `other`) is a TypeScript union with **no** `CHECK` — it is a classification that will grow with the operator's real service lines and nothing branches on unknown members.

**A service plan is not a `catalog_items` row, and the reason is concrete rather than philosophical.** [Domain Boundaries](../domain-boundaries/#catalog-and-listings) gives Catalog "products/services", which reads like an invitation to add `catalog_items.kind = 'service'`. The implemented Phase 3 migration constrains that column: `check(kind in ('simple','variant_group','variant'))`. Adding a service member means widening a `CHECK` on a table that already holds data, in a phase that has no other reason to touch Catalog, to gain a shared identity that nothing needs — a service plan has a cadence, a term, and a billing timing, and a catalog item has a SKU, a variant parent, and channel listings, and neither set is meaningful for the other.

So `service_plans.catalog_item_id` is a **nullable, opportunistic link**, present only where a service genuinely also needs a SKU (it appears on invoices generated from a product list, or it is sold through a store). This is the same relationship shape as [`channel_listings.marketplace_item_id`](../commerce-schema-design/#channel_listings-versus-marketplace_items--two-different-concepts): two real concepts that sometimes point at each other, not one concept wearing two tables. Recorded in [contradictions](#contradictions-and-tensions-found-in-existing-documentation).

### `subscriptions` and `subscription_items`

```text
subscriptions
id                            uuid primary key
reference_code                text not null
service_plan_id               uuid null references service_plans(id)
counterparty_id               uuid not null references counterparties(id)
counterparty_site_id          uuid null references counterparty_sites(id)
project_id                    uuid null references projects(id)
economic_entity_id            uuid null references economic_entities(id)
entity_attribution_source     text not null
entity_attributed_at          timestamptz null
entity_attributed_by_user_id  text null references user(id) on delete set null
name                          text not null
status                        text not null default 'draft'
currency                      char(3) not null
cadence                       text not null
billing_timing                text not null
billing_anchor_day            integer null
started_on                    date not null
ends_on                       date null
paused_from                   date null
paused_until                  date null
cancelled_on                  date null
cancellation_reason           text null
auto_renew                    boolean not null default true
generation_horizon_days       integer not null default 60
last_generated_period_end_on  date null
notes                         text null
created_by_user_id            text null references user(id) on delete set null
created_at                    timestamptz not null
updated_at                    timestamptz not null
unique(reference_code)
check(status in ('draft','active','paused','cancelled','expired'))
check(cadence in ('weekly','monthly','quarterly','semiannual','annual','one_time'))
check(billing_timing in ('advance','arrears'))
check(billing_anchor_day is null or billing_anchor_day between 1 and 31)
check(ends_on is null or ends_on >= started_on)
check((paused_from is null) or (paused_until is null) or (paused_until >= paused_from))
check(entity_attribution_source in
      ('manual','plan_default','counterparty_role_default','installation_default','unattributed'))
check(generation_horizon_days between 0 and 400)
```

```text
subscription_items
id                    uuid primary key
subscription_id       uuid not null references subscriptions(id) on delete cascade
line_number           integer not null
service_plan_id       uuid null references service_plans(id)
catalog_item_id       uuid null references catalog_items(id)
description           text not null
quantity              numeric(20,6) not null default 1
unit_amount           numeric(20,6) not null
currency              char(3) not null
charge_model          text not null default 'flat'
effective_from        date not null
effective_to          date null
created_at            timestamptz not null
updated_at            timestamptz not null
unique(subscription_id, line_number)
check(quantity > 0)
check(charge_model in ('flat','per_unit','usage_manual'))
check(effective_to is null or effective_to >= effective_from)
```

- `service_plan_id` on the subscription is **nullable**, because a bespoke retainer with no reusable plan is normal in a small service business, and forcing a one-off plan record for every one of them is how a plan catalogue becomes junk. The same instinct that keeps `inventory_items.catalog_item_id` nullable.
- `billing_anchor_day` up to 31 is deliberate, with the normalization rule stated in code rather than the schema: a period anchored on the 31st ends on the last day of a short month. A `CHECK` limiting it to 28 would refuse a contract someone actually signed.
- **`paused_from`/`paused_until` are a range, not a status alone**, because a pause has to be expressible in advance ("suspended for July") and has to leave a *hole in the period series* that is visible rather than a gap that looks like a generation bug.
- `charge_model = 'usage_manual'` means the operator types the usage figure each period. There is no metering, no rating engine, and no usage event table. When something genuinely meters (bandwidth, seats pulled from an API), it writes a `service_period_charges` row through a domain service, and that is the extension point.

### `service_periods`: generated, not invoiced

This is the section the phase is really about.

```text
service_periods
id                        uuid primary key
subscription_id           uuid not null references subscriptions(id)
counterparty_id           uuid not null references counterparties(id)
economic_entity_id        uuid null references economic_entities(id)
sequence                  integer not null
period_start_on           date not null
period_end_on             date not null
status                    text not null default 'scheduled'
billing_status            text not null default 'not_billable'
currency                  char(3) not null
recurring_amount          numeric(20,6) not null default 0
proration_factor          numeric(10,6) not null default 1
billable_on               date null
delivered_at              timestamptz null
waived_reason             text null
generation_key            text not null
generated_at              timestamptz not null
created_at                timestamptz not null
updated_at                timestamptz not null
unique(subscription_id, sequence)
unique(subscription_id, period_start_on)
unique(generation_key)
check(period_end_on >= period_start_on)
check(status in ('scheduled','open','delivered','waived','cancelled'))
check(billing_status in ('not_billable','billable','invoiced','written_off'))
check(proration_factor > 0 and proration_factor <= 1)
check(status <> 'waived' or (recurring_amount = 0 and waived_reason is not null))
exclude using gist (
  subscription_id with =,
  daterange(period_start_on, period_end_on, '[]') with &&
)
```

```text
service_period_charges
id                    uuid primary key
service_period_id     uuid not null references service_periods(id) on delete cascade
subscription_item_id  uuid null references subscription_items(id)
line_number           integer not null
charge_kind           text not null
description           text not null
quantity              numeric(20,6) not null default 1
unit_amount           numeric(20,6) not null
currency              char(3) not null
amount                numeric(20,6) not null
recorded_by_user_id   text null references user(id) on delete set null
created_at            timestamptz not null
updated_at            timestamptz not null
unique(service_period_id, line_number)
check(charge_kind in ('recurring','usage','one_time','proration','credit'))
check(amount <> 0)
```

#### Two status columns, on purpose

`status` is the **obligation**: was this month of service scheduled, live, delivered, waived, or cancelled. `billing_status` is the **money**: is it not yet chargeable, chargeable, on an invoice, or written off. They are two columns because they move independently and because collapsing them is the mistake this whole section exists to prevent.

```text
status      scheduled -> open -> delivered
                            \-> waived      (a paused month; amount 0, reason required)
                            \-> cancelled   (the subscription ended mid-period)

billing_status  not_billable -> billable -> invoiced
                                     \-> written_off
```

A period can be `delivered` and `not_billable` (a goodwill month), `open` and `billable` (billed in advance, service still running), or `delivered` and never invoiced at all — which is a finding, and a report, and the reason the two columns exist.

#### Generation is a scheduled job, and it is never a side effect of invoicing

Periods are generated forward to `generation_horizon_days` by a maintenance job, the way [Phase 5 generates fiscal periods](../financial-schema-design/#fiscal-periods-and-closing-semantics) — *"generated, never auto-created on demand"*. Four arguments, and they are the load-bearing ones for this phase:

1. **A period is a fact about time passing, not about a document.** March happened. The customer's server ran. That is true whether or not anyone got around to invoicing, and a data model in which March only exists once someone bills it cannot answer "what did we deliver last quarter".
2. **Generating on invoice creation makes unbilled revenue invisible.** The most valuable single number a service business has is "what have we delivered and not charged for", and it is computable only if the delivered thing exists as a row. Under the alternative, the query returns nothing and the money is simply forgotten.
3. **Suspension and proration become expressible.** A paused month is a `waived` row with amount zero and a reason, sitting in the series where the gap is visible. A mid-month start is a row with `proration_factor < 1`. Under generate-on-invoice, both are absences, and an absence cannot be distinguished from a bug.
4. **MRR becomes a `sum()` over facts rather than a projection over configuration.** Recurring revenue computed by walking subscription rows and simulating a calendar is a forecast dressed as a report, and it silently disagrees with what was actually billed. Computed over `service_periods`, it agrees by construction.

The rule to state flatly, because it is the one an implementer will break: **no code path outside the generation job may insert a `service_periods` row.** Invoicing consumes periods; it never creates them.

#### Idempotency and the overlap invariant

```text
generation_key = 'sp:' || subscription_id || ':' || period_start_on
```

`unique(generation_key)` is the retry probe — the `inventory_movements.deduplication_key` mechanism verbatim, because the generation job is at-least-once like every other Graphile Worker job.

The `EXCLUDE USING gist` constraint is the invariant that makes double-billing a month structurally impossible: **no subscription has two overlapping periods, ever.** It needs the `btree_gist` extension for the `uuid with =` operand — the same extension [Phase 5 already requires](../financial-schema-design/#book_entity_links) for `book_entity_links` and `fiscal_periods`, so if Phase 5 has shipped there is nothing new to install. If the extension is unavailable, the fallback is `unique(subscription_id, period_start_on)` (which is present anyway) plus a service-level overlap check, accepting a weaker invariant that cannot catch a period whose *end* was extended.

#### What is not modeled

**No deferred revenue and no recognition schedule.** A period billed in advance is revenue Phase 6 posts at invoice issue, not spread across the days of service. Recognizing over the period requires a policy (daily? monthly? at delivery?), a deferred-revenue account, and reversing entries, and inventing that policy would be complete and wrong. The periods now exist, so the capability is additive when someone needs it — which is precisely why generating them matters. Listed as an [open question](#open-questions).

## Quotes, invoices, and receivables: what Loxep owns

The roadmap asks for a "Quotes/invoices/AR model **where owning those capabilities provides value**". [Companion Services](../../product/companion-services/#invoice-ninja) is more specific: *"Loxep can own customers, projects, subscriptions, billable facts, and eventually accounting while Invoice Ninja provides mature invoice delivery, recurring billing, PDFs, payment links, reminders, and customer-facing workflows until replacing those capabilities is justified."* The [guiding rule](../../product/companion-services/#guiding-rule) is: *"Integrate mature specialist capability before rebuilding it, but keep Loxep's own domain model authoritative where the data is central to its long-term purpose."*

Those three statements do not automatically agree, because [Master Domain Map section 8](../../product/master-domain-map/#8-billing-and-accounts-receivable) lists AR aging, reminders, PDFs, email delivery, and payment links under Billing DESIGN-FOR — the same capabilities the companion doc assigns to Invoice Ninja. That conflict is [recorded below](#contradictions-and-tensions-found-in-existing-documentation) rather than smoothed over, and this section takes the companion doc's side and argues it.

### The line

```text
LOXEP OWNS                              INVOICE NINJA (or any successor) OWNS
------------------------------------    ------------------------------------
the source facts: time, materials,      PDF rendering, templates, branding
  service periods, expenses, orders
the DECISION that a fact is billed      email delivery, reminders, dunning
  and which line it went on
which entity is the seller (ADR-0017)   the customer portal and login
the counterparty who owes               payment links, gateways, card data
the currency and the amounts            the customer-visible invoice number
the AR source fact Phase 5 posts        tax rate calculation
what has NOT been billed yet            aging emails and collection workflow
```

Four arguments for owning the left column, in order of weight:

1. **Only Loxep can know what has not been billed.** The unbilled-work queue is the join of `time_entries`, `project_material_uses`, `service_periods`, and `expenses` against `invoice_line_sources`. Three of those four tables exist nowhere but Loxep, so no external billing system can compute it. This is the capability that most obviously "provides value", and it is unreachable without an owned invoice model.
2. **Only Loxep can prevent double-billing.** If the record of what was billed lives in Invoice Ninja, then a fact billed in January and re-selected in February is caught by whoever remembers. With `invoice_line_sources` and its [active-source unique index](#the-constraint-that-earns-its-place), it is caught by PostgreSQL.
3. **Phase 5 needs an AR source fact and has none.** [Phase 5's contradiction 4](../financial-schema-design/#contradictions-and-tensions-found-in-existing-documentation) records this precisely: AR postings are listed under Accounting DESIGN-FOR, but "AR has none until invoices exist in Phase 6". A ledger cannot post a receivable from a PDF on someone else's server. The owned invoice *is* the missing fact.
4. **Entity attribution is a Loxep concept.** ADR-0017's whole deliverable is that an LLC and its DBAs are separately reportable. Which operating identity issued an invoice determines which entity's P&L the revenue lands in, and that is not a field an external billing tool models the way Loxep needs it modeled.

And four arguments against owning the right column, which are just as important:

1. **Every one of them is a solved commodity**, done better by a mature product, and none of them touch Loxep's source facts.
2. **They are where the recurring cost is.** Templates, deliverability, tax display rules, and dunning cadences are permanent maintenance for zero analytical value.
3. **Payment handling drags in compliance.** The moment Loxep renders a payment link it is adjacent to card data, and ADR-0019's posture is that no such material exists in this schema at all.
4. **The exit path stays open either way.** Because Loxep owns the facts and the document header, replacing Invoice Ninja is writing a new adapter, and rendering invoices natively later is adding a template — neither is a data migration. That is the companion doc's "accelerate rather than become an irreversible dependency", satisfied by construction.

### Quotes are not owned

**Recommendation: Phase 6 creates no `quotes` table.** A quote's Loxep-side content is one number — what we told the client the job would cost — and that number is `projects.estimate_amount`. Everything else about a quote is presentation and delivery: a document, a template, an expiry, an accept button, a signature. All of that is Invoice Ninja's, linked through `external_resources` with `purpose = 'estimate'`.

The test that decides it is the same one that justified owning invoices, run in reverse: a quote consumes no owned source facts, produces no receivable, generates no posting, and cannot be double-billed. Owning it would buy a table and a lifecycle in exchange for nothing. If quoting later becomes a real workflow — versioned quotes, line-level acceptance, quote-to-project conversion — the exit path is a `quotes` table that references `projects` and reuses `invoice_lines`' shape, which is additive. Listed as an [open question](#open-questions), and it is one of two places where this design deliberately reads the roadmap narrowly.

## The invoice model

```text
invoices
id                            uuid primary key
reference_code                text not null
document_kind                 text not null default 'invoice'
counterparty_id               uuid not null references counterparties(id)
economic_entity_id            uuid null references economic_entities(id)
entity_attribution_source     text not null
entity_attributed_at          timestamptz null
entity_attributed_by_user_id  text null references user(id) on delete set null
project_id                    uuid null references projects(id)
subscription_id               uuid null references subscriptions(id)
billing_contact_id            uuid null references counterparty_contacts(id)
billing_site_id               uuid null references counterparty_sites(id)
status                        text not null default 'draft'
numbering_source              text not null default 'external'
external_number               text null
external_status               text null
currency                      char(3) not null
subtotal_amount               numeric(20,6) not null default 0
discount_amount               numeric(20,6) not null default 0
tax_amount                    numeric(20,6) not null default 0
total_amount                  numeric(20,6) not null default 0
external_balance_amount       numeric(20,6) null
external_balance_at           timestamptz null
issue_on                      date null
due_on                        date null
terms_days                    integer null
issued_at                     timestamptz null
issued_by_user_id             text null references user(id) on delete set null
voided_at                     timestamptz null
void_reason                   text null
reverses_invoice_id           uuid null references invoices(id)
notes                         text null
created_by_user_id            text null references user(id) on delete set null
created_at                    timestamptz not null
updated_at                    timestamptz not null
unique(reference_code)
check(document_kind in ('invoice','credit_note'))
check(status in ('draft','approved','issued','void'))
check(numbering_source in ('loxep','external'))
check(entity_attribution_source in
      ('manual','project_default','counterparty_role_default',
       'installation_default','unattributed'))
check(status <> 'issued' or (issue_on is not null and issued_at is not null))
check((status = 'void') = (voided_at is not null))
check(reverses_invoice_id is distinct from id)
check(document_kind = 'credit_note' or reverses_invoice_id is null)
check((document_kind = 'invoice') = (total_amount >= 0))
check(due_on is null or issue_on is null or due_on >= issue_on)
```

```text
invoice_lines
id                    uuid primary key
invoice_id            uuid not null references invoices(id) on delete cascade
line_number           integer not null
line_kind             text not null
catalog_item_id       uuid null references catalog_items(id)
service_plan_id       uuid null references service_plans(id)
project_id            uuid null references projects(id)
description           text not null
quantity              numeric(20,6) not null default 1
unit_amount           numeric(20,6) not null
discount_amount       numeric(20,6) not null default 0
tax_amount            numeric(20,6) not null default 0
tax_treatment         text null
line_total            numeric(20,6) not null
created_at            timestamptz not null
updated_at            timestamptz not null
unique(invoice_id, line_number)
check(line_kind in ('time','material','service_period','expense',
                    'product','manual','discount'))
```

```text
invoice_line_sources
id                    uuid primary key
invoice_line_id       uuid not null references invoice_lines(id) on delete cascade
source_fact_type      text not null
source_fact_id        uuid not null
quantity_contributed  numeric(20,6) null
amount_contributed    numeric(20,6) null
currency              char(3) null
is_active             boolean not null default true
linked_at             timestamptz not null
unique(invoice_line_id, source_fact_type, source_fact_id)
unique(source_fact_type, source_fact_id) where is_active
check(source_fact_type in ('time_entry','project_material_use','service_period',
                           'service_period_charge','expense','expense_allocation',
                           'order','manual'))
```

### The constraint that earns its place

`unique(source_fact_type, source_fact_id) where is_active` is the best constraint in this design, and it deserves the same emphasis Phase 5 gave its [composite foreign keys](../financial-schema-design/#the-composite-foreign-keys-are-the-best-constraint-in-this-design).

**A billable fact can appear on at most one live invoice line.** Not "should not" — cannot. The failure it prevents is silent, embarrassing, and the single most common defect in home-grown billing: an hour billed in March and billed again in April because a filter was wrong. Under a boolean `invoiced` flag on each source table, the guarantee is only as strong as whichever service remembered to set it, and every source table needs its own flag and its own discipline. Under one partial unique index, the second insert fails.

The lifecycle rules that make it work:

- voiding an invoice sets `is_active = false` on every source link beneath it, in the same transaction, which **returns those facts to the unbilled queue**. That is the correct behaviour: a voided invoice never happened, and the work still needs billing;
- issuing a **credit note** does *not* deactivate the original links. The work was billed and money is being returned; re-billing it would be a second charge, not a correction;
- `amount_contributed` and `quantity_contributed` are nullable and exist because one line legitimately aggregates many facts — "12.5 hours consulting, March" is nine time entries, and the per-entry share must be recorded for the profitability read models to attribute revenue back to the work.

This is `journal_entry_source_links` with one difference, and the difference is deliberate: Phase 5's links are [unenforced `(type, id)` stamps](../financial-schema-design/#source-fact-provenance-is-an-unenforced-stamp) with **no** uniqueness, because a posted entry must survive the deletion of its source fact. Here the pair carries a partial unique, because preventing double-billing is worth more than surviving a delete of a fact that is never hard-deleted in normal operation. Same shape, opposite trade, both argued.

### Immutability, numbering, and derived payment state

- **An issued invoice is immutable.** A `BEFORE UPDATE OR DELETE` trigger on `invoices` and `invoice_lines` raises when the invoice's status is `issued` or `void`, exactly as [Phase 5 protects posted journal entries](../financial-schema-design/#balance-enforcement-per-currency-the-options) and [Phase 4 protects movements](../inventory-schema-design/#append-only-means-append-only). Corrections are credit notes. A document sent to a customer is not editable, and an invariant that lives only in TypeScript is a convention when every package in the monolith can reach the table.
- **`numbering_source` defaults to `external`.** Where Invoice Ninja issues the document, Invoice Ninja owns the number the customer sees and Loxep stores it in `external_number`; Loxep's own `reference_code` is an internal handle and is never presented as an invoice number. Two systems both minting customer-visible sequential numbers is how a business ends up with two INV-0042s, and gapless numbering is a legal requirement in several jurisdictions that Loxep is in no position to guarantee for a document it does not render. `numbering_source = 'loxep'` exists for the eventual native path and is not the default.
- **There is no `amount_paid` column and no `partially_paid` / `paid` status.** Payment state is derived from `invoice_payments`, for the same reason [`ledger_accounts.normal_balance` is not a column](../financial-schema-design/#chart-of-accounts): storing a second source for a derived fact creates a disagreement with no arbiter. `status` is the lifecycle of the *document* (`draft → approved → issued`, or `void`), which Loxep genuinely owns.
- **`external_balance_amount` is the exception, and it is the `payouts.net_amount` argument verbatim.** It is a *provider-asserted* figure — Invoice Ninja said the balance is this — and a disagreement between it and Loxep's own `total_amount − sum(payments)` is **evidence**, not a bug. It is the single most useful diagnostic the billing integration produces, and it is why the column is stored rather than computed.
- **Credit notes are `invoices` rows with negative amounts**, not a separate table. A credit note shares every column, the same lifecycle, the same lines, the same posting path, and the same counterparty; it is a receivable in reverse. Negative storage means the receivable balance for a counterparty is `sum(total_amount)` and nothing else — the [signed-amount rule](../financial-schema-design/#signed-amount-not-debit-and-credit-columns) that already governs `journal_lines`, `inventory_movements`, `payout_lines`, and `bank_transactions`, applied a fifth time.

## Payments received

```text
invoice_payments
id                        uuid primary key
invoice_id                uuid not null references invoices(id)
payment_group_key         text null
external_payment_ref      text null
method                    text not null
currency                  char(3) not null
amount                    numeric(20,6) not null
received_on               date not null
financial_account_id      uuid null references financial_accounts(id)
processor_fee_amount      numeric(20,6) not null default 0
note                      text null
recorded_by_user_id       text null references user(id) on delete set null
created_at                timestamptz not null
updated_at                timestamptz not null
unique(invoice_id, external_payment_ref) where external_payment_ref is not null
check(amount <> 0)
check(method in ('bank_transfer','card','cash','check','marketplace_balance',
                 'processor','credit_applied','other'))
```

**There is no `payments` table with a `payment_allocations` child.** The two-table model is the textbook answer and it buys one thing: a single payment covering three invoices, allocated across them. Phase 6 represents that as three `invoice_payments` rows sharing a `payment_group_key` and an `external_payment_ref`, which gives the same reporting with one table and no allocation-sum invariant to maintain. The trade is honest: with the two-table model, "this £900 bank credit is one payment" is a row; here it is a group. For a self-hosted operator whose payments overwhelmingly settle one invoice at a time, and whose bank reconciliation already runs through Phase 5's [`reconciliation_matches`](../financial-schema-design/#reconciliation-foundation) — which explicitly supports many-to-one in both directions — the group key is enough. If real usage proves otherwise, `payments` plus `payment_allocations` is an additive refactor that leaves `invoice_payments` as a view. Listed as an [open question](#open-questions).

- `amount` is **signed**: positive is money received, negative is a refund to the customer. Consistent with everything else in the schema.
- `processor_fee_amount` is recorded on the payment because a gateway that deposits £96.50 against a £100 invoice has not underpaid, and the £3.50 is an expense. Recording it here means the invoice is fully settled and the fee posts as a fee, rather than leaving a permanent £3.50 receivable that trains people to ignore the AR report — the same argument Phase 5 made for [facilitator tax clearing](../financial-schema-design/#the-marketplace-facilitator-distinction-is-the-entire-point).
- **No card, token, gateway response, or PAN fragment is stored.** `external_payment_ref` is the provider's opaque identifier and nothing more (ADR-0019).
- Phase 5's `reconciliation_matches.internal_type` gains `invoice_payment`, so a bank credit can be matched to a customer payment the same way a deposit is matched to a payout.

## Posting into the Phase 5 ledger

Phase 6 writes no journal entries. It supplies the two source facts Phase 5's posting engine has been missing, and Phase 5's [declarative posting rules](../financial-schema-design/#declarative-posting-rules) do the rest.

Two `CHECK` widenings on `posting_rules.source_fact_type`, and two new seeded `system_key` values:

```text
new source_fact_type members     invoice, invoice_payment
new ledger account system_keys   accounts_receivable   (asset)
                                 service_revenue       (revenue)
```

The rules themselves, sketched in Phase 5's own worked-example style:

```text
INVOICE ISSUED (rule: ar_invoice, source_fact_type='invoice')
  DR  accounts_receivable        total
  CR  service_revenue            subtotal net of discount
  CR  sales_tax_payable          tax, where liability = seller_liability
  CR/DR remainder                rounding plug

CREDIT NOTE ISSUED (same rule, negative amounts; no second rule needed)

PAYMENT RECEIVED (rule: ar_payment, source_fact_type='invoice_payment')
  DR  undeposited_funds          amount net of processor fee
  DR  payment_processing_fees    processor_fee_amount
  CR  accounts_receivable        amount

BANK DEPOSIT matches (reconciliation, not a rule)
  DR  bank                       deposit amount
  CR  undeposited_funds          same
```

After a customer has paid, `accounts_receivable` returns to zero for that invoice. **A non-zero residual is the finding** — a payment recorded against the wrong invoice, a credit note nobody issued, or a fee that was netted and never recorded. This is the same clearing-account discipline the Phase 5 payout flow uses, applied to receivables, and it is what makes an AR balance checkable rather than asserted.

Three restraints:

- **Time entries do not post.** An hour of the owner's own labour is not an expense; recognizing it would create a cost with no counterparty and inflate both sides of the P&L. Subcontractor labour posts through `expenses` where it already has a payee, a receipt, and a category. `time_entries.cost_rate_amount` is a *management* costing figure used by the profitability read models, and it deliberately never touches the ledger.
- **Service periods do not post.** Revenue is recognized at invoice issue under the accrual rule set Phase 5 ships. Recognizing over the period is the deferred-revenue policy this phase declined to invent.
- **Material uses do not post.** Stock leaving for a job posts as COGS through the Phase 4 `consumption` movement under Phase 5's existing `inventory_movement` rule — which requires `cogs_on_consumption` to be added to the shipped rule set alongside `cogs_on_depletion`, and is a rule addition rather than a schema change.

## External-resource integration surfaces

The foundation already owns the mechanism, and Phase 6 is the first phase to use it for real:

```text
external_resources(provider, connection_id, external_type, external_id, url, title, metadata)
resource_links(external_resource_id, resource_type, resource_id, purpose)
```

[Companion Services](../../product/companion-services/#generic-external-resources) is explicit that this exists so "Loxep should not require a bespoke schema change for each documentation or work-management provider", and that "the integration boundary must preserve other task systems later rather than placing Vikunja-specific IDs throughout domain tables". **Phase 6 adds no provider-specific column to any table.** There is no `projects.vikunja_project_id`, no `invoices.invoice_ninja_id`, and no `counterparties.outline_collection_id`.

### The concrete vocabulary

`resource_type` mirrors the Loxep table name; `purpose` names what the link is *for*, so one project can carry a task board, a scope-of-work document, and a runbook without ambiguity.

```text
provider       external_type       resource_type          purpose
-------------- ------------------- ---------------------- ------------------------
vikunja        project             project                task_board
vikunja        task                project                task
vikunja        task                time_entry             source_task
vikunja        project             subscription           recurring_checklist

outline        document            project                scope_of_work
outline        document            project                runbook
outline        document            counterparty           account_notes
outline        document            counterparty_site      site_notes
outline        collection          service_plan           service_documentation
outline        document            invoice                billing_note

invoiceninja   client              counterparty           billing_client
invoiceninja   quote               project                estimate
invoiceninja   invoice             invoice                delivery_document
invoiceninja   payment             invoice_payment        payment_record
invoiceninja   recurring_invoice   subscription           recurring_billing
```

Two rules keep this from becoming a synchronization engine:

- **`external_resources.metadata` holds sync metadata only** — last-synced instant, the external object's own status string, an ETag. It never holds a copy of the document, the task description, or the invoice lines. Companion Services says to "synchronize selected metadata rather than copying document content into Loxep", and the moment a task's title is authoritative in two places, one of them is stale.
- **The link's direction of authority is fixed per purpose and written down.** `billing_client` means Loxep's counterparty is authoritative and the Invoice Ninja client is a projection of it. `task_board` means Vikunja is authoritative for task state and Loxep only counts. `delivery_document` means Loxep owns the facts and the amounts; Invoice Ninja owns the rendered artefact and the number.

### The Invoice Ninja round-trip

```text
Loxep                                          Invoice Ninja
-----                                          -------------
counterparty  --(create/update client)------>  client
   ^                                              |
   +--- resource_links purpose='billing_client'---+

invoice (status=approved, numbering=external)
   --(push header + lines)-------------------->  invoice (draft)
   <--(external_number, url, status)-----------
   +--- resource_links purpose='delivery_document'
   set invoices.status = 'issued', issued_at, external_number

                        (IN sends, reminds, collects)

   <--(payment webhook or poll)---------------   payment
   invoice_payments row + resource_links purpose='payment_record'
   <--(balance)--------------------------------
   invoices.external_balance_amount / _at
```

- **The link row is the idempotency probe.** "Has this invoice been pushed" is the existence of a `resource_links` row with `purpose = 'delivery_document'`, not a boolean on `invoices`. That is only safe if the link table cannot hold duplicates — and today it can, because `resource_links` has no primary key, no unique constraint, and no index at all. Phase 6 must add `unique(external_resource_id, resource_type, resource_id, purpose)` before relying on this. See [contradictions](#contradictions-and-tensions-found-in-existing-documentation) and the [migration plan](#which-existing-tables-gain-columns-and-why-phase-6-is-the-first-that-does).
- **Push happens at `approved → issued`, never from a draft.** A draft invoice is an internal working document; pushing it would put an editable thing in front of a customer and would break the immutability rule the moment someone edited it back.
- **Loxep never pulls invoice lines back.** If someone edits an invoice inside Invoice Ninja, `external_balance_amount` will disagree with Loxep's total and the disagreement is a named finding. Reconciling by overwriting Loxep's lines would let an external tool rewrite the record of which owned facts were billed, which is the one thing this whole design exists to prevent.
- **Health for these integrations reuses the `integration_health` subject model** sketched in Companion Services, with `subject_type = 'connection'` for the Invoice Ninja/Vikunja/Outline connections. No new table.

## Project and subscription profitability read models

Per the precedent set three times, these are **read models in the owning package, not database views**. Volumes are small, the shapes will change, and view definitions in migrations hide business logic from the type system and the test suite. No Timescale continuous aggregate: these are transactional tables.

### Composition, per project

```text
  billed revenue         invoice_lines on issued invoices, via invoice_line_sources
                         attributed back to this project (credit notes negative)
+ unbilled billable      time: billable_minutes/60 x bill_rate_amount
                         materials: quantity x unit_charge_amount
                         expenses: amount where client_billable
                         periods: recurring_amount + charges where billing_status='billable'
− labour cost            sum(minutes/60 x cost_rate_amount)  [entries with a cost rate]
− material cost          sum(quantity x unit_cost_amount)    [Phase 4 frozen basis]
− attributed expenses    Phase 5 expenses/expense_allocations where project_id = this
− subcontractor cost     included above: subcontractor hours are expenses, not wages
= project contribution   after labour, materials, and directly attributed expenses
```

Explicitly **not** in this number: overhead, unallocated software and subscription costs, sales effort, and any share of installation-level expenses. Every surface that displays it must say "contribution after labour, materials, and attributed expenses", never "profit" — the same labelling discipline [Phase 3 imposed on its pre-COGS figure](../commerce-schema-design/#what-phase-3-does-not-create) and [Phase 4 on its post-COGS one](../inventory-schema-design/#realized-profitability), one step further along.

Two composition hazards, both inherited:

- **Labour cost is present only where a cost rate resolved.** An entry with `cost_rate_source = 'unresolved'` contributes zero cost and would silently overstate contribution. The read model reports the count of unrated entries alongside the figure, and refuses to present a margin percentage when any entry in scope is unrated — the same posture Phase 4 took for [mixed-currency items](../inventory-schema-design/#realized-profitability) and Phase 5 for the [entity-filtered balance sheet](../financial-schema-design/#the-entity-filtered-pl-is-the-payoff-and-the-entity-filtered-balance-sheet-is-a-trap): an honest gap beats a plausible wrong number.
- **Materials must not be double-counted against COGS.** A `consumption` movement posts COGS in the ledger *and* appears as material cost here. These are two views of one cost, not two costs, and the project read model is a management figure that does not sum with the P&L. This is the same trap Phase 4 documented for [marketplace-purchased postage](../inventory-schema-design/#shipments) and it should be labelled as loudly.

### Composition, per subscription

```text
  recognized revenue     service_periods where billing_status='invoiced',
                         plus service_period_charges, by period — so MRR is a
                         sum over FACTS, not a projection over configuration
− direct service cost    Phase 5 expenses/expense_allocations where subscription_id
− support labour         time entries against the subscription's project
= subscription contribution, per period and per subscription
```

### Initial read models

```text
project contribution        per project, as composed above, by currency
subscription contribution   per subscription and per period
recurring revenue (MRR/ARR) sum over service_periods, by entity and currency
unbilled work               the billing queue: time, materials, expenses, and
                            periods with no active invoice_line_sources row
unrated billable work       billable entries with bill_rate_source='unresolved'
undelivered periods         status='open' past period_end_on
delivered but never billed  status='delivered' and billing_status<>'invoiced'
receivable balance          sum(invoices.total_amount) − sum(invoice_payments.amount),
                            per counterparty, per entity, per currency
external balance variance   invoices.external_balance_amount vs. Loxep's own figure
counterparty history        orders + projects + subscriptions + invoices, per party
duplicate candidates        counterparties grouped by normalized_name, shared
                            confirmed identifiers, shared normalized channels
merged-reference leaks      rows pointing at a merged counterparty
intercompany revenue        invoices whose counterparty mirrors an economic entity
```

Every money figure is grouped by currency and **never summed across currencies**, unchanged from all three prior phases. The one place cross-currency summation is legitimate remains the [journal's functional amount](../financial-schema-design/#multi-currency-the-minimal-journal-answer), and nothing here reaches into it.

## Relationship overview

```text
economic_entities                       counterparties
      |                                       |
      |   counterparty_entity_roles           +--> counterparty_contacts --> contact_channels
      +---------------------------------------+--> counterparty_sites
      |   (our entity E has role R with        +--> contact_channels (party-level)
      |    outside party C; entity nullable)   +--> counterparty_identifiers (matching evidence)
      |                                        +--> merged_into_counterparty_id (survivor pointer)
      |                                        +--> mirrors_economic_entity_id (declared intercompany)
      v
   projects ──> counterparty_sites
      |  \
      |   +--> parent_project_id (depth <= 1)
      |
      +--> time_entries ──> billing_rates (resolved once, FROZEN on the entry)
      |         \--> worked_by_user_id (ADR-0020 form 1)
      |          \-> worked_by_label   (ADR-0020 form 2; survives user deletion)
      |           \> worked_by_counterparty_id (subcontractors)
      |
      +--> project_material_uses ──> inventory_items      (P4; basis snapshotted)
      |                          ──> inventory_allocations (P4)
      |                          ──> inventory_movements   (P4; append-only, unique)
      |
      +--> expenses.project_id / expense_allocations.project_id   (P5; added columns)

service_plans ──> subscriptions ──> subscription_items
                       |
                       v
                 service_periods  (generated forward; non-overlapping by EXCLUDE)
                       |            status = obligation, billing_status = money
                       +--> service_period_charges

                       all four billable sources
                                |
                                v
invoices ──> invoice_lines ──> invoice_line_sources
   |                             unique(source_fact_type, source_fact_id) where is_active
   |                             = a fact is billed at most ONCE
   +--> invoice_payments ──> financial_accounts (P5)
   +--> reverses_invoice_id (credit notes; negative amounts)

orders.counterparty_id (P3; added column, backfilled via counterparty_identifiers)

external_resources ──> resource_links ──> project | counterparty | invoice |
                                          invoice_payment | subscription |
                                          service_plan | time_entry | counterparty_site
  vikunja (tasks)   outline (docs)   invoiceninja (clients, invoices, payments)

media_links (resource_type = 'counterparty' | 'project' | 'invoice' |
             'counterparty_site' | 'time_entry')

Phase 5:  invoices + invoice_payments --> posting rules --> accounts_receivable
Later:    quotes (additive, references projects, reuses invoice_lines' shape)
Later:    payments + payment_allocations (additive; invoice_payments becomes a view)
Later:    deferred revenue recognition over service_periods (additive rules, no DDL)
Later:    vendor bills / AP --> counterparties with role 'vendor' (unowned by any phase)
```

Every arrow into a future phase is a *reference added later*, not a rewrite of these tables. Same test as Phases 3, 4, and 5.

## Migration plan sketch

### Ordering

Foreign keys dictate most of it, and the phase should ship in four migrations matching its four milestones rather than one.

```text
0.  (prerequisite) the Phase 3 commerce migration is applied — verified, it is
0b. (prerequisite) the Phase 4 inventory migration MUST be applied before
    project_material_uses; it is a design, not a migration, as of this writing
0c. (prerequisite) the Phase 5 financial migration MUST be applied before
    invoice_payments, the expenses/expense_allocations alterations, and the
    posting-rule and reconciliation CHECK widenings
0d. CREATE EXTENSION btree_gist   (required by the service_periods exclusion;
                                   already required twice by Phase 5)

Migration A — counterparties
 1. counterparties                      (economic_entities, self-ref, user)
 2. counterparty_contacts               (counterparties)
 3. counterparty_sites                  (counterparties, counterparty_contacts)
 4. contact_channels                    (counterparties, counterparty_contacts)
 5. counterparty_identifiers            (counterparties, user)
 6. counterparty_entity_roles           (counterparties, economic_entities,
                                         counterparty_contacts, counterparty_sites)
 7. orders.counterparty_id              (ALTER; Phase 3 table)
 8. resource_links unique + index       (ALTER; foundation table — see below)

Migration B — projects, time, materials
 9. projects                            (counterparties, counterparty_sites,
                                         economic_entities, self-ref, user)
10. billing_rates                       (projects, counterparties, user)
11. time_entries                        (projects, counterparties, billing_rates, user)
12. project_material_uses               (projects, inventory_items, catalog_items,
                                         inventory_allocations, inventory_movements)
13. expenses.project_id / .payee_counterparty_id / .client_billable   (ALTER; P5)
14. expense_allocations.project_id / .counterparty_id                 (ALTER; P5)

Migration C — services and subscriptions
15. service_plans                       (catalog_items, economic_entities, user)
16. subscriptions                       (service_plans, counterparties,
                                         counterparty_sites, projects,
                                         economic_entities, user)
17. subscription_items                  (subscriptions, service_plans, catalog_items)
18. service_periods                     (subscriptions, counterparties,
                                         economic_entities) + EXCLUDE constraint
19. service_period_charges              (service_periods, subscription_items, user)
20. expense_allocations.subscription_id (ALTER; P5)

Migration D — billing
21. invoices                            (counterparties, economic_entities, projects,
                                         subscriptions, contacts, sites, self-ref, user)
22. invoice_lines                       (invoices, catalog_items, service_plans, projects)
23. invoice_line_sources                (invoice_lines) + active-source unique
24. invoice_payments                    (invoices, financial_accounts, user)
25. invoice immutability triggers       (invoices and invoice_lines, when issued/void)
26. posting_rules.source_fact_type CHECK widened     (ALTER; P5)
27. reconciliation_matches.internal_type CHECK widened (ALTER; P5)
28. reporting-only indexes (optional split)
```

Migration B depends on Phase 4 and Phase 5 both being applied, and Migration C depends on Phase 5. Migration A depends on nothing beyond the foundation and Phase 3, which means **the counterparty milestone can ship even if Phases 4 and 5 slip** — and it is the milestone with the most immediate value, because it is what backfills `orders.counterparty_id` for commerce data that already exists.

All migrations run through `loxep migrate` under the existing advisory lock (ADR-0018). Hand-written SQL is required in at least five places: the `EXCLUDE USING gist` on `service_periods`, the partial unique indexes with `where is_active` and `where is_primary`, the `UNIQUE NULLS NOT DISTINCT` constraints, the invoice immutability triggers, and the `CHECK` widenings on Phase 5 tables (which are `DROP CONSTRAINT` + `ADD CONSTRAINT` pairs). Verify current Drizzle Kit capability at implementation time and drop to SQL rather than weakening any constraint.

### Which existing tables gain columns, and why Phase 6 is the first that does

Phases 3, 4, and 5 each ended this section with "none". Phase 6 cannot, and the difference is structural rather than a lapse: this is the phase that *names the parties and purposes the earlier phases deliberately left as text*, and a name that cannot be attached to the row it names is not worth having. Every alteration below was promised in writing by the document that owns the table.

- **`orders`** — gains `counterparty_id uuid null references counterparties(id)` and `counterparty_match_source text null` (`manual | identifier | unmatched`). [Phase 3 promised exactly this](../commerce-schema-design/#orders): "Phase 6 adds the counterparty model and a nullable `counterparty_id`, backfilled by matching, without rewriting these columns." `buyer_external_id` and `buyer_display_name` stay — they are the matching evidence. **No other Commerce table changes**, and there is no `order_lines.project_id`.
- **`expenses`** — gains `project_id`, `payee_counterparty_id`, `client_billable`. The first two were promised by Phase 5; the third is [argued above](#expenses-attributed-to-projects). `payee_name` stays.
- **`expense_allocations`** — gains `project_id`, `counterparty_id`, `subscription_id`, which is [Phase 5's own list](../financial-schema-design/#expenses-and-receipts) of the attribution targets that did not exist yet, minus `shipment` (which exists but has no Phase 6 consumer, so Phase 6 declines to add a column nothing reads).
- **`posting_rules`** — `source_fact_type` `CHECK` widened by `invoice` and `invoice_payment`. Phase 5's [contradiction 4](../financial-schema-design/#contradictions-and-tensions-found-in-existing-documentation) predicted this precisely.
- **`reconciliation_matches`** — `internal_type` `CHECK` widened by `invoice_payment`.
- **`resource_links`** — **no columns**, but Phase 6 must add `unique(external_resource_id, resource_type, resource_id, purpose)` and `index(resource_type, resource_id)`. The applied foundation migration gives this table no primary key, no unique constraint, and no index whatsoever, which means an at-least-once integration job can link the same Vikunja task twice and no query can find a project's links without a sequential scan. Phase 6 is the first consumer that makes both facts matter. Recorded as a [tension](#contradictions-and-tensions-found-in-existing-documentation) because it is a foundation defect this phase happens to trip over, not a Phase 6 requirement.
- **`catalog_items`** — **no changes, deliberately.** The `kind` `CHECK` is not widened with a `service` member; see [service plans](#service-plans-subscriptions-and-service-periods).
- **`inventory_items`, `inventory_movements`, `inventory_allocations`, `acquisitions`, `shipments`** — no new columns. Every Phase 4 → Phase 6 relationship is an inbound foreign key from `project_material_uses`. In particular there is no `inventory_movements.project_id` and no `inventory_allocations.project_id`, and the `allocation_kind = 'project'` member Phase 4 already ships resolves through `project_material_uses.inventory_allocation_id`.
- **`economic_entities`** — no new columns. **No `counterparty_id`, not now, not ever.** This is the phase where that column would be added by a well-meaning implementer wiring up intercompany billing, and adding it would collapse the exact distinction ADR-0017 devotes a section to. The relationship lives in `counterparty_entity_roles`, and the declared mirror lives on `counterparties`, both pointing inward.
- **`connections`** — no new columns. Invoice Ninja, Vikunja, and Outline are ordinary connections with ordinary credentials. The subscription-period generation job and the invoice push are scheduled work; if either needs polling cadence, it registers a `monitor_targets` target type under the [shared-scheduling rule](../domain-boundaries/#scheduling-is-shared-foundation-infrastructure) rather than adding a scheduler.
- **`media_objects` / `media_links`** — no new columns. New `resource_type` values (`counterparty`, `counterparty_site`, `project`, `time_entry`, `invoice`) and new `purpose` values (`contract`, `scope_of_work`, `customer_po`, `site_photo`, `signature`, `work_evidence`), which is exactly what those columns are for.
- **`application_settings`** — new keys only, under namespaced `projects.*` and `billing.*` prefixes: `projects.default_entity_id`, `projects.time_rounding_minutes`, `projects.default_billable`, `billing.default_terms_days`, `billing.invoice_delivery_connection_id`, `billing.period_generation_horizon_days`. No DDL.
- **Better Auth tables** — untouched, per ADR-0020.

If implementation discovers a genuine need to alter an existing table beyond this list, that is a signal to revisit this design, not to quietly add the column.

### Index strategy

Volumes are modest: a two-person service business writes a few thousand time entries, a few hundred invoices, and a few thousand service periods a year. One index per named query, not defensive indexing.

Write and hot paths:

```text
counterparties         unique(reference_code)
counterparties         index(normalized_name)                   duplicate candidates
counterparties         index(merged_into_counterparty_id) where not null
counterparty_identifiers unique nulls not distinct
                         (identifier_kind, provider, normalized_value)
                         where confidence = 'confirmed'          the match probe;
                                                                 constraint IS the index
counterparty_entity_roles index(counterparty_id)
counterparty_entity_roles index(economic_entity_id, role) where economic_entity_id is not null
contact_channels       index(normalized_value)                  match by email/handle
counterparty_sites     index(counterparty_id) where active
projects               unique(reference_code)
projects               index(counterparty_id) where not null
projects               index(parent_project_id) where not null
projects               index(status) where status not in ('completed','cancelled','closed')
                                                                open work (partial, tiny)
time_entries           index(project_id, worked_on)             the project timesheet
time_entries           index(worked_by_user_id, worked_on desc) "my week"
time_entries           index(worked_on) where billable and locked_at is null
                                                                the unbilled queue (partial)
billing_rates          index(scope_kind, effective_from desc)   the resolution probe
project_material_uses  index(project_id)
project_material_uses  unique(inventory_movement_id) where not null   idempotency probe
service_periods        unique(generation_key)                   the retry probe
service_periods        index(subscription_id, period_start_on)
service_periods        index(billing_status, period_end_on)
                         where billing_status = 'billable'      the billing queue (partial)
invoices               unique(reference_code)
invoices               index(counterparty_id, issue_on desc)
invoices               index(economic_entity_id, issue_on desc) entity-scoped AR
invoices               index(status) where status <> 'issued'   drafts (partial, tiny)
invoice_lines          index(invoice_id)
invoice_line_sources   unique(source_fact_type, source_fact_id) where is_active
                                                                the double-bill guard;
                                                                constraint IS the index
invoice_line_sources   index(invoice_line_id)
invoice_payments       index(invoice_id)
resource_links         unique(external_resource_id, resource_type, resource_id, purpose)
resource_links         index(resource_type, resource_id)        "links for this project"
```

Reporting and resolution:

```text
orders                 index(counterparty_id) where not null    counterparty history
orders                 index(counterparty_id) where counterparty_id is null
                                                                match backlog (partial)
time_entries           index(counterparty_id, worked_on) where project_id is null
subscriptions          index(counterparty_id)
subscriptions          index(status) where status = 'active'    generation scan (partial)
service_period_charges index(service_period_id)
invoices               index(project_id) where not null         project revenue
invoices               index(subscription_id) where not null    subscription revenue
invoice_payments       index(received_on desc)
invoice_payments       index(payment_group_key) where not null
expenses               index(project_id) where not null         (added with the column)
expense_allocations    index(project_id) where not null         (added with the column)
```

`invoice_line_sources unique(source_fact_type, source_fact_id) where is_active` is the one that matters most: it is simultaneously the correctness guarantee and the index the unbilled-work read model anti-joins against, which is the most-run query in the phase.

Not indexed on purpose: `counterparties.kind` and `status` (two and three values, always filtered alongside something selective), `time_entries.billable` unpartialled, `invoice_lines.line_kind`, `service_periods.status` (the `billing_status` partial serves the queries that matter), `contact_channels.channel_kind`.

## Provisional implementation decisions (partial)

Every decision in this section is **PROVISIONAL**: implemented per this document's own recommendation under an owner directive, pending review. Each is marked `PROVISIONAL` at the code that implements it, so nothing here can drift out of sight.

This section is **scoped to the counterparty milestone**. It says nothing about projects, services, or billing, because none of them was built.

### What shipped

```text
migration      packages/db/migrations/0006_expenses_and_counterparties.sql
                 (shared with the Phase 5 expenses milestone)
schema         packages/db/src/schema/counterparties.ts   (4 tables, 0 altered)
services       packages/counterparties/src/               (@loxep/counterparties)
  normalize.ts       normalized_name and normalized_value; exact, never fuzzy
  codes.ts           CP-2026-0117 reference-code generation
  merge.ts           THE resolver, the picker predicate, merge/unmerge, reports
  counterparties.ts  create/update, the boundary refusals, the declared mirror
  contacts.ts        contacts and channels, primaries, opt-out
  roles.ts           relationship rows, terms, the entity-scoped pickers
  dedupe.ts          exact-normalized candidates by name and by channel
tests          packages/counterparties/test/              (123 tests, real PostgreSQL)
               packages/db/test/schema.test.ts            (boundary + deferred tables)
```

### What is still design-only

**Fifteen of this document's nineteen tables**, plus every alteration it planned to other phases' tables:

```text
counterparty_sites          its only consumers are projects and invoices
counterparty_identifiers    its purpose is backfilling orders.counterparty_id,
                            which is an ALTER this slice does not make
projects, time_entries, billing_rates, project_material_uses
service_plans, subscriptions, subscription_items,
  service_periods, service_period_charges
invoices, invoice_lines, invoice_line_sources, invoice_payments

ALTERs not made: orders.counterparty_id / .counterparty_match_source;
  expenses.project_id / .payee_counterparty_id / .client_billable;
  expense_allocations.project_id / .counterparty_id / .subscription_id;
  posting_rules and reconciliation_matches CHECK widenings;
  the resource_links unique + index
```

`packages/db/test/schema.test.ts` asserts each deferred table name is absent. Note in particular that **`expenses` and `counterparties` ship in the same migration and are still not linked**: `expenses.payee_name` remains denormalized text, because the column that names a payee belongs to a Phase 6 milestone with a matching table, and adding an unbackfillable FK just because both tables happen to exist would be the opposite of the discipline that kept them apart for three phases.

The `resource_links` integrity gap recorded as [tension 1](#contradictions-and-tensions-found-in-existing-documentation) is **not** fixed here; migration 0004 already gave `media_links` and `resource_links` their natural keys and indexes, so what remains of that item is only the counterparty-specific link usage, which does not exist yet.

### The open questions this milestone touched, as implemented

Only OQ2, OQ3, OQ12, OQ13, and OQ14. **OQ1 and OQ4–OQ11 and OQ15 are untouched and still open** — every one of them is about invoicing, projects, rates, or service periods, none of which was built.

- **OQ2 — the role model, implemented as recommended.** `counterparty_entity_roles(counterparty_id, economic_entity_id nullable, role, terms…)` with `unique nulls not distinct`, and **no role column on `counterparties` at all**. There is no `is_customer`/`is_vendor` pair, and `kind` has exactly two members. The nullable entity is the contestable half and it is nullable: a party may hold one installation-wide `customer` row, and the `NULLS NOT DISTINCT` unique is what stops it holding two. A test asserts that null case specifically, because without `NULLS NOT DISTINCT` the constraint would be silently inert for exactly the rows an early unattributed installation creates.
- **OQ3 — merge, implemented as recommended, with one addition.** Survivor pointer, never a delete, never a foreign-key rewrite, one resolver, merged rows excluded from every picker, unmerge is a one-column update. See the divergence below for the addition.
- **OQ12 — the declared mirror, implemented as recommended.** `counterparties.mirrors_economic_entity_id` exists, `declareMirror()` is the only API that relates the two concepts, it is audited as its own act, and `mirrors()` is the read model that makes intercompany revenue a query instead of a surprise.
- **OQ13 — data minimization, held as recommended.** Nothing harvests names, emails, or addresses out of retained `provider_objects`; a marketplace buyer becomes a counterparty only when an operator says so. There is no automatic order-to-counterparty match, partly because that is the policy and partly because the identifier table it would need is deferred.
- **OQ14 — the proposed domain-to-package rule, adopted for the two packages this slice creates.** `@loxep/counterparties` passes all three tests cleanly. Expenses landed in `@loxep/accounting` rather than `@loxep/domain`, which is the divergence from Phase 5's own recommendation that this document said would be the first thing to test the rule against.

### Divergences from the draft

- **Merge COMPRESSES pointers, and refuses two shapes the DDL would allow.** The draft states resolution as `coalesce(merged_into_counterparty_id, id)` — a single hop — and nothing in the DDL keeps the graph one level deep. `A → B` then `B → C` would leave `A` resolving to a row that is itself merged, and every read using the documented formula would silently under-count. Implementation keeps the formula true two ways: merging an already-merged row and merging *into* an already-merged row are both **refused** (which also makes a cycle unconstructible), and when a survivor is later merged on, the rows pointing at it are **re-pointed in the same transaction**. The honest cost: after `A → C` and `C → D`, row `A` stores `D` and no longer stores that it was once merged into `C`. The evidence is not lost — a `counterparty.merge_pointer_compressed` audit event carries the before and after pointer for every row moved — but it lives in the audit trail rather than in the column, and unmerging `C` therefore leaves `A` pointing at `D`.
- **`counterparty_contacts` ships although it is not part of the counterparty "core" as scoped.** `contact_channels` is physically undefined without it: its `num_nonnulls(counterparty_id, counterparty_contact_id) = 1` discriminator and both of its uniques reference the contact. Dropping the contact column instead would have silently changed the draft's channel model.
- **`counterparty_entity_roles` carries `billing_contact_id` but NOT `billing_site_id`.** `counterparty_sites` is deferred, and a column pointing at a table that does not exist is worse than no column — the rule Phase 5 states and this slice reuses. It is additive.
- **The partial primary-channel unique uses a `coalesce()` expression index.** Drizzle's `uniqueIndex` has no `nullsNotDistinct()` (only the constraint form does) and this one must be partial, so it uses the portable fallback this document itself names for exactly this case. The `num_nonnulls = 1` check guarantees `coalesce(counterparty_id, counterparty_contact_id)` is a total key, so nothing is weakened. The non-partial value unique is a real `UNIQUE … NULLS NOT DISTINCT`.
- **Five foreign keys are named explicitly.** Their derived names run 64–72 bytes and PostgreSQL silently truncates at 63: the `counterparties` self-reference and mirror, the `contact_channels` contact reference, and all three long references on `counterparty_entity_roles`. A test asserts no constraint or index name on the new tables exceeds the limit.
- **`normalized_name` follows the LEGAL name when one exists**, falling back to the display name, and is recomputed on every write so it cannot drift from the name it is derived from.
- **`grant()` is an upsert, not an insert.** Keyed on the same triple the unique governs, using `is not distinct from` so the installation-wide row is matched rather than duplicated. "Make them a customer of the LLC on net-30" is idempotent.
- **`listForPicker()` is a separate function, not a flag on `list()`.** "Which rows may accumulate NEW references" is a different question from "which rows exist", and a boolean would let a caller get the wrong answer by omission. `list()` hides merged rows by default and returns them only when asked.
- **A channel's VALUE never enters an audit snapshot.** An audit row is not the place to duplicate a contact's email address; the events record the channel id, kind, and primacy. A test asserts the address does not appear.
- **Dedupe is exact-normalized only, and the gaps are tested.** No trigram, no edit distance, no phonetic key, no scoring — the same "ship the state, not the matcher" posture Phase 5 took for reconciliation, and for the same reason: this finder feeds an operation that is expensive to undo, and a candidate list that is right most of the time trains an operator to accept it without reading. Tests assert both what it catches (`The Acme Roofing Co., Inc.` groups with `acme roofing company incorporated`) and what it deliberately does not (`Acme Roofing` vs `Acme Roofing LLC`; any misspelling; a local phone number vs its E.164 form). Adding `pg_trgm` later needs no schema change and no change to the return shape; removing a fuzzy matcher after operators have merged on its suggestions is not symmetrical.

### Verified at implementation time

Against drizzle-kit 0.31.10 and `timescale/timescaledb-ha:pg18.4-ts2.29.1-all`, everything generated correctly from the Drizzle schema and **nothing needed hand-written SQL or was weakened**: `UNIQUE … NULLS NOT DISTINCT` on both `contact_channels` and `counterparty_entity_roles`, `num_nonnulls` `CHECK`s, partial unique indexes with boolean predicates, a unique index over a `coalesce()` expression, and `date` columns in `{ mode: "string" }`. The `EXCLUDE USING gist` and `btree_gist` items on the pre-implementation checklist were not needed, because the constraint that requires them is on `service_periods`.

### What a reviewer should push back on first

In rough order of how expensive each is to reverse after data exists:

1. **Merge compression.** The refusals are uncontroversial; re-pointing rows onto a new survivor moves evidence from a column into the audit trail. The alternative is a recursive resolver on every read path.
2. **The nullable entity on a role.** Making it `not null` later means inventing an entity for every existing row.
3. **The declared mirror.** A door in a wall ADR-0017 built deliberately. Dropping the column and declaring intercompany billing unsupported is a defensible answer that should be written down rather than assumed.
4. **Exact-only dedupe.** Cheap to extend, and the gaps are real today.
5. **Shipping `counterparty_contacts` while deferring `counterparty_sites`.** Both are "shallow" tables; only one was forced by a constraint.

## Open questions

Each item is a genuinely unresolved decision with a recommendation, not a placeholder. **The first three are OWNER-REVIEW-CRITICAL**: they set the boundary of what Loxep owns and the shape of party identity, and each one is expensive or impossible to reverse after real customer and billing data exists.

### Owner answers (2026-08-12) — the three critical questions are RESOLVED

1. **Own-versus-integrate invoicing**: **build a first-class Invoice Ninja integration first**, per the recommendation — Ninja's existing payment wiring (Stripe et al.) is the deciding upside ("it ain't broke"). Owning invoicing natively stays an explicitly open future option the schema must not foreclose (`numbering_source` keeps the `loxep` arm), but nothing native ships in the first release.
2. **Counterparty roles**: **relationship rows with a nullable entity** (`counterparty_entity_roles`), payment terms on the relationship — accepted as recommended.
3. **Merge posture**: **survivor pointer** (`merged_into_counterparty_id`), never rewrite history's foreign keys — accepted as recommended.

Related owner ruling recorded the same day: [ADR-0021](../../decisions/0021-order-payload-retention/)'s default flipped to `keep` because retained order payloads feed the long-term CRM/cross-platform customer-matching direction this document's counterparty model serves.

**OQ2, OQ3, OQ12, OQ13, and OQ14 have been implemented per their recommendation and marked PROVISIONAL** (see [Provisional implementation decisions (partial)](#provisional-implementation-decisions-partial)); every other question below is untouched and fully open. They are retained verbatim because the recommendation is not the same thing as the answer, and the review needs the original reasoning.

1. **OWNER-REVIEW-CRITICAL — Where exactly is the own-versus-integrate line for invoicing?** *Recommendation: Loxep owns the source facts, the decision that a fact was billed and on which line, the seller entity, the counterparty, the amounts, and the AR source fact Phase 5 posts from — and owns nothing about rendering, delivery, reminders, portals, payment collection, or the customer-visible invoice number, which stay with Invoice Ninja and are linked through `external_resources`. Loxep owns no quotes table at all; a quote is `projects.estimate_amount` plus a link.* This is the minimum model that makes the unbilled-work queue computable and double-billing structurally impossible, which are the two capabilities no external system can provide because three of the four source tables exist only in Loxep. The owner must confirm two things. First, that shipping without native invoice PDFs and email is acceptable for the first release — because the alternative is a template engine, a deliverability problem, and a tax-display ruleset, none of which advance the analytical purpose. Second, that Invoice Ninja owning the customer-visible number is acceptable; if Loxep must issue gapless numbers itself, `numbering_source` flips to `loxep` and a counter row on a settings key is needed, which is a small change *now* and a renumbering exercise later. The residual risk of the recommendation is that [Master Domain Map section 8](../../product/master-domain-map/#8-billing-and-accounts-receivable) currently promises the whole AR feature set, and accepting this recommendation means editing that section rather than building it.

2. **OWNER-REVIEW-CRITICAL — Is a counterparty's role a relationship row, and may its entity be null?** *Recommendation: `counterparty_entity_roles(counterparty_id, economic_entity_id nullable, role, terms...)` with `unique nulls not distinct`, and no role column on `counterparties` at all.* Role is a property of a relationship: the same dealer sells you pallets and buys back a repaired lamp, and "customer" is meaningless without saying *whose* customer. The nullable entity is the contestable half — it reads as "this relationship holds installation-wide" and exists because an operator who has attributed nothing yet still has customers, which is the dominant early state under Phase 3's `unattributed` ladder. The owner should confirm the nullable, because making it `not null` later means inventing an entity for every existing role row, and making it nullable later is free. The second thing to confirm is that payment terms belong on the relationship rather than the party — net-30 with the LLC and cash with the personal side is representable only this way.

3. **OWNER-REVIEW-CRITICAL — Merge posture: survivor pointer or foreign-key rewrite?** *Recommendation: `merged_into_counterparty_id` on the loser, never delete, never rewrite history's foreign keys, resolve through the pointer in one function, exclude merged rows from every picker, and make unmerge a one-column update.* The alternative is what most systems do and it destroys the evidence of what was matched, makes unmerge a reconstruction exercise, and contradicts the precedent set twice already (`orders.duplicate_of_order_id`, ledger reversal-not-mutation). The cost is real and the owner should accept it explicitly: every counterparty read path must resolve the pointer, and one that forgets will under-count. If the owner prefers the rewrite, it must be decided **before** the first merge, because the two postures produce different data and there is no migration between them that recovers what a rewrite discarded.

4. **Are billable facts derived, or materialized into a `billable_items` table?** *Recommendation: derive them.* The unbilled queue is an anti-join of four source tables against `invoice_line_sources`, and a materialized `billable_items` row per time entry, material use, expense, and service period would be a second copy of facts with no arbiter — the failure `acquisitions` avoided by [refusing to store a total](../inventory-schema-design/#acquisitions) and Phase 5 avoided by [not copying non-capitalized acquisition costs into `expenses`](../financial-schema-design/#non-capitalized-acquisition-costs). The counter-argument is legitimate: a single billing table makes the invoice-building UI a single query and lets a fifth source type be added without touching the read model. If measured query complexity ever justifies it, the additive answer is a materialized view or a `billable_items` cache maintained by the same services, not a hand-maintained table.

5. **How deep should the rate-resolution ladder be, and should cost rates share the table?** *Recommendation: six scopes plus a manual override, first-match-wins by declared precedence, resolved once and frozen on the entry with its source; cost rates are the same table with `rate_kind = 'cost'`.* Six levels is more than a one-person shop needs and exactly what a shop with two workers, three clients, and one discounted retainer needs. The risk is that nobody configures level 6 and every entry is `unresolved`; the mitigation is that `unresolved` is a visible backlog rather than a silent zero. The owner should confirm the *absence* of an overlap constraint on effective-dated rates — two overlapping rows at the same scope resolve by latest `effective_from` and are reported, rather than being rejected at insert.

6. **Does `minutes` govern, or the start/end instants?** *Recommendation: `minutes` is the authority, the instant pair is optional evidence, and no `CHECK` ties them.* Most entries in a small service business are typed after the fact, and an instants-only model forces the operator to invent a window to record a true duration. The owner should also confirm `billable_minutes` as a separate column: it is what makes write-downs visible, and collapsing it into `minutes` means every utilization figure quietly launders every courtesy discount.

7. **How far ahead are service periods generated, and how is a mid-period change prorated?** *Recommendation: generate forward `subscriptions.generation_horizon_days` (default 60) from a maintenance job, never on demand and never as a side effect of invoicing; represent a partial period as `proration_factor < 1` on the period rather than as a separate adjustment row.* The horizon exists because a period must be visible before it is billable (advance billing needs next month's row this month) and because generating to infinity fills the table with rows for a subscription that will be cancelled. The proration choice is the contestable part: a factor is simple and loses the *reason*, while a `proration` charge row keeps the reason and complicates every period total. Both exist in this schema; the recommendation is factor-first, charge-row for the cases a factor cannot express.

8. **Deferred revenue: recognize at invoice, or over the service period?** *Recommendation: recognize at invoice issue in Phase 6, and treat period-based recognition as a later addition that needs no schema change.* An annual hosting plan billed in January is, under this recommendation, twelve months of revenue in January — which is defensible for a small operator on an accrual basis and is not what a larger one would expect. The reason to defer rather than decide is that recognition requires a policy (daily, monthly, at delivery), a deferred-revenue account, and a reversing convention, and inventing them would be complete and wrong. The reason it is *safe* to defer is that `service_periods` already exists as a row per month, so the later capability is a posting-rule change and a system-key addition, not a data reconstruction. The owner should confirm this before the first annual plan is billed.

9. **Should Loxep own quotes after all?** *Recommendation: no — `projects.estimate_amount` plus an Invoice Ninja link.* A quote consumes no owned facts, produces no receivable, generates no posting, and cannot be double-billed, so every argument that justified owning invoices fails for quotes. The counter-argument is that the roadmap lists "Quotes/invoices/AR model" as one bullet and [Domain Boundaries](../domain-boundaries/#billing-and-receivables) lists "quotes/estimates when implemented" under Billing, so declining them is a narrow reading of both. If quote-to-project conversion or line-level acceptance becomes a real workflow, a `quotes` table referencing `projects` and reusing `invoice_lines`' shape is additive.

10. **Who owns the customer-visible invoice number?** *Recommendation: whoever renders the document — `numbering_source` defaults to `external`, and Loxep's `reference_code` is never presented as an invoice number.* Two systems minting sequential customer-facing numbers produces two INV-0042s, and gapless numbering is a legal requirement in several jurisdictions that Loxep cannot guarantee for a document it does not render. If the owner wants Loxep to number, the mechanism is Phase 5's `accounting_books.next_entry_number` pattern — a counter row taken `FOR UPDATE` inside the issue transaction, not a PostgreSQL sequence, for exactly the gaplessness reason Phase 5 gave.

11. **Is the double-bill guard a partial unique on the link table, or a flag on every source fact?** *Recommendation: `unique(source_fact_type, source_fact_id) where is_active` on `invoice_line_sources`.* One index guarantees what four booleans on four tables can only hope for, and it puts the guarantee in the database rather than in whichever service remembered. The trade is that voiding an invoice must flip `is_active` on its links in the same transaction — a service rule the constraint depends on — and that a credit note deliberately does *not* flip them. Both rules need a test written before the billing service exists. The alternative flag-per-table model should be rejected explicitly rather than drifted into.

12. **May a counterparty declare that it mirrors an installation-owned entity?** *Recommendation: yes, via `counterparties.mirrors_economic_entity_id`, and make every profitability and receivable read model aware of it.* The intercompany case is real (one LLC genuinely billing a sibling for shared services), the operator will create the counterparty with or without a column, and an *undeclared* mirror is indistinguishable from a real customer while a declared one is a filter. The counter-argument is that this is a door in a wall ADR-0017 built deliberately, and that some reviewers would rather the case be impossible than visible. If the owner prefers the wall intact, the column is dropped and intercompany billing is simply unsupported — which is a defensible answer that should be written down rather than assumed.

13. **Where does buyer and contact personal data live, and for how long?** *Recommendation: hold Phase 3's line — `contact_channels` holds what an operator deliberately typed for a party they do business with, and Phase 6 does **not** harvest names, emails, or addresses out of retained `provider_objects` to populate counterparties automatically.* Marketplace buyers become counterparties only when an operator says so, which keeps the data-minimization posture Phase 3's [open question 8](../commerce-schema-design/#open-questions) established and which the WooCommerce findings confirmed is a real concern. This remains a **policy** question and Phase 6 builds no retention logic: `contact_channels.opted_out_at` records that a channel must not be used, and nothing deletes anything on a schedule. The owner should decide whether an automatic order-to-counterparty match is acceptable at all, because it is the difference between a customer list of forty people and one of four thousand.

14. **Which package owns this — and what is the GENERAL RULE for mapping domains to packages?** [Phase 5's open question 14](../financial-schema-design/#open-questions) observed that this had now happened three times (Phase 3's `monitor_targets` ownership, Phase 4's shipping ownership, Phase 5's four finance domains) and said "the recurrence suggests the documentation needs a general rule about domain-to-package mapping rather than a third one-off decision." Phase 6 is the fourth occurrence, with four domains in one phase, so this document proposes the rule rather than making a fourth one-off decision.

    *Proposed rule — a domain gets its own package only when all three of these hold:*

    ```text
    T1  EXCLUSIVE TABLES     it owns tables no other candidate package writes
    T2  ACYCLIC INBOUND EDGE at least one other package depends on it while it
                             depends on none of them, OR it has its own
                             integration/worker surface that others do not
    T3  SURVIVES THE UI      the boundary still makes sense if every workspace
                             were reorganized tomorrow
    ```

    *And two counter-tests that override all three:*

    ```text
    C1  if splitting would require a new shared types package to break a cycle,
        do not split — the two domains are one package with two modules
    C2  a table has exactly ONE owning package, always; a domain that would
        need to co-write another domain's table is not a package boundary
    ```

    *Plus two naming rules: a package is named after a domain, never after a workspace (`@loxep/accounting`, not `@loxep/finance`), and domains that co-locate remain separate **modules** inside the package with their own service boundaries, so a later split is a move rather than a rewrite.*

    Applied to Phase 6, the rule produces: **`@loxep/counterparties`** (T1 yes; T2 yes — Projects, Services, Billing, and Commerce all depend on it and it depends on none of them; T3 yes), **`@loxep/work`** for projects, time, rates, materials, services, subscriptions, and periods (T1 yes; T2 yes — Billing depends on Work, not the reverse; T3 yes; and Projects and Services fail T2 *against each other*, so C1 keeps them together as two modules), and **`@loxep/billing`** for invoices, AR, and the Invoice Ninja mapping (T1 yes; T2 yes — it has its own integration and worker surface; T3 yes). Three packages, not four, and not one.

    Applied backwards, the rule reproduces Phase 3's answer (Catalog fails T2 — nothing depends on catalog without commerce — so `@loxep/commerce` holds both as two modules) and Phase 4's (Shipping fails T2 today and gains it the moment a carrier integration with its own worker arrives, which is a *concrete trigger* for the split rather than a vague "later"). It **diverges from Phase 5's own recommendation in one place**: Phase 5 proposed expenses and sales-tax facts in `@loxep/domain` "alongside the other cross-cutting facts", and under T2 expenses belong in `@loxep/accounting` because Accounting depends on expenses and nothing else does. That divergence is deliberate evidence that the rule is doing work rather than rubber-stamping the answers already given, and it is the first thing a reviewer should test the rule against. *Recommendation: adopt the rule as an edit to [Domain Boundaries](../domain-boundaries/) — a short subsection beside the existing "Scheduling is shared foundation infrastructure" note — and, if the reviewer judges it a rule change rather than a clarification, as an ADR.* Like all three prior occurrences, it should be decided **before** implementation begins, because it determines package boundaries rather than table shapes.

15. **One `invoice_payments` table, or `payments` plus `payment_allocations`?** *Recommendation: one table, with `payment_group_key` for the rare payment that settles several invoices.* The two-table model is the textbook answer and buys one thing this operator rarely needs. The additive exit is real — `payments` plus `payment_allocations` with `invoice_payments` becoming a view — and the concrete revisit trigger is the first time an operator complains that a bank credit shows as three payments instead of one.

## Contradictions and tensions found in existing documentation

Recorded here for a human to resolve; this document does not attempt to fix them.

1. **`resource_links` has no primary key, no unique constraint, and no index.** The applied foundation migration (`0000_auth_and_foundation.sql`) creates it with four columns, one foreign key, and nothing else — and `media_links` has the same shape. Phase 6 is the first phase to make this matter twice over: an at-least-once integration job can link the same Vikunja task or Invoice Ninja invoice repeatedly with no `ON CONFLICT` target, and "the links for this project" is a sequential scan. The [Foundational Data Model](../foundational-data-model/#external-companion-resources) describes the mechanism as the answer to provider-specific columns without saying anything about its integrity. Phase 6's migration plan adds the unique and the index, but the gap belongs to the foundation and the same fix is probably owed to `media_links`.

2. **`resource_links.resource_id` and `media_links.resource_id` are `text`, not `uuid`.** Consistent between the two and consistent with a polymorphic link table, and it means neither referential integrity nor type safety exists on the hot path Phase 6 depends on. This is defensible — Phase 5 made the same trade for [`journal_entry_source_links`](../financial-schema-design/#source-fact-provenance-is-an-unenforced-stamp) and argued it — but nothing in the foundation documents states the trade or names the orphan-detection report that should accompany it.

3. **Master Domain Map section 8 and Companion Services disagree about who owns invoice delivery.** Section 8 lists "AR aging and reminders" and "Invoice numbering, tax facts, PDFs, email delivery, portal/payment links" under Billing DESIGN-FOR; [Companion Services](../../product/companion-services/#invoice-ninja) assigns exactly those capabilities to Invoice Ninja and says Loxep should own "customers, projects, subscriptions, billable facts, and eventually accounting". The roadmap's hedge — "where owning those capabilities provides value" — is the only thing holding the two together, and it does not say which capabilities those are. This design takes the companion doc's side; section 8 should be split into "owned billing facts" and "delivered by a companion" or the recommendation in [open question 1](#open-questions) should be rejected.

4. **AP is now the only accounting capability with no owning phase at all.** Phase 5's contradiction 4 noted that AR/AP postings are listed together under Accounting DESIGN-FOR while AR had no source fact until Phase 6. Phase 6 supplies AR and does **not** supply AP: vendor bills were declared an explicit non-goal by [Phase 4](../inventory-schema-design/#what-phase-4-does-not-create), belong to [Purchasing](../domain-boundaries/#purchasing) in Domain Boundaries, and appear in no phase of the roadmap. Seen from the Phase 6 side, this is the same gap Phase 5 recorded, now narrowed to one half and still unassigned. An AP aging report has nothing to aggregate.

5. **Phase 4 left a `project` allocation kind and a `consumption` movement kind with no way to name the project.** `inventory_allocations.allocation_kind = 'project'` ships in Phase 4's design with a `CHECK` and no `project_id`, and its own kind/reference consistency check (`(allocation_kind = 'order_line') = (order_line_id is not null)`) leaves the `project` member pointing at nothing. This design resolves it by pointing inward from `project_material_uses`, which means the Phase 4 `CHECK` is satisfiable but the member is unusable through Phase 4's own tables alone. Phase 4's wording should say that the project reference arrives from Phase 6 rather than implying an unwritten column.

6. **The domain map requires entity attribution on service work; Domain Boundaries' Projects section does not mention it.** [Section 7](../../product/master-domain-map/#7-projects-jobs-service-work-and-subscriptions) lists "Economic-entity attribution for the party providing the service where needed" under DESIGN-FOR, and [Domain Boundaries' Projects and Work](../domain-boundaries/#projects-and-work) lists projects, sites, status, time, tasks, billable facts, and project attribution for materials and expenses — with no entity attribution requirement at all, unlike its Commerce and Inventory sections which both state one explicitly. This design attributes projects, subscriptions, and invoices to entities. Domain Boundaries should gain the sentence its two sibling sections already have.

7. **Sites are assigned to two different domains.** [Domain Boundaries](../domain-boundaries/#customers-and-counterparties) puts "addresses/sites" under Customers and counterparties; the roadmap's Phase 6 bullet reads "Projects/jobs/sites", which reads as Projects owning them; [Workspaces](../../product/workspaces/) lists "addresses/sites" under `/customers` and "jobs/projects" under `/projects`. This design puts sites in Customers and has projects reference them, which matches two of the three. The roadmap bullet should be re-punctuated or a note added.

8. **`catalog_items.kind` has no `service` member, while Catalog is documented as owning "products/services".** [Domain Boundaries](../domain-boundaries/#catalog-and-listings) gives Catalog "products/services/SKUs"; the implemented Phase 3 migration constrains `kind` to `simple | variant_group | variant`. This design creates `service_plans` as a separate table with an opportunistic `catalog_item_id` and does not widen the `CHECK`. Either Catalog's scope statement should say "products, and services only where they need a SKU", or the `CHECK` widening should be scheduled — and it should be decided before anyone tries to put a hosting plan on a channel listing.

9. **`expenses.reimbursable` still has no consumer, and Phase 6 does not give it one.** Phase 5 shipped the boolean; Phase 6 adds `client_billable` for a different question (rebill to the customer) and introduces no employee model, no reimbursement workflow, and no payee-owed concept, because payroll is a permanent non-goal. Two years from now `reimbursable` will either be dead weight or the seed of an expense-reimbursement feature nobody has scheduled. It should be documented as one or the other.

10. **This design rests on two schemas that do not exist yet, and one that shipped provisionally.** [Commerce Schema Design](../commerce-schema-design/#provisional-implementation-decisions) records that Phase 3 is implemented under an owner directive with all eight open questions resolved per their own recommendations and marked PROVISIONAL — including `order_fees.fee_direction`, a column invented during implementation. Phases 4 and 5 remain design documents. Phase 6 therefore cites Phase 4 and Phase 5 column names that no migration has ever created, and cites Phase 3 columns that may still change under review. Phase 4's own first implementation note already records that Phase 3 diverged from its draft in a way that changed a read model. The structural risk is that Phase 6's expense, material, and payment seams are drawn against prose; the mitigation is item 2 of [Before implementing this schema](#before-implementing-this-schema), and it is not optional.

11. **Four domains, one phase, two-and-a-half workspaces — the package question, for the fourth time.** [Domain Boundaries](../domain-boundaries/) defines Customers and counterparties, Projects and Work, Services and Subscriptions, and Billing and Receivables as four separate ownership boundaries; the roadmap folds all four into Phase 6; [Workspaces](../../product/workspaces/) splits them across `/customers`, `/projects`, and part of `/finance`. These are consistent under the "workspace UX is not domain ownership" rule, and the package question is open for the fourth consecutive phase. [Open question 14](#open-questions) proposes the general rule Phase 5 asked for rather than making a fourth one-off decision; that proposal is itself the thing to review.

12. **"Unified operational history across commerce, projects, services, and billing" is promised unconditionally and is conditional in practice.** [Section 6](../../product/master-domain-map/#6-customers-and-operational-crm) lists it under DESIGN-FOR. A counterparty's history spans `orders` (matched only where `counterparty_identifiers` resolved a channel handle), `projects`, `subscriptions`, and `invoices`. The commerce half is as complete as the matching is, and marketplace buyers are frequently unmatchable because the channel exposes only a handle. The promise is achievable and partial, and the map states it without qualification — the same shape as [Phase 5's tension 9](../financial-schema-design/#contradictions-and-tensions-found-in-existing-documentation) about entity reporting.

## Before implementing this schema

1. **resolve the three OWNER-REVIEW-CRITICAL open questions first** — the own-versus-integrate invoicing line, the counterparty role model and its nullable entity, and the merge posture. The first determines what gets built at all, the second is expensive to widen after role rows exist, and the third produces different data depending on the answer with no migration back;
2. **re-read the applied migrations, not the design documents, for every reference outside Phase 6.** Phase 3 is implemented provisionally and may still change under review; Phase 4 and Phase 5 are prose. Every column name this document cites on `orders`, `inventory_items`, `inventory_movements`, `inventory_allocations`, `expenses`, `expense_allocations`, `financial_accounts`, `posting_rules`, and `reconciliation_matches` must come from a migration before a foreign key is written. Phase 4's own first implementation note records that Phase 3 diverged from its draft in a way that changed a read model; assume the same will happen again;
3. **decide the package boundaries (open question 14) before writing code** — it determines where the billing engine and the Invoice Ninja adapter live, and the general rule it proposes affects three earlier phases as well as this one;
4. verify `btree_gist` availability in the deployment image before relying on the `service_periods` exclusion constraint, and decide the weaker fallback deliberately if it is unavailable rather than discovering it at migration time;
5. verify current Drizzle Kit support for `UNIQUE NULLS NOT DISTINCT`, partial unique indexes with boolean predicates, `EXCLUDE USING gist`, `num_nonnulls` checks, trigger creation, and `CHECK` replacement on existing tables, and fall back to hand-written SQL rather than weakening any constraint;
6. **write the double-billing test first** — the same time entry, material use, and service period each attached to a second live invoice line must fail at the database, voiding an invoice must return its sources to the unbilled queue, and issuing a credit note must not — because it is the invariant every billing read model in this design assumes;
7. write the period-generation tests alongside it: the generation job run twice produces one period, a paused month produces a waived period with a reason and zero amount, a mid-month start produces a prorated period, and an attempt to insert an overlapping period fails at the database;
8. write the invoice immutability tests: an attempted `UPDATE` and an attempted `DELETE` on an issued `invoices` row and on its lines must both fail, and a correction must be expressible only as a credit note;
9. write the rate-resolution tests before the time service: each of the six scopes winning in turn, a manual override beating all of them, an effective-dated rate change not rewriting a prior entry, and an unresolved rate landing in the backlog rather than defaulting to zero;
10. write the counterparty-boundary tests: a `tax_identifier` on a `person` row must fail, a second confirmed identifier claiming the same provider handle must fail, a merged counterparty must not appear in any picker, and every read model must be exercised against a merged pair;
11. add the `resource_links` unique constraint and index in Migration A **before** any integration writes a link, and decide whether `media_links` gets the same treatment in the same migration;
12. keep provider SDK types at the integration boundary (ADR-0009); nothing here may be typed from an Invoice Ninja, Vikunja, or Outline library;
13. update this document, the roadmap, and Domain Boundaries when implementation reality diverges, rather than letting the documentation drift.

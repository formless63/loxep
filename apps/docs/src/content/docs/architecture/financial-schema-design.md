---
title: Financial Foundation Schema Design (Phase 5)
---

This document is the physical schema design for [Phase 5 — Financial foundation](../../product/roadmap/#phase-5--financial-foundation). It stands in the same relationship to Phase 5 that [Commerce Schema Design (Phase 3)](../commerce-schema-design/) stands in to Phase 3 and [Inventory & Acquisition Schema Design (Phase 4)](../inventory-schema-design/) stands in to Phase 4: a concrete migration target with table sketches, constraints, and the reasoning behind them, written before any migration exists.

It **extends** the foundation and both prior designs. Where an existing table, convention, or ADR already answers a question, that answer is reused rather than restated differently. Nothing here changes an already-implemented table, and nothing here alters a table Phase 3 or Phase 4 designed — every reference into an earlier phase is an outbound foreign key or an unenforced provenance stamp added by Phase 5.

**Implementation status: FOUR MILESTONES of this design are implemented, PROVISIONALLY — expenses and receipts, the financial core, posting rules and statements, and now COGS posting.** Migration `0006_expenses_and_counterparties.sql` created expenses and their allocations; migration `0009_accounting_books_chart_and_journal.sql` created **books, the effective-dated book-to-entity link, the chart of accounts, dimensions, fiscal periods, and the double-entry journal**; migration `0010_posting_rules_and_source_links.sql` created **the declarative rule model and multi-fact provenance**, and activated the three columns its two predecessors deferred — thirteen of this document's twenty-two tables in total. The second milestone was unblocked by the [owner's answers](#owner-answers-2026-08-12--the-three-critical-questions-are-resolved) to all three OWNER-REVIEW-CRITICAL questions on 2026-08-12, and not one day before. The fourth milestone added **no tables at all**: COGS posting from inventory depletion needed only the two source-fact readers the rule model's `CHECK` had been carrying a place for since migration 0010, so money spent on goods now reaches the ledger without a migration. The remaining nine tables — payouts, banking, reconciliation, and sales-tax facts — are **design only**. See [Provisional implementation decisions](#provisional-implementation-decisions) for exactly what shipped, what diverged, and what is still on paper.

The original preamble is retained for the record: *Design work only. No migration, Drizzle schema, or accounting service code is authorized by this page; the exact column types and constraints must be re-verified against the current PostgreSQL/Drizzle behavior immediately before implementation, per the [dependency policy](../../development/dependency-policy/).*

**Phase 5's migration cannot run before Phase 3's and Phase 4's.** Posting rules consume `orders`, `order_fees`, `order_refunds`, `inventory_movements`, `acquisition_costs`, and `shipments`; the payout model reconciles against `order_fees`; the expense model attributes to `acquisitions`. Unlike Phase 4, most of that coupling is *not* expressed as foreign keys — see [Source-fact provenance](#source-fact-provenance-is-an-unenforced-stamp) for why the ledger deliberately refuses referential integrity into operational tables — but the semantics are unusable without the facts.

This is by a wide margin the largest phase designed so far: twenty-two tables against nine in each of Phase 3 and Phase 4. It should ship in the four milestones the phase is already broken into — books/chart of accounts/journal first, then posting rules and statements, then expenses and receipts, then payouts, banking, and reconciliation — rather than as one migration.

## Scope

Phase 5 adds the physical tables required to turn operational facts into a trustworthy set of books, without making the ledger the only representation of what happened:

- `accounting_books` — an explicit set of books; an installation may have several;
- `book_entity_links` — which economic entities' activity a book contains, with effective dating;
- `ledger_accounts` — the per-book chart of accounts;
- `accounting_dimensions` and `accounting_dimension_values` — optional classes/departments/segments;
- `fiscal_periods` — period boundaries and closing state;
- `journal_entries` and `journal_lines` — the double-entry journal;
- `journal_line_dimensions` — dimension values attached to a line;
- `posting_rules`, `posting_rule_versions`, `posting_rule_lines` — the declarative rule model;
- `journal_entry_source_links` — which operational facts produced an entry;
- `financial_accounts` — real-world bank, card, marketplace, and processor balances;
- `payouts` and `payout_lines` — marketplace/processor settlement batches and their components;
- `bank_statement_imports` and `bank_transactions` — the import-first banking path;
- `reconciliation_matches` — match state between bank reality and internal records;
- `expenses` and `expense_allocations` — costs not already captured as acquisition or fee facts;
- `sales_tax_facts` — normalized tax facts with an explicit liability distinction.

Twenty-two new tables. No existing table gains a column — see [Which existing tables gain columns: none](#which-existing-tables-gain-columns-none).

The domains involved are **Accounting** (books, chart of accounts, dimensions, periods, journal, posting rules, statements), **Payments/Payouts/Banking** (financial accounts, payouts, bank transactions, reconciliation), **Costs and Expenses** (expenses and allocations), and **Tax** (sales-tax facts), which remain four distinct ownership boundaries per [Domain Boundaries](../domain-boundaries/#accounting) even though they land in one phase and surface in one `/finance` workspace. Workspace UX is not domain ownership. Whether four domains become four packages or one is an [open question](#open-questions).

## What Phase 5 does not create

Phase 5 stops at a working general ledger fed from facts that already exist. It deliberately does not create:

```text
tax filing / returns / nexus / rate tables      Never in this shape — Loxep is not a tax engine
sales-tax rate calculation at time of sale      Never — providers calculate; Loxep records
invoices / quotes / AR subledger / credit notes Phase 6 — an AR posting needs an AR source fact
counterparties / customers / vendors as records Phase 6 — payee stays denormalized text
project/job cost attribution                    Phase 6 — the column is additive when projects exist
service/subscription revenue recognition        Phase 6 — needs subscription periods to recognize over
payroll, contractors, 1099 tracking             Later — a whole compliance domain, not a ledger feature
budgets, forecasts, variance reporting          Later — no budget model, no budget columns
FX revaluation / remeasurement policy           Later — see the minimal multi-currency answer below
fixed assets, depreciation schedules            Later — domain map section 11, unscheduled
cash flow statement (indirect method)           Later — requires a closing/retained-earnings model
closing entries and retained-earnings roll      Later — computed in the read model, not stored
bank provider APIs (Plaid/GoCardless/SimpleFIN) Later — import files first, connections after
OCR / structured receipt extraction             Later (Documents) — media_links only in Phase 5
automated reconciliation matching / ML          Later — Phase 5 ships match STATE, not automation
multi-book consolidation / eliminations         Later — no intercompany model exists
per-book or per-account ACLs                    Still none (ADR-0017); membership installation-wide
```

Four of these deserve emphasis because they are the most likely to be smuggled in during implementation:

- **Recording a tax fact is not calculating or filing tax.** `sales_tax_facts` stores what a marketplace or processor already determined, plus the one judgement Loxep genuinely needs to make: whether the amount is the seller's liability or the facilitator's. There is no rate table, no jurisdiction registry, no filing calendar, and no return. See [Sales-tax facts](#sales-tax-facts).
- **Reconciliation is a state machine, not a matcher.** The phase deliverable is "reconciliation foundation": the tables and states that let a human say "this deposit is that payout". Suggestion generation is one deliberately dumb function over exact amount and a date window. Any confidence score, fuzzy string match, or learned matcher is a later concern that this schema does not need to change to accommodate.
- **The ledger is not a rebuild target.** [Master Domain Map](../../product/master-domain-map/#10-accounting-and-tax) lists "replay/rebuild of derived accounting where controls permit" — Phase 5 implements *reversal and re-post*, not wipe-and-regenerate. A rebuild that deletes posted entries in a closed period destroys the audit trail that is the only reason to keep a ledger. See [contradictions](#contradictions-and-tensions-found-in-existing-documentation).
- **Inventory valuation is not cost basis and not COGS.** Phase 4 froze cost basis on the item. Phase 5 posts COGS from depletion movements at that frozen basis. Period-end revaluation, lower-of-cost-or-market, and write-down policy are judgements this phase does not form, even though it now has a book to post them to.

## Conventions inherited from the foundation

Nothing below invents a convention. From the [Foundational Data Model](../foundational-data-model/), the [Foundation Schema Draft](../foundation-schema/), and the [Implementation Contract](../../development/implementation-contract/):

- UUID primary keys with `defaultRandom()`; provider and external identifiers are stored separately as text and never become Loxep keys;
- money is `numeric(20,6)` plus an ISO currency code; no persisted arithmetic in JavaScript `number`;
- state columns are `text` with application-owned TypeScript unions, never PostgreSQL enums;
- `CHECK` constraints only for genuinely closed sets. Almost every closed set in this design is **Loxep-owned** — no provider invents an account type or a period status — so Phase 5 uses `CHECK`s at roughly the Phase 4 density, and the exceptions (`expenses.category`, `financial_accounts.institution_name`) are called out where they occur;
- no `payload` or free-form attribute `jsonb` column on any table below. This matters more here than anywhere else: a posting-rule template stored as jsonb would be an unvalidated mini-language inside a text column, and it is instead `posting_rule_lines` rows;
- user-reference columns follow ADR-0020: nullable FK to the Better Auth user id with `ON DELETE SET NULL`;
- no credentials, tokens, or secret material appear in any of these tables (ADR-0019). Bank and processor credentials, when provider APIs arrive, stay in `connection_credentials`;
- idempotent write paths use a deterministic key column with a unique constraint, reusing the `market_events` / `inventory_movements.deduplication_key` mechanism verbatim.

Accounting is ordinary transactional relational data. **No table in this design is a Timescale hypertable.** A journal looks like a time series and is not: it is a small set of discrete business facts with foreign keys pointing at it, and hypertable partitioning would cost referential integrity for nothing. Financial KPI *snapshots* over time are Reporting work.

### Two deliberate divergences from foundation convention

**Accounting dates are `date`, not `timestamptz`.** `journal_entries.entry_date`, `fiscal_periods.starts_on` / `ends_on`, `bank_transactions.posted_on`, and `expenses.expense_date` are calendar dates in the book's own frame of reference, not instants. Storing them as `timestamptz` forces a timezone decision at every write, and the only possible consequence of getting it wrong is an entry landing in the wrong month — which is precisely the failure a period model exists to prevent. Instants that genuinely are instants (`posted_at`, `matched_at`, `imported_at`, `created_at`) remain `timestamptz` with semantic names, unchanged.

**`ledger_accounts`, not `accounts`.** Better Auth owns a table named `account` (ADR-0020), and Loxep does not touch Better Auth's tables or names. The obvious accounting name is therefore unavailable, and `ledger_accounts` is used throughout. This is a real constraint that no existing document mentions — see [contradictions](#contradictions-and-tensions-found-in-existing-documentation).

## Books and entities: the cardinality that decides everything

This is the load-bearing decision of Phase 5, and every other choice in the document is downstream of it.

[ADR-0017](../../decisions/0017-installation-entities-books-and-access/) is unambiguous about the shape: an accounting book is not an economic entity, more than one economic entity or operating identity may share one book, and Phase 0 must not add a required `accounting_book_id` to `economic_entities`. The [Implementation Contract](../../development/implementation-contract/#economic-entities-counterparties-and-accounting-books), [Domain Boundaries](../domain-boundaries/#accounting), [System Overview](../system-overview/#economic-entities-versus-accounting-books), and the [roadmap](../../product/roadmap/#phase-5--financial-foundation) all repeat it. The forbidden shape is not merely discouraged; it is the single most-repeated prohibition in the documentation.

So the question Phase 5 must actually answer is not "one book per entity or not" — that is settled — but **what the book-to-entity link means**, which is a much sharper question with two genuinely different answers.

### The two readings

```text
(a) SCOPE OF INCLUSION            (b) REPORTING LABEL
------------------------------    ------------------------------
"activity attributed to entity    "book B happens to contain some
 E posts into book B"              activity of entity E"

the link ROUTES postings          the link DESCRIBES contents
required before a fact can post   derivable after the fact from
                                    the entity dimension on lines
must be unambiguous per entity    may be many-to-many freely
an operator decision              an observation
```

Under (b), the link table is almost decorative: you could delete it and recompute it as `select distinct accounting_book_id, economic_entity_id from journal_lines`. Under (a) it is configuration the posting engine cannot run without.

### Recommendation: scope of inclusion, effective-dated, with a `reporting_only` role for the (b) cases

The link is primarily a routing decision, because the posting engine has to answer one question — *given this order, attributed to entity E, which book does it post to?* — and there is nowhere else for that answer to live:

1. **A single installation-default book fails on the day a second book exists**, which is exactly the installation this phase is designed for (personal activity in one book, an LLC and its DBAs in another).
2. **A book on the posting rule** couples rules to books and forces every rule to be duplicated once per book. The rule "an eBay sale credits revenue and debits marketplace clearing" is a statement about *accounting*, not about a book; making it book-specific multiplies the maintenance surface by the number of books for no gain.
3. **A book on the connection** re-introduces the exact defect [Phase 3 rejected](../commerce-schema-design/#attribution-is-a-stored-column-on-orders-not-a-join) for entity attribution: connections are mutable configuration, and re-attributing one would silently reroute the accounting of every future fact — and would tempt someone to reroute historical ones.
4. **The entity is already on the fact.** Phase 3 put `economic_entity_id` on `orders` and Phase 4 put it on `acquisitions` and `inventory_items`, in both cases explicitly reasoning that "Phase 5 must read attribution, not recompute it". Routing on the entity is the payoff those two decisions were making down-payments on.

So `book_entity_links` carries a `link_role`:

- `posting_primary` — this book receives postings for this entity's facts. **At most one at any point in time per entity**, which is what makes routing deterministic. Many entities may share one book; that is the whole point.
- `reporting_only` — reading (b): this book is *also* a place this entity's activity shows up, recorded for reporting/navigation purposes, and it never routes a posting. It exists so that the honest cases (an entity whose activity was posted into a book before a reorganization, an entity reported on across two books) are representable without corrupting routing.

And the link is **effective-dated**, because entities move between books at date boundaries — a DBA operating inside the LLC's book for two years is spun into its own book at the start of a fiscal year — and that must not be a destructive `UPDATE` that retroactively claims last year's entries belonged somewhere else. This is the same "attribution is a fact, not a setting" rule that governs Phase 3 orders and Phase 4 items, applied to a relationship instead of a column.

### `accounting_books`

```text
accounting_books
id                          uuid primary key
code                        text not null
name                        text not null
functional_currency         char(3) not null
accounting_basis            text not null
fiscal_year_start_month     integer not null default 1
fiscal_year_start_day       integer not null default 1
requires_entity_dimension   boolean not null default false
next_entry_number           bigint not null default 1
status                      text not null default 'active'
opened_on                   date not null
notes                       text null
created_by_user_id          text null references user(id) on delete set null
created_at                  timestamptz not null
updated_at                  timestamptz not null
unique(code)
check(accounting_basis in ('cash','accrual'))
check(status in ('active','archived'))
check(fiscal_year_start_month between 1 and 12)
check(fiscal_year_start_day between 1 and 31)
```

Notes:

- **There is no `economic_entity_id` column on this table, and there must never be one.** A book with an owning entity is a one-book-per-entity model wearing a link table as a disguise. Every ownership statement lives in `book_entity_links`.
- `functional_currency` is the book's reporting currency and the denomination of every statement it produces. It is set at book creation and is effectively immutable afterwards — changing it would require restating every `journal_lines.functional_amount` ever written, which is not a migration anyone should perform. Flagged as [OWNER-REVIEW-CRITICAL](#open-questions).
- `accounting_basis` is recorded because it changes what a P&L means, not because Phase 5 branches on it. The posting rules described below are accrual-shaped (revenue at sale, not at payout). A cash-basis book is representable and its rules would post from settlement facts instead; Phase 5 ships the accrual rule set and stores the label honestly. See [open questions](#open-questions).
- `requires_entity_dimension` is small and load-bearing: it is what makes an entity-filtered *balance sheet* meaningful. See [Core statements](#core-statements-as-read-models).
- `next_entry_number` is a counter row, not a PostgreSQL sequence, and that is deliberate. A sequence is gap-full on rollback, and an auditor's expectation of a journal is gapless numbering. Posting takes `SELECT ... FOR UPDATE` on the book row, increments, and writes inside the posting transaction. The serialization cost is irrelevant at a self-hosted reseller's posting volume and buys an invariant that is otherwise impossible.
- `fiscal_year_start_month/day` exist because a January fiscal year is an assumption, not a fact, and hardcoding it means the first non-calendar-year book requires a migration.

### `book_entity_links`

```text
book_entity_links
id                    uuid primary key
accounting_book_id    uuid not null references accounting_books(id)
economic_entity_id    uuid not null references economic_entities(id)
link_role             text not null
effective_from        date not null
effective_to          date null
dimension_label       text null
note                  text null
created_by_user_id    text null references user(id) on delete set null
created_at            timestamptz not null
updated_at            timestamptz not null
check(link_role in ('posting_primary','reporting_only'))
check(effective_to is null or effective_to >= effective_from)
exclude using gist (
  economic_entity_id with =,
  daterange(effective_from, coalesce(effective_to, 'infinity'::date), '[]') with &&
) where (link_role = 'posting_primary')
```

- The exclusion constraint is the routing invariant: **no entity has two primary books on the same day.** It requires the `btree_gist` extension for the `uuid with =` operand; the same extension is required by `fiscal_periods`, so one `CREATE EXTENSION` pays for both. If a deployment cannot install it, the portable fallback is a partial unique on open-ended rows (`unique(economic_entity_id) where link_role = 'posting_primary' and effective_to is null`) plus a service-level overlap check on historical rows, accepting a weaker invariant — verify extension availability against the `timescale/timescaledb-ha:pg18.4-ts2.29.2-all` image at implementation time.
- `dimension_label` is the display name this entity carries on statements filtered by the entity dimension. It is optional and defaults to `economic_entities.name`. It exists because "Acme LLC" and its DBA "Route 9 Vintage" want different labels on a P&L than they carry in Settings, and the alternative is renaming the entity record itself.
- There is **no unique on `(accounting_book_id, economic_entity_id)`**. An entity can legitimately have a `posting_primary` row for 2026 and a `reporting_only` row for the same book afterwards.

### Routing, and what happens when it fails

```text
1. the fact carries economic_entity_id
     -> the posting_primary book whose effective range contains the fact's
        accounting date            posting_book_source = 'entity_link'

2. the fact carries no entity, and application_settings has
   accounting.default_book_id set
     -> that book                  posting_book_source = 'installation_default'

3. otherwise
     -> the fact does not post; it enters the UNPOSTABLE BACKLOG
```

Step 3 is not a failure mode, it is the design. A fact with no entity and no default book is a fact whose accounting ownership nobody has stated, and inventing one silently is how a ledger becomes untrustworthy. This is the same principle as Phase 3's unattributed-order backlog and Phase 4's unmatched-depletion backlog, applied one layer up: **an unpostable fact is a visible backlog to resolve, never a rejected ingestion and never a guess.** Operational facts before accounting.

The backlog is a read model, not a table — it is `select` over source facts that have no `journal_entry_source_links` row and no matching rule or route. Materializing it would create a second thing that can drift from the facts.

## Chart of accounts

One chart per book. Not shared, not global, not templated at runtime.

```text
ledger_accounts
id                    uuid primary key
accounting_book_id    uuid not null references accounting_books(id)
code                  text not null
name                  text not null
account_type          text not null
account_subtype       text null
parent_account_id     uuid null references ledger_accounts(id)
is_postable           boolean not null default true
is_contra             boolean not null default false
system_key            text null
currency              char(3) null
description           text null
status                text not null default 'active'
created_at            timestamptz not null
updated_at            timestamptz not null
unique(accounting_book_id, code)
unique(accounting_book_id, id)
unique(accounting_book_id, system_key) where system_key is not null
check(account_type in ('asset','liability','equity','revenue','expense'))
check(status in ('active','archived'))
check(parent_account_id is distinct from id)
```

- **`account_type` is a five-member closed set with a `CHECK`**, because it is the one classification every statement depends on and there is no provider inventing a sixth. Contra accounts (sales returns, accumulated depreciation later) are `is_contra = true` on the ordinary type rather than a sixth type, which keeps the statement grouping trivial.
- **`normal_balance` is not a column.** It is `debit` for `asset`/`expense` and `credit` for `liability`/`equity`/`revenue`, flipped by `is_contra`. Storing it would create a second source for a derived fact with no arbiter — the same argument that kept money totals off `acquisitions`.
- `account_subtype` is free text with a TypeScript union and **no** `CHECK`, because it is the layer that grows: `bank`, `undeposited_funds`, `accounts_receivable`, `inventory`, `clearing`, `sales_tax_payable`, `cogs`, `marketplace_fees`, `shipping_expense`, `fx_gain_loss`, `opening_balance_equity`, `suspense`. Nothing branches on an unknown member; statements branch on `account_type`.
- `is_postable = false` marks roll-up header accounts. Journal lines may only reference postable accounts, enforced in the posting service and by a `CHECK` that cannot be written at the line (it is a cross-table condition) — so it is a service rule plus an integrity test, with the reconciliation report "posted lines against non-postable accounts" as the safety net. A trigger is available if a real incident argues for it.
- `unique(accounting_book_id, id)` looks redundant against the primary key and is not: it is the target of the composite foreign key that makes cross-book contamination structurally impossible. See [the journal](#the-double-entry-journal).
- `currency` is nullable and normally null. It is set only where an account is genuinely denominated in one non-functional currency — a GBP bank account inside a USD book — so that the reconciliation and statement layers can tell "this account holds foreign currency" from "this line happened to be in a foreign currency".

### System versus user accounts

`system_key` is the mechanism that lets Loxep's shipped posting rules work in a chart the operator owns and edits.

```text
system_key                        typical account
--------------------------------- ------------------------------------------
marketplace_clearing              asset   — money the marketplace owes us
undeposited_funds                 asset   — settled but not yet in the bank
inventory                         asset   — stock at landed cost
sales_tax_payable                 liab.   — tax WE must remit
facilitator_tax_clearing          liab.   — tax the marketplace collects and remits
sales_revenue                     revenue
sales_returns                     revenue (contra)
shipping_income                   revenue — customer-paid shipping
cogs                              expense
marketplace_fees                  expense
payment_processing_fees           expense
shipping_expense                  expense — actual postage
fx_gain_loss                      expense — realized conversion difference
opening_balance_equity            equity
suspense                          asset   — the plug of last resort, always reported
```

The rules that govern them:

- **A system account may be renamed and re-coded freely.** Operators have opinions about account numbering and should keep them; `system_key` is the stable handle, `code` and `name` are theirs.
- **A system account may never be deleted, and its `system_key` and `account_type` may never change.** Deleting it would break every rule that resolves through it; changing its type would silently move an account between statements.
- **Loxep seeds a default chart at book creation from a code-owned template**, not from a database table of templates. After creation the rows belong to the operator. A template table would invite the question "what happens when the template changes", and the honest answer — nothing, because the book already has its own rows — is better expressed by not having the table.
- `suspense` earns its place by being the account the posting engine uses when a rule matched but an account could not be resolved, *and* by being permanently visible in a named read model. A suspense balance that nobody looks at is worse than a failed posting; a suspense balance on the front page is a work queue.

## Accounting dimensions

ADR-0017 says separation within a shared book "may be expressed through the chart of accounts, dimensions, classes, departments, or another accounting classification model selected later." Phase 5 selects: **the economic entity is the primary separation mechanism, and it is a first-class column on `journal_lines`, not a generic dimension row.** Everything else (classes, departments, segments) is genuinely optional and gets a generic model.

### Why the entity is a column and not a dimension row

1. **It is the only dimension guaranteed to be present.** Phase 3 and Phase 4 both put `economic_entity_id` on their source facts specifically so Phase 5 could read it. A class or department has no equivalent upstream fact; it is operator classification applied at posting time.
2. **It is the filter every statement uses.** ADR-0017's entire promise — an LLC and its assumed names sharing one book while remaining separately reportable — is a `where` clause on this value. A column supports `index(accounting_book_id, economic_entity_id, entry_date)`; a junction turns the primary reporting filter into a join on the largest table in the schema.
3. **Its absence must be enforceable.** `accounting_books.requires_entity_dimension` needs a `NOT NULL`-shaped check on a specific value, which a junction row cannot express (you cannot constrain the absence of a row from the row's own table).
4. **It is the one classification that must keep referential integrity.** A generic dimension value is a text code the operator invented. An economic entity is a foundation record with a parent relation and a lifecycle, and a journal line pointing at a text copy of its name would be the exact "do not equate these concepts" failure ADR-0017 exists to prevent.

The rejected third option — a `jsonb` dimension bag on the line — is rejected by the foundation rule that normalized domain tables do not become loosely typed JSON stores, and by the fact that a dimension value with no referential target cannot be renamed without rewriting history.

### The generic model, for the optional dimensions

```text
accounting_dimensions
id                    uuid primary key
accounting_book_id    uuid not null references accounting_books(id)
code                  text not null
name                  text not null
is_required           boolean not null default false
sort_order            integer not null default 0
active                boolean not null default true
created_at            timestamptz not null
updated_at            timestamptz not null
unique(accounting_book_id, code)

accounting_dimension_values
id                    uuid primary key
dimension_id          uuid not null references accounting_dimensions(id)
parent_value_id       uuid null references accounting_dimension_values(id)
code                  text not null
name                  text not null
active                boolean not null default true
created_at            timestamptz not null
updated_at            timestamptz not null
unique(dimension_id, code)
check(parent_value_id is distinct from id)

journal_line_dimensions
journal_line_id       uuid not null references journal_lines(id) on delete cascade
dimension_id          uuid not null references accounting_dimensions(id)
dimension_value_id    uuid not null references accounting_dimension_values(id)
primary key(journal_line_id, dimension_id)
```

- The composite primary key enforces **at most one value per dimension per line**, which is the whole semantic content of "a dimension". Without it, a line could carry two departments and every report would double-count.
- Dimensions are **per-book**, matching the chart. A department that exists in the LLC's book has no meaning in the personal book.
- `is_required` is enforced by the posting service at the posting transition, not by a constraint, because a draft entry legitimately lacks dimensions while it is being built. The reconciliation report is "posted lines missing a required dimension".
- `on delete cascade` from `journal_lines` expresses composition — a dimension tag has no existence apart from its line. Posted lines are never deleted anyway (see below); this exists for draft cleanup.

**Phase 5 ships zero dimensions configured by default.** The tables exist; the model is empty until an operator creates one. This is not hedging: a self-hosted reseller with one LLC and two DBAs needs the entity dimension and nothing else, and shipping a "Class" dimension nobody asked for is how accounting software becomes unusable.

## Fiscal periods and closing semantics

```text
fiscal_periods
id                    uuid primary key
accounting_book_id    uuid not null references accounting_books(id)
period_code           text not null
fiscal_year           integer not null
sequence              integer not null
starts_on             date not null
ends_on               date not null
status                text not null default 'open'
closed_at             timestamptz null
closed_by_user_id     text null references user(id) on delete set null
note                  text null
created_at            timestamptz not null
updated_at            timestamptz not null
unique(accounting_book_id, period_code)
unique(accounting_book_id, fiscal_year, sequence)
check(ends_on >= starts_on)
check(status in ('open','soft_closed','closed','locked'))
exclude using gist (
  accounting_book_id with =,
  daterange(starts_on, ends_on, '[]') with &&
)
```

- The exclusion constraint makes overlapping periods impossible, which is the invariant that lets "the period containing this date" be a lookup rather than a judgement. Same `btree_gist` dependency as `book_entity_links`.
- Periods are **generated, never auto-created on demand.** A book creation generates a fiscal year of monthly periods from its `fiscal_year_start_*`; a maintenance job extends forward. Posting into a date with no period is an unpostable-backlog condition, not an implicit `INSERT`, because auto-creating a period silently reopens a year the operator believed was finished.

### Recommendation: soft close

```text
open          ordinary posting; anything goes
soft_closed   ordinary posting BLOCKED; an explicitly authorized, audited
              backdated posting is permitted and is FLAGGED on the entry
closed        all posting blocked; reopening is an explicit audited action
locked        all posting blocked; no application path reopens it
```

Soft close is the right default for this product specifically:

1. **Provider facts arrive late, and that is normal.** eBay reports a final-value fee adjustment three days after month end; a payout statement lands on the 4th covering the 28th–31st; a carrier post-audit reweigh charge arrives a week later ([Phase 4](../inventory-schema-design/#shipments) called that one of the most reliably underestimated costs in resale). A hard close makes those facts unpostable.
2. **The alternative silently misstates two periods.** "Post it to the next open period" moves a March fee into April. Both months are then wrong, and nothing on either statement says so.
3. **The flag is the point.** A backdated posting into a soft-closed period is recorded with `journal_entries.is_backdated = true` and an `audit_events` row, so the delta between the statement someone printed on the 1st and the statement today is answerable by query.

`closed` exists for the moment a return has been filed and the numbers must stop moving. `locked` exists for years old enough that even an authorized reopen is a mistake; nothing in the application UI reopens it.

Enforcement is the posting service **plus** a `BEFORE INSERT OR UPDATE` trigger on `journal_entries` that raises when the resolved period is `closed` or `locked`, mirroring the [Phase 4 append-only trigger](../inventory-schema-design/#append-only-means-append-only) reasoning: an invariant that lives only in TypeScript is a convention, and every package in the monolith can reach this table.

**Closing entries are not modeled.** There is no year-end entry rolling revenue and expense into retained earnings. Retained earnings is computed in the balance-sheet read model as the accumulated net income of prior fiscal years. Storing closing entries would double the number of entries a small book contains, would make the trial balance depend on whether the close job had run, and would need reversing when a prior year is legitimately corrected. Flagged as an [open question](#open-questions) because it is a genuine convention split.

## The double-entry journal

```text
journal_entries
id                        uuid primary key
accounting_book_id        uuid not null references accounting_books(id)
entry_number              bigint null
fiscal_period_id          uuid null references fiscal_periods(id)
entry_date                date not null
status                    text not null default 'draft'
entry_source              text not null
posting_rule_version_id   uuid null references posting_rule_versions(id)
posting_key               text null
source_fact_type          text null
source_fact_id            uuid null
source_fact_fingerprint   text null
reverses_entry_id         uuid null references journal_entries(id)
is_backdated              boolean not null default false
description               text not null
memo                      text null
posted_at                 timestamptz null
posted_by_user_id         text null references user(id) on delete set null
created_by_user_id        text null references user(id) on delete set null
created_at                timestamptz not null
updated_at                timestamptz not null
unique(accounting_book_id, id)
unique(accounting_book_id, entry_number) where entry_number is not null
unique(posting_key) where posting_key is not null
check(status in ('draft','posted','reversed','void'))
check(entry_source in ('posting_rule','manual','import','opening_balance'))
check((entry_source = 'posting_rule') = (posting_rule_version_id is not null))
check(status <> 'posted' or (entry_number is not null
                             and fiscal_period_id is not null
                             and posted_at is not null))
check(reverses_entry_id is distinct from id)
```

```text
journal_lines
id                    uuid primary key
journal_entry_id      uuid not null references journal_entries(id) on delete cascade
accounting_book_id    uuid not null
ledger_account_id     uuid not null
economic_entity_id    uuid null references economic_entities(id)
line_number           integer not null
description           text null
currency              char(3) not null
amount                numeric(20,6) not null
functional_currency   char(3) not null
functional_amount     numeric(20,6) not null
fx_rate               numeric(24,12) not null default 1
fx_rate_source        text not null default 'unity'
fx_rate_at            timestamptz null
created_at            timestamptz not null
unique(journal_entry_id, line_number)
foreign key(accounting_book_id, journal_entry_id)
  references journal_entries(accounting_book_id, id)
foreign key(accounting_book_id, ledger_account_id)
  references ledger_accounts(accounting_book_id, id)
check(amount <> 0)
check(fx_rate > 0)
check((currency = functional_currency) = (fx_rate_source = 'unity'))
check(fx_rate_source in ('unity','provider_reported','manual','imported'))
```

### The composite foreign keys are the best constraint in this design

`journal_lines` carries a denormalized `accounting_book_id`, and both of its foreign keys are composite: the line's book must equal its entry's book, **and** the line's book must equal its account's book. Together they make it structurally impossible to post a line in book A to an account belonging to book B, or to attach a line to an entry in another book.

That failure — a chart-of-accounts row from the wrong book appearing in an entry — is silent, catastrophic, and exactly the kind of thing a multi-book installation produces under a service-layer-only guarantee. It is worth one redundant uuid column per line, and the redundancy cannot drift because the constraints forbid it. This requires `unique(accounting_book_id, id)` on both `journal_entries` and `ledger_accounts`, which is why those appear above.

### Signed amount, not debit and credit columns

`amount` is **signed**: positive is a debit, negative is a credit. There are no `debit_amount` / `credit_amount` columns.

This follows the [Phase 4 `inventory_movements.quantity`](../inventory-schema-design/#signed-quantity-one-location-per-row) reasoning exactly, and the reasoning is if anything stronger here. With two columns, an account balance is `sum(debit) - sum(credit)` over two nullable columns, and every single balance query in the system — trial balance, P&L, balance sheet, clearing residual, reconciliation variance — has to get that expression right. With one signed column, a balance is `sum(amount)`. Nothing else. The balance check is `sum(amount) = 0` rather than `sum(debit) = sum(credit)` across nulls.

The counter-argument is real: accountants read debit and credit, and a signed column invites a sign error at the presentation boundary. The answer is that presentation is where it belongs — the read model emits `debit = greatest(amount, 0)` and `credit = greatest(-amount, 0)`, one function, tested once — rather than pushing the ambiguity into every aggregate. Flagged as an [open question](#open-questions) because it is a convention split reviewers will have opinions about.

### Balance enforcement per currency: the options

The invariant is that a posted entry's lines sum to zero **per currency**, and separately that its functional amounts sum to zero. The database options were analyzed:

```text
(a) service-layer only
    Cheapest. Weakest. Every package in the monolith can reach journal_lines,
    and the invariant is then only as strong as code review — the same
    objection Phase 4 raised against a TypeScript-only append-only rule.

(b) a deferred CHECK constraint
    DOES NOT EXIST. PostgreSQL CHECK constraints cannot be declared
    DEFERRABLE; only UNIQUE, PRIMARY KEY, FOREIGN KEY, and EXCLUDE can be.
    Worth stating because it is the first thing an implementer will try.

(c) a CONSTRAINT TRIGGER, AFTER INSERT OR UPDATE OR DELETE ON journal_lines,
    DEFERRABLE INITIALLY DEFERRED
    Fires at COMMIT, so lines may be inserted one statement at a time and
    the entry only has to balance when the transaction ends. Re-sums the
    affected entry grouped by currency and raises unless every group is zero.
    RECOMMENDED.

(d) a materialized journal_entry_balances row with a CHECK
    Correct and heavy: a second table to maintain, a second thing to drift,
    and it still needs a trigger to stay current.

(e) insert all lines in one statement and CHECK a generated column
    Not expressible: a CHECK sees one row, and a generated column cannot
    aggregate across rows.
```

Recommendation is **(c)**, narrowed by one further rule that makes it cheap:

**Posted entries and their lines are immutable.** A second `BEFORE UPDATE OR DELETE` trigger on both tables raises when the entry's status is `posted`, `reversed`, or `void`. Corrections are reversal entries, never edits. This is the [Phase 4 append-only rule](../inventory-schema-design/#append-only-means-append-only) applied to the ledger, where it is even less negotiable — a ledger whose posted rows can be updated is a spreadsheet.

With immutability in place, the balance trigger only ever fires on the draft→posted transition and on inserts into a draft entry, so its cost is bounded by the size of one entry. Drafts are exempt: an entry being assembled is legitimately unbalanced, and blocking that would make the manual-entry UI impossible.

The `void` status exists only for draft entries that were abandoned; a posted entry is never voided, it is reversed.

### Per-line dimension columns versus a junction

Analyzed above under [Accounting dimensions](#accounting-dimensions) and resolved as a hybrid: **entity is a column, everything else is a junction.**

The two pure options both fail. Per-line columns for every dimension require a migration on the largest table in the schema every time an operator invents a department, and are overwhelmingly null. A pure junction makes the one filter that matters — the entity, which is ADR-0017's entire deliverable — a join against `journal_line_dimensions` on every statement query, and gives up the foreign key to `economic_entities`.

## Multi-currency: the minimal journal answer

[Phase 3 open question 4](../commerce-schema-design/#open-questions) and [Phase 4 open question 8](../inventory-schema-design/#open-questions) both deferred currency conversion to Phase 5 without saying which Phase 5 concept would answer it. This is the answer:

**Conversion happens at posting, into the journal, and nowhere else.**

```text
accounting_books.functional_currency   the book's reporting currency
journal_lines.currency + amount        the TRANSACTION currency and amount
journal_lines.functional_amount        the same money in the book's currency
journal_lines.fx_rate / _source / _at  the rate used, frozen at posting
```

The rules:

- Operational tables are unchanged and stay in their native currency forever. `orders`, `order_fees`, `acquisition_costs`, `inventory_items`, `shipments`, `payouts`, and `bank_transactions` continue to store exactly one currency and no converted amount, and the Phase 3/Phase 4 read models continue to refuse to sum across currencies. The journal is the only place a converted number is allowed to exist, because the journal is the only place that has a book to define what it is converted *to*.
- The rate is **captured at posting and frozen**, exactly like Phase 4's cost basis and Phase 3's entity attribution. A rate that changes when a rate table is refreshed is not a fact.
- Where transaction currency equals functional currency, `fx_rate = 1` and `fx_rate_source = 'unity'`, populated rather than null, so no read path has to branch on a null.
- **Both sides must balance.** The transaction-currency sum per currency is zero, and the functional sum is zero. When lines in one entry use different rates — a GBP sale settled at one rate against a USD cost posted at another — the functional side will not balance on its own, and the posting engine adds a balancing line to the `fx_gain_loss` system account. That line is *why the account exists* and it must be generated, never left to the rule author.

### Where rates come from in Phase 5

There is no rate feed and no `fx_rates` table.

```text
provider_reported   the source fact carried a rate or both amounts.
                    Marketplace payout statements frequently do, and this is
                    by far the best source: it is the rate the money actually
                    moved at, not an approximation of it.
manual              an operator entered the rate for this posting.
imported            a rate that arrived with a bank statement import.
unity               same currency; rate 1.
```

If a rate feed is ever justified, it is an additive `fx_rates` table keyed on `(base_currency, quote_currency, rate_date, source)` plus a `fx_rate_source = 'feed'` member, and nothing in `journal_lines` changes. That exit path is why the rate is stored on the line rather than referenced from a rate table today.

**Period-end revaluation of open foreign-currency balances is explicitly out of scope.** A USD book holding a GBP bank account has an unrealized gain or loss at every reporting date, and recognizing it requires a policy (which accounts are monetary), a rate source, and a reversing-entry convention. Phase 5 records realized differences at posting and reports foreign-currency account balances in their own currency alongside the functional total. That is honest and incomplete; inventing a revaluation policy would be complete and wrong.

## Declarative posting rules

A rule is a **source-fact selector plus a line template**. It is not an expression language, and it must not become one.

The precedent is already set: [opportunity rules](../foundational-data-model/#detected-market-events) are "a small closed set of predicates ... evaluated purely against the event and the two observations it came from, never a general-purpose rule engine", with first-match-wins and a rule stamp that is never overwritten. Posting rules are the same shape applied to a different fact class, and the same restraint applies for a stronger reason: a rule engine that can compute arbitrary amounts is a rule engine that can produce an unbalanced entry, and debugging why last March's revenue is wrong should not require reading a stored expression.

### `posting_rules`

```text
posting_rules
id                    uuid primary key
code                  text not null
name                  text not null
source_fact_type      text not null
accounting_book_id    uuid null references accounting_books(id)
priority              integer not null default 100
status                text not null default 'draft'
current_version_id    uuid null references posting_rule_versions(id)
description           text null
created_by_user_id    text null references user(id) on delete set null
created_at            timestamptz not null
updated_at            timestamptz not null
unique(code)
check(status in ('draft','active','disabled'))
check(source_fact_type in ('order','order_fee','order_refund','order_fulfillment',
                           'inventory_movement','acquisition_cost','shipment',
                           'expense','payout','payout_line','bank_transaction',
                           'sales_tax_fact','manual'))
```

- `accounting_book_id` is **nullable and normally null**: a null rule applies in every book, which is what makes one shipped rule set work for an installation with three books. A non-null value narrows a rule to one book for the cases where an operator's chart genuinely differs.
- `priority` plus **first-match-wins** is the resolution model, matching the `market_events.rule_id` precedent exactly. A fact that matches three rules posts once, under the highest-priority match, and the version that produced it is stamped on the entry.
- A fact type with no matching active rule produces an unpostable-backlog item, not an error. Rule coverage is a named read model.

### `posting_rule_versions`

```text
posting_rule_versions
id                        uuid primary key
posting_rule_id           uuid not null references posting_rules(id)
version                   integer not null
status                    text not null default 'draft'
effective_from            date null
effective_to              date null
match_provider            text null
match_channel             text null
match_economic_entity_id  uuid null references economic_entities(id)
match_fee_type            text null
match_fee_direction       text null
match_movement_kind       text null
match_source_kind         text null
match_expense_category    text null
match_capitalize          boolean null
match_currency            char(3) null
match_min_amount          numeric(20,6) null
match_max_amount          numeric(20,6) null
note                      text null
created_by_user_id        text null references user(id) on delete set null
created_at                timestamptz not null
unique(posting_rule_id, version)
check(status in ('draft','active','superseded'))
check(effective_to is null or effective_from is null or effective_to >= effective_from)
check(match_max_amount is null or match_min_amount is null
      or match_max_amount >= match_min_amount)
```

**All predicates null means "every fact of this type", and every non-null predicate is an AND.** That is the entire selector semantics. There is no OR, no negation, no nesting, no expression column. A rule that needs OR is two rules with different priorities, which is also more legible in a list.

The predicate columns are deliberately typed and named after real columns on the Phase 3/Phase 4 facts (`order_fees.fee_type`, `order_fees.fee_direction`, `inventory_movements.movement_kind`, `acquisitions.source_kind`, `acquisition_costs.capitalize`). Not every predicate applies to every fact type; a predicate that does not apply to the rule's `source_fact_type` is a validation error at rule save time, not a silent no-op.

**A version is immutable once any journal entry references it.** Editing an active rule creates version N+1 and marks N `superseded`; `posting_rules.current_version_id` moves. This is the whole reason versions exist: an entry posted in March must be explainable by exactly the rule text that produced it, and a mutable rule makes every historical entry unexplainable. Flagged as [OWNER-REVIEW-CRITICAL](#open-questions).

### `posting_rule_lines`

```text
posting_rule_lines
id                        uuid primary key
posting_rule_version_id   uuid not null references posting_rule_versions(id)
                            on delete cascade
line_number               integer not null
account_system_key        text null
ledger_account_id         uuid null references ledger_accounts(id)
amount_source             text not null
amount_multiplier         numeric(20,6) not null default 1
inherit_entity            boolean not null default true
dimension_value_id        uuid null references accounting_dimension_values(id)
description_template      text null
created_at                timestamptz not null
unique(posting_rule_version_id, line_number)
unique(posting_rule_version_id) where amount_source = 'remainder'
check(num_nonnulls(account_system_key, ledger_account_id) = 1)
check(amount_multiplier <> 0)
check(amount_source in ('total','subtotal','shipping','discount','tax',
                        'fee','refund','net','cost_basis','quantity_times_basis',
                        'remainder'))
```

- **Account resolution is by `system_key` or by explicit id, exactly one.** `system_key` is what makes a rule book-portable: the same rule resolves `marketplace_clearing` to whichever account carries that key in whichever book the fact routed to. An explicit `ledger_account_id` is for the book-specific case and implicitly pins the rule to that book.
- **`remainder` is the plug line, and at most one per version.** It takes whatever value makes the entry balance. This is what allows a template author to write "debit clearing for the total, credit revenue for the subtotal, credit shipping income for shipping, credit tax payable for tax, and put the difference here" without doing arithmetic, and it is what makes it impossible to author a template that cannot balance. A version with no `remainder` line is valid and is checked for balance at rule-save time against a synthetic fact.
- `inherit_entity` defaults true: the line carries the source fact's `economic_entity_id` into `journal_lines.economic_entity_id`. Setting it false is for lines that genuinely belong to no operating identity — an installation-level bank fee posted into a shared book.
- `description_template` is a small named-placeholder string (`"eBay sale {external_order_number}"`), not an expression. The placeholder set is closed per fact type and validated at save.
- Debit versus credit is **not a column**: it falls out of the sign of `amount_source × amount_multiplier`. A credit line is a multiplier of `-1`. One representation, consistent with the signed-amount decision on `journal_lines`.

### Idempotent posting via source-fact identity

```text
journal_entries.posting_key =
  'pr:' || rule_code || ':v' || version || ':' || source_fact_type
        || ':' || source_fact_id
```

`unique(posting_key) where posting_key is not null` is the retry probe. Jobs are at-least-once; a posting handler that runs twice must not post twice. This is the `inventory_movements.deduplication_key` mechanism verbatim.

The rule version is **inside the key**, and that is not decoration. Without it, a deliberate re-post under a corrected rule would be silently swallowed by the unique constraint — the worst possible failure, because the operator would see a successful job and an unchanged ledger. With it, a re-post under a new version mints a new key and the old entry is reversed explicitly.

Reversal entries get their own deterministic key: `'rev:' || <original posting_key>`, so a retried reversal is also idempotent.

### Re-post on fact change: reversal and re-post, never mutation

Operational facts change after they post. An order gets a refund; a fee is corrected on re-sync; a lot's cost allocation is finalized after the first sale; a payout statement supersedes an estimate. The ledger must follow, and there are exactly two ways to make it follow.

**Recommendation: reverse the original entry and post a new one. Never mutate a posted entry.**

1. **Posted entries are immutable and periods close.** Mutating an entry in a soft-closed period retroactively rewrites a statement someone has already read, with nothing recording that it changed. The reversal approach puts the correction where it belongs: the reversal and the new entry carry their own `entry_date`, which may land in an open period even when the original did not.
2. **The audit trail is the product.** "What did we believe on the 1st, and what changed" is answerable by query when corrections are entries, and is answerable only by database archaeology when they are updates.
3. **It is the only strategy that works in every period state.** Mutation is impossible against a closed period; reversal-and-repost degrades gracefully to "the correction lands in the current period", which is what an accountant would do by hand.
4. **It composes with the immutability trigger.** The rule the database enforces and the rule the service follows are the same rule, so there is no case where the service wants something the database forbids.

Detecting that a fact changed is `journal_entries.source_fact_fingerprint`: a hash over exactly the fields of the source fact that the rule consumed. Re-evaluation compares fingerprints and does nothing when they match, which is the overwhelmingly common case — every provider re-sync of an unchanged order re-triggers evaluation, and the fingerprint is what makes that free. When the fingerprint differs, the engine reverses and re-posts in one transaction.

### `journal_entry_source_links`

Cross-domain rule 4: derived state identifies the source facts it was computed from. One entry usually comes from one fact — that case is covered by `journal_entries.source_fact_type` / `source_fact_id`. A payout entry, by contrast, settles a batch of orders, fees, and refunds at once, and needs a list.

```text
journal_entry_source_links
id                    uuid primary key
journal_entry_id      uuid not null references journal_entries(id) on delete cascade
source_fact_type      text not null
source_fact_id        uuid not null
role                  text not null
amount_contributed    numeric(20,6) null
currency              char(3) null
linked_at             timestamptz not null
unique(journal_entry_id, source_fact_type, source_fact_id, role)
check(role in ('primary','settled','allocated','reversed_from','evidence'))
```

#### Source-fact provenance is an unenforced stamp

`source_fact_id` is a plain `uuid` with **no foreign key**, and `source_fact_type` is a text discriminator. This is deliberate and it is the most contestable choice in the document, so the argument is stated plainly.

The alternative — one nullable typed FK column per referenceable table — would give referential integrity at the cost of roughly a dozen mostly-null columns on this table and on `reconciliation_matches`, which is precisely what [cross-domain rule 5](../domain-boundaries/#cross-domain-rules) warns against ("avoid shared tables containing unrelated optional columns from many domains merely to reduce table count").

More decisively: **a posted journal entry must survive the deletion of its source fact.** A ledger whose entries can be cascaded away, or whose entries can block an operational delete, is not a ledger. That is cross-domain rule 7 read in both directions — financial interpretations must not overwrite operational history, and operational maintenance must not erase financial history. The precedent already exists twice: `market_events.rule_id` and `acquisition_opportunity_links.opportunity_rule_id` are both unenforced historical stamps for the identical stated reason.

The residual risk is real: nothing stops a link pointing at a row that no longer exists. The mitigations are that operational facts are never hard-deleted in normal operation (Phase 3 states this for orders; Phase 4's movements are append-only), and a named reconciliation report — "posted entries whose source fact cannot be resolved" — makes an orphan visible rather than invisible. Listed as an [open question](#open-questions) because reviewers may weigh integrity differently.

### A worked example: an eBay sale, its fees, and its payout

This is the whole machine in one flow, and it is where the clearing-account pattern earns its place.

```text
ORDER posts (rule: order_sale, source_fact_type='order')
  DR  marketplace_clearing        gross total
  CR  sales_revenue               subtotal
  CR  shipping_income             shipping
  CR  facilitator_tax_clearing    tax (facilitator-collected)
  CR/DR remainder                 rounding/discount plug

DEPLETION posts (rule: cogs_on_depletion, source_fact_type='inventory_movement',
                 match_movement_kind='depletion_sale')
  DR  cogs                        quantity x frozen landed cost basis
  CR  inventory                   same

FEE posts (rule: marketplace_fee, source_fact_type='order_fee',
           match_fee_direction='seller_charge')
  DR  marketplace_fees            fee amount
  CR  marketplace_clearing        same

REFUND posts (rule: order_refund)
  DR  sales_returns               refund amount
  CR  marketplace_clearing        same

PAYOUT posts (rule: marketplace_payout, source_fact_type='payout')
  DR  undeposited_funds           net payout
  DR  facilitator_tax_clearing    tax withheld and remitted by the marketplace
  CR  marketplace_clearing        gross settled

BANK DEPOSIT matches (reconciliation, not a rule)
  DR  bank                        deposit amount
  CR  undeposited_funds           same
```

After the payout is fully reconciled, `marketplace_clearing` and `facilitator_tax_clearing` both return to zero for that settlement window. **A non-zero residual is the finding** — it means a fee Loxep never ingested, an order that was never normalized, a refund the payout knew about and Commerce did not, or a rule that fired twice. This is what makes the domain map's requirement — "a sale and its eventual bank deposit must remain reconcilable through intervening fees, refunds, taxes, and clearing balances" — a checkable invariant instead of an aspiration.

Note that `fee_direction` is load-bearing here exactly as it is in [Phase 4's contribution composition](../inventory-schema-design/#realized-profitability): only `seller_charge` fees post as expenses. A `buyer_surcharge` is already inside the order total the buyer paid, and posting it as a fee would understate income by exactly the amount the buyer covered.

## Payouts and clearing accounts

### `financial_accounts`

The real-world places money sits. Distinct from `ledger_accounts`, which is how a book *describes* them.

```text
financial_accounts
id                        uuid primary key
kind                      text not null
name                      text not null
institution_name          text null
account_identifier_last4  text null
currency                  char(3) not null
connection_id             uuid null references connections(id)
economic_entity_id        uuid null references economic_entities(id)
ledger_account_id         uuid null references ledger_accounts(id)
opened_on                 date null
closed_on                 date null
active                    boolean not null default true
notes                     text null
created_at                timestamptz not null
updated_at                timestamptz not null
check(kind in ('bank','card','cash','marketplace_balance','processor_balance',
               'loan','other'))
```

- **Only the last four digits of an account identifier are stored, ever.** A full account number is credential-adjacent data with no operational use here; the last four is what a bank statement shows and what a human matches on.
- `connection_id` is nullable and normally null in Phase 5, reserved for the later provider-API path.
- `ledger_account_id` maps this real-world account to its chart account. It is a single nullable FK, which is correct for the dominant single-book installation and **wrong for an installation where two books both need to see one shared bank account** — an additive `financial_account_book_mappings` table is the exit path. Listed as an [open question](#open-questions).

### `payouts` and `payout_lines`

```text
payouts
id                            uuid primary key
connection_id                 uuid null references connections(id)
provider                      text not null
external_payout_id            text null
financial_account_id          uuid null references financial_accounts(id)
economic_entity_id            uuid null references economic_entities(id)
entity_attribution_source     text not null
entity_attributed_at          timestamptz null
entity_attributed_by_user_id  text null references user(id) on delete set null
status                        text not null
currency                      char(3) not null
gross_amount                  numeric(20,6) not null default 0
fee_amount                    numeric(20,6) not null default 0
refund_amount                 numeric(20,6) not null default 0
tax_amount                    numeric(20,6) not null default 0
adjustment_amount             numeric(20,6) not null default 0
reserve_amount                numeric(20,6) not null default 0
net_amount                    numeric(20,6) not null
initiated_at                  timestamptz null
paid_at                       timestamptz null
expected_arrival_on           date null
period_start_on               date null
period_end_on                 date null
first_ingested_at             timestamptz not null
last_synced_at                timestamptz not null
created_at                    timestamptz not null
updated_at                    timestamptz not null
unique(connection_id, provider, external_payout_id)
  where external_payout_id is not null
check(entity_attribution_source in
      ('manual','connection_default','installation_default','unattributed'))
check(status in ('announced','in_transit','paid','failed','reversed','cancelled'))

payout_lines
id                    uuid primary key
payout_id             uuid not null references payouts(id) on delete cascade
line_number           integer not null
external_line_id      text null
line_type             text not null
order_id              uuid null references orders(id)
order_fee_id          uuid null references order_fees(id)
order_refund_id       uuid null references order_refunds(id)
external_order_ref    text null
description           text null
currency              char(3) not null
amount                numeric(20,6) not null
occurred_at           timestamptz null
created_at            timestamptz not null
unique(payout_id, line_number)
unique(payout_id, external_line_id) where external_line_id is not null
check(amount <> 0)
check(line_type in ('order_proceeds','fee','refund','tax','shipping_label',
                    'adjustment','dispute','reserve_hold','reserve_release',
                    'transfer','other'))
```

- **Attribution follows the Phase 3/Phase 4 ladder unchanged**, including the write-once rule. A payout is a completed past event, so it takes Phase 3's immutable treatment rather than Phase 4's transferable one.
- `amount` on a line is **signed**: positive increases the payout, negative reduces it. Consistent with `journal_lines` and `bank_transactions`, and different from `order_fees` where positive means "charged to the seller" — the divergence is intentional and is the same reasoning Phase 3 gave for not merging fees and refunds into one signed table: a payout line is a *component of a settlement*, and its natural polarity is the direction it moves the deposit.
- **The typed FK columns here are the exception that proves the source-link rule.** `payout_lines` points at Commerce tables with real foreign keys because a payout line's *purpose* is to reconcile against a specific known fact, the target set is three tables rather than a dozen, and a payout is not a ledger entry that must survive operational deletion. Where the FKs are null and `external_order_ref` is set, the payout named an order Loxep has not ingested — which is a **gap in commerce ingestion**, a named reconciliation finding, and one of the most useful diagnostics this phase produces.
- `net_amount` is stored even though it is derivable, because unlike an acquisition's landed cost it is a **provider-asserted fact** — the marketplace said the deposit would be this much — and a disagreement between the asserted net and the sum of lines is evidence, not a bug. Same reasoning as `orders.total_amount`, opposite of `acquisitions`.
- This table is where **"processor fees not attached to one order"** finally lands. Both [Phase 3](../commerce-schema-design/#what-phase-3-does-not-create) and [Phase 4](../inventory-schema-design/#what-phase-4-does-not-create) deferred payout-level and processor-level fees to Phase 5 without naming their home. A monthly store subscription, an ad-spend charge not attributable to one sale, and a chargeback fee are `payout_lines` with `line_type = 'fee'` and null order references, and they post through an `order`-independent rule.

## Expenses and receipts

```text
expenses
id                            uuid primary key
economic_entity_id            uuid null references economic_entities(id)
entity_attribution_source     text not null
entity_attributed_at          timestamptz null
entity_attributed_by_user_id  text null references user(id) on delete set null
accounting_book_id            uuid null references accounting_books(id)
reference_code                text not null
expense_date                  date not null
payee_name                    text null
category                      text not null
description                   text null
currency                      char(3) not null
amount                        numeric(20,6) not null
tax_amount                    numeric(20,6) not null default 0
payment_method                text not null
financial_account_id          uuid null references financial_accounts(id)
acquisition_cost_id           uuid null
status                        text not null default 'recorded'
reimbursable                  boolean not null default false
recurring_group_key           text null
notes                         text null
created_by_user_id            text null references user(id) on delete set null
created_at                    timestamptz not null
updated_at                    timestamptz not null
unique(reference_code)
check(amount <> 0)
check(entity_attribution_source in
      ('manual','installation_default','unattributed'))
check(status in ('draft','recorded','posted','void'))
check(payment_method in ('card','cash','bank_transfer','marketplace_balance',
                         'direct_debit','other'))

expense_allocations
id                    uuid primary key
expense_id            uuid not null references expenses(id) on delete cascade
line_number           integer not null
amount                numeric(20,6) not null
economic_entity_id    uuid null references economic_entities(id)
ledger_account_id     uuid null references ledger_accounts(id)
dimension_value_id    uuid null references accounting_dimension_values(id)
acquisition_id        uuid null
catalog_item_id       uuid null references catalog_items(id)
channel               text null
note                  text null
created_at            timestamptz not null
unique(expense_id, line_number)
check(amount <> 0)
```

- `reference_code` is a scannable human identifier (`EXP-2026-0231`), for the same reason `acquisitions.reference_code` and `inventory_items.item_code` exist: people label things, and a UUID is not a label.
- `category` is `text` with a TypeScript union and **no** `CHECK`. This is one of the few open sets in the design and the reason is empirical: expense categories are the thing every operator customizes first, and a `CHECK` here guarantees a migration in month two.
- `payee_name` is denormalized text, matching `acquisitions.vendor_name` exactly. When Phase 6's counterparty model arrives it adds a nullable `payee_counterparty_id` and backfills by matching — the identical treatment Phase 3 gave `buyer_external_id` and Phase 4 gave `vendor_name`.
- `accounting_book_id` is a nullable **override**. Normally null: the book is routed from the entity. It exists for the honest case of an expense an operator wants in a specific book regardless.
- **Flexible attribution is `expense_allocations`, and it ships only the targets that exist.** Entity, ledger account, dimension value, acquisition, catalog item, and channel all have real referents today. Customer, project, shipment, and service do not — [Domain Boundaries](../domain-boundaries/#costs-and-expenses) lists them, and Phase 6 adds them as additive nullable columns. A column pointing at a table that does not exist is worse than no column.
- `acquisition_id` and `acquisition_cost_id` are plain `uuid` with **no FK**, because Phase 4's tables are designed and not yet migrated; if Phase 4 has shipped when Phase 5 is implemented, these become real foreign keys and should. Verify against the applied migration, not this document.
- The invariant `sum(expense_allocations.amount) = expenses.amount` is a **service rule and a reconciliation report, not a constraint**, because a draft expense is legitimately partly allocated. Identical reasoning to Phase 4's lot-allocation invariant and Phase 3's order-total rule: three phases, three causes, one conclusion.
- An expense with **no** allocations is valid and complete — it posts to the account its rule resolves from `category`. Allocations are for splitting, not for existing.

### Receipts need no new table

`media_links` already attaches a `media_object` to any resource by `(resource_type, resource_id, purpose)`. Phase 5 adds `resource_type` values `expense`, `payout`, `bank_statement_import`, and `journal_entry`, with `purpose` values `receipt`, `invoice`, `statement`, and `supporting_document`. These are text values in application code, not DDL — the same conclusion Phase 3 reached for product media and Phase 4 for lot photos.

Document *semantics* — OCR text, structured extraction, matching status — belong to the Documents domain and are not Phase 5. Media knows how the file is stored; Accounting knows the image is receipt evidence; nobody in Phase 5 reads what it says.

### Non-capitalized acquisition costs

[Phase 4 open question 10](../inventory-schema-design/#open-questions) left `acquisition_costs.capitalize = false` rows recorded and unconsumed, saying "Phase 5's expense model will consume these rows". Phase 5's answer: **they are not copied into `expenses`.** A posting rule with `source_fact_type = 'acquisition_cost'` and `match_capitalize = false` posts them directly from where they already are.

Copying would create two records of one fact with no arbiter, which is the failure `acquisitions` avoided by refusing to store a total. The mileage the operator typed against a lot last March is already a complete fact; it needs a posting, not a duplicate.

## Bank transaction ingestion

Import files first. Provider APIs later, behind the existing connection model, without changing these tables.

```text
bank_statement_imports
id                        uuid primary key
financial_account_id      uuid not null references financial_accounts(id)
import_kind               text not null
media_object_id           uuid null references media_objects(id)
original_filename         text null
content_hash              text not null
statement_start_on        date null
statement_end_on          date null
row_count                 integer not null default 0
imported_count            integer not null default 0
duplicate_count           integer not null default 0
error_count               integer not null default 0
status                    text not null
imported_by_user_id       text null references user(id) on delete set null
imported_at               timestamptz not null
created_at                timestamptz not null
unique(financial_account_id, content_hash)
check(import_kind in ('csv','ofx','qfx','qbo','camt053','manual','provider_api'))
check(status in ('pending','parsed','imported','failed','reverted'))

bank_transactions
id                        uuid primary key
financial_account_id      uuid not null references financial_accounts(id)
bank_statement_import_id  uuid null references bank_statement_imports(id)
external_transaction_id   text null
dedupe_key                text not null
posted_on                 date not null
value_on                  date null
description_raw           text not null
description_normalized    text not null
counterparty_name         text null
reference                 text null
transaction_type          text null
currency                  char(3) not null
amount                    numeric(20,6) not null
running_balance           numeric(20,6) null
reconciliation_status     text not null default 'unmatched'
created_at                timestamptz not null
updated_at                timestamptz not null
unique(dedupe_key)
unique(financial_account_id, external_transaction_id)
  where external_transaction_id is not null
check(amount <> 0)
check(reconciliation_status in ('unmatched','suggested','matched','ignored'))
```

- `amount` is **signed**: positive is money in. Consistent with `journal_lines` and `payout_lines`, and it makes an account balance a `sum()`.
- The uploaded file itself is kept as a `media_object`. The evidence for a ledger should be re-readable, and the media layer already solves storing it.
- `unique(financial_account_id, content_hash)` means the same file cannot be imported twice into the same account. This is the cheap half of dedupe and it catches the overwhelmingly common operator error.

### Dedupe identity is the hard part

Statement files carry no stable transaction identity. Two coffees on the same day for the same amount at the same merchant are two genuine transactions that are byte-identical as rows.

```text
dedupe_key = sha256(
    financial_account_id
  || posted_on
  || amount
  || description_normalized
  || occurrence_index
)
```

`occurrence_index` is computed **within the import**, per `(posted_on, amount, description_normalized)` group, starting at zero. `description_normalized` is case-folded, whitespace-collapsed, and stripped of the trailing reference noise banks append — a per-institution normalization that lives in code, not in the schema.

This is stable across re-imports of the same file, and stable across an overlapping file **as long as each day appears in full**. The honest residual risk: a file that starts or ends mid-day can shift occurrence indices for that day and produce a duplicate or a false collision. The mitigations are that `statement_start_on`/`statement_end_on` are recorded so overlaps are detectable, that the import reports its duplicate count rather than silently absorbing rows, and that a day with a shifted index shows up as an unmatched transaction rather than as a corrupted balance. Listed as an [open question](#open-questions).

When provider APIs arrive, `external_transaction_id` becomes the preferred identity and `dedupe_key` degrades to a secondary guard for the file path — no schema change, which is the point of storing both.

## Reconciliation foundation

Phase 5 ships **match state**, not matching.

```text
reconciliation_matches
id                        uuid primary key
bank_transaction_id       uuid not null references bank_transactions(id)
internal_type             text not null
internal_id               uuid not null
match_kind                text not null
status                    text not null default 'suggested'
currency                  char(3) not null
amount_matched            numeric(20,6) not null
variance_amount           numeric(20,6) not null default 0
matched_by                text not null
note                      text null
matched_at                timestamptz null
matched_by_user_id        text null references user(id) on delete set null
created_at                timestamptz not null
updated_at                timestamptz not null
unique(bank_transaction_id, internal_type, internal_id)
  where status in ('suggested','confirmed')
check(status in ('suggested','confirmed','rejected','superseded'))
check(matched_by in ('operator','suggestion','import'))
check(match_kind in ('payout_deposit','expense_payment','transfer',
                     'manual_journal','refund','fee','opening_balance','other'))
check(internal_type in ('payout','expense','journal_entry','bank_transaction'))
```

- `internal_type` / `internal_id` follow the same unenforced-stamp rule as `journal_entry_source_links`, for the same reasons.
- **Many-to-one is allowed in both directions.** One deposit can settle two payouts; one payout can arrive as two deposits. The partial unique prevents duplicating the *same* pair, and the "confirmed matches do not exceed the transaction amount" rule is a service check plus a report, not a constraint — a legitimate over-match is a finding an operator needs to see, not an insert that should fail.
- `variance_amount` exists because a match with a small difference (a wire fee deducted in transit) is still the right match, and forcing it to be exact would push operators into editing facts to make them line up. The variance is the thing the ledger then has to account for.
- **Matching does not post.** Confirming a match may *trigger* a posting rule — a confirmed payout deposit posts the bank/undeposited-funds pair — but the match row is not a journal entry and never becomes one. Keeping them separate is what allows a match to be rejected without a reversal.
- Suggestion generation is one function: same `financial_account_id`, amount equal within a tolerance, date within a window, and nothing else. No fuzzy string matching, no learned confidence, no scoring column. `matched_by = 'suggestion'` records that the machine proposed it; a human confirms. When a smarter matcher is justified it writes rows into the same table with the same states.

## Sales-tax facts

Facts and one liability judgement. Not a tax engine, not a filing system.

```text
sales_tax_facts
id                        uuid primary key
fact_source               text not null
order_id                  uuid null references orders(id)
order_line_id             uuid null references order_lines(id)
order_refund_id           uuid null references order_refunds(id)
expense_id                uuid null references expenses(id)
economic_entity_id        uuid null references economic_entities(id)
jurisdiction_country      char(2) null
jurisdiction_region       text null
jurisdiction_name         text null
tax_type                  text not null
collector                 text not null
remitter                  text not null
liability                 text not null
provider_reported         boolean not null default true
currency                  char(3) not null
taxable_amount            numeric(20,6) not null default 0
tax_amount                numeric(20,6) not null
tax_rate                  numeric(10,6) null
occurred_on               date not null
created_at                timestamptz not null
updated_at                timestamptz not null
check(fact_source in ('order','order_line','order_refund','expense','manual'))
check(tax_type in ('sales_tax','vat','gst','hst','pst','use_tax','other'))
check(collector in ('marketplace_facilitator','seller','processor','none'))
check(remitter in ('marketplace_facilitator','seller','unknown'))
check(liability in ('seller_liability','facilitator_liability','not_applicable'))
```

### The marketplace-facilitator distinction is the entire point

Under marketplace-facilitator regimes, the marketplace collects sales tax from the buyer and remits it to the jurisdiction. That money passes through the seller's gross sales figure and is never the seller's liability. Treating it as one — crediting `sales_tax_payable` — creates a liability on the balance sheet that will never be paid and that grows forever.

```text
liability = 'facilitator_liability'
  posts DR/CR against facilitator_tax_clearing ONLY.
  The order entry credits it; the payout entry debits it.
  Net balance is zero once settled, and a residual is a finding.
  It never touches sales_tax_payable and never touches P&L.

liability = 'seller_liability'
  posts CR sales_tax_payable. This is money we owe and will remit.

liability = 'not_applicable'
  exempt, zero-rated, or out of scope. Recorded, posts nothing.
```

Recording facilitator tax rather than discarding it matters because several jurisdictions still require facilitator-collected amounts in gross-sales reporting, and because the clearing residual is what proves the payout reconciled to the penny.

Other rules:

- **`collector`, `remitter`, and `liability` are three columns, not one.** The processor collecting, the marketplace remitting, and whose liability it is are independently variable, and a single collapsed column loses the case that actually causes errors.
- **`provider_reported` marks inference.** Where a provider gives an explicit facilitator flag, the fact is recorded from it. Where it does not, Loxep infers `facilitator_liability` from the channel and records `provider_reported = false` so the inference is visible and re-derivable. Flagged as an [open question](#open-questions).
- **Jurisdiction fields are all nullable.** Providers frequently report a tax amount with no jurisdiction at all. A fact with a null region is honest and useful; refusing to record it because the jurisdiction is unknown would lose the amount entirely.
- Phase 3's `orders.tax_amount` and `order_lines.tax_amount` are **untouched**. `sales_tax_facts` normalizes the jurisdiction and liability layer alongside them, sourced from retained provenance; it does not replace, correct, or duplicate the Commerce columns.

## Core statements as read models

Per the Phase 3 and Phase 4 precedent, statements are **read models in an accounting package, not database views**. Volumes are small, the shapes will change, and view definitions in migrations hide business logic from the type system and the test suite. If a database view is ever justified by query complexity it is a plain non-materialized view in its own late migration, droppable and recreatable without touching base tables. No Timescale continuous aggregate — these are transactional tables.

```text
trial balance          sum(functional_amount) by ledger_account, for a book,
                       over a period range; must sum to zero overall

profit & loss          revenue and expense accounts over a date range, per book,
                       OPTIONALLY FILTERED BY THE ENTITY DIMENSION

balance sheet          asset/liability/equity as of a date, per book;
                       retained earnings computed from prior fiscal years

clearing residual      balance of each clearing account by settlement window;
                       the payout reconciliation invariant
unpostable backlog     source facts with no route, no rule, or no period
suspense balance       anything that landed in the plug account, always visible
rule coverage          fact types and counts with no matching active rule
unreconciled banking   bank_transactions where reconciliation_status='unmatched'
payout gaps            payout_lines naming orders Loxep never ingested
orphan provenance      posted entries whose source fact cannot be resolved
fx exposure            foreign-currency account balances, shown in BOTH currencies
```

### The entity-filtered P&L is the payoff, and the entity-filtered balance sheet is a trap

An entity-filtered profit and loss statement is exactly what ADR-0017 promised: an LLC and its two assumed names share one book and one chart of accounts, and each operating identity still gets its own income statement. It works because every revenue and expense line carries `economic_entity_id`, inherited from the source fact through `posting_rule_lines.inherit_entity`.

An entity-filtered **balance sheet** is only meaningful if *every* line in the book carries the dimension — including the ones nobody thinks about, like the opening bank balance and the equity contributions. Filter a partially-dimensioned book and the assets will not equal the liabilities plus equity, and the report will be wrong in a way that looks like a bug in the accounting rather than a gap in the data.

So: **`accounting_books.requires_entity_dimension` gates it.** An entity-filtered balance sheet is offered only for books where that flag is true and a validation confirms no posted line lacks the dimension. Otherwise the UI offers the entity-filtered P&L, offers the unfiltered balance sheet, and says why — which is the honest answer, and is more useful than a plausible statement that does not balance.

Every money figure on every statement is in the book's `functional_currency`, which is what `journal_lines.functional_amount` exists for. This is the one place in Loxep where cross-currency summation is correct, and it is correct precisely because the conversion is a stored, frozen, per-line fact rather than a report-time guess.

## Relationship overview

```text
economic_entities
    |
    |  book_entity_links (effective-dated; posting_primary routes, at most one
    |  per entity per day; reporting_only never routes)
    v
accounting_books ──> ledger_accounts (per book; system_key handles)
    |            ──> accounting_dimensions ──> accounting_dimension_values
    |            ──> fiscal_periods (non-overlapping; soft/hard close)
    |
    v
journal_entries ──> journal_lines ──> journal_line_dimensions
    |   ^                  |
    |   |                  +--> ledger_accounts   (composite FK: same book)
    |   |                  +--> economic_entities (THE separation dimension)
    |   |
    |   +-- reverses_entry_id (corrections are entries, never edits)
    |
    +--> journal_entry_source_links (unenforced type+id stamp)
    +--> posting_rule_versions ──> posting_rule_lines
              ^
              |
        posting_rules (selector + priority; first match wins)
              ^
              |  reads, never mutates
   +----------+-------------------------------------------+
   |          |            |            |                 |
 orders   order_fees   order_refunds  inventory_movements  acquisition_costs
 (P3)       (P3)          (P3)          (P4)                (P4)
   |          |            |
   |          |            |
   +----------+------------+---> payout_lines ──> payouts
                                                    |
financial_accounts <────────────────────────────────+
   |                                                |
   +--> bank_statement_imports ──> bank_transactions
                                        |
                                        v
                              reconciliation_matches
                                        |
                          (payout | expense | journal_entry)

expenses ──> expense_allocations ──> ledger_accounts / dimensions /
   |                                  acquisitions / catalog_items
   +--> media_links (resource_type = 'expense', purpose = 'receipt')

sales_tax_facts ──> orders / order_refunds / expenses
                    (liability distinction drives which account posts)

Phase 6:  expenses --> project_id, counterparty_id (additive columns)
Phase 6:  invoices --> AR postings (a new source_fact_type, no schema change here)
Later:    fx_rates table --> fx_rate_source = 'feed' (additive)
Later:    financial_account_book_mappings (additive, multi-book)
```

Every arrow into a future phase is a *reference added later*, not a rewrite of these tables. Same test as Phase 3 and Phase 4.

## Migration plan sketch

### Ordering

Foreign keys dictate most of it, and the phase should ship in four migrations matching its four milestones rather than one.

```text
0. (prerequisite) the Phase 3 commerce migration must already be applied
0b. (prerequisite) the Phase 4 inventory migration should be applied before the
    posting rules that consume inventory_movements and acquisition_costs
0c. CREATE EXTENSION btree_gist   (required by two exclusion constraints)

Migration A — books, chart, journal
 1. accounting_books
 2. book_entity_links                  (accounting_books, economic_entities)
 3. ledger_accounts                    (accounting_books, self-ref)
 4. accounting_dimensions              (accounting_books)
 5. accounting_dimension_values        (accounting_dimensions, self-ref)
 6. fiscal_periods                     (accounting_books)
 7. journal_entries                    (accounting_books, fiscal_periods, self-ref)
 8. journal_lines                      (composite FKs to entries and accounts)
 9. journal_line_dimensions            (journal_lines, dimensions, values)
10. journal balance constraint trigger (deferred, per (entry, currency))
11. journal immutability triggers      (entries and lines, when posted)
12. fiscal-period posting-guard trigger

Migration B — posting rules
13. posting_rules
14. posting_rule_versions              (posting_rules, economic_entities)
15. posting_rule_lines                 (versions, ledger_accounts, dim values)
16. journal_entries.posting_rule_version_id FK activation
17. journal_entry_source_links         (journal_entries)

Migration C — expenses
18. expenses                           (economic_entities, accounting_books,
                                        financial_accounts, user)
19. expense_allocations                (expenses, ledger_accounts, dim values,
                                        catalog_items)

Migration D — money movement
20. financial_accounts                 (connections, economic_entities,
                                        ledger_accounts)
21. payouts                            (connections, financial_accounts,
                                        economic_entities, user)
22. payout_lines                       (payouts, orders, order_fees,
                                        order_refunds)
23. bank_statement_imports             (financial_accounts, media_objects, user)
24. bank_transactions                  (financial_accounts, imports)
25. reconciliation_matches             (bank_transactions, user)
26. sales_tax_facts                    (orders, order_lines, order_refunds,
                                        expenses, economic_entities)
27. reporting-only indexes (optional split)
```

Step 18's `financial_account_id` FK means Migration C depends on D, or `expenses.financial_account_id` is added in D. **Recommendation: ship D before C**, or drop the FK from C and add it in D — the milestone order in the issue tracker (expenses before payouts) is a delivery-value order, not a dependency order, and this is the one place they conflict.

All migrations run through `loxep migrate` under the existing advisory lock (ADR-0018). Hand-written SQL is required in at least four places: the two `EXCLUDE USING gist` constraints, the deferred balance constraint trigger, the immutability triggers, and the composite foreign keys. Verify current Drizzle Kit capability at implementation time and drop to SQL rather than weakening any constraint. **Verify `btree_gist` availability in the `timescale/timescaledb-ha:pg18.4-ts2.29.2-all` image before relying on the exclusion constraints**; the fallback is documented above and is genuinely weaker.

### Which existing tables gain columns: none

- **`economic_entities`** — no new columns. **No `accounting_book_id`, not now, not ever.** This is the phase where that column would be added by a well-meaning implementer, and adding it would invert the single most-repeated prohibition in the documentation. Ownership lives in `book_entity_links`, pointing inward.
- **`orders`, `order_lines`, `order_fees`, `order_refunds`, `order_fulfillments`** — no new columns. There is no `orders.journal_entry_id` and no `orders.posted_at`: posting state is a property of the ledger's relationship to the fact, not of the fact. Whether an order has posted is a lookup in `journal_entries` by `posting_key` prefix or in `journal_entry_source_links`, both of which are indexed for it.
- **`inventory_items`, `inventory_movements`, `acquisitions`, `acquisition_costs`, `shipments`** — no new columns. Same rule. In particular there is no `inventory_items.valuation_amount`; valuation is a Phase 5 judgement expressed as journal entries, not a column on a Phase 4 fact.
- **`connections`** — no new columns. Phase 5 creates no scheduled polling of its own; payout ingestion reuses the existing scheduling model with new target types when it arrives, which re-raises [Phase 3's open question 6](../commerce-schema-design/#open-questions) about `monitor_targets` ownership without changing its answer.
- **`media_objects` / `media_links`** — no new columns. Four new `resource_type` values and four new `purpose` values, which is exactly what those columns are for.
- **`application_settings`** — new keys only, under a namespaced `accounting.*` prefix: `accounting.default_book_id`, `accounting.default_entity_id`, `accounting.auto_post_enabled`, `accounting.posting_lag_days`. No DDL.
- **Better Auth tables** — untouched, per ADR-0020.

If implementation discovers a genuine need to alter an existing table, that is a signal to revisit this design, not to quietly add the column.

### Index strategy

Journal lines are the only table here with real growth, and even that is modest: a reseller posting five entries per order at a few hundred orders a month writes low tens of thousands of lines a year. One index per named query, not defensive indexing.

Write and hot paths:

```text
journal_entries    unique(posting_key) where not null      the idempotency probe;
                                                           constraint IS the index
journal_entries    unique(accounting_book_id, entry_number) where not null
journal_entries    index(accounting_book_id, entry_date)   period assembly
journal_entries    index(source_fact_type, source_fact_id) "did this fact post?"
journal_entries    index(posting_rule_version_id) where not null
                                                           rule-impact analysis
journal_lines      index(journal_entry_id)                 entry assembly
journal_lines      index(accounting_book_id, ledger_account_id, id)
                                                           account balance; the
                                                           single most-run query
journal_lines      index(accounting_book_id, economic_entity_id)
                     where economic_entity_id is not null  entity-filtered reports
journal_entry_source_links  index(source_fact_type, source_fact_id)
                                                           reverse provenance
bank_transactions  unique(dedupe_key)                      the import probe
bank_transactions  index(financial_account_id, posted_on desc)
bank_transactions  index(financial_account_id, amount, posted_on)
                     where reconciliation_status = 'unmatched'
                                                           the suggestion probe
                                                           (partial, tiny)
payout_lines       index(payout_id)
payout_lines       index(order_id) where not null          order-to-payout join
fiscal_periods     index(accounting_book_id, starts_on)    period resolution
book_entity_links  index(economic_entity_id, effective_from)
                                                           the routing probe
```

Reporting and resolution:

```text
journal_lines      index(ledger_account_id, currency)
                     where currency <> functional_currency  fx exposure (partial)
ledger_accounts    index(accounting_book_id, account_type)  statement grouping
ledger_accounts    index(accounting_book_id, parent_account_id) where not null
expenses           index(economic_entity_id, expense_date desc)
expenses           index(category, expense_date desc)
expenses           index(status) where status <> 'posted'   posting backlog (partial)
expense_allocations index(expense_id)
expense_allocations index(acquisition_id) where not null
payouts            index(connection_id, paid_at desc)
payouts            index(status) where status <> 'paid'     open settlements (partial)
reconciliation_matches index(bank_transaction_id)
reconciliation_matches index(internal_type, internal_id)
sales_tax_facts    index(jurisdiction_country, jurisdiction_region, occurred_on)
sales_tax_facts    index(liability, occurred_on)            filing-summary grouping
sales_tax_facts    index(order_id) where not null
financial_accounts index(ledger_account_id) where not null
```

`journal_lines index(accounting_book_id, ledger_account_id, id)` is the one that matters most: every balance, every statement line, and every clearing residual is a range scan on it. Including `id` keeps it usable as a covering-ish index for the ordered read without adding `amount`, which would double its size for a marginal gain at these volumes — revisit only if measured.

Not indexed on purpose: `journal_entries.status` (low cardinality, always filtered with a date range), `journal_lines.currency` unpartialled (one value dominates), `ledger_accounts.system_key` (the partial unique already serves it), `expenses.payment_method`.

## Provisional implementation decisions

Every decision in this section is **PROVISIONAL**: implemented per this document's own recommendation under an owner directive, pending review. Each is marked `PROVISIONAL` at the code that implements it, so nothing here can drift out of sight.

Four milestones are recorded, in the order they shipped:

```text
milestone 1  expenses and receipts            2 tables, migration 0006
milestone 2  books, chart, journal            9 tables, migration 0009
milestone 3  posting rules and statements     2 tables + 2, migration 0010
milestone 4  COGS posting                     NO migration — two readers over
                                              tables Phase 4 already shipped
still design only                             9 tables
```

Milestone 2 could not have shipped earlier: it was blocked on all three OWNER-REVIEW-CRITICAL questions, which the owner [answered on 2026-08-12](#owner-answers-2026-08-12--the-three-critical-questions-are-resolved).

### Milestone 1 — what shipped (expenses and receipts)

```text
migration      packages/db/migrations/0006_expenses_and_counterparties.sql
                 (shared with the Phase 6 counterparty milestone)
schema         packages/db/src/schema/expenses.ts    (2 tables, 0 altered)
services       packages/accounting/src/              (@loxep/accounting)
  decimal.ts        exact decimal strings, scaled BigInt, no division
  attribution.ts    the three-rung expense attribution ladder
  codes.ts          EXP-2026-0231 reference-code generation
  posting.ts        the posting SEAM — three constants, two functions, no rows
  expenses.ts       create/update/submit/void, allocations, the invariant
  receipts.ts       media_links attachment, idempotent, plus the missing report
  reports.ts        by entity, by period, unallocated, posting backlog
tests          packages/accounting/test/             (87 tests, real PostgreSQL)
               packages/db/test/schema.test.ts       (deferred-table assertions)
```

### Milestone 1 — the open questions it touched, as implemented

Only these. Everything else was untouched at the time, because nothing had been built that could resolve it.

- **OQ8 (unenforced source-fact references), partially.** The seam between an expense and a future journal entry is a **source-fact identity**, not a column: `('expense', expenses.id)`, exported as `EXPENSE_SOURCE_FACT_TYPE` / `expenseSourceFact()`. `expenses` gains no `journal_entry_id`, no `posting_key`, and no `posted_at`, and a test asserts their absence. This is the recommendation working in the direction it was argued for — because the link is an identity rather than a reference, the seam is *complete today* and the ledger, when it arrives, only has to read. `postingKeyFor()` is deliberately **not** implemented: the key embeds the rule version, and a helper that guessed a version would encode exactly the silent-swallow failure OQ2 warns about.
- **OQ14 (which package owns this), against this document's own recommendation.** Phase 5 recommended expenses in `@loxep/domain`; they shipped in **`@loxep/accounting`**, per [Phase 6's proposed general rule](../services-billing-schema-design/#open-questions) under which expenses fail the inbound-edge test anywhere else. Both documents flag this as the reviewer's first test of that rule. It is a file move to reverse.

### Milestone 1 — divergences from the draft

- **`expenses.status` defaults to `draft`, not `recorded`.** The shipped lifecycle locks a row at `recorded`, so a DDL default of `recorded` would drop an insert that omitted the column straight into the immutable state. `create()` still accepts `recorded` explicitly for the type-it-in-and-done case.
- **Only `draft` is mutable, and there is no `reopen`.** The draft sketches the status column and says nothing about edits. The strict reading was chosen because loosening a lock later is a one-line change while tightening one after a year of silent post-hoc edits means auditing history to find out which numbers were ever true. A recorded expense is corrected by voiding it and recording the corrected fact — the same posture the ledger takes for a posted entry.
- **Over-allocation is REFUSED; under-allocation is allowed.** The design says the sum equality is "a service rule and a reconciliation report, not a constraint". Implementation splits that into the half that is never legitimate and the half that is: a split must land inside the closed interval between zero and the expense's amount, taking the expense's sign as the direction. Under-allocation is a draft and appears in `unallocatedExpenses()`; over-allocation is arithmetic no later edit can make true. The guard runs on **both** sides — adding an allocation, and *reducing an expense's amount below what is already allocated*.
- **`expense_allocations` gains a `num_nonnulls(...) >= 1` target CHECK the draft does not sketch.** An allocation must name at least one of entity, acquisition, catalog item, or channel. It is `>= 1` rather than `= 1` on purpose: these targets are orthogonal dimensions of one split, not alternative kinds of it, so "$40 of this fuel bill belongs to the LLC, against that auction lot" is one row naming two targets. What the check forbids is the row that names nothing.
- **`expenses.acquisition_cost_id` and `expense_allocations.acquisition_id` are REAL foreign keys.** The draft left them as bare `uuid`s because Phase 4 had not migrated; it has (migration 0005), and the draft's own instruction was to make them real in that case. The no-copy rule is unchanged: `acquisition_costs.capitalize = false` rows are still not copied into `expenses`.
- **Four sketched columns are omitted, not stubbed:** `expenses.accounting_book_id`, `expenses.financial_account_id`, `expense_allocations.ledger_account_id`, and `expense_allocations.dimension_value_id`. Each would point at a table that does not exist, which the design itself calls worse than no column. All four are additive.
- **`entity_attribution_source` has three members, not Phase 4's five.** An expense has no connection and no parent lot to inherit from, so `connection_default` and `acquisition_default` would be `CHECK` members no code path could produce — worse than absent, because a reader would believe the path exists.
- **A currency may not be changed while allocations exist.** Allocations carry no currency of their own and are denominated in the expense's, so the edit would silently redenominate every one of them. Clearing the allocations first is the documented path.
- **Receipt attachment is idempotent in `@loxep/accounting`, not in `@loxep/storage`.** `MediaService.addLink` raises `23505` on the 0004 natural key; `ReceiptsService.attach` absorbs that one violation and returns the existing link, because jobs are at-least-once. Teaching the shared media service to swallow conflicts would change behaviour for every other consumer to fix a rule only this one has.
- **`accounting.default_economic_entity` is named but NOT registered.** Registration is an edit to `@loxep/domain`'s shipped settings registry, which this slice does not own; the installation default is a parameter to `resolveExpenseAttribution` instead. The signature does not change when the key is registered.

### Milestone 1 — verified at implementation time

Against drizzle-kit 0.31.10 and `timescale/timescaledb-ha:pg18.4-ts2.29.1-all`, everything generated correctly from the Drizzle schema and **nothing needed hand-written SQL or was weakened**: `num_nonnulls` `CHECK`s, partial indexes with `<>` and `is not null` predicates, `DESC NULLS LAST` index ordering, and `date` columns in `{ mode: "string" }`.

One implementation-level trap worth recording for the next phase: `db.execute(<string>)` returns rows under Drizzle's own type-parser overrides, and a `timestamptz` arrives as a **string**, not a `Date`. Row mappers built over `execute` must convert rather than cast — a cast compiles and then hands a string to a caller whose type says `Date`. `sql.ts` owns `toDate` / `toDateOrNull` / `toCalendarDate` for that reason.

### Milestone 1 — what a reviewer should push back on first

1. **The edit lock.** `draft`-only mutability is stricter than the draft says. It is cheap to loosen and expensive to add later, which is why it was chosen this way — but it is a product decision, not a schema one.
2. **The `>= 1` target check on allocations.** It forbids a row nothing could read, and it is a constraint the draft did not sketch.
3. **`@loxep/accounting` rather than `@loxep/domain`.** A package boundary, and the first live test of Phase 6's proposed domain-to-package rule.
4. **`status` defaulting to `draft`.** Trivial to reverse before data exists, awkward after.

### Milestone 2 — what shipped (books, chart of accounts, journal)

```text
migration      packages/db/migrations/0009_accounting_books_chart_and_journal.sql
schema         packages/db/src/schema/accounting.ts   (9 tables, 0 altered)
services       packages/accounting/src/               (@loxep/accounting)
  currency.ts        the USD-only refusal, and the seam it names
  books.ts           books, the effective-dated entity link, routing + roll-up
  chart.ts           chart CRUD, system-account rules, normalBalanceOf
  chart-template.ts  the code-owned starter chart, copied once per book
  periods.ts         generation, resolution, the four-state close
  journal.ts         draft/post/void/reverse, idempotency, balance, dimensions
  ledger-reports.ts  trial balance, account balance, activity, entity coverage
tests          packages/accounting/test/              (207 tests total, +120)
                 ledger-schema.test.ts   39  the DDL, through raw SQL
                 books.test.ts           27  books, chart, links, routing
                 periods.test.ts         14  generation and closing
                 journal.test.ts         30  posting, idempotency, reversal
                 ledger-reports.test.ts  10  incl. the end-to-end clearing fixture
               packages/db/test/schema.test.ts        (presence, exclusions, triggers)
```

The nine tables are exactly this document's "Migration A": `accounting_books`, `book_entity_links`, `ledger_accounts`, `accounting_dimensions`, `accounting_dimension_values`, `fiscal_periods`, `journal_entries`, `journal_lines`, `journal_line_dimensions`. **No existing table gained a column**, including `expenses`.

### Milestone 2 — the owner's three answers, made physical

```text
1 book granularity     book_entity_links(link_role, effective_from/to) plus an
                       EXCLUDE USING gist that permits at most ONE
                       posting_primary book per entity per day. Routing walks
                       the entity, then its ANCESTORS: a child entity with no
                       link of its own posts into its parent's book, which is
                       what "included in / part of" means in ledger terms.
                       linkEntity() enforces the rule in BOTH directions —
                       a child may not name a different book than its parent's,
                       and a parent may not be linked while a descendant posts
                       elsewhere over the same dates.
2 rule mutability      posted entries are immutable (BEFORE triggers on entries
                       and lines); corrections are reverseEntry(), which posts a
                       negated linked entry and stamps the original `reversed`.
3 functional currency   USD-only refused at the service boundary with an error
                       naming the seam; journal_lines still carries currency,
                       amount, functional_currency, functional_amount, fx_rate,
                       fx_rate_source, fx_rate_at, all populated (unity) rather
                       than null. No CHECK pins USD into the DDL.
```

### Milestone 2 — the open questions it resolved, as implemented

- **OQ4 (per-currency balance enforcement) — the recommendation, exactly.** A `DEFERRABLE INITIALLY DEFERRED` constraint-trigger pair (`journal_lines_balanced`, `journal_entries_balanced`) re-sums the affected entry at COMMIT, per transaction currency and again per functional currency, and refuses a posted entry with no lines. Drafts are exempt. The service checks the same invariant first so the ordinary mistake fails at the call site with the offending currency and total; the trigger is the guarantee, not the error message.
- **OQ5 (soft close) — the recommendation, with the authorization question left to the owner.** All four states ship. `closed`/`locked` refuse every posting; `soft_closed` refuses an ordinary one and permits an explicitly authorized backdated posting that MUST carry `is_backdated = true`. Enforcement is the service **and** a `BEFORE INSERT OR UPDATE` trigger, which additionally verifies that a posted entry's stamped period is the one whose range contains its `entry_date`. **Whether backdating is `admin`-only is still open**: `@loxep/accounting` models no roles and takes an explicit `allowBackdated` parameter, so gating it is the web layer's decision and `admin`-only remains the recommendation.
- **OQ6 (signed amount) — the recommendation.** One signed `amount`; debit/credit are derived once, in `ledger-reports.ts`, as `greatest(amount, 0)` / `greatest(-amount, 0)`.
- **OQ7 (entity as a column) — the recommendation.** `journal_lines.economic_entity_id` is a real foreign key; classes/departments use the generic dimension tables with the junction. Required dimensions are enforced at the posting transition, never on a draft.
- **OQ8 (unenforced source-fact references) — the recommendation, now in both directions.** `journal_entries.source_fact_type` / `source_fact_id` carry no foreign key, a `num_nonnulls(...) <> 1` CHECK refuses a half-written stamp, and `findBySourceFact()` answers "did this fact post?" without one. `expenses` still gains no `journal_entry_id`.
- **OQ12 (cash-basis label) — the recommendation.** `accounting_basis` ships, defaults to `accrual`, and nothing branches on it. A book may be labelled `cash`; no cash-basis rule set exists, and the label is honest rather than aspirational.
- **OQ13 (closing entries) — the recommendation.** None are stored. There is no retained-earnings account in the shipped chart, and `opening_balance_equity` is the only equity account seeded.
- **OQ14 (package ownership) — the recommendation, this time.** Books, chart, dimensions, periods, the journal, and the ledger read models are all in `@loxep/accounting`, which is what OQ14 recommends. Expenses remain there too, which is still the divergence milestone 1 recorded.

OQ9, OQ10, and OQ11 remain **untouched**: they belong to payouts, tax facts, and bank import, none of which exist.

### Milestone 2 — divergences from the draft, and decisions it did not sketch

- **`journal_entries.posting_rule_version_id` is OMITTED** (activated by migration 0010, one milestone later, exactly as the plan below predicted)**.** `posting_rule_versions` does not exist, and a column pointing at a table that does not exist is worse than no column — this document's own rule. Its migration plan already activates that foreign key in "Migration B", together with the paired `(entry_source = 'posting_rule') = (version_id is not null)` CHECK. `entry_source`'s CHECK keeps its unreachable `posting_rule` member anyway, following the `expenses.status = 'posted'` precedent; the service refuses to write it.
- **The `posted` → `reversed` status stamp is a WHITELISTED update, and the draft does not reconcile that with immutability.** The draft says posted entries are immutable *and* gives `journal_entries.status` a `reversed` member, which nothing could ever set. The trigger permits exactly one update on a posted row — `status` to `reversed` with `updated_at`, compared through `to_jsonb(NEW) - 'status' - 'updated_at' = to_jsonb(OLD) - …` so that nothing else can ride along. A reversed entry's **lines are untouched and still count in every balance**; the reversal's own lines net them out, and `reversed` is a marker rather than a report filter.
- **`journal_lines` immutability guards INSERT as well as UPDATE and DELETE.** The draft says posted lines are immutable, which reads as "no edits". Adding a *balanced pair* of lines to a posted entry would slip past the deferred balance check while restating a month someone has already read, so lines are written while the entry is a draft and the entry is posted afterwards. The posting service follows the same order.
- **Reversing a reversal is REFUSED (the draft is silent).** A retried reversal is idempotent and returns the first one; reversing the reversal itself raises. A double negation is indistinguishable from the original entry while carrying provenance that says otherwise, and the honest expression of "we reversed that by mistake" is a fresh entry stating what is true.
- **`buyer_fee_income` is a system account the draft's key table does not list.** Phase 3 shipped `order_fees.fee_direction`, which its own design did not have: a `seller_charge` is a deduction from proceeds and posts to `marketplace_fees`, while a `buyer_surcharge` is money the buyer paid that is already inside the order total. Posting the second as a fee expense would understate income by exactly the amount the buyer covered — the error every Phase 4 contribution read model already avoids. The chart needs an income account for it or the P&L and the item-level contribution figure disagree by a real amount.
- **`ledger_accounts.parent_account_id` is a COMPOSITE foreign key.** The draft sketches a single-column self-reference; the same denormalized-book trick that protects `journal_lines` makes a cross-book roll-up header structurally impossible, and costs nothing because `MATCH SIMPLE` skips the constraint when the parent is null.
- **`journal_entries.fiscal_period_id` is a COMPOSITE foreign key too**, for the same reason: an entry stamped with another book's March is a class of error no read model could detect.
- **Both of `journal_lines`' entry references cascade.** The draft cascades only the single-column one. Mixing a cascading and a non-cascading reference to the same parent row makes deleting a draft depend on referential-trigger firing order; making both cascade removes the question, and only drafts are ever deleted.
- **`accounting_books.next_entry_number > 0` and `journal_lines.line_number > 0` are CHECKs the draft does not sketch.** A counter at zero mints numbers a later increment repeats, which is exactly the gaplessness the counter exists to provide.
- **A fiscal year is labelled by the calendar year it STARTS in.** `FY2026` for a book running July 2026 → June 2027. Both conventions exist; this one makes `fiscal_year` derivable from `starts_on` without knowing the book's configuration, and degrades to the obvious answer for a January start. Period generation is one SQL statement anchored on the year's start date, so a book starting on the 31st still produces contiguous, non-overlapping months.
- **`createBook` seeds the chart and one fiscal year by default.** The three are useless apart, and the chart and periods are separate idempotent transactions so that a failure while seeding twenty accounts leaves a usable book rather than none.
- **A system account may not be ARCHIVED.** The draft says it may never be deleted; archiving has the same effect on rule resolution, so it is refused with the reason. Renaming, re-coding, and reparenting stay free.
- **A system key must be a member of the closed `LEDGER_SYSTEM_KEYS` set.** An invented handle is one no rule will ever resolve, which reads as working configuration and behaves as a silent suspense posting.
- **`accounting.default_book_id` is NAMED but not registered**, exactly as `accounting.default_economic_entity` was in milestone 1: the installation default is a parameter, and registering the key in `@loxep/domain`'s settings registry is an edit this slice does not own.

### Milestone 2 — verified at implementation time

Against **drizzle-kit 0.31.10 / drizzle-orm 0.45.2** and `timescale/timescaledb-ha:pg18.4-ts2.29.1-all` (PostgreSQL 18.4), composite foreign keys, partial unique indexes, `num_nonnulls` CHECKs, expression index predicates, and explicit constraint names all generate correctly, and **nothing was weakened to fit**. Four constraints are beyond drizzle-kit and are hand-written at the end of the migration: the two `EXCLUDE USING gist` constraints, the deferred balance constraint-trigger pair, and the immutability plus period-guard triggers.

**`btree_gist` is available in the deployment image** (version 1.8, verified before relying on it), so the design's documented weaker fallback — a partial unique on open-ended rows plus a service-level overlap check — was **not** needed and is not used.

One trap worth recording: a `daterange` with an inclusive upper bound of `'infinity'::date` is legal and canonicalizes to `[from,infinity]`, which is what makes the open-ended half of the routing exclusion work.

### Milestone 2 — what a reviewer should push back on first

1. **The `posted` → `reversed` whitelist.** It is the only mutation a posted entry ever receives, and the draft did not say it should exist. The alternative is leaving `reversed` unreachable and discovering a reversal only through `reverses_entry_id`.
2. **Refusing to reverse a reversal.** Defensible either way; the draft is silent.
3. **The roll-up enforcement in `linkEntity`.** It refuses configurations an operator might reasonably want (a DBA with its own book while its parent has one), on the strength of the owner's answer that a child's book IS its parent's. Loosening it is a service change with no migration.
4. **`buyer_fee_income` in the shipped chart.** A system key the design's own table does not list, added because Phase 3's shipped reality requires it.
5. **Fiscal years labelled by their starting year.**

### Milestone 2's admin surface (`/finance/books`, loxep-cmo)

The nine tables and the `@loxep/accounting` services above shipped with zero UI callers, the same situation milestone 1 was in before `/finance/expenses` existed. `/finance/books` closes that gap: a `DataTable` list (code, name, functional currency, active entity-link count, the fiscal period covering today), a create dialog, and a book detail page composing entity-link management, fiscal-year generation, period open/close/reopen, and a trial-balance panel. Every write goes through `apps/web/src/server/books-functions.ts` behind `requireAdmin`; reads (including the trial balance) are `requireSession`.

Two things worth recording because they are compositional rather than schema decisions:

- **`createBook` is called once, unmodified, from the UI's create-book handler.** The service already composes the row insert, the code-owned starter chart (`seedDefaultChart`), and the first fiscal year (`generateFiscalYear`) behind `seedChart`/`generatePeriods`, both defaulting `true`. The surface does not re-sequence those calls or offer a currency picker — functional currency stays fixed at USD (owner answer 3) with the dialog naming the seam rather than hiding it.
- **No backdating UI exists.** OQ5's authorization question — whether `allowBackdated` is `admin`-only or member-reachable — is still open (see Milestone 2's "what shipped" above); the period-close dialog offers `soft_closed`/`closed`/`locked` as ordinary transitions and nothing calls the backdated-posting path, so the open question stays open rather than being answered by omission of a checkbox nobody asked for.

This closes the dashboard Financial band's "no books surface to link to yet" gap (`apps/web/src/features/dashboard/components/financial-band.tsx`): its no-book Empty state now links to `/finance/books`, and the e2e suite (`apps/web/e2e/books.spec.ts`) asserts the band actually fills in once a book and its first fiscal year exist.

### Milestone 3 — what shipped (posting rules and statements)

```text
migration      packages/db/migrations/0010_posting_rules_and_source_links.sql
schema         packages/db/src/schema/accounting.ts   (4 tables, 1 column)
               packages/db/src/schema/expenses.ts     (3 columns, 1 CHECK widened)
services       packages/accounting/src/               (@loxep/accounting)
  source-facts.ts           the closed normalized shape a rule can see, and the
                            four readers that exist (order, order_fee,
                            order_refund, expense)
  posting-rules.ts          rules, immutable versions, templates, save-time
                            validation, first-match-wins resolution
  posting-rules-template.ts the shipped rule set, code-owned like the chart
  posting-engine.ts         evaluate -> post / no-op / reverse-and-repost
  statements.ts             income statement and balance sheet
  journal.ts                EXTENDED: entry_source `posting_rule` with its
                            version stamp, and source links written inside the
                            posting transaction
tests          packages/accounting/test/              (250 tests total, +43)
                 posting-rules.test.ts    15  validation, versioning, the
                                              database-level freeze
                 posting-engine.test.ts   19  the five idempotency behaviours,
                                              fee_direction, the backlog
                 statements.test.ts        9  incl. the end-to-end reconciliation
               packages/db/test/schema.test.ts        (+3: the column, the CHECK,
                                              the triggers, the 63-byte limit)
```

The four tables are exactly this document's "Migration B": `posting_rules`,
`posting_rule_versions`, `posting_rule_lines`, and `journal_entry_source_links`.
Alongside them, the columns two earlier migrations deferred **to the milestone
that would read them** finally land: `journal_entries.posting_rule_version_id`
with its paired biconditional `CHECK`, `expenses.accounting_book_id`, and
`expense_allocations.ledger_account_id` / `dimension_value_id`.
`expenses.financial_account_id` is still absent, for the unchanged reason that
`financial_accounts` does not exist.

### Milestone 3 — the design's own checklist, item by item

```text
same fact posted twice        one entry; posting_key is the retry probe
fact re-synced unchanged      NO-OP; source_fact_fingerprint is the free probe
fact changed after posting    reverse + repost, never mutation
re-post under a new version   reverse + repost, new key, old stamp preserved
retried reversal              idempotent (milestone 2, unchanged)
rule set tested with the      every shipped template resolves only seeded
  chart template              system keys, asserted at save time AND in a test
clearing invariant end to end  order + fees + surcharge + refund + expense,
                              posted BY THE RULES, with the balance sheet and
                              the income statement agreeing to the micro-unit
```

### Milestone 3 — divergences from the draft, and decisions it did not sketch

- **PROVISIONAL: the posting key carries the FINGERPRINT.** The design's formula is `'pr:' || rule_code || ':v' || version || ':' || type || ':' || id`, and its argument for the version being inside it is exactly right: without it, a deliberate re-post under a corrected rule is swallowed by `unique(posting_key)` and the operator sees a successful job and an unchanged ledger. **That argument applies unchanged to the design's own primary re-post scenario** — a fact that changed while the rule did not. The version is identical, so the key is identical, so the correction is swallowed the same way. The implemented key appends `':' || left(fingerprint, 12)`. Idempotency is unchanged; reversal-and-repost becomes expressible at all. This is the one place where the document's stated formula could not do what the document's stated behaviour requires.
- **PROVISIONAL: the buyer-surcharge entry debits `suspense`, not `marketplace_clearing`.** The sale rule debits clearing for the provider-asserted `total`, which already contains the surcharge; debiting clearing again would count the money twice and leave a permanent clearing residual — destroying the one number that is supposed to be zero. The sale rule's `remainder` plug parks the unrecognized part of the total in `suspense`, and the surcharge entry clears it. That makes suspense a work queue for orders whose components do not add up, which is the role this document gives it, and makes an uningested surcharge visible rather than quietly inflating revenue.
- **PROVISIONAL: an expense's funding side credits `opening_balance_equity`.** `financial_accounts` does not exist, so an expense paid from an unmodeled account is owner-funded — which is what that account means in practice. Crediting `suspense` instead would make the plug permanently non-zero for ordinary correct activity and train an operator to ignore it. The banking milestone reclassifies by posting the real account.
- **PROVISIONAL: an unmapped expense category posts to `suspense` through a catch-all rule.** The shipped chart carries a handful of expense accounts and an operator's categories outgrow them within a month. The alternative — refusing to post — leaves the expense invisible in the ledger *and* in the backlog, because the backlog is "facts with no entry".
- **The template balance check is SYMBOLIC, not numeric.** The design says a version with no `remainder` line "is checked for balance at rule-save time against a synthetic fact". One set of numbers would pass a template that balances only when shipping and tax happen to be zero. Each amount is decomposed into independent components (`total = subtotal + shipping + tax − discount` for an order) and the whole combination must cancel identically.
- **Placeholders are a closed set per fact type, validated at save.** `{buyer_email}` fails when the rule is written rather than rendering as literal text on a year of journal lines.
- **`posting_rules.current_version_id` is a real foreign key**, expressed with drizzle's lazy `AnyPgColumn` reference because the two tables point at each other. The alternative was one of the two constraints living in hand-written SQL, outside the snapshot.
- **Rule-version immutability is enforced by a trigger, not only by the service, and the two have different strengths.** The database freezes a version referenced by ANY journal entry — whitelisting only `status` and `effective_to`, which is the supersede lifecycle rather than an edit of the text — and freezes its lines against `INSERT` as well as `UPDATE` and `DELETE`. The service is stricter: an active rule is never edited in place, only superseded by version N+1.
- **The engine honours `expense_allocations.ledger_account_id` at build time.** The rule model has no `amount_source` for "per allocation" — a line template is deliberately not a loop — so an expense whose splits name accounts has its debit side replaced by one line per allocation, each carrying that allocation's entity and dimension value. This is why those two columns ship in this migration rather than a later one, and the fingerprint counts them so editing a split reverses and reposts.
- **Facts can be INELIGIBLE, which is neither an error nor a missing rule.** A cancelled order, a pending or failed refund, and a `draft` or `void` expense are recorded as unpostable with a reason. Posting revenue for a cancelled order would be a real misstatement produced by a correct-looking rule.
- **Dates convert from `timestamptz` to `date` in UTC**, deliberately, so the same order posts to the same month on every machine. A per-book local-midnight setting is a later, explicit decision rather than a silent dependency on `TZ`.
- **The unpostable backlog ships as a read model over the facts**, exactly as the design requires, with `explainFact()` answering "which rule would fire, and why not the others" — the diagnostic that makes first-match-wins debuggable.
- **`decimal.ts` gains ONE rounding function.** `multiplyDecimals` rounds half away from zero, because `amount_source × multiplier` with a `0.5` multiplier on an odd number of micro-units genuinely cannot be exact. It is the only rounding in the package, and the `remainder` plug absorbs the residue so a rounded template still balances to the micro-unit.

### Milestone 3 — what a reviewer should push back on first

1. **The fingerprint in the posting key.** It diverges from a formula this document states verbatim. The argument is that the formula cannot express the behaviour the same document requires, but the reviewer should confirm the divergence rather than inherit it.
2. **`suspense` as the sale rule's plug and the buyer-surcharge counter-account.** It makes suspense routinely non-zero between ingesting an order and ingesting its fees, which is a deliberate trade of "quiet and wrong" for "visible and explainable".
3. **`opening_balance_equity` as every expense's funding side**, and the catch-all expense rule that posts to `suspense`.
4. **The engine's allocation split**, which is behaviour the declarative model cannot express and therefore lives in code.
5. **Whether a cancelled order should post nothing, or post and be reversed** when it was cancelled after payment.

## Milestone 4 — COGS posting, and the acquisition seam

### Milestone 4 — what shipped

**No migration.** The rule model's `CHECK` already admitted both fact types and `posting_rule_lines.amount_source` already carried `cost_basis` and `quantity_times_basis`; the chart template already seeded `inventory` and `cogs`. Everything this milestone needed was activated by earlier ones, which is what the `CHECK`-carries-every-fact-type decision was for.

```text
services       packages/accounting/src/
  source-facts.ts           TWO NEW READERS: acquisition_cost and
                            inventory_movement, plus the per-kind ineligibility
                            rules that make the double-count seam explicit
  posting-rules-template.ts FOUR NEW RULES: acquisition_cost_capitalized,
                            acquisition_cost_expensed, cogs_on_depletion,
                            cogs_depletion_reversed
  posting-rules.ts          the symbolic balance basis for both fact types
  posting-engine.ts         a fact that became INELIGIBLE after posting now has
                            its entry reversed rather than left standing
  decimal.ts                proRataShare(), the one division this package has
tests          packages/accounting/test/              (264 tests total, +14)
                 cogs-posting.test.ts     13  the buy side, the sell side, the
                                              partial-depletion arithmetic, and
                                              the acquisition seam
                 statements.test.ts       10  (+1: the buy -> hold -> sell
                                              reconciliation)
```

The two readers close the gap [the flipping-lifecycle design](../flipping-lifecycle-design/#acquisitions-to-accounting--the-gap) called the biggest hole in the loop: money spent on goods now reaches the ledger.

### Milestone 4 — the shape, stated once

```text
BUY    acquisition_cost, capitalize = true
         DR inventory                 an ASSET; never touches the P&L
         CR opening_balance_equity    the same funding side an expense uses

       acquisition_cost, capitalize = false
         DR suspense                  posted where it sits, never copied into
         CR opening_balance_equity    `expenses` (this document's own rule)

HOLD   inventory_movement, receipt    NOTHING. The dollar is already in
                                      inventory; posting the intake as well
                                      would debit the asset twice.

SELL   inventory_movement, depletion_sale
         DR cogs                      the FROZEN basis, apportioned exactly
         CR inventory                 the asset returns to zero, not to a residue

UNDO   inventory_movement, reversal of a depletion_sale
         DR inventory / CR cogs       at the basis the reversed depletion carried
```

Every other movement kind is deliberately **unposted and says why**, which is the backlog model applied to a fact type most of whose rows are not accounting events at all: a transfer changes no value; a `return_in` has no writer in the product yet and no stated basis policy; and `adjustment_out` / `shrinkage` / `disposal` / `consumption` are write-offs, whose value is exactly the valuation judgement [this phase does not form](#what-phase-5-does-not-create).

### Milestone 4 — contradiction 2, resolved PROVISIONAL

[Contradiction 2](#contradictions-and-tensions-found-in-existing-documentation) asked for a decision: the roadmap's Phase 5 bullets said nothing about COGS posting while this design posts it, and the contradiction offered two ways out — add the bullet, or move the assignment. **Taken per this document's own recommendation, and marked PROVISIONAL: COGS posting from inventory depletion is Phase 5, the roadmap bullets now say so, and the rules above are the implementation.** What is emphatically *not* taken with it is inventory *valuation*: revaluation, lower-of-cost-or-market, and write-down policy remain unformed, which is why a `disposal` movement posts nothing rather than debiting an invented loss account.

### Milestone 4 — divergences and decisions the draft did not sketch

- **PROVISIONAL: a capitalized acquisition cost credits `opening_balance_equity`.** The same choice and the same reasoning as the expense rules — `financial_accounts` does not exist, so a purchase paid from an unmodeled account is owner-funded. Splitting the two (expenses to equity, purchases to suspense) would make the plug account permanently non-zero for the single largest category of a reseller's ordinary, correct spend, which is the failure the expense decision already refused.
- **PROVISIONAL: a NON-capitalized acquisition cost posts to `suspense`.** This document says such a row is posted "directly from where they already are" and does not say to what. The rule model cannot route it well: the predicate set specified for this fact type has no `cost_type`, so a declarative rule genuinely cannot tell mileage from a non-capitalized repair part. It therefore takes the same answer the unmapped-expense catch-all already ships — visible in a named report, replaced the moment an operator writes a rule naming their own account.
- **The COGS amount is apportioned by CUMULATIVE-SHARE DIFFERENCING.** A movement's basis is `share(L, depleted-through-this-movement, Q) − share(L, depleted-before-it, Q)`, where `share` is the two-bucket case of the same largest-remainder distribution `@loxep/inventory` uses. Apportioning each movement independently would leave a fully depleted item's shares summing to slightly less than its landed cost, and `inventory` holding a micro-unit forever. Differencing makes the last depletion take the residue, so the asset returns to exactly zero — asserted by a test that depletes a 100.000000 basis across three units.
- **A `reversal` movement posts the inverse, and only when it reverses a `depletion_sale`.** `@loxep/inventory` corrects an append-only ledger with reversal rows, and a depletion that did not happen must not leave COGS overstated while the stock comes back. The basis a reversal carries is the *reversed* movement's, fixed by that movement's place in the depletion sequence.
- **Earlier depletions count toward the sequence whether or not they were later reversed.** Renumbering them would change the fingerprint of every LATER movement, cascading one reversal into a chain of reposts for facts that did not change.
- **A foreign-currency CAPITALIZED cost is ineligible, not converted.** `@loxep/inventory` excludes such a cost from landed cost rather than converting it (its open question 8), so that money is in no item's basis and no depletion would ever relieve it. Debiting `inventory` for it would create an asset that can only grow. It enters the backlog with the reason named.
- **A fact that became INELIGIBLE after posting now has its entry reversed.** This is a behaviour change to the shipped engine and it is what makes the acquisition seam hold: an expense that was recorded, posted, and then voided because the money really bought goods must not leave its expense entry standing while the promoted `acquisition_cost` debits inventory. It is the same event as "the fact changed after posting" and gets the same treatment. It also, incidentally, corrects an order cancelled after it posted.
- **`expenses.acquisition_cost_id` gains its first reader.** The `acquisition_cost` reader links the expense that names it as a `journal_entry_source_links` row with role `evidence`, which is [the flipping design's OQ2 recommendation (a)](../flipping-lifecycle-design/#open-questions) — the supersession pointer — made visible from the ledger side. Nothing yet *writes* the column; the void-and-promote UI that will is that design's work, and this milestone tests the seam by writing the pointer the way that path would.
- **`decimal.ts` gains its second and last rounding function**, `proRataShare`, exactly as that file predicted it would when a posting engine needed largest-remainder distribution. It lives here rather than being imported from `@loxep/inventory`, because this package must not acquire a package edge to reach one function.

### Milestone 4 — what a reviewer should push back on first

1. **`suspense` as the account for non-capitalized acquisition costs.** It is defensible and it is a guess about what those rows mean.
2. **Reversing on ineligibility.** It makes `evaluateFact` write to the ledger on a path that reports `unpostable`, which reads oddly until you see the double-count it prevents.
3. **Posting nothing for `disposal` and `shrinkage`**, which leaves inventory overstated for genuinely lost stock until a valuation milestone exists. The alternative is inventing a loss account this phase declined to form a policy for.
4. **Cumulative-share differencing**, whose per-event numbers can differ by one micro-unit from `profitability.ts`'s when an item depletes partially across several events. The totals always agree; the per-event split is order-dependent by construction, because the engine sees one movement at a time.

### Milestone 5 — the pump (loxep-6fm)

**Implementation-status correction.** Through milestone 4, `createPostingEngine`/`evaluateFacts` shipped complete and tested but had **zero runtime callers** — `@loxep/app` did not depend on `@loxep/accounting`, no worker task posted facts, and no web action did either (WEAVE AUDIT 2026-08 finding 1, `apps/docs/src/content/docs/product/weave-audit-2026-08.md`). Every fact this document's rules describe — a sale, a fee, an expense, an acquisition cost, a depletion — reached its own domain table and stopped there, one hop short of the ledger. That is now closed:

```text
services   packages/app/src/accounting-posting.ts
  accounting.post-facts     a Graphile Worker cron task, the same thin-
                             wrapper shape as `health.sweep`/
                             `infrastructure.gatus-push`: this module owns
                             the task/cron definition, `@loxep/accounting`'s
                             engine owns the posting mechanics
tests      packages/app/test/accounting-posting.test.ts
  4 tests: task/cron shape, a posted fact fills the Financial dashboard
  band's own query, idempotency (a redelivered fact AND a repeated whole-
  sweep run), and the archived-book gating case below
```

- **Trigger mechanics: cadence sweep, PROVISIONAL.** This document names `accounting.default_book_id`, `accounting.default_entity_id`, `accounting.auto_post_enabled`, and `accounting.posting_lag_days` as `application_settings` keys (see "Migration plan sketch" above) but is otherwise silent on whether posting is event-driven or cadence-driven. Absent a named answer, the pump runs `evaluateFacts` over `unpostedFacts` on a recurring 5-minute cron, mirroring `health.sweep`'s own precedent — PROVISIONAL, and on-write enqueueing from the web actions that create facts (WEAVE AUDIT finding 1's own "STRETCH" list) remains a future latency improvement layered on top of the sweep, not a replacement for it.
- **Rule seeding folded into the sweep, PROVISIONAL.** `DEFAULT_POSTING_RULES` (`posting-rules-template.ts`) are global (`posting_rules.accounting_book_id` is nullable-and-normally-null) but `PostingEngine.seedDefaultRules()` also had zero callers outside tests. Rather than invent a separate admin action this bead does not own, the sweep calls `seedDefaultRules()` every run; it is idempotent by rule code and never touches a rule an operator has since edited.
- **A genuine engine-contract gap, fixed:** an entity could route to an ARCHIVED (disabled) book — Phase 5's toggleable-books answer (`accounting_books.status`, `archiveBook`) — and `evaluateFact` would let `journal.postEntry`'s archived-book guard throw instead of returning `unpostable`, which would have aborted an entire sweep on one disabled book. `posting-engine.ts` now checks the routed book's status before attempting to post and degrades to the same `no_route` backlog outcome a missing link produces (see that file's "GAP FIX (loxep-6fm)" comment).
- **Not built in this bead:** the posting-backlog panel on `/finance/overview`, and trial-balance drill-down to journal lines — both remain design-only/UI work, tracked separately under loxep-6fm.

### What is still design-only

**Nine of this document's twenty-two tables**, and every capability that depends on them:

```text
financial_accounts, payouts, payout_lines
bank_statement_imports, bank_transactions,
  reconciliation_matches
sales_tax_facts
```

Consequently there is still **no payout or clearing settlement, no bank import, no reconciliation, and no tax fact**. `shipment` also remains a `CHECK` member with no reader, and a rule naming a fact type nothing can read is refused at save time with the missing reader named. `packages/db/test/schema.test.ts` asserts each absent table name, so an accidental `payouts` fails a test rather than quietly deciding the settlement model.

**COGS-on-depletion is no longer among them.** Milestone 4 built the `acquisition_cost` and `inventory_movement` readers and the four rules that consume them, resolving [contradiction 2](#contradictions-and-tensions-found-in-existing-documentation) provisionally in favour of "COGS posting is Phase 5". Inventory **valuation** — revaluation, lower-of-cost-or-market, write-down policy — is still unformed and is why several movement kinds deliberately post nothing.

The clearing-account pattern was **already proven by hand** in milestone 2 — `ledger-reports.test.ts` posts an order, its fees, a refund, a depletion, a payout, and a bank deposit and asserts that `marketplace_clearing`, `facilitator_tax_clearing`, and `undeposited_funds` all return to exactly zero. Milestone 3 proves the same shape **through the rules**: `statements.test.ts` seeds an order, a seller fee, a buyer surcharge, a refund, and an expense, posts all five through the engine, and asserts that suspense returns to zero, that the balance sheet balances to the micro-unit, that its current earnings equal the income statement's net income, and that re-running every fact changes nothing.

## Open questions

Each item is a genuinely unresolved decision with a recommendation, not a placeholder. **The first three are OWNER-REVIEW-CRITICAL**: they are the accounting-shape decisions that are hardest to change once a single entry is posted, and each one silently invalidates historical data if it is reversed later.

### Owner answers (2026-08-12) — the three critical questions are RESOLVED

1. **Book granularity**: books are **toggleable per economic entity**, and entities must be relatable as *included-in/part-of* others — an assumed name's activity must be viewable on its own while its actual totals and financial impact land in the parent company's book. This ratifies the recommended `book_entity_links` shape (scope-of-inclusion, effective-dated, `posting_primary`/`reporting_only`) with the concrete reading: a child entity's `posting_primary` book is its parent's book, and per-entity views are reporting slices over entity attribution, not separate ledgers. Onboarding should default to one book per top-level entity.
2. **Posting-rule mutability**: **immutable versions; corrections are always reversal plus repost** — the owner confirms this matches the journal-entry pattern they use elsewhere, and accepts the entry-count cost.
3. **Functional currency**: **USD-only for the initial build**, defaulted per book, with the multi-currency seam (per-line frozen conversion, `functional_amount`) kept in the schema so other currencies can be wired later without restatement. No period-end revaluation, as recommended.

Phase 5 implementation is unblocked on these three; the remaining open questions below keep their recommendations and are resolvable during implementation per the provisional-decision policy.

**OQ4, OQ5, OQ6, OQ7, OQ8, OQ10, OQ12, OQ13, and OQ14 have been implemented per their own recommendation and marked PROVISIONAL** (see [Provisional implementation decisions](#provisional-implementation-decisions)). OQ10 joined them in milestone 3: the shipped sale rule credits `facilitator_tax_clearing` and never `sales_tax_payable`, so facilitator-collected tax passes through a clearing account that nets to zero once the payout settles and never touches P&L — the recommendation, made physical, before `sales_tax_facts` exists to record the liability distinction in its own right. OQ9 and OQ11 remain untouched and fully open, because financial accounts and bank import do not exist. Every question is retained verbatim below, because the recommendation is not the same thing as the answer and the review needs the original reasoning — and because OQ5 still contains one genuinely unanswered part: whether backdating into a soft-closed period is `admin`-only.

1. **OWNER-REVIEW-CRITICAL — Book granularity and `book_entity_links` semantics.** How many books does a real installation have, and does the entity link *route* postings (scope of inclusion) or merely *describe* contents (reporting label)? *Recommendation: scope of inclusion, effective-dated, with `link_role in ('posting_primary','reporting_only')` and an exclusion constraint guaranteeing at most one primary book per entity per day; facts with no entity fall back to an installation default book, and facts with neither enter an unpostable backlog rather than being guessed into a book.* Routing has to live somewhere, and every other candidate location — a single default book, the posting rule, or the connection — either fails on the second book or re-introduces the mutable-configuration-rewrites-history defect Phase 3 explicitly rejected. The residual question the owner must answer is the practical one: is the intended installation one book containing the LLC and its DBAs plus a second book for personal activity, or one book for everything, or one per legal entity? The schema supports all three, but the *default* the product ships and the onboarding flow it builds should match reality, and getting it wrong means operators create the wrong number of books before there is any data to migrate.

2. **OWNER-REVIEW-CRITICAL — Posting-rule mutability and the re-post policy.** Are rule versions immutable once referenced, and when a source fact changes, does the ledger reverse-and-repost or mutate the existing entry? *Recommendation: versions are immutable once any entry references them; corrections are always reversal plus a fresh entry under the current version; the rule version is embedded in `posting_key` so a deliberate re-post cannot be swallowed by the idempotency unique; `source_fact_fingerprint` makes the no-op case free.* Mutation is cheaper and produces a tidier-looking ledger, and it is wrong for three reasons that compound: it rewrites statements someone has already read, it is impossible against a closed period, and it destroys the only record of what was believed when. The cost of the recommendation is real and should be acknowledged — a book with many corrections accumulates three entries per corrected fact, and the entry count is roughly double what a mutating system would show. The owner should confirm that is acceptable before the first rule fires, because converting a mutating ledger to a reversing one afterwards means reconstructing history that was never written down.

3. **OWNER-REVIEW-CRITICAL — Functional currency, and whether it can ever change.** Each book declares one functional currency, every `journal_lines.functional_amount` is denominated in it, and every statement is produced in it. *Recommendation: functional currency is set at book creation and is effectively immutable; conversion happens at posting with the rate frozen on the line; operational tables never store a converted amount; period-end revaluation of open foreign-currency balances is out of scope and reported as an honest gap rather than an invented policy.* This resolves [Phase 3 open question 4](../commerce-schema-design/#open-questions) and [Phase 4 open question 8](../inventory-schema-design/#open-questions), both of which deferred conversion here without naming the mechanism. The owner needs to confirm two things: that the installation's books are single-currency in the sense that matters (an operator buying in GBP and selling in USD still has a USD book, which is fine), and that "no revaluation" is acceptable — because a book holding a foreign-currency bank account will show a balance sheet whose foreign accounts are stated at historical rates, which is defensible for a small operator and is not what a larger one would expect. Changing the functional currency later requires restating every functional amount ever written; there is no additive escape.

4. **How is per-currency balance enforced at the database?** *Recommendation: a `DEFERRABLE INITIALLY DEFERRED` constraint trigger on `journal_lines` that re-sums the entry per currency and per functional amount at COMMIT, combined with immutability triggers so it only fires on the draft-to-posted transition.* A deferred `CHECK` is not available in PostgreSQL — that is worth stating because it is the first thing anyone tries. If a reviewer judges triggers too heavy for the initial codebase, the fallback is the service rule plus integrity tests, accepting that the ledger's core invariant is then only as strong as code review — the identical trade [Phase 4 open question 2](../inventory-schema-design/#open-questions) made for append-only movements, with higher stakes.

5. **Soft close or hard close, and who may backdate?** *Recommendation: four states (`open`, `soft_closed`, `closed`, `locked`) with soft close as the default post-period state, backdated postings permitted into `soft_closed` only through an explicit authorized path that flags the entry and writes `audit_events`.* Provider facts genuinely arrive late and the alternative — posting a March fee into April — silently misstates two periods. The owner should decide whether the authorization is `admin`-only or available to `member`, which is the first place in the product where the deployment role distinction has real accounting consequences.

6. **Signed `amount` or `debit_amount`/`credit_amount` columns on `journal_lines`?** *Recommendation: one signed column, positive is debit, with debit/credit derived at presentation.* Every balance becomes `sum(amount)` instead of a two-column difference over nullable values, which is the Phase 4 signed-quantity argument applied to money. The counter-argument is legitimate — accountants read debit and credit, and a signed column moves the sign risk to the UI boundary — and if the owner prefers the two-column form it should be decided now, because it changes the balance constraint, every read model, and every posting-rule line template.

7. **Entity as a column versus as a generic dimension.** *Recommendation: hybrid — `journal_lines.economic_entity_id` is a real foreign key, and classes/departments/segments use the generic dimension tables with a junction.* The entity is the only dimension guaranteed present on upstream facts, the only one every statement filters on, the only one whose absence must be enforceable, and the only one that needs referential integrity to a foundation record. The cost is that entity is special-cased in every dimension-handling code path forever.

8. **Unenforced source-fact references, or typed foreign keys?** `journal_entry_source_links` and `reconciliation_matches` both carry a `(type, id)` pair with no foreign key. *Recommendation: keep them unenforced.* A posted entry must survive the deletion of its source fact, and the alternative — a dozen nullable typed FK columns — is exactly the shape [cross-domain rule 5](../domain-boundaries/#cross-domain-rules) warns against. The precedent exists twice already (`market_events.rule_id`, `acquisition_opportunity_links.opportunity_rule_id`). The residual risk is orphaned provenance, mitigated by a named reconciliation report and by the fact that operational facts are not hard-deleted in normal operation. `payout_lines` deliberately goes the other way and uses real FKs, because its target set is three tables and its purpose is reconciliation rather than immutable history — the inconsistency is intentional and should be confirmed rather than smoothed over.

9. **How does one real-world bank account map into two books?** `financial_accounts.ledger_account_id` is a single nullable FK, which is right for one book and wrong for an installation where a shared account must appear in both. *Recommendation: ship the single column, and add `financial_account_book_mappings(financial_account_id, accounting_book_id, ledger_account_id)` additively the first time a real installation needs it.* The single column costs nothing to widen and the mapping table costs a join on every banking read for a case that may never occur.

10. **Is facilitator-collected tax posted through a clearing account, or not posted at all?** *Recommendation: post it through `facilitator_tax_clearing`, both sides, netting to zero once the payout settles.* Posting nothing is simpler and breaks the payout reconciliation, because the gross the marketplace reports includes tax and the net it deposits does not — the difference has to land somewhere or the clearing residual is permanently non-zero for a legitimate reason, which trains operators to ignore the one number that is supposed to be zero. The alternative view is that money that never belonged to the seller should not appear in the seller's books at all; that view is defensible and the owner should pick.

11. **Bank import dedupe identity.** *Recommendation: `sha256(account, posted_on, amount, normalized_description, occurrence_index)` with the occurrence index computed per day-amount-description group within the import, plus a file-level content hash unique per account.* It is stable for whole-day file boundaries and can shift for files that truncate mid-day — an honest limitation, surfaced as duplicate counts and unmatched rows rather than silently absorbed. Revisit when provider APIs supply stable transaction ids, at which point this degrades to a secondary guard.

12. **Does Phase 5 support cash-basis books, or only record the label?** `accounting_books.accounting_basis` is stored, and the shipped rule set is accrual-shaped (revenue at sale, COGS at depletion). *Recommendation: store the label, ship accrual rules, and treat a cash-basis rule set as a later addition that needs no schema change.* A cash-basis book is expressible today by writing rules that post from settlement facts instead of sale facts, which is genuinely how it should work — but nobody has written those rules, and a book labelled `cash` running accrual rules is worse than one honestly labelled `accrual`. The owner should decide whether the label ships at all in the first milestone.

13. **Closing entries and retained earnings: computed or stored?** *Recommendation: computed in the balance-sheet read model from prior fiscal years' net income; no stored closing entries.* Storing them doubles the entry count in a small book, makes the trial balance depend on whether a close job ran, and requires reversal when a prior year is legitimately corrected. The counter-argument is that every traditional accounting system stores them and an accountant reviewing the book will look for them. This is a convention split, not a correctness question.

14. **Which package owns this?** Four domains land in one phase — Accounting, Payments/Payouts/Banking, Costs and Expenses, Tax. *Recommendation: one `@loxep/accounting` package for books, chart, dimensions, periods, journal, and posting rules; a separate `@loxep/banking` for financial accounts, payouts, bank ingestion, and reconciliation; expenses and sales-tax facts in `@loxep/domain` alongside the other cross-cutting facts.* This has the identical shape as [Phase 3's open question 6](../commerce-schema-design/#open-questions) about scheduling ownership and [Phase 4's tension 4](../inventory-schema-design/#contradictions-and-tensions-found-in-existing-documentation) about shipping ownership — the third occurrence of the same unresolved pattern — and like both of those it should be decided **before** implementation begins, because it determines package boundaries rather than table shapes.

## Contradictions and tensions found in existing documentation

Recorded here for a human to resolve; this document does not attempt to fix them.

1. **The natural name `accounts` is taken by Better Auth.** ADR-0020 makes Better Auth's generated tables — including `account` — Loxep-owned checked-in schema that Loxep does not rename. The chart of accounts therefore cannot be `accounts`, and this design uses `ledger_accounts`. No existing document mentions the collision, and an implementer reading "chart of accounts" in the roadmap and the domain map would reasonably create `accounts` and discover the conflict at migration time. Worth one sentence in ADR-0020's consequences or the implementation contract.

2. **Roadmap Phase 5 says nothing about inventory valuation or COGS posting, and this design posts both.** *(**RESOLVED PROVISIONAL** in milestone 4, per this item's own first recommendation — see [contradiction 2, resolved](#milestone-4--contradiction-2-resolved-provisional). COGS posting from inventory depletion is Phase 5 work, the roadmap bullets now say so explicitly, and the `acquisition_cost` / `inventory_movement` readers and their four rules are shipped. Inventory **valuation** is NOT resolved with it and remains unscheduled, which is why a `disposal` or `shrinkage` movement posts nothing. The original text follows.)* [Phase 4's tension 5](../inventory-schema-design/#contradictions-and-tensions-found-in-existing-documentation) already flagged that valuation is unscheduled — Phase 4 says "cost basis", Phase 5's bullet list says nothing about inventory. This design adds a COGS-on-depletion posting rule and an `inventory` system account, which is the only way per-item realized profitability and the P&L can agree. The Phase 5 roadmap bullets should gain "COGS posting from inventory depletion" explicitly, or the assignment should be corrected here. Seen from the Phase 5 side, this is the same gap Phase 4 recorded, still open.

3. **"Replay/rebuild of derived accounting where controls permit" invites a destructive implementation.** [Master Domain Map section 10](../../product/master-domain-map/#10-accounting-and-tax) lists it under Accounting DESIGN-FOR, and read literally it means regenerating the ledger from source facts. This design implements reversal-and-repost instead, because a rebuild that deletes posted entries in a closed period destroys the audit trail and violates the period model. The two are not the same capability and the map wording does not distinguish them. It should say "re-post corrections as reversing entries" or explicitly scope rebuild to draft/unposted state.

4. **AR/AP postings are listed under Accounting DESIGN-FOR, but their source facts are Phase 6.** The domain map lists "AR/AP, inventory/COGS, and clearing-account postings" together. Inventory/COGS and clearing have source facts in Phases 4 and 5; AR has none until invoices exist in Phase 6, and AP has none until vendor bills exist (which Phase 4 declared an explicit non-goal and no phase currently owns). Phase 5 therefore ships no AR or AP subledger and no receivable/payable posting rules, and the map bullet should be split by phase so nobody builds an AR aging report against an empty concept.

5. **Four domain boundaries, one phase, one workspace — the package question, for the third time.** [Domain Boundaries](../domain-boundaries/) defines Accounting, "Payments, Payouts, and Banking", "Costs and Expenses", and Tax as four separate ownership boundaries; the roadmap folds all four into Phase 5; [Workspaces](../../product/workspaces/) puts all four in `/finance`. These are consistent under the "workspace UX is not domain ownership" rule, but the package question is open and this is now the third phase to hit it (Phase 3: `monitor_targets` ownership; Phase 4: shipping ownership; Phase 5: four finance domains). The recurrence suggests the documentation needs a general rule about domain-to-package mapping rather than a third one-off decision.

6. **ADR-0017 lists chart-of-accounts structure *first* among separation mechanisms; this design chooses the dimension.** The ADR says separation "may be expressed through the chart of accounts, dimensions, classes, departments, or another accounting classification model selected later", and [Domain Boundaries](../domain-boundaries/#accounting) echoes "separated by chart-of-accounts structure or accounting dimensions". This design makes the entity dimension primary and treats per-entity account duplication as the anti-pattern it is — duplicating a fifty-account chart across three operating identities produces a hundred and fifty accounts and makes consolidated reporting a string-parsing exercise. That is a defensible reading of "or", but it is not the literal emphasis of the ADR's ordering, and it is the choice the owner should confirm most carefully after the book-cardinality question itself.

7. **Phase 4's expectation that non-capitalized acquisition costs are "consumed" by the expense model reads as a copy.** [Phase 4 open question 10](../inventory-schema-design/#open-questions) says "Phase 5's expense model will consume these rows". This design posts them directly from `acquisition_costs` via a posting rule with `match_capitalize = false`, and deliberately does not copy them into `expenses`. The Phase 4 wording should be tightened to "posted directly by a Phase 5 posting rule" so no one writes a migration that duplicates a year of mileage entries into a second table.

8. **Neither Phase 3 nor Phase 4 says the operational tables stay unconverted permanently.** Both deferred multi-currency "to Phase 5", which reads as "Phase 5 will add converted amounts". Phase 5's answer is the opposite: conversion happens only in the journal, and `orders`, `acquisitions`, `inventory_items`, and `shipments` keep exactly one currency forever. That is a stronger commitment than either prior document made, and if it is accepted, both prior open questions should be updated to say so rather than left reading as deferrals.

9. **The domain map's Reporting section promises entity reporting "independently of how accounting books group those entities" — and the balance sheet cannot deliver it unconditionally.** [Section 13](../../product/master-domain-map/#13-reporting-analytics-and-time-series-data) lists "reporting by economic entity independently of how accounting books group those entities" under DESIGN-FOR. An entity-filtered P&L delivers this. An entity-filtered balance sheet does so only when every posted line in the book carries the dimension, which is why `accounting_books.requires_entity_dimension` exists. The promise is achievable but conditional, and the map states it unconditionally.

## Before implementing this schema

1. **resolve the three OWNER-REVIEW-CRITICAL open questions first** — book granularity and link semantics, posting-rule mutability and re-post policy, and functional currency. All three are unrecoverable after the first entry posts, and the first one changes the onboarding flow, not just a table;
2. re-read the applied Phase 3 migration and, if it has landed, the Phase 4 migration, rather than their design documents, before writing any reference here. Phase 4's own first implementation note records that Phase 3 implementation already diverged from its draft in a way that changed a read model (`order_fees.fee_direction`); column names must come from migrations, not from prose;
3. decide the package boundaries (open question 14) before writing code — it determines where the posting engine lives and whether banking is separable;
4. verify `btree_gist` availability in the deployment image before relying on either exclusion constraint, and decide the fallback deliberately if it is unavailable rather than discovering it at migration time;
5. verify current Drizzle Kit support for composite foreign keys, `EXCLUDE USING gist`, partial unique indexes with `IN` predicates, deferred constraint triggers, and `num_nonnulls` checks, and fall back to hand-written SQL rather than weakening any constraint;
6. write the balance test first — an attempted insert of an unbalanced posted entry must fail at COMMIT, in both the transaction currency and the functional currency, and a multi-rate entry must be balanced by a generated `fx_gain_loss` line — because it is the invariant every statement in this design assumes;
7. write the immutability tests alongside it: an attempted `UPDATE` and an attempted `DELETE` on a posted `journal_entries` row and on its lines must both fail, and a posting into a `closed` period must fail;
8. write the idempotency tests before the posting engine: the same fact posted twice, a fact re-synced unchanged (fingerprint match, no-op), a fact changed after posting (reverse and re-post), a re-post under a new rule version, and a retried reversal must all be covered against real PostgreSQL;
9. seed and test the chart template and the shipped rule set together — a rule referencing a `system_key` no seeded account carries is a silent suspense posting, and that failure should be caught by a test rather than by a balance nobody looks at;
10. confirm the clearing-account invariant with a real end-to-end fixture — order, fees, refund, depletion, payout, deposit — and assert that `marketplace_clearing` and `facilitator_tax_clearing` both return to exactly zero. That single test is the strongest available evidence that this design works;
11. keep provider SDK types at the integration boundary (ADR-0009); nothing here may be typed from a marketplace, bank, or accounting library;
12. update this document, the roadmap, and Domain Boundaries when implementation reality diverges, rather than letting the documentation drift.

/**
 * Phase 5's financial core: accounting books, the per-book chart of accounts,
 * accounting dimensions, fiscal periods, the double-entry journal, and the
 * declarative posting-rule model that feeds it.
 *
 * Physical realization of the "Books and entities", "Chart of accounts",
 * "Accounting dimensions", "Fiscal periods and closing semantics", "The
 * double-entry journal", and "Declarative posting rules" sections of
 * `apps/docs/src/content/docs/architecture/financial-schema-design.md` —
 * **thirteen of that design's twenty-two tables**, matching its own
 * "Migration A" (0009) and "Migration B" (0010) in the migration plan sketch.
 * Payouts, banking, reconciliation, and sales-tax facts are later milestones
 * and are NOT here.
 *
 * ## The three OWNER-REVIEW-CRITICAL questions were answered (2026-08-12)
 *
 * This milestone was blocked until they were, because each is unrecoverable
 * after a single entry posts. The answers, and where each one is physical:
 *
 * ```text
 * 1 book granularity   books are toggleable PER ENTITY, and entities relate as
 *                      included-in/part-of: a child entity's posting_primary
 *                      book IS its parent's book, and per-entity views are
 *                      reporting slices over journal_lines.economic_entity_id
 *                      rather than separate ledgers.
 *                      -> book_entity_links, effective-dated, link_role, and
 *                         the EXCLUDE constraint that makes routing single-
 *                         valued on any given day.
 * 2 rule mutability    immutable versions; corrections are reversal + repost,
 *                      never mutation.
 *                      -> journal_entries.reverses_entry_id plus the
 *                         immutability triggers in migration 0009.
 * 3 functional currency USD-only for the initial build, with the multi-currency
 *                      seam KEPT so other currencies wire in later without
 *                      restating a single stored amount.
 *                      -> journal_lines keeps currency/amount AND
 *                         functional_currency/functional_amount/fx_rate/
 *                         fx_rate_source/fx_rate_at. @loxep/accounting refuses
 *                         a non-USD book or line at the service boundary and
 *                         names the seam in the error. No CHECK pins USD into
 *                         the DDL, because a constraint that has to be dropped
 *                         to use a designed column is not a safety rail.
 * ```
 *
 * ## Conventions inherited, not reinvented
 *
 * uuid PKs with `defaultRandom()`; `numeric(20,6)` money with a separate ISO
 * currency code; state columns as `text` + application-owned TypeScript unions
 * (never PG enums); ADR-0020 user references as nullable `SET NULL` FKs; no
 * `payload`/attribute `jsonb` column anywhere; deterministic idempotency keys
 * with a unique constraint (`journal_entries.posting_key`, the
 * `inventory_movements.deduplication_key` mechanism verbatim).
 *
 * **No table here is a Timescale hypertable.** A journal looks like a time
 * series and is not: it is a small set of discrete business facts with foreign
 * keys pointing at it, and hypertable partitioning would cost referential
 * integrity for nothing.
 *
 * ## Two deliberate divergences from foundation convention
 *
 * - **Accounting dates are `date`, not `timestamptz`.** `entry_date`,
 *   `starts_on`/`ends_on`, `effective_from`/`effective_to`, and `opened_on` are
 *   calendar dates in the book's own frame. Instants that genuinely are
 *   instants (`posted_at`, `closed_at`, `created_at`) stay `timestamptz`.
 * - **`ledger_accounts`, not `accounts`.** Better Auth owns a table named
 *   `account` (ADR-0020) and Loxep does not rename Better Auth's tables, so the
 *   obvious accounting name is unavailable. This is a real constraint no other
 *   document mentions; the design records it as contradiction 1.
 *
 * ## What is enforced HERE versus in migration 0009's hand-written SQL
 *
 * drizzle-orm 0.45.2 / drizzle-kit 0.31.10 express everything below —
 * composite foreign keys, partial unique indexes, `num_nonnulls` checks,
 * expression predicates — and nothing was weakened to fit. Four constraints
 * are genuinely beyond it and are hand-written in the migration:
 *
 * ```text
 * EXCLUDE USING gist   book_entity_links: at most one posting_primary book per
 *                      entity per day  (partial, WHERE link_role = …)
 * EXCLUDE USING gist   fiscal_periods: no two periods of one book overlap
 * CONSTRAINT TRIGGER   the deferred per-entry, per-currency balance check
 * BEFORE trigger       posted-entry immutability, and the period posting guard
 * ```
 *
 * Both exclusions need `btree_gist` for the `uuid with =` operand; it is
 * available in `timescale/timescaledb-ha:pg18.4-ts2.29.1-all` (verified,
 * version 1.8) so the design's weaker portable fallback was not needed.
 *
 * ## What migration 0010 added, and what it still leaves out
 *
 * ```text
 * posting_rules / _versions / _lines        the declarative rule model
 * journal_entry_source_links                multi-fact provenance
 * journal_entries.posting_rule_version_id   the FK 0009 deliberately omitted,
 *                                           with the paired
 *                                           (entry_source = 'posting_rule') =
 *                                           (version_id is not null) CHECK
 * ```
 *
 * `entry_source = 'posting_rule'` is therefore reachable from 0010 onward, and
 * the rule engine in `@loxep/accounting` is the only writer permitted to use
 * it. Still absent, still deliberately: `financial_accounts`, `payouts`,
 * `payout_lines`, bank ingestion, `reconciliation_matches`, `sales_tax_facts`.
 */
import { sql } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import {
  bigint,
  boolean,
  char,
  check,
  date,
  foreignKey,
  index,
  integer,
  numeric,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { user } from "./auth.ts";
import { economicEntities } from "./entities.ts";

/* ------------------------------------------------------------------ unions */

/** `accounting_books.accounting_basis` — Loxep-owned closed set, `CHECK`ed. */
export const ACCOUNTING_BASES = ["cash", "accrual"] as const;
export type AccountingBasis = (typeof ACCOUNTING_BASES)[number];

/** `accounting_books.status`. Books are archived, never deleted. */
export const ACCOUNTING_BOOK_STATUSES = ["active", "archived"] as const;
export type AccountingBookStatus = (typeof ACCOUNTING_BOOK_STATUSES)[number];

/**
 * `book_entity_links.link_role` — the answer to "does the link ROUTE postings
 * or merely DESCRIBE contents", which the owner resolved as: both, explicitly
 * labelled.
 *
 * ```text
 * posting_primary  this book receives postings for this entity's facts. At
 *                  most one per entity at any point in time, which is what
 *                  makes routing deterministic. MANY entities may share one
 *                  book — that is the whole point, and it is how a DBA's
 *                  activity lands in its parent LLC's book.
 * reporting_only   this book is also a place this entity's activity shows up,
 *                  recorded for reporting/navigation. It NEVER routes.
 * ```
 */
export const BOOK_ENTITY_LINK_ROLES = [
  "posting_primary",
  "reporting_only",
] as const;
export type BookEntityLinkRole = (typeof BOOK_ENTITY_LINK_ROLES)[number];

/**
 * `ledger_accounts.account_type` — a five-member closed set with a `CHECK`,
 * because it is the one classification every statement depends on and no
 * provider invents a sixth.
 *
 * `normal_balance` is deliberately **not a column**: it is `debit` for
 * `asset`/`expense` and `credit` for `liability`/`equity`/`revenue`, flipped by
 * `is_contra`. Storing it would create a second source for a derived fact with
 * no arbiter.
 */
export const LEDGER_ACCOUNT_TYPES = [
  "asset",
  "liability",
  "equity",
  "revenue",
  "expense",
] as const;
export type LedgerAccountType = (typeof LEDGER_ACCOUNT_TYPES)[number];

export const LEDGER_ACCOUNT_STATUSES = ["active", "archived"] as const;
export type LedgerAccountStatus = (typeof LEDGER_ACCOUNT_STATUSES)[number];

/**
 * Initial `ledger_accounts.account_subtype` values. TypeScript union with
 * **no** `CHECK`: this is the layer that grows, and nothing branches on an
 * unknown member — statements branch on `account_type`.
 */
export const LEDGER_ACCOUNT_SUBTYPES = [
  "bank",
  "undeposited_funds",
  "accounts_receivable",
  "inventory",
  "clearing",
  "sales_tax_payable",
  "cogs",
  "marketplace_fees",
  "shipping_expense",
  "fx_gain_loss",
  "opening_balance_equity",
  "suspense",
] as const;
export type LedgerAccountSubtype = (typeof LEDGER_ACCOUNT_SUBTYPES)[number];

/**
 * `fiscal_periods.status` — soft close, per the design's recommendation.
 *
 * ```text
 * open          ordinary posting; anything goes
 * soft_closed   ordinary posting BLOCKED; an explicitly authorized, audited
 *               backdated posting is permitted and is FLAGGED on the entry
 * closed        all posting blocked; reopening is an explicit audited action
 * locked        all posting blocked; no application path reopens it
 * ```
 *
 * Soft close is right for this product specifically because provider facts
 * arrive late as a matter of course — an eBay final-value-fee adjustment three
 * days after month end, a payout statement on the 4th covering the 28th–31st, a
 * carrier post-audit reweigh a week later. A hard close makes those unpostable,
 * and "post it to the next open period" silently misstates two months.
 */
export const FISCAL_PERIOD_STATUSES = [
  "open",
  "soft_closed",
  "closed",
  "locked",
] as const;
export type FiscalPeriodStatus = (typeof FISCAL_PERIOD_STATUSES)[number];

/** Period states that refuse every posting, at the trigger and in the service. */
export const POSTING_BLOCKED_PERIOD_STATUSES = ["closed", "locked"] as const;

/**
 * `journal_entries.status`.
 *
 * ```text
 * draft     being assembled; legitimately unbalanced, freely edited
 * posted    in the books; immutable from here on
 * reversed  posted, and a later entry reverses it. The lines are UNCHANGED and
 *           still count in every balance — the reversal's own lines are what
 *           net them out. This is a marker, never an exclusion filter.
 * void      a DRAFT that was abandoned. A posted entry is never voided, it is
 *           reversed.
 * ```
 */
export const JOURNAL_ENTRY_STATUSES = [
  "draft",
  "posted",
  "reversed",
  "void",
] as const;
export type JournalEntryStatus = (typeof JOURNAL_ENTRY_STATUSES)[number];

/** Entry statuses whose lines are in the books and count in every balance. */
export const LEDGER_VISIBLE_ENTRY_STATUSES = ["posted", "reversed"] as const;

/**
 * `journal_entries.entry_source`.
 *
 * `posting_rule` is presently unreachable — no rule engine exists — and ships
 * inside the `CHECK` anyway, so that widening a constraint on a table with rows
 * is not the first thing the posting-rule milestone has to do. It is the same
 * call `expenses.status = 'posted'` made one milestone earlier.
 */
export const JOURNAL_ENTRY_SOURCES = [
  "posting_rule",
  "manual",
  "import",
  "opening_balance",
] as const;
export type JournalEntrySource = (typeof JOURNAL_ENTRY_SOURCES)[number];

/**
 * `journal_lines.fx_rate_source` — where the frozen rate came from.
 *
 * Under the USD-only answer every line is `unity`. The other three members are
 * the seam, and they are in the `CHECK` from the first migration for the same
 * reason `posting_rule` is.
 */
export const FX_RATE_SOURCES = [
  "unity",
  "provider_reported",
  "manual",
  "imported",
] as const;
export type FxRateSource = (typeof FX_RATE_SOURCES)[number];

/**
 * The system-account handles Loxep's own posting rules resolve through.
 *
 * A system account may be renamed and re-coded freely — operators have opinions
 * about account numbering and should keep them; `system_key` is the stable
 * handle. It may never be deleted, and its `system_key` and `account_type` may
 * never change: deleting it breaks every rule that resolves through it, and
 * changing its type silently moves an account between statements.
 *
 * `buyer_fee_income` is not in the design's sketch and is required by
 * Phase 3's shipped reality: `order_fees.fee_direction` distinguishes a
 * `seller_charge` (a deduction from proceeds, posts to `marketplace_fees`) from
 * a `buyer_surcharge` (money the BUYER paid that is already inside the order
 * total). Posting a buyer surcharge as a fee expense would understate income by
 * exactly the amount the buyer covered, so it needs an income account of its
 * own.
 */
export const LEDGER_SYSTEM_KEYS = [
  "marketplace_clearing",
  "undeposited_funds",
  "inventory",
  "sales_tax_payable",
  "facilitator_tax_clearing",
  "sales_revenue",
  "sales_returns",
  "shipping_income",
  "buyer_fee_income",
  "cogs",
  "marketplace_fees",
  "payment_processing_fees",
  "shipping_expense",
  "fx_gain_loss",
  "opening_balance_equity",
  "suspense",
] as const;
export type LedgerSystemKey = (typeof LEDGER_SYSTEM_KEYS)[number];

/** `posting_rules.status`. A `draft` rule never fires; a `disabled` one stops. */
export const POSTING_RULE_STATUSES = ["draft", "active", "disabled"] as const;
export type PostingRuleStatus = (typeof POSTING_RULE_STATUSES)[number];

/**
 * `posting_rule_versions.status`.
 *
 * ```text
 * draft       being authored; freely edited, never fires
 * active      the version new postings run under
 * superseded  replaced by version N+1. Its text is FROZEN, because the entries
 *             it produced are explained by it and by nothing else.
 * ```
 */
export const POSTING_RULE_VERSION_STATUSES = [
  "draft",
  "active",
  "superseded",
] as const;
export type PostingRuleVersionStatus =
  (typeof POSTING_RULE_VERSION_STATUSES)[number];

/**
 * `posting_rules.source_fact_type` — the classes of operational fact a rule may
 * read.
 *
 * The whole set is `CHECK`ed from this migration even though only four members
 * have an implemented reader (`order`, `order_fee`, `order_refund`, `expense`),
 * the same call `entry_source = 'posting_rule'` and `expenses.status = 'posted'`
 * made before it: widening a `CHECK` on a table with rows should not be the
 * first thing the next milestone has to do. A rule naming an unimplemented type
 * is refused by the service, which names the reader that does not exist.
 */
export const POSTING_RULE_SOURCE_FACT_TYPES = [
  "order",
  "order_fee",
  "order_refund",
  "order_fulfillment",
  "inventory_movement",
  "acquisition_cost",
  "shipment",
  "expense",
  "payout",
  "payout_line",
  "bank_transaction",
  "sales_tax_fact",
  "manual",
] as const;
export type PostingRuleSourceFactType =
  (typeof POSTING_RULE_SOURCE_FACT_TYPES)[number];

/**
 * `posting_rule_lines.amount_source` — which number on the source fact a line
 * takes, before its multiplier.
 *
 * `remainder` is the plug: at most one per version, and it takes whatever value
 * makes the entry balance. Not every source applies to every fact type, and a
 * line naming an inapplicable one is a validation error at save time rather
 * than a silent zero.
 */
export const POSTING_AMOUNT_SOURCES = [
  "total",
  "subtotal",
  "shipping",
  "discount",
  "tax",
  "fee",
  "refund",
  "net",
  "cost_basis",
  "quantity_times_basis",
  "remainder",
] as const;
export type PostingAmountSource = (typeof POSTING_AMOUNT_SOURCES)[number];

/**
 * `journal_entry_source_links.role` — how a fact relates to the entry.
 *
 * ```text
 * primary       the fact the entry is ABOUT; mirrors the header stamp
 * settled       a fact this entry settles (a payout clearing an order)
 * allocated     a fact this entry allocates part of
 * reversed_from the fact whose earlier entry this one reverses
 * evidence      context, not arithmetic: a fee's parent order
 * ```
 */
export const JOURNAL_ENTRY_SOURCE_LINK_ROLES = [
  "primary",
  "settled",
  "allocated",
  "reversed_from",
  "evidence",
] as const;
export type JournalEntrySourceLinkRole =
  (typeof JOURNAL_ENTRY_SOURCE_LINK_ROLES)[number];

/**
 * `media_links.resource_type` for documents supporting a journal entry, and the
 * `purpose` values this milestone adds. Application text, not DDL.
 */
export const JOURNAL_ENTRY_RESOURCE_TYPE = "journal_entry";

/* ----------------------------------------------------------------- tables */

/**
 * An explicit set of books. An installation may have several — personal
 * activity in one, an LLC and its DBAs in another.
 *
 * **There is no `economic_entity_id` column on this table, and there must never
 * be one.** A book with an owning entity is a one-book-per-entity model wearing
 * a link table as a disguise, and ADR-0017's prohibition is the single
 * most-repeated rule in the documentation. Every ownership statement lives in
 * {@link bookEntityLinks}, pointing inward.
 */
export const accountingBooks = pgTable(
  "accounting_books",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    code: text("code").notNull(),
    name: text("name").notNull(),

    /**
     * The book's reporting currency and the denomination of every statement it
     * produces. Set at creation and effectively immutable afterwards: changing
     * it would require restating every `journal_lines.functional_amount` ever
     * written. USD-only for now (owner answer 3) — enforced in
     * `@loxep/accounting`, not by a `CHECK`.
     */
    functionalCurrency: char("functional_currency", { length: 3 })
      .notNull()
      .default("USD"),

    /**
     * Recorded because it changes what a P&L means, not because anything
     * branches on it. The shipped rule set will be accrual-shaped; a cash-basis
     * book is representable and its rules would post from settlement facts.
     */
    accountingBasis: text("accounting_basis").notNull().default("accrual"),

    /** A January fiscal year is an assumption, not a fact. */
    fiscalYearStartMonth: integer("fiscal_year_start_month").notNull().default(1),
    fiscalYearStartDay: integer("fiscal_year_start_day").notNull().default(1),

    /**
     * Small and load-bearing: it is what makes an entity-filtered BALANCE SHEET
     * meaningful. An entity-filtered P&L works on any book; a balance sheet
     * only balances when every posted line carries the dimension.
     */
    requiresEntityDimension: boolean("requires_entity_dimension")
      .notNull()
      .default(false),

    /**
     * A counter row, not a PostgreSQL sequence, and that is deliberate: a
     * sequence is gap-full on rollback and an auditor's expectation of a
     * journal is gapless numbering. Posting takes `SELECT … FOR UPDATE` on the
     * book row, increments, and writes inside the posting transaction. The
     * serialization cost is irrelevant at a self-hosted reseller's volume and
     * buys an invariant that is otherwise impossible.
     */
    nextEntryNumber: bigint("next_entry_number", { mode: "number" })
      .notNull()
      .default(1),

    status: text("status").notNull().default("active"),
    openedOn: date("opened_on", { mode: "string" }).notNull(),
    notes: text("notes"),

    createdByUserId: text("created_by_user_id").references(() => user.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    unique("accounting_books_code_uq").on(table.code),
    check(
      "accounting_books_accounting_basis_check",
      sql`${table.accountingBasis} in ('cash', 'accrual')`,
    ),
    check(
      "accounting_books_status_check",
      sql`${table.status} in ('active', 'archived')`,
    ),
    check(
      "accounting_books_fiscal_year_start_month_check",
      sql`${table.fiscalYearStartMonth} between 1 and 12`,
    ),
    check(
      "accounting_books_fiscal_year_start_day_check",
      sql`${table.fiscalYearStartDay} between 1 and 31`,
    ),
    /**
     * Not sketched, and cheap: an entry number counter that has gone to zero or
     * negative would mint numbers a later increment repeats, which is exactly
     * the gaplessness the counter exists to guarantee.
     */
    check(
      "accounting_books_next_entry_number_check",
      sql`${table.nextEntryNumber} > 0`,
    ),
  ],
);

/**
 * Which economic entities' activity a book contains, effective-dated.
 *
 * The link is primarily a **routing decision**: the posting engine has to
 * answer "given this fact, attributed to entity E, which book does it post
 * to?", and there is nowhere else for that answer to live. A single
 * installation-default book fails on the day a second book exists; a book on
 * the posting rule duplicates every rule per book; a book on the connection
 * re-introduces the mutable-configuration-rewrites-history defect Phase 3
 * explicitly rejected. The entity is already on the fact — Phase 3 put
 * `economic_entity_id` on `orders` and Phase 4 on `acquisitions` and
 * `inventory_items` reasoning that "Phase 5 must read attribution, not
 * recompute it". This table is the payoff those decisions were paying down.
 *
 * It is effective-dated because entities move between books at date
 * boundaries — a DBA operating inside the LLC's book for two years is spun into
 * its own book at the start of a fiscal year — and that must not be a
 * destructive `UPDATE` that retroactively claims last year's entries belonged
 * somewhere else. Attribution is a fact, not a setting.
 *
 * There is deliberately **no unique on (accounting_book_id,
 * economic_entity_id)**: an entity can legitimately hold a `posting_primary`
 * row for 2026 and a `reporting_only` row for the same book afterwards.
 *
 * The routing invariant — no entity has two primary books on the same day — is
 * the `EXCLUDE USING gist` constraint in migration 0009, which drizzle-kit
 * cannot express.
 */
export const bookEntityLinks = pgTable(
  "book_entity_links",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    accountingBookId: uuid("accounting_book_id").notNull(),
    economicEntityId: uuid("economic_entity_id").notNull(),
    linkRole: text("link_role").notNull(),

    effectiveFrom: date("effective_from", { mode: "string" }).notNull(),
    /** Null means open-ended: this is the current arrangement. */
    effectiveTo: date("effective_to", { mode: "string" }),

    /**
     * The display name this entity carries on statements filtered by the entity
     * dimension; defaults to `economic_entities.name`. "Acme LLC" and its DBA
     * "Route 9 Vintage" want different labels on a P&L than they carry in
     * Settings, and the alternative is renaming the entity record itself.
     */
    dimensionLabel: text("dimension_label"),
    note: text("note"),

    createdByUserId: text("created_by_user_id").references(() => user.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    /**
     * Named explicitly, here and on every reference below, because several
     * derived names for this schema's long table/column pairs exceed
     * PostgreSQL's 63-byte identifier limit and would be silently truncated
     * (`accounting_dimension_values_parent_value_id_accounting_dimension_values_id_fk`
     * is 78 bytes). Naming the short ones too keeps one rule instead of two.
     */
    foreignKey({
      name: "book_entity_links_book_fk",
      columns: [table.accountingBookId],
      foreignColumns: [accountingBooks.id],
    }),
    foreignKey({
      name: "book_entity_links_entity_fk",
      columns: [table.economicEntityId],
      foreignColumns: [economicEntities.id],
    }),
    check(
      "book_entity_links_link_role_check",
      sql`${table.linkRole} in ('posting_primary', 'reporting_only')`,
    ),
    check(
      "book_entity_links_effective_range_check",
      sql`${table.effectiveTo} is null or ${table.effectiveTo} >= ${table.effectiveFrom}`,
    ),
    /** The routing probe: "which book does entity E post to on date D?" */
    index("book_entity_links_entity_effective_idx").on(
      table.economicEntityId,
      table.effectiveFrom,
    ),
    index("book_entity_links_book_idx").on(table.accountingBookId),
  ],
);

/**
 * The per-book chart of accounts. One chart per book — not shared, not global,
 * not templated at runtime.
 *
 * Loxep seeds a default chart at book creation from a **code-owned** template
 * (`@loxep/accounting`'s `chart-template.ts`), not from a database table of
 * templates. After creation the rows belong to the operator. A template table
 * would invite "what happens when the template changes", whose honest answer —
 * nothing, the book already has its own rows — is better expressed by not
 * having the table.
 */
export const ledgerAccounts = pgTable(
  "ledger_accounts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    accountingBookId: uuid("accounting_book_id").notNull(),
    code: text("code").notNull(),
    name: text("name").notNull(),
    accountType: text("account_type").notNull(),
    /** Open set: TS union, no `CHECK`. See {@link LEDGER_ACCOUNT_SUBTYPES}. */
    accountSubtype: text("account_subtype"),

    parentAccountId: uuid("parent_account_id"),

    /** `false` marks a roll-up header. Journal lines may only reference postable accounts. */
    isPostable: boolean("is_postable").notNull().default(true),
    /**
     * Contra accounts (sales returns; accumulated depreciation later) are a
     * flag on the ordinary type rather than a sixth type, which keeps statement
     * grouping trivial.
     */
    isContra: boolean("is_contra").notNull().default(false),

    /** The stable handle Loxep's own rules resolve through. See {@link LEDGER_SYSTEM_KEYS}. */
    systemKey: text("system_key"),

    /**
     * Nullable and normally null. Set only where an account is genuinely
     * denominated in one non-functional currency — a GBP bank account inside a
     * USD book — so the reconciliation and statement layers can tell "this
     * account holds foreign currency" from "this line happened to be in one".
     */
    currency: char("currency", { length: 3 }),
    description: text("description"),
    status: text("status").notNull().default("active"),

    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    foreignKey({
      name: "ledger_accounts_book_fk",
      columns: [table.accountingBookId],
      foreignColumns: [accountingBooks.id],
    }),
    /**
     * The parent reference is COMPOSITE, not the sketch's single-column one.
     * A roll-up header in another book would silently mis-group a statement,
     * and the same denormalized-book-column trick that protects `journal_lines`
     * protects the hierarchy for free. `MATCH SIMPLE` means the constraint is
     * skipped when `parent_account_id` is null, which is the common case.
     */
    foreignKey({
      name: "ledger_accounts_parent_fk",
      columns: [table.accountingBookId, table.parentAccountId],
      foreignColumns: [table.accountingBookId, table.id],
    }),
    unique("ledger_accounts_book_code_uq").on(table.accountingBookId, table.code),
    /**
     * Looks redundant against the primary key and is not: it is the target of
     * the composite foreign key on `journal_lines` that makes cross-book
     * contamination structurally impossible.
     */
    unique("ledger_accounts_book_id_uq").on(table.accountingBookId, table.id),
    uniqueIndex("ledger_accounts_book_system_key_uq")
      .on(table.accountingBookId, table.systemKey)
      .where(sql`system_key is not null`),
    check(
      "ledger_accounts_account_type_check",
      sql`${table.accountType} in ('asset', 'liability', 'equity', 'revenue', 'expense')`,
    ),
    check(
      "ledger_accounts_status_check",
      sql`${table.status} in ('active', 'archived')`,
    ),
    check(
      "ledger_accounts_parent_self_check",
      sql`${table.parentAccountId} is distinct from ${table.id}`,
    ),
    index("ledger_accounts_book_type_idx").on(
      table.accountingBookId,
      table.accountType,
    ),
    index("ledger_accounts_book_parent_idx")
      .on(table.accountingBookId, table.parentAccountId)
      .where(sql`parent_account_id is not null`),
  ],
);

/**
 * Optional classes/departments/segments — everything the entity dimension is
 * not.
 *
 * **Phase 5 ships zero dimensions configured by default.** The tables exist;
 * the model is empty until an operator creates one. A self-hosted reseller with
 * one LLC and two DBAs needs the entity dimension and nothing else, and
 * shipping a "Class" dimension nobody asked for is how accounting software
 * becomes unusable.
 */
export const accountingDimensions = pgTable(
  "accounting_dimensions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    accountingBookId: uuid("accounting_book_id").notNull(),
    code: text("code").notNull(),
    name: text("name").notNull(),
    /**
     * Enforced by the posting service at the posting transition, not by a
     * constraint: a draft entry legitimately lacks dimensions while it is being
     * built. The safety net is the "posted lines missing a required dimension"
     * report.
     */
    isRequired: boolean("is_required").notNull().default(false),
    sortOrder: integer("sort_order").notNull().default(0),
    active: boolean("active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    foreignKey({
      name: "accounting_dimensions_book_fk",
      columns: [table.accountingBookId],
      foreignColumns: [accountingBooks.id],
    }),
    unique("accounting_dimensions_book_code_uq").on(
      table.accountingBookId,
      table.code,
    ),
    /** Composite-FK target: a dimension value may only join a line of its own book. */
    unique("accounting_dimensions_book_id_uq").on(
      table.accountingBookId,
      table.id,
    ),
  ],
);

export const accountingDimensionValues = pgTable(
  "accounting_dimension_values",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    dimensionId: uuid("dimension_id").notNull(),
    parentValueId: uuid("parent_value_id"),
    code: text("code").notNull(),
    name: text("name").notNull(),
    active: boolean("active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    foreignKey({
      name: "accounting_dimension_values_dimension_fk",
      columns: [table.dimensionId],
      foreignColumns: [accountingDimensions.id],
    }),
    foreignKey({
      name: "accounting_dimension_values_parent_fk",
      columns: [table.parentValueId],
      foreignColumns: [table.id],
    }),
    unique("accounting_dimension_values_dimension_code_uq").on(
      table.dimensionId,
      table.code,
    ),
    check(
      "accounting_dimension_values_parent_self_check",
      sql`${table.parentValueId} is distinct from ${table.id}`,
    ),
  ],
);

/**
 * Period boundaries and closing state.
 *
 * Periods are **generated, never auto-created on demand**: book creation
 * generates a fiscal year of monthly periods from the book's
 * `fiscal_year_start_*`, and posting into a date with no period is an
 * unpostable-backlog condition rather than an implicit `INSERT`. Auto-creating
 * a period silently reopens a year the operator believed was finished.
 *
 * The non-overlap invariant is the `EXCLUDE USING gist` constraint in migration
 * 0009; it is what lets "the period containing this date" be a lookup rather
 * than a judgement.
 */
export const fiscalPeriods = pgTable(
  "fiscal_periods",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    accountingBookId: uuid("accounting_book_id").notNull(),
    /** Human handle, unique per book: `FY2026-P03`. */
    periodCode: text("period_code").notNull(),
    fiscalYear: integer("fiscal_year").notNull(),
    sequence: integer("sequence").notNull(),
    startsOn: date("starts_on", { mode: "string" }).notNull(),
    endsOn: date("ends_on", { mode: "string" }).notNull(),
    status: text("status").notNull().default("open"),
    closedAt: timestamp("closed_at", { withTimezone: true }),
    closedByUserId: text("closed_by_user_id").references(() => user.id, {
      onDelete: "set null",
    }),
    note: text("note"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    foreignKey({
      name: "fiscal_periods_book_fk",
      columns: [table.accountingBookId],
      foreignColumns: [accountingBooks.id],
    }),
    unique("fiscal_periods_book_period_code_uq").on(
      table.accountingBookId,
      table.periodCode,
    ),
    unique("fiscal_periods_book_year_sequence_uq").on(
      table.accountingBookId,
      table.fiscalYear,
      table.sequence,
    ),
    /** Composite-FK target: an entry may only be stamped with a period of its own book. */
    unique("fiscal_periods_book_id_uq").on(table.accountingBookId, table.id),
    check(
      "fiscal_periods_range_check",
      sql`${table.endsOn} >= ${table.startsOn}`,
    ),
    check(
      "fiscal_periods_status_check",
      sql`${table.status} in ('open', 'soft_closed', 'closed', 'locked')`,
    ),
    index("fiscal_periods_book_starts_on_idx").on(
      table.accountingBookId,
      table.startsOn,
    ),
  ],
);

/**
 * The declarative posting-rule model's header: a source-fact SELECTOR, and
 * nothing else.
 *
 * A rule is *a source-fact selector plus a line template*. It is not an
 * expression language and it must not become one — the precedent is
 * `opportunity_rules`, "a small closed set of predicates … never a
 * general-purpose rule engine", and the restraint matters more here for a
 * stronger reason: a rule engine that can compute arbitrary amounts is a rule
 * engine that can produce an unbalanced entry, and debugging why last March's
 * revenue is wrong should not require reading a stored expression.
 *
 * `accounting_book_id` is **nullable and normally null**: a null rule applies in
 * every book, which is what makes one shipped rule set work for an installation
 * with three books. Resolution is `priority` plus **first match wins**, matching
 * the `market_events.rule_id` precedent exactly, and the version that produced
 * an entry is stamped on it.
 */
export const postingRules = pgTable(
  "posting_rules",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    code: text("code").notNull(),
    name: text("name").notNull(),
    /** Which class of operational fact this rule reads. See {@link POSTING_RULE_SOURCE_FACT_TYPES}. */
    sourceFactType: text("source_fact_type").notNull(),
    /** Null = every book. A value narrows the rule to one book's chart. */
    accountingBookId: uuid("accounting_book_id"),
    priority: integer("priority").notNull().default(100),
    status: text("status").notNull().default("draft"),
    /**
     * The version new postings use. Moves when a version is superseded.
     *
     * A lazy self-referential-style reference (`AnyPgColumn`) because the two
     * tables point at each other: a version belongs to a rule, and a rule names
     * its current version. Declaring it any other way would need one of the two
     * foreign keys to live in hand-written SQL, outside the snapshot.
     */
    currentVersionId: uuid("current_version_id").references(
      (): AnyPgColumn => postingRuleVersions.id,
    ),
    description: text("description"),
    createdByUserId: text("created_by_user_id").references(() => user.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    foreignKey({
      name: "posting_rules_book_fk",
      columns: [table.accountingBookId],
      foreignColumns: [accountingBooks.id],
    }),
    unique("posting_rules_code_uq").on(table.code),
    check(
      "posting_rules_status_check",
      sql`${table.status} in ('draft', 'active', 'disabled')`,
    ),
    check(
      "posting_rules_source_fact_type_check",
      sql`${table.sourceFactType} in ('order', 'order_fee', 'order_refund',
                                     'order_fulfillment', 'inventory_movement',
                                     'acquisition_cost', 'shipment', 'expense',
                                     'payout', 'payout_line', 'bank_transaction',
                                     'sales_tax_fact', 'manual')`,
    ),
    /** The resolution probe: candidates for one fact type, best priority first. */
    index("posting_rules_type_status_priority_idx").on(
      table.sourceFactType,
      table.status,
      table.priority,
    ),
  ],
);

/**
 * An immutable version of a rule: its predicates, its effective dating, and
 * (through {@link postingRuleLines}) its line template.
 *
 * **All predicates null means "every fact of this type", and every non-null
 * predicate is an AND.** That is the entire selector semantics: no OR, no
 * negation, no nesting, no expression column. A rule that needs OR is two rules
 * with different priorities, which is also more legible in a list.
 *
 * **A version is immutable once any journal entry references it** (owner answer
 * 2, and migration 0010's trigger). Editing an active rule creates version N+1
 * and marks N `superseded`; `posting_rules.current_version_id` moves. This is
 * the whole reason versions exist: an entry posted in March must be explainable
 * by exactly the rule text that produced it, and a mutable rule makes every
 * historical entry unexplainable.
 *
 * The predicate columns are deliberately typed and named after real columns on
 * the Phase 3/Phase 4 facts (`order_fees.fee_type`, `order_fees.fee_direction`,
 * `inventory_movements.movement_kind`, `acquisitions.source_kind`,
 * `acquisition_costs.capitalize`). A predicate that does not apply to the rule's
 * `source_fact_type` is a validation error at rule-save time, not a silent
 * no-op.
 */
export const postingRuleVersions = pgTable(
  "posting_rule_versions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    postingRuleId: uuid("posting_rule_id").notNull(),
    version: integer("version").notNull(),
    status: text("status").notNull().default("draft"),
    /** Calendar dates in the book's frame: which facts this text applies to. */
    effectiveFrom: date("effective_from", { mode: "string" }),
    effectiveTo: date("effective_to", { mode: "string" }),

    matchProvider: text("match_provider"),
    matchChannel: text("match_channel"),
    matchEconomicEntityId: uuid("match_economic_entity_id"),
    matchFeeType: text("match_fee_type"),
    matchFeeDirection: text("match_fee_direction"),
    matchMovementKind: text("match_movement_kind"),
    matchSourceKind: text("match_source_kind"),
    matchExpenseCategory: text("match_expense_category"),
    matchCapitalize: boolean("match_capitalize"),
    matchCurrency: char("match_currency", { length: 3 }),
    matchMinAmount: numeric("match_min_amount", { precision: 20, scale: 6 }),
    matchMaxAmount: numeric("match_max_amount", { precision: 20, scale: 6 }),

    note: text("note"),
    createdByUserId: text("created_by_user_id").references(() => user.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    foreignKey({
      name: "posting_rule_versions_rule_fk",
      columns: [table.postingRuleId],
      foreignColumns: [postingRules.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "posting_rule_versions_entity_fk",
      columns: [table.matchEconomicEntityId],
      foreignColumns: [economicEntities.id],
    }),
    unique("posting_rule_versions_rule_version_uq").on(
      table.postingRuleId,
      table.version,
    ),
    check(
      "posting_rule_versions_status_check",
      sql`${table.status} in ('draft', 'active', 'superseded')`,
    ),
    check(
      "posting_rule_versions_effective_range_check",
      sql`${table.effectiveTo} is null or ${table.effectiveFrom} is null
          or ${table.effectiveTo} >= ${table.effectiveFrom}`,
    ),
    check(
      "posting_rule_versions_amount_range_check",
      sql`${table.matchMaxAmount} is null or ${table.matchMinAmount} is null
          or ${table.matchMaxAmount} >= ${table.matchMinAmount}`,
    ),
    check("posting_rule_versions_version_check", sql`${table.version} > 0`),
    index("posting_rule_versions_rule_status_idx").on(
      table.postingRuleId,
      table.status,
    ),
  ],
);

/**
 * One line of a version's template.
 *
 * ```text
 * account resolution   by system_key OR by explicit id, exactly one. A system
 *                      key is what makes a rule book-portable: the same rule
 *                      resolves `marketplace_clearing` to whichever account
 *                      carries that key in whichever book the fact routed to.
 * amount               amount_source x amount_multiplier, and debit versus
 *                      credit falls out of the SIGN. A credit line is a
 *                      multiplier of -1; there is no debit/credit column, for
 *                      the same reason journal_lines has none.
 * remainder            the plug line, at most one per version. It takes
 *                      whatever value makes the entry balance, which is what
 *                      makes it impossible to author a template that cannot
 *                      balance.
 * ```
 *
 * `description_template` is a small named-placeholder string
 * (`"eBay sale {external_order_number}"`), not an expression: the placeholder
 * set is closed per fact type and validated at save.
 */
export const postingRuleLines = pgTable(
  "posting_rule_lines",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    postingRuleVersionId: uuid("posting_rule_version_id").notNull(),
    lineNumber: integer("line_number").notNull(),
    /** Book-portable resolution. Exactly one of these two is set. */
    accountSystemKey: text("account_system_key"),
    ledgerAccountId: uuid("ledger_account_id"),
    amountSource: text("amount_source").notNull(),
    amountMultiplier: numeric("amount_multiplier", { precision: 20, scale: 6 })
      .notNull()
      .default("1"),
    /** The line carries the source fact's entity into `journal_lines`. */
    inheritEntity: boolean("inherit_entity").notNull().default(true),
    dimensionValueId: uuid("dimension_value_id"),
    descriptionTemplate: text("description_template"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    foreignKey({
      name: "posting_rule_lines_version_fk",
      columns: [table.postingRuleVersionId],
      foreignColumns: [postingRuleVersions.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "posting_rule_lines_account_fk",
      columns: [table.ledgerAccountId],
      foreignColumns: [ledgerAccounts.id],
    }),
    foreignKey({
      name: "posting_rule_lines_dimension_value_fk",
      columns: [table.dimensionValueId],
      foreignColumns: [accountingDimensionValues.id],
    }),
    unique("posting_rule_lines_version_line_uq").on(
      table.postingRuleVersionId,
      table.lineNumber,
    ),
    /** At most one plug line per version. */
    uniqueIndex("posting_rule_lines_version_remainder_uq")
      .on(table.postingRuleVersionId)
      .where(sql`amount_source = 'remainder'`),
    check(
      "posting_rule_lines_account_check",
      sql`num_nonnulls(${table.accountSystemKey}, ${table.ledgerAccountId}) = 1`,
    ),
    check(
      "posting_rule_lines_multiplier_check",
      sql`${table.amountMultiplier} <> 0`,
    ),
    check("posting_rule_lines_line_number_check", sql`${table.lineNumber} > 0`),
    check(
      "posting_rule_lines_amount_source_check",
      sql`${table.amountSource} in ('total', 'subtotal', 'shipping', 'discount',
                                   'tax', 'fee', 'refund', 'net', 'cost_basis',
                                   'quantity_times_basis', 'remainder')`,
    ),
    index("posting_rule_lines_version_idx").on(table.postingRuleVersionId),
  ],
);

/**
 * The double-entry journal's header row.
 *
 * **Posted entries and their lines are immutable** (migration 0009's trigger).
 * Corrections are reversal entries, never edits — this is Phase 4's append-only
 * rule applied to the ledger, where it is even less negotiable: a ledger whose
 * posted rows can be updated is a spreadsheet. The one whitelisted exception is
 * the `posted` → `reversed` status stamp, which changes nothing else.
 */
export const journalEntries = pgTable(
  "journal_entries",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    accountingBookId: uuid("accounting_book_id").notNull(),

    /** Gapless per book, minted from `accounting_books.next_entry_number`. Null until posted. */
    entryNumber: bigint("entry_number", { mode: "number" }),
    fiscalPeriodId: uuid("fiscal_period_id"),

    /** A calendar date in the book's frame, never an instant. */
    entryDate: date("entry_date", { mode: "string" }).notNull(),
    status: text("status").notNull().default("draft"),
    entrySource: text("entry_source").notNull(),

    /**
     * The retry probe. Jobs are at-least-once and a posting handler that runs
     * twice must not post twice — the `inventory_movements.deduplication_key`
     * mechanism verbatim. The rule version belongs INSIDE the key once rules
     * exist, so that a deliberate re-post under a corrected rule mints a new
     * key instead of being silently swallowed by the unique.
     */
    postingKey: text("posting_key"),

    /**
     * WHICH rule text produced this entry — a real foreign key, unlike the
     * source-fact stamp below, because a rule version is Loxep's own immutable
     * record and is never deleted while an entry references it.
     *
     * Activated by migration 0010 ("Migration B" in the design's own plan)
     * together with the paired CHECK below. An entry whose `entry_source` is
     * `posting_rule` MUST name a version and no other entry may: that is what
     * makes "explain this number" a lookup rather than an investigation.
     */
    postingRuleVersionId: uuid("posting_rule_version_id"),

    /**
     * Provenance, deliberately UNENFORCED: a text discriminator and a bare
     * uuid with no foreign key. A posted journal entry must survive the
     * deletion of its source fact, and a ledger whose entries can be cascaded
     * away — or whose entries block an operational delete — is not a ledger.
     * The precedent exists twice already (`market_events.rule_id`,
     * `acquisition_opportunity_links.opportunity_rule_id`).
     */
    sourceFactType: text("source_fact_type"),
    sourceFactId: uuid("source_fact_id"),
    /** Hash over exactly the source-fact fields a rule consumed; the free no-op probe. */
    sourceFactFingerprint: text("source_fact_fingerprint"),

    reversesEntryId: uuid("reverses_entry_id"),
    /** Set when the entry posts into a `soft_closed` period through the authorized path. */
    isBackdated: boolean("is_backdated").notNull().default(false),

    description: text("description").notNull(),
    memo: text("memo"),

    postedAt: timestamp("posted_at", { withTimezone: true }),
    postedByUserId: text("posted_by_user_id").references(() => user.id, {
      onDelete: "set null",
    }),
    createdByUserId: text("created_by_user_id").references(() => user.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    foreignKey({
      name: "journal_entries_book_fk",
      columns: [table.accountingBookId],
      foreignColumns: [accountingBooks.id],
    }),
    /**
     * Composite, for the same reason `journal_lines`' are: an entry stamped
     * with a period belonging to a different book would put March's activity in
     * another book's March, which no read model could detect.
     */
    foreignKey({
      name: "journal_entries_period_fk",
      columns: [table.accountingBookId, table.fiscalPeriodId],
      foreignColumns: [fiscalPeriods.accountingBookId, fiscalPeriods.id],
    }),
    foreignKey({
      name: "journal_entries_reverses_fk",
      columns: [table.reversesEntryId],
      foreignColumns: [table.id],
    }),
    foreignKey({
      name: "journal_entries_posting_rule_version_fk",
      columns: [table.postingRuleVersionId],
      foreignColumns: [postingRuleVersions.id],
    }),
    /** Composite-FK target for `journal_lines`: same-book lines, structurally. */
    unique("journal_entries_book_id_uq").on(table.accountingBookId, table.id),
    uniqueIndex("journal_entries_book_entry_number_uq")
      .on(table.accountingBookId, table.entryNumber)
      .where(sql`entry_number is not null`),
    /** The idempotency probe; the constraint IS the index. */
    uniqueIndex("journal_entries_posting_key_uq")
      .on(table.postingKey)
      .where(sql`posting_key is not null`),
    check(
      "journal_entries_status_check",
      sql`${table.status} in ('draft', 'posted', 'reversed', 'void')`,
    ),
    check(
      "journal_entries_entry_source_check",
      sql`${table.entrySource} in ('posting_rule', 'manual', 'import', 'opening_balance')`,
    ),
    /**
     * The design's paired check, activated with the column: an entry claims a
     * rule exactly when a rule produced it. Without the biconditional an entry
     * could claim `posting_rule` and name nothing (unexplainable) or name a
     * version while claiming to be manual (a rule blamed for a human's number).
     */
    check(
      "journal_entries_posting_rule_version_check",
      sql`(${table.entrySource} = 'posting_rule') = (${table.postingRuleVersionId} is not null)`,
    ),
    /** A posted entry is numbered, stamped with its period, and has an instant. */
    check(
      "journal_entries_posted_completeness_check",
      sql`${table.status} not in ('posted', 'reversed')
          or (${table.entryNumber} is not null
              and ${table.fiscalPeriodId} is not null
              and ${table.postedAt} is not null)`,
    ),
    check(
      "journal_entries_reverses_self_check",
      sql`${table.reversesEntryId} is distinct from ${table.id}`,
    ),
    /**
     * Not sketched: a half-written provenance stamp is unreadable in both
     * directions — a type with no id names nothing, an id with no type cannot
     * be resolved. Either both or neither.
     */
    check(
      "journal_entries_source_fact_check",
      sql`num_nonnulls(${table.sourceFactType}, ${table.sourceFactId}) <> 1`,
    ),
    index("journal_entries_book_entry_date_idx").on(
      table.accountingBookId,
      table.entryDate,
    ),
    /** "Did this fact post?" — reverse provenance without a foreign key. */
    index("journal_entries_source_fact_idx").on(
      table.sourceFactType,
      table.sourceFactId,
    ),
    index("journal_entries_reverses_entry_id_idx")
      .on(table.reversesEntryId)
      .where(sql`reverses_entry_id is not null`),
    /** Rule-impact analysis: "which entries did version N produce?" */
    index("journal_entries_posting_rule_version_idx")
      .on(table.postingRuleVersionId)
      .where(sql`posting_rule_version_id is not null`),
  ],
);

/**
 * The double-entry journal's lines.
 *
 * ## Signed amount, not debit and credit columns
 *
 * `amount` is signed: **positive is a debit, negative is a credit**, and there
 * are no `debit_amount`/`credit_amount` columns. This is Phase 4's signed
 * `inventory_movements.quantity` argument applied to money, and it is stronger
 * here: with two nullable columns every balance in the system — trial balance,
 * P&L, balance sheet, clearing residual, reconciliation variance — is
 * `sum(debit) - sum(credit)` over nulls and has to get that expression right.
 * With one signed column a balance is `sum(amount)`, and the entry check is
 * `sum(amount) = 0` rather than a cross-null comparison. Presentation is where
 * debit/credit belongs: the read model emits `debit = greatest(amount, 0)` and
 * `credit = greatest(-amount, 0)`, one function, tested once.
 *
 * ## The composite foreign keys are the best constraint in this design
 *
 * The line carries a denormalized `accounting_book_id`, and both of its
 * references are composite: the line's book must equal its ENTRY's book, and
 * the line's book must equal its ACCOUNT's book. Together they make it
 * structurally impossible to post a line in book A against an account belonging
 * to book B. That failure is silent, catastrophic, and exactly what a
 * multi-book installation produces under a service-layer-only guarantee. It is
 * worth one redundant uuid per line, and the redundancy cannot drift because
 * the constraints forbid it.
 *
 * Both entry references carry `ON DELETE CASCADE`, not only the single-column
 * one the design sketches. Mixing a cascading and a non-cascading reference to
 * the same parent row makes the outcome of deleting a draft entry depend on
 * referential-trigger firing order; making both cascade removes the question.
 * Only drafts are ever deleted — the immutability trigger refuses the rest.
 */
export const journalLines = pgTable(
  "journal_lines",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    journalEntryId: uuid("journal_entry_id").notNull(),
    accountingBookId: uuid("accounting_book_id").notNull(),
    ledgerAccountId: uuid("ledger_account_id").notNull(),

    /**
     * THE separation dimension, and a real foreign key rather than a generic
     * dimension row: it is the only dimension guaranteed present on upstream
     * facts, the only one every statement filters on, the only one whose
     * absence must be enforceable, and the only one that needs referential
     * integrity to a foundation record. ADR-0017's entire promise — an LLC and
     * its assumed names sharing one book while remaining separately reportable
     * — is a `where` clause on this column.
     */
    economicEntityId: uuid("economic_entity_id"),

    lineNumber: integer("line_number").notNull(),
    description: text("description"),

    /** The TRANSACTION currency and amount. */
    currency: char("currency", { length: 3 }).notNull(),
    amount: numeric("amount", { precision: 20, scale: 6 }).notNull(),

    /**
     * The same money in the book's currency — the one place in Loxep where
     * cross-currency summation is correct, precisely because the conversion is
     * a stored, frozen, per-line fact rather than a report-time guess. Under
     * the USD-only answer this always equals `amount`; the columns are the seam
     * that lets another currency be wired in later without restating anything.
     */
    functionalCurrency: char("functional_currency", { length: 3 }).notNull(),
    functionalAmount: numeric("functional_amount", {
      precision: 20,
      scale: 6,
    }).notNull(),

    /** Captured at posting and frozen. A rate that changes on refresh is not a fact. */
    fxRate: numeric("fx_rate", { precision: 24, scale: 12 })
      .notNull()
      .default("1"),
    fxRateSource: text("fx_rate_source").notNull().default("unity"),
    fxRateAt: timestamp("fx_rate_at", { withTimezone: true }),

    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    foreignKey({
      name: "journal_lines_entry_fk",
      columns: [table.journalEntryId],
      foreignColumns: [journalEntries.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "journal_lines_book_entry_fk",
      columns: [table.accountingBookId, table.journalEntryId],
      foreignColumns: [journalEntries.accountingBookId, journalEntries.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "journal_lines_book_account_fk",
      columns: [table.accountingBookId, table.ledgerAccountId],
      foreignColumns: [ledgerAccounts.accountingBookId, ledgerAccounts.id],
    }),
    foreignKey({
      name: "journal_lines_entity_fk",
      columns: [table.economicEntityId],
      foreignColumns: [economicEntities.id],
    }),
    unique("journal_lines_entry_line_number_uq").on(
      table.journalEntryId,
      table.lineNumber,
    ),
    /** A zero line is not a posting, it is an empty row. */
    check("journal_lines_amount_check", sql`${table.amount} <> 0`),
    check("journal_lines_line_number_check", sql`${table.lineNumber} > 0`),
    check("journal_lines_fx_rate_check", sql`${table.fxRate} > 0`),
    /**
     * Same currency exactly when the rate is unity, and vice versa. Populating
     * rather than nulling the unity case is what keeps every read path free of
     * a null branch.
     */
    check(
      "journal_lines_unity_check",
      sql`(${table.currency} = ${table.functionalCurrency}) = (${table.fxRateSource} = 'unity')`,
    ),
    check(
      "journal_lines_fx_rate_source_check",
      sql`${table.fxRateSource} in ('unity', 'provider_reported', 'manual', 'imported')`,
    ),
    index("journal_lines_entry_idx").on(table.journalEntryId),
    /**
     * The single most-run query in the schema: every balance, every statement
     * line, and every clearing residual is a range scan on this index.
     * Including `id` keeps it usable for the ordered read without carrying
     * `amount`, which would double its size for a marginal gain at these
     * volumes.
     */
    index("journal_lines_book_account_idx").on(
      table.accountingBookId,
      table.ledgerAccountId,
      table.id,
    ),
    index("journal_lines_book_entity_idx")
      .on(table.accountingBookId, table.economicEntityId)
      .where(sql`economic_entity_id is not null`),
    /** FX exposure — partial, and empty under the USD-only answer. */
    index("journal_lines_foreign_currency_idx")
      .on(table.ledgerAccountId, table.currency)
      .where(sql`currency <> functional_currency`),
  ],
);

/**
 * Dimension values attached to a line.
 *
 * The composite primary key enforces **at most one value per dimension per
 * line**, which is the whole semantic content of "a dimension": without it a
 * line could carry two departments and every report would double-count.
 * `ON DELETE CASCADE` from `journal_lines` expresses composition — a dimension
 * tag has no existence apart from its line — and matters only for draft
 * cleanup, since posted lines are never deleted.
 */
export const journalLineDimensions = pgTable(
  "journal_line_dimensions",
  {
    journalLineId: uuid("journal_line_id").notNull(),
    dimensionId: uuid("dimension_id").notNull(),
    dimensionValueId: uuid("dimension_value_id").notNull(),
  },
  (table) => [
    primaryKey({
      name: "journal_line_dimensions_pk",
      columns: [table.journalLineId, table.dimensionId],
    }),
    foreignKey({
      name: "journal_line_dimensions_line_fk",
      columns: [table.journalLineId],
      foreignColumns: [journalLines.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "journal_line_dimensions_dimension_fk",
      columns: [table.dimensionId],
      foreignColumns: [accountingDimensions.id],
    }),
    foreignKey({
      name: "journal_line_dimensions_value_fk",
      columns: [table.dimensionValueId],
      foreignColumns: [accountingDimensionValues.id],
    }),
    index("journal_line_dimensions_value_idx").on(table.dimensionValueId),
  ],
);

/**
 * Which operational facts produced an entry — cross-domain rule 4, in the many
 * case.
 *
 * One entry usually comes from one fact, and that case is already covered by
 * `journal_entries.source_fact_type` / `source_fact_id`. A payout entry, by
 * contrast, settles a batch of orders, fees, and refunds at once and needs a
 * LIST; a fee entry names the fee it posted and the order it belongs to. The
 * header stamp stays authoritative for "the fact this entry is about"; this
 * table is everything the entry touched.
 *
 * `source_fact_id` is a plain `uuid` with **no foreign key**, and
 * `source_fact_type` is a text discriminator — the same unenforced stamp the
 * header carries, for the same reason: **a posted journal entry must survive
 * the deletion of its source fact.** A ledger whose entries can be cascaded
 * away, or whose entries block an operational delete, is not a ledger. The
 * alternative — a dozen nullable typed FK columns — is exactly the shape
 * cross-domain rule 5 warns against. The residual risk (a link pointing at a
 * row that no longer exists) is made visible by the "orphan provenance" report
 * rather than hidden by a constraint that would break the ledger to prevent it.
 */
export const journalEntrySourceLinks = pgTable(
  "journal_entry_source_links",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    journalEntryId: uuid("journal_entry_id").notNull(),
    sourceFactType: text("source_fact_type").notNull(),
    sourceFactId: uuid("source_fact_id").notNull(),
    role: text("role").notNull(),
    /** What this fact contributed, where the entry's amount is a sum of facts. */
    amountContributed: numeric("amount_contributed", {
      precision: 20,
      scale: 6,
    }),
    currency: char("currency", { length: 3 }),
    linkedAt: timestamp("linked_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    foreignKey({
      name: "journal_entry_source_links_entry_fk",
      columns: [table.journalEntryId],
      foreignColumns: [journalEntries.id],
    }).onDelete("cascade"),
    /** The at-least-once conflict target: re-linking the same pair is a no-op. */
    unique("journal_entry_source_links_natural_uq").on(
      table.journalEntryId,
      table.sourceFactType,
      table.sourceFactId,
      table.role,
    ),
    check(
      "journal_entry_source_links_role_check",
      sql`${table.role} in ('primary', 'settled', 'allocated', 'reversed_from', 'evidence')`,
    ),
    /** Reverse provenance: "which entries touched this fact?" */
    index("journal_entry_source_links_source_fact_idx").on(
      table.sourceFactType,
      table.sourceFactId,
    ),
  ],
);

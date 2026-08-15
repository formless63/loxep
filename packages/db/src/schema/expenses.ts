/**
 * Phase 5 expenses and their flexible cost attribution (Costs and Expenses
 * domain).
 *
 * Physical realization of the "Expenses and receipts" section of
 * `apps/docs/src/content/docs/architecture/financial-schema-design.md`. **Two
 * tables out of that design's twenty-two**, created by migration 0006 as the
 * first milestone of that phase — before books, the journal, or the posting
 * rules existed, because all three of that document's OWNER-REVIEW-CRITICAL
 * open questions were still unanswered and every one of them is unrecoverable
 * after the first entry posts. They were answered on 2026-08-12; migrations
 * 0009 and 0010 built the ledger and the rule engine that now READ these two
 * tables.
 *
 * Conventions are inherited, not reinvented: uuid PKs with `defaultRandom()`,
 * `numeric(20,6)` money with a separate ISO currency code, state columns as
 * `text` with application-owned TypeScript unions (never PG enums), ADR-0020
 * user references as nullable `SET NULL` FKs, and no `payload` or free-form
 * attribute `jsonb` column anywhere.
 *
 * Phase 5's deliberate divergence from foundation convention applies here:
 * `expenses.expense_date` is a `date`, not a `timestamptz`. It is a calendar
 * date in a book's frame of reference rather than an instant, and the only
 * possible consequence of getting a timezone wrong is an expense landing in the
 * wrong month — precisely the failure a period model exists to prevent.
 * Instants that genuinely are instants (`entity_attributed_at`, `created_at`,
 * `updated_at`) stay `timestamptz` with semantic names.
 *
 * ## The three columns migration 0010 finally added, and the one still missing
 *
 * ```text
 * expenses.accounting_book_id             ADDED 0010  book override
 * expense_allocations.ledger_account_id   ADDED 0010  per-split account
 * expense_allocations.dimension_value_id  ADDED 0010  per-split dimension
 * expenses.financial_account_id           STILL ABSENT — financial_accounts
 *                                         does not exist until the banking
 *                                         milestone
 * ```
 *
 * All four were omitted from 0006 under the design's own rule, stated in the
 * same section it states the columns: *"A column pointing at a table that does
 * not exist is worse than no column."* Migration 0009 gave three of them
 * targets and deliberately did not add them; migration 0010 does, because it is
 * the milestone whose rule engine READS them. The fourth waits for its table
 * for exactly the same reason it always did.
 *
 * ## The posting seam
 *
 * There is no `journal_entry_id`, no `posting_key`, and no FK into any ledger
 * table — still true now that the ledger and its rule engine exist, and their
 * absence is the design working rather than the design missing. Phase 5 posts
 * through **source-fact identity**: an entry carries `source_fact_type` +
 * `source_fact_id`, and its idempotency key is
 * `'pr:' || rule_code || ':v' || version || ':' || source_fact_type || ':' ||
 * source_fact_id || ':' || fingerprint12`. The seam this table owes the ledger
 * is a STABLE IDENTITY, and it has one: `('expense', expenses.id)`, expressed
 * in code as `EXPENSE_SOURCE_FACT_TYPE` / `expenseSourceFact()`.
 *
 * ## PROVISIONAL DECISIONS
 *
 * Implemented under an explicit owner directive to resolve the open questions
 * that touch expenses per the design's own recommendation and mark the result
 * PROVISIONAL for review. See the design document's "Provisional implementation
 * decisions (partial)" section. Summary:
 *
 * ```text
 * category is an OPEN set: text + TS union, no CHECK   expenses.category
 * payee stays denormalized text (no counterparty FK)   expenses.payeeName
 * non-capitalized acquisition_costs are NOT copied     (absence)
 * sum(allocations) = amount is a SERVICE rule          (absence of a trigger)
 * an expense with NO allocations is valid and complete (allocations optional)
 * receipts need no new table — media_links carries it  (absence)
 * ```
 */
import { sql } from "drizzle-orm";
import {
  boolean,
  char,
  check,
  date,
  foreignKey,
  index,
  integer,
  numeric,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import {
  accountingBooks,
  accountingDimensionValues,
  ledgerAccounts,
} from "./accounting.ts";
import { user } from "./auth.ts";
import { catalogItems } from "./commerce.ts";
import { counterparties } from "./counterparties.ts";
import { economicEntities } from "./entities.ts";
import { acquisitionCosts, acquisitions } from "./inventory.ts";
import { documentLineCandidates } from "./documents.ts";

/* ------------------------------------------------------------------ unions */

/**
 * `expenses.status` — a Loxep-owned CLOSED set, so it gets a `CHECK`.
 *
 * ```text
 * draft     being typed; freely editable, legitimately PARTLY allocated
 * recorded  the operator asserts this happened; locked against edits
 * posted    a journal entry exists for it — UNREACHABLE in this slice, because
 *           no journal exists. The member ships anyway so that widening a
 *           CHECK on a table with rows is not the first thing the posting
 *           engine has to do.
 * void      recorded in error; kept, never deleted
 * ```
 */
export const EXPENSE_STATUSES = [
  "draft",
  "recorded",
  "posted",
  "void",
] as const;
export type ExpenseStatus = (typeof EXPENSE_STATUSES)[number];

/** Statuses in which an expense and its allocations may still be edited. */
export const EDITABLE_EXPENSE_STATUSES = ["draft"] as const;

/**
 * `expenses.payment_method` — closed, `CHECK`ed.
 *
 * No provider invents a payment method here: the operator types how they paid.
 * `marketplace_balance` is not decoration — a seller who pays for supplies out
 * of an eBay balance has genuinely not touched a bank account, and a reconciler
 * that assumes every expense has a bank counterpart would chase it forever.
 */
export const EXPENSE_PAYMENT_METHODS = [
  "card",
  "cash",
  "bank_transfer",
  "marketplace_balance",
  "direct_debit",
  "other",
] as const;
export type ExpensePaymentMethod = (typeof EXPENSE_PAYMENT_METHODS)[number];

/**
 * `expenses.entity_attribution_source` — closed, `CHECK`ed.
 *
 * Three members, not Phase 4's five: an expense has no connection and no parent
 * lot to inherit an entity from, so `connection_default` and
 * `acquisition_default` would be unreachable strings. The column's purpose is
 * unchanged — it is the eligibility marker for bulk re-attribution, which may
 * never rewrite a `manual` row.
 */
export const EXPENSE_ENTITY_ATTRIBUTION_SOURCES = [
  "manual",
  "installation_default",
  "unattributed",
] as const;
export type ExpenseEntityAttributionSource =
  (typeof EXPENSE_ENTITY_ATTRIBUTION_SOURCES)[number];

/**
 * Initial `expenses.category` values. TypeScript union with **no** `CHECK`, and
 * this is one of the few genuinely open sets in the financial design.
 *
 * The reason is empirical rather than aesthetic: expense categories are the
 * thing every operator customizes first, and a `CHECK` here guarantees a
 * migration in month two. The asymmetry with `payment_method` — closed, few,
 * and branched on — is the whole rule.
 */
export const EXPENSE_CATEGORIES = [
  "supplies",
  "shipping_supplies",
  "postage",
  "software_subscription",
  "marketplace_subscription",
  "advertising",
  "professional_services",
  "bank_fees",
  "insurance",
  "rent",
  "utilities",
  "vehicle_mileage",
  "travel",
  "meals",
  "equipment",
  "repairs_maintenance",
  "storage",
  "education",
  "taxes_licenses",
  "other",
] as const;
export type ExpenseCategory = (typeof EXPENSE_CATEGORIES)[number];

/**
 * `media_links.resource_type` value for a receipt attached to an expense, and
 * the `purpose` values Phase 5 adds.
 *
 * Receipts need no new table: `media_links` already attaches a `media_object`
 * to any row by `(resource_type, resource_id, purpose)`, and migration 0004
 * gave that tuple a real unique so an at-least-once attach has an `ON CONFLICT`
 * target. These are application text values, not DDL.
 */
export const EXPENSE_RESOURCE_TYPE = "expense";
export const EXPENSE_MEDIA_PURPOSES = [
  "receipt",
  "invoice",
  "supporting_document",
] as const;
export type ExpenseMediaPurpose = (typeof EXPENSE_MEDIA_PURPOSES)[number];

/* ----------------------------------------------------------------- tables */

export const expenses = pgTable(
  "expenses",
  {
    id: uuid("id").primaryKey().defaultRandom(),

    /**
     * Attribution, identical in shape to `acquisitions` and `inventory_items`.
     * Nullable: an unattributed expense is a real and common early state, not
     * an error.
     */
    economicEntityId: uuid("economic_entity_id").references(
      () => economicEntities.id,
    ),
    entityAttributionSource: text("entity_attribution_source").notNull(),
    entityAttributedAt: timestamp("entity_attributed_at", {
      withTimezone: true,
    }),
    entityAttributedByUserId: text("entity_attributed_by_user_id").references(
      () => user.id,
      { onDelete: "set null" },
    ),

    /** `EXP-2026-0231`. People label things and a UUID is not a label. */
    referenceCode: text("reference_code").notNull(),

    /** A calendar date in the book's frame, never an instant. */
    expenseDate: date("expense_date", { mode: "string" }).notNull(),

    /**
     * Denormalized text, matching `acquisitions.vendor_name` exactly. Phase 6
     * adds a nullable `payee_counterparty_id` and backfills by matching; this
     * column stays, because it is the matching evidence.
     */
    payeeName: text("payee_name"),

    /**
     * Added migration 0024 (`expense-entry-design.md` section 2, milestone
     * M1). Nullable: the quick-entry fast path never requires a counterparty,
     * and a thrift-store receipt from an unnamed shop is a real expense.
     *
     * `payeeName` is ALWAYS written alongside this column — the service
     * snapshots the resolved `display_name` at write time, so a later rename
     * of the party does not rewrite history. No backfill: matching
     * `payeeName` to parties in bulk needs `counterparty_identifiers` (still
     * design-only) and a mis-match would be silent.
     *
     * Any read that joins through this column MUST resolve the survivor
     * pointer via `resolvedIdExpression` from `@loxep/counterparties/merge.ts`,
     * so a merged party's expenses report under the survivor.
     *
     * No inline `.references()` here — the FK is declared explicitly below
     * (`expenses_payee_counterparty_fk`) so drizzle-kit does not emit a
     * second, auto-derived-name constraint alongside it.
     */
    payeeCounterpartyId: uuid("payee_counterparty_id"),

    /** Open set: TS union, no `CHECK`. See {@link EXPENSE_CATEGORIES}. */
    category: text("category").notNull(),
    description: text("description"),

    currency: char("currency", { length: 3 }).notNull(),
    amount: numeric("amount", { precision: 20, scale: 6 }).notNull(),
    taxAmount: numeric("tax_amount", { precision: 20, scale: 6 })
      .notNull()
      .default("0"),

    paymentMethod: text("payment_method").notNull(),

    /**
     * Optional cross-reference to the Phase 4 lot cost that records the same
     * spend from the inventory side.
     *
     * The design sketched this as a plain `uuid` with no FK because Phase 4 had
     * not shipped; it HAS shipped (migration 0005), so per the design's own
     * instruction this is a real foreign key.
     *
     * It is a cross-reference, never a copy path. Phase 5's answer to Phase 4's
     * open question 10 is that `acquisition_costs.capitalize = false` rows are
     * NOT copied into `expenses` — they post directly from where they already
     * are. Copying would create two records of one fact with no arbiter.
     */
    acquisitionCostId: uuid("acquisition_cost_id").references(
      () => acquisitionCosts.id,
    ),

    /**
     * A nullable **override**, added by migration 0010 with the posting-rule
     * milestone that reads it. Normally null: the book is routed from the
     * entity exactly as every other fact's is. It exists for the honest case of
     * an expense an operator wants in a specific book regardless of routing.
     */
    accountingBookId: uuid("accounting_book_id").references(
      () => accountingBooks.id,
    ),

    status: text("status").notNull().default("draft"),

    /**
     * Recorded, and deliberately without a consumer. Phase 6 explicitly
     * declines to give it one (no employee model, no reimbursement workflow,
     * no payee-owed concept), and payroll is a permanent non-goal.
     */
    reimbursable: boolean("reimbursable").notNull().default(false),

    /**
     * A free-text grouping key for "this is the March instance of the monthly
     * storage unit". It is NOT a recurrence engine, a schedule, or a job: it is
     * the string a report groups by so an operator can see twelve of them.
     */
    recurringGroupKey: text("recurring_group_key"),

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
    unique("expenses_reference_code_uq").on(table.referenceCode),

    /**
     * Named explicitly per the migration plan's own instruction, even though
     * the derived name (`expenses_payee_counterparty_id_counterparties_id_fk`,
     * 51 bytes) is under the 63-byte limit here — stated explicitly so a
     * later long rename cannot silently truncate it.
     */
    foreignKey({
      name: "expenses_payee_counterparty_fk",
      columns: [table.payeeCounterpartyId],
      foreignColumns: [counterparties.id],
    }),

    /**
     * A zero-amount expense is not a fact, it is an empty form. Same reasoning
     * as `inventory_movements.quantity <> 0`. Negative IS permitted: a vendor
     * credit against a previously recorded cost is a real expense row.
     */
    check("expenses_amount_check", sql`${table.amount} <> 0`),
    check(
      "expenses_entity_attribution_source_check",
      sql`${table.entityAttributionSource} in ('manual', 'installation_default', 'unattributed')`,
    ),
    check(
      "expenses_status_check",
      sql`${table.status} in ('draft', 'recorded', 'posted', 'void')`,
    ),
    check(
      "expenses_payment_method_check",
      sql`${table.paymentMethod} in ('card', 'cash', 'bank_transfer', 'marketplace_balance', 'direct_debit', 'other')`,
    ),

    index("expenses_entity_date_idx").on(
      table.economicEntityId,
      table.expenseDate.desc(),
    ),
    index("expenses_category_date_idx").on(
      table.category,
      table.expenseDate.desc(),
    ),
    /** The posting backlog: tiny, partial, and the only reason `status` is indexed. */
    index("expenses_posting_backlog_idx")
      .on(table.status)
      .where(sql`${table.status} <> 'posted'`),
    index("expenses_acquisition_cost_id_idx")
      .on(table.acquisitionCostId)
      .where(sql`${table.acquisitionCostId} is not null`),
    index("expenses_payee_counterparty_id_idx")
      .on(table.payeeCounterpartyId)
      .where(sql`${table.payeeCounterpartyId} is not null`),
  ],
);

/**
 * Flexible cost attribution: how one expense splits across the things it was
 * really for.
 *
 * **Ships only the targets that exist.** Entity, acquisition, catalog item, and
 * channel had real referents in 0006; ledger account and dimension value gained
 * theirs in 0009 and are added here by 0010. Customer, project, shipment, and
 * service still do not exist (Phase 6), and each is an additive nullable column
 * when its table lands.
 *
 * The invariant `sum(amount) = expenses.amount` is a **service rule and a
 * report, not a constraint**, because a draft expense is legitimately partly
 * allocated. This is the third phase to reach that conclusion from a different
 * direction — Phase 3's order-total rule, Phase 4's lot-allocation invariant,
 * and now this — and the shipped rule is stricter in one direction than the
 * design's prose: allocations may never EXCEED the expense, in any status, and
 * `@loxep/accounting` refuses the write. Under-allocation is a draft; over-
 * allocation is arithmetic that cannot become true later.
 *
 * An expense with **no** allocations is valid and complete. Allocations are for
 * splitting, not for existing.
 */
export const expenseAllocations = pgTable(
  "expense_allocations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    expenseId: uuid("expense_id")
      .notNull()
      .references(() => expenses.id, { onDelete: "cascade" }),
    lineNumber: integer("line_number").notNull(),
    amount: numeric("amount", { precision: 20, scale: 6 }).notNull(),

    economicEntityId: uuid("economic_entity_id").references(
      () => economicEntities.id,
    ),
    /** Real FK: Phase 4 shipped (migration 0005). */
    acquisitionId: uuid("acquisition_id").references(() => acquisitions.id),
    catalogItemId: uuid("catalog_item_id").references(() => catalogItems.id),
    /**
     * Added by migration 0010, with the milestone that reads them: an operator
     * splitting a bill may name the account and the dimension value the split
     * belongs to. Both stay nullable — the shipped expense rule resolves an
     * account from the expense's `category`, and an allocation that names one
     * overrides that for its own share.
     */
    ledgerAccountId: uuid("ledger_account_id").references(
      () => ledgerAccounts.id,
    ),
    dimensionValueId: uuid("dimension_value_id"),
    /** Free text (`ebay`, `woo`, `retail`) — open by the same rule as `category`. */
    channel: text("channel"),
    note: text("note"),

    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    unique("expense_allocations_expense_line_uq").on(
      table.expenseId,
      table.lineNumber,
    ),
    check("expense_allocations_amount_check", sql`${table.amount} <> 0`),
    check("expense_allocations_line_number_check", sql`${table.lineNumber} > 0`),
    /**
     * The kind/reference discipline this design's siblings established
     * (`order_fees.fee_scope`, `inventory_allocations`' kind/reference pair,
     * `acquisition_opportunity_links`' `num_nonnulls(...) >= 1`), applied here
     * in the `>= 1` form rather than the discriminated-union form.
     *
     * `>= 1` and not `= 1` is the deliberate half: these targets are ORTHOGONAL
     * dimensions of one split, not alternative kinds of it. "$40 of this fuel
     * bill belongs to the LLC, against that auction lot" is one allocation
     * naming two targets, and a discriminator column would force it to be two
     * rows summing to $80. What the check forbids is the row that names
     * nothing: an allocation that splits an amount toward no target is not an
     * attribution, and nothing downstream could ever read it.
     *
     * Migration 0010 WIDENS it — strictly loosening, so no existing row can
     * fail — to count `ledger_account_id` and `dimension_value_id`, which
     * became real targets when the chart and the dimensions shipped. "$40 of
     * this bill is Shipping Expense" is an attribution naming exactly one
     * thing, and it was previously refused for naming the wrong one.
     */
    check(
      "expense_allocations_target_check",
      sql`num_nonnulls(${table.economicEntityId}, ${table.acquisitionId}, ${table.catalogItemId}, ${table.channel}, ${table.ledgerAccountId}, ${table.dimensionValueId}) >= 1`,
    ),

    /**
     * Named explicitly: drizzle's derived name for this pair
     * (`expense_allocations_dimension_value_id_accounting_dimension_values_id_fk`)
     * is 72 bytes, and PostgreSQL silently truncates at 63 — a truncated name
     * collides the day a second long reference lands on this table.
     */
    foreignKey({
      name: "expense_allocations_dimension_value_fk",
      columns: [table.dimensionValueId],
      foreignColumns: [accountingDimensionValues.id],
    }),

    index("expense_allocations_expense_id_idx").on(table.expenseId),
    index("expense_allocations_acquisition_id_idx")
      .on(table.acquisitionId)
      .where(sql`${table.acquisitionId} is not null`),
  ],
);

/**
 * `expense_lines.line_kind` — closed, `CHECK`ed. Every receipt line the
 * design's connective field table anticipates: the purchased item itself,
 * the three things that ride alongside it on real paper (shipping, tax,
 * fee), a coupon or discount (negative `line_amount`), and an open bucket
 * for anything else transcribed.
 */
export const EXPENSE_LINE_KINDS = [
  "item",
  "shipping",
  "tax",
  "fee",
  "discount",
  "other",
] as const;
export type ExpenseLineKind = (typeof EXPENSE_LINE_KINDS)[number];

/**
 * A receipt line — WHAT WAS BOUGHT, not WHERE THE MONEY IS CHARGED.
 * `expense-entry-design.md` section 4 draws the distinction this table
 * exists to keep separate from `expense_allocations`: a line comes off the
 * receipt (may have quantity and unit price, may name no target at all,
 * count is fixed by the document); an allocation comes out of the
 * operator's head (has an amount and one or more targets, must name at
 * least one, count is chosen by the operator). Widening
 * `expense_allocations` to carry `description`/`quantity`/`unit_amount` was
 * REJECTED — it would require loosening `expense_allocations_target_check`
 * (`>= 1`, three phases converged on independently) so a bare transcribed
 * line could be stored, and dropping `expense_allocations_amount_check`
 * (`<> 0`), because a zero-priced "free with purchase" line is a real
 * receipt line and a zero-amount ALLOCATION attributes nothing.
 *
 * Deliberate absences, each an answer, not an oversight:
 *
 * ```text
 * no currency        one expense, one currency — expenses.currency is authoritative
 * no date            expenses.expense_date is the date
 * no tax_amount      a receipt's tax IS a line (line_kind = 'tax'); a per-line
 *                    tax column would create a second place tax lives
 * no acquisition_id / catalog_item_id / ledger_account_id
 *                    those are ALLOCATION targets and live on expense_allocations;
 *                    a line that wants an account is telling you the expense
 *                    needs a split, not that the line needs a target column
 * ```
 *
 * `line_amount` MAY be zero and MAY be negative — a coupon line is
 * negative, a free line is zero. `expenses.amount` keeps its own `<> 0`
 * check because a zero-total expense is not a fact; a zero-amount LINE is
 * ordinary evidence.
 *
 * `sum(|line_amount|) <= |expenses.amount|` is a SERVICE RULE and a report,
 * never a `CHECK` — the fourth time this documentation reaches that
 * conclusion, for the same reason each prior time did: a draft expense is
 * legitimately half-transcribed. `@loxep/accounting` refuses lines whose
 * absolute sum EXCEEDS the expense; under-transcription is a draft.
 */
export const expenseLines = pgTable(
  "expense_lines",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    expenseId: uuid("expense_id")
      .notNull()
      .references(() => expenses.id, { onDelete: "cascade" }),
    lineNumber: integer("line_number").notNull(),

    description: text("description"),
    quantity: numeric("quantity", { precision: 20, scale: 6 }),
    unitAmount: numeric("unit_amount", { precision: 20, scale: 6 }),
    lineAmount: numeric("line_amount", { precision: 20, scale: 6 }).notNull(),
    lineKind: text("line_kind").notNull().default("item"),

    /**
     * A REAL foreign key with a partial unique index below — unlike
     * `document_line_candidates.target_kind`/`target_id`, which is a stamp
     * across four tables and cannot be one. The candidate still stamps
     * `target_kind = 'expense'`, `target_id = <this row's expense_id>`; the
     * LINE-level provenance hangs off this column, where a real constraint
     * is possible, which is what lets `CANDIDATE_TARGET_KINDS` stay
     * unwidened. `SET NULL` (not `CASCADE`): a candidate row surviving past
     * a line's own provenance link is a bookkeeping detail, never a reason
     * to delete evidence of the purchase.
     *
     * No inline `.references()` — the FK is declared explicitly below
     * (`expense_lines_document_line_candidate_fk`) because the derived name
     * (`expense_lines_document_line_candidate_id_document_line_candidates_id_fk`,
     * 74 bytes) exceeds PostgreSQL's 63-byte identifier limit.
     */
    documentLineCandidateId: uuid("document_line_candidate_id"),
    note: text("note"),

    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    unique("expense_lines_expense_line_uq").on(
      table.expenseId,
      table.lineNumber,
    ),
    // Partial, not a plain `unique()`: most lines carry no candidate at
    // all (a manually typed row), and a bare unique constraint would treat
    // every `null` as a duplicate of every other, refusing the second
    // manual line on ANY expense. `document_line_candidates` already uses
    // the identical `where ... is not null` shape for the analogous case.
    uniqueIndex("expense_lines_document_line_candidate_uq")
      .on(table.documentLineCandidateId)
      .where(sql`${table.documentLineCandidateId} is not null`),

    check("expense_lines_line_number_check", sql`${table.lineNumber} > 0`),
    check(
      "expense_lines_line_kind_check",
      sql`${table.lineKind} in ('item', 'shipping', 'tax', 'fee', 'discount', 'other')`,
    ),

    foreignKey({
      name: "expense_lines_document_line_candidate_fk",
      columns: [table.documentLineCandidateId],
      foreignColumns: [documentLineCandidates.id],
    }).onDelete("set null"),

    index("expense_lines_expense_id_idx").on(table.expenseId),
    index("expense_lines_document_line_candidate_id_idx")
      .on(table.documentLineCandidateId)
      .where(sql`${table.documentLineCandidateId} is not null`),
  ],
);

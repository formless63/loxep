/**
 * Phase 5 expenses and their flexible cost attribution (Costs and Expenses
 * domain).
 *
 * Physical realization of the "Expenses and receipts" section of
 * `apps/docs/src/content/docs/architecture/financial-schema-design.md`. **Two
 * tables out of that design's twenty-two.** This is a deliberate partial slice:
 * accounting books, the chart of accounts, dimensions, fiscal periods, the
 * double-entry journal, posting rules, payouts, banking, reconciliation, and
 * sales-tax facts are NOT created here, because all three of that document's
 * OWNER-REVIEW-CRITICAL open questions (book granularity, posting-rule
 * mutability, functional currency) are unresolved and every one of them is
 * unrecoverable after the first entry posts.
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
 * ## Columns the design sketches and migration 0006 deliberately OMITTED
 *
 * ```text
 * expenses.accounting_book_id       book override; TABLE NOW EXISTS (0009)
 * expenses.financial_account_id     financial_accounts still does not exist
 * expense_allocations.ledger_account_id      NOW EXISTS (0009)
 * expense_allocations.dimension_value_id     NOW EXISTS (0009)
 * ```
 *
 * They were omitted under the design's own rule, stated in the same section it
 * states the columns: *"A column pointing at a table that does not exist is
 * worse than no column."* Migration 0009 landed books, the chart, and
 * dimensions, so three of the four now have targets — and they are STILL
 * absent, because adding them is an `ALTER` on a shipped table that belongs
 * with the posting-rule milestone that will actually read them. Each remains
 * additive; none is load-bearing for what expenses do today. The book an
 * expense posts to is routed from its entity exactly as every other fact's is.
 *
 * ## The posting seam
 *
 * There is no `journal_entry_id`, no `posting_key`, and no FK into any ledger
 * table — still true now that migration 0009 has created the ledger, and their
 * absence is the design working rather than the design missing. Phase 5 posts through **source-fact identity**: an entry carries
 * `source_fact_type` + `source_fact_id`, and its idempotency key is
 * `'pr:' || rule_code || ':v' || version || ':' || source_fact_type || ':' ||
 * source_fact_id`. The seam this table therefore owes the future ledger is a
 * STABLE IDENTITY, and it has one: `('expense', expenses.id)`. That identity is
 * expressed in code as `EXPENSE_SOURCE_FACT_TYPE` / `expenseSourceFact()` in
 * `@loxep/accounting`, and `status = 'posted'` is the state a posting engine
 * will set. Nothing but that engine may reach it.
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
  index,
  integer,
  numeric,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { user } from "./auth.ts";
import { catalogItems } from "./commerce.ts";
import { economicEntities } from "./entities.ts";
import { acquisitionCosts, acquisitions } from "./inventory.ts";

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
  ],
);

/**
 * Flexible cost attribution: how one expense splits across the things it was
 * really for.
 *
 * **Ships only the targets that exist.** Entity, acquisition, catalog item, and
 * channel all have real referents today. Ledger account and dimension value do
 * not (no chart of accounts, no dimensions); customer, project, shipment, and
 * service do not (Phase 6). Each is an additive nullable column when its table
 * lands.
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
     */
    check(
      "expense_allocations_target_check",
      sql`num_nonnulls(${table.economicEntityId}, ${table.acquisitionId}, ${table.catalogItemId}, ${table.channel}) >= 1`,
    ),

    index("expense_allocations_expense_id_idx").on(table.expenseId),
    index("expense_allocations_acquisition_id_idx")
      .on(table.acquisitionId)
      .where(sql`${table.acquisitionId} is not null`),
  ],
);

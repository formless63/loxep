/**
 * Expenses and their flexible cost attribution — the Costs and Expenses half of
 * Phase 5. The ledger now exists alongside it (see `journal.ts`), and nothing
 * here posts into it: that is the posting-rule milestone's job.
 *
 * ## The lifecycle, deliberately small
 *
 * ```text
 * draft ──submit──> recorded ──(a posting engine, one day)──> posted
 *   │                   │
 *   └──────void─────────┴──> void
 * ```
 *
 * `draft` is the only mutable state. Everything about an expense and every one
 * of its allocations can be edited there and nowhere else. `submit` is the
 * operator asserting the fact is complete; after it, the row is evidence, and
 * the only remaining act is `void` — which retains the row, because deleting
 * the record of a mistake destroys the record that it was made.
 *
 * This is stricter than the design's prose, which sketches `status` with a
 * `recorded` default and says nothing about edits. The reasoning for choosing
 * the strict reading now: loosening a lock later is a one-line change, while
 * tightening one after a year of silent post-hoc edits means auditing history
 * to find out which numbers were ever true. There is deliberately no `reopen`.
 *
 * ## Allocations: what the database will not enforce, and what this will
 *
 * The design is explicit that `sum(expense_allocations.amount) =
 * expenses.amount` is *"a service rule and a reconciliation report, not a
 * constraint, because a draft expense is legitimately partly allocated"* —
 * the same conclusion Phase 3 reached for order totals and Phase 4 for lot
 * allocation, three phases and three different causes.
 *
 * This service therefore enforces the half of that invariant that is never
 * legitimate, and only that half:
 *
 * ```text
 * under-allocated   ALLOWED   an unfinished draft, and a named report
 * fully allocated   ALLOWED   the finished state
 * over-allocated    REFUSED   arithmetic no later edit can make true
 * sign flipped      REFUSED   a split of $100 whose running total leaves
 *                             [0, 100] is not a split of that $100
 * ```
 *
 * Every comparison runs through exact scaled-`BigInt` decimal strings
 * (`decimal.ts`); no persisted amount is ever a JavaScript `number`.
 *
 * The over-allocation guard is applied on **both** sides of the arithmetic:
 * adding an allocation checks it against the expense's amount, and *reducing an
 * expense's amount* checks it against the allocations that already exist. A
 * guard that only watched one side would let an operator allocate $100 fully
 * and then edit the expense down to $60.
 *
 * ## Currency discipline
 *
 * `expense_allocations` has no currency column, by design: an allocation is a
 * share of one expense and is denominated in that expense's currency by
 * construction. That makes the expense's `currency` load-bearing for rows other
 * than itself, so this service treats it as follows:
 *
 * - stored uppercase, always, so `usd` and `USD` are never two currencies;
 * - editable only while `draft` AND only while the expense has **no**
 *   allocations. Changing the currency under existing allocations would
 *   silently redenominate every one of them — the numbers would not move and
 *   their meaning would.
 *
 * ## PROVISIONAL
 *
 * Everything here implements the financial design's own recommendations under
 * an owner directive, pending review. Nothing in THIS module creates a book, an
 * account, a dimension, a period, or a journal entry, and nothing sets
 * `status = 'posted'` — see `posting.ts` for the seam, and `journal.ts` for the
 * ledger that reads it.
 */
import { createAuditService } from "@loxep/domain";
import type { LoxepDb } from "@loxep/db";
import { expenseAllocations, expenses } from "@loxep/db/schema";
import type { ExpenseStatus } from "@loxep/db/schema";
import { z } from "zod";
import {
  resolveExpenseAttribution,
  REATTRIBUTABLE_SOURCES,
} from "./attribution.ts";
import { expenseReferenceCode, withCodeRetry } from "./codes.ts";
import {
  ZERO,
  compareDecimals,
  isNegative,
  subtractDecimals,
  sumDecimals,
  toMoneyString,
} from "./decimal.ts";
import {
  AccountingConflictError,
  AccountingNotFoundError,
  AccountingValidationError,
  ExpenseNotEditableError,
  ExpenseOverAllocatedError,
} from "./errors.ts";
import { POSTED_STATUS } from "./posting.ts";
import {
  dateLiteral,
  numericLiteral,
  textLiteral,
  toCalendarDate,
  toDate,
  toDateOrNull,
  uuidLiteral,
} from "./sql.ts";

export type ExpenseRow = typeof expenses.$inferSelect;
export type ExpenseAllocationRow = typeof expenseAllocations.$inferSelect;

/** Reads and writes work against a handle or an open transaction alike. */
type Executor = Pick<LoxepDb, "insert" | "execute" | "query">;

/* ------------------------------------------------------------------ schemas */

const decimalString = z
  .string()
  .regex(/^-?\d+(\.\d+)?$/, "expected a plain decimal string");
const currencyCode = z
  .string()
  .regex(/^[A-Za-z]{3}$/, "expected an ISO-4217 alphabetic code");
const calendarDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "expected a calendar date as YYYY-MM-DD");

const allocationSchema = z
  .strictObject({
    /** Assigned in order when omitted; explicit values must be unique per expense. */
    lineNumber: z.number().int().positive().optional(),
    amount: decimalString,
    economicEntityId: z.uuid().nullish(),
    acquisitionId: z.uuid().nullish(),
    catalogItemId: z.uuid().nullish(),
    channel: z.string().trim().min(1).nullish(),
    /**
     * Added with migration 0010, and READ by the posting engine: an allocation
     * naming an account splits the expense entry's debit side, carrying this
     * account, this entity, and this dimension value onto its own line.
     */
    ledgerAccountId: z.uuid().nullish(),
    dimensionValueId: z.uuid().nullish(),
    note: z.string().trim().min(1).nullish(),
  })
  .refine(
    (allocation) =>
      [
        allocation.economicEntityId,
        allocation.acquisitionId,
        allocation.catalogItemId,
        allocation.channel,
        allocation.ledgerAccountId,
        allocation.dimensionValueId,
      ].some((target) => target !== undefined && target !== null),
    {
      message:
        "an allocation must name at least one target — entity, acquisition, " +
        "catalog item, channel, ledger account, or dimension value " +
        "(expense_allocations_target_check). Targets are orthogonal, so " +
        "naming several is allowed and naming none is not: a split toward " +
        "nothing is not an attribution.",
      path: ["economicEntityId"],
    },
  );

export type AllocationInput = z.input<typeof allocationSchema>;

const createExpenseSchema = z.strictObject({
  /**
   * `undefined` falls through to the installation default;
   * explicit `null` is an operator deliberately leaving it unattributed.
   */
  economicEntityId: z.uuid().nullish(),
  installationDefaultEntityId: z.uuid().nullish(),
  /** Generated as `EXP-<year>-NNNN` when omitted. */
  referenceCode: z.string().trim().min(1).optional(),
  expenseDate: calendarDate,
  payeeName: z.string().trim().min(1).nullish(),
  /**
   * Added migration 0024 (`expense-entry-design.md` section 2, milestone
   * M1). When set, the service resolves the counterparty's `display_name`
   * IN THE SAME WRITE and snapshots it into `payeeName`, overriding whatever
   * `payeeName` the caller also passed — "both are written, always" is the
   * design's own rule, and it is the service's job to keep that true rather
   * than trust the picker's last-known label. Omitted/`null` leaves the
   * quick-entry free-text fast path exactly as it was.
   */
  payeeCounterpartyId: z.uuid().nullish(),
  category: z.string().trim().min(1),
  description: z.string().trim().min(1).nullish(),
  currency: currencyCode,
  amount: decimalString,
  taxAmount: decimalString.default("0"),
  paymentMethod: z.enum([
    "card",
    "cash",
    "bank_transfer",
    "marketplace_balance",
    "direct_debit",
    "other",
  ]),
  acquisitionCostId: z.uuid().nullish(),
  status: z.enum(["draft", "recorded"]).default("draft"),
  reimbursable: z.boolean().default(false),
  recurringGroupKey: z.string().trim().min(1).nullish(),
  notes: z.string().trim().min(1).nullish(),
  createdByUserId: z.string().min(1).nullish(),
  requestId: z.string().min(1).nullish(),
  allocations: z.array(allocationSchema).default([]),
});

export type CreateExpenseInput = z.input<typeof createExpenseSchema>;

const updateExpenseSchema = z.strictObject({
  expenseId: z.uuid(),
  expenseDate: calendarDate.optional(),
  payeeName: z.string().trim().min(1).nullish(),
  /**
   * `undefined` leaves the link untouched. `null` clears it — the "unlink"
   * case — WITHOUT touching `payeeName`, because the last-known label stays
   * valid evidence even once the party link is removed. A non-null uuid is
   * the "link this payee" action (design section 2): the service resolves
   * that counterparty's current `display_name` and snapshots it into
   * `payeeName` in the same write, overriding any `payeeName` passed
   * alongside it in the same call.
   */
  payeeCounterpartyId: z.uuid().nullish(),
  category: z.string().trim().min(1).optional(),
  description: z.string().trim().min(1).nullish(),
  currency: currencyCode.optional(),
  amount: decimalString.optional(),
  taxAmount: decimalString.optional(),
  paymentMethod: z
    .enum([
      "card",
      "cash",
      "bank_transfer",
      "marketplace_balance",
      "direct_debit",
      "other",
    ])
    .optional(),
  acquisitionCostId: z.uuid().nullish(),
  reimbursable: z.boolean().optional(),
  recurringGroupKey: z.string().trim().min(1).nullish(),
  notes: z.string().trim().min(1).nullish(),
  actorUserId: z.string().min(1).nullish(),
  requestId: z.string().min(1).nullish(),
});

export type UpdateExpenseInput = z.input<typeof updateExpenseSchema>;

function parse<T extends z.ZodType>(schema: T, input: unknown): z.output<T> {
  const parsed = schema.safeParse(input);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("; ");
    throw new AccountingValidationError(`invalid expense input: ${issues}`);
  }
  return parsed.data;
}

/* ------------------------------------------------------------- arithmetic */

/**
 * The allocation invariant, stated once.
 *
 * A split of an expense must land inside the closed interval between zero and
 * the expense's own amount, taking the expense's sign as the direction. That
 * one rule covers both cases without a branch on sign at the call site: a
 * positive expense may be allocated `0 ≤ Σ ≤ amount`, a negative one (a vendor
 * credit) `amount ≤ Σ ≤ 0`.
 *
 * Individual allocation lines may still be mixed-sign — a bill split as `+120`
 * supplies and `−20` rebate is a real thing — because the invariant is about
 * the total, not about each line. What it forbids is a total that exceeds the
 * expense or points the other way.
 */
export function allocationsFit(amount: string, allocated: string): boolean {
  if (isNegative(amount)) {
    return (
      compareDecimals(allocated, ZERO) <= 0 &&
      compareDecimals(allocated, amount) >= 0
    );
  }
  return (
    compareDecimals(allocated, ZERO) >= 0 &&
    compareDecimals(allocated, amount) <= 0
  );
}

/** `amount − Σ allocations`, exact; zero when fully allocated. */
export function unallocatedRemainder(
  amount: string,
  allocated: string,
): string {
  return subtractDecimals(amount, allocated);
}

/* --------------------------------------------------------------- service */

export interface AllocationSummary {
  expenseId: string;
  currency: string;
  amount: string;
  allocatedAmount: string;
  unallocatedAmount: string;
  allocationCount: number;
  fullyAllocated: boolean;
}

export interface ExpensesService {
  create: (
    input: CreateExpenseInput,
  ) => Promise<{ expense: ExpenseRow; allocations: ExpenseAllocationRow[] }>;
  get: (expenseId: string) => Promise<ExpenseRow>;
  getByReferenceCode: (referenceCode: string) => Promise<ExpenseRow>;
  /** Draft only. Refuses any edit that would leave the expense over-allocated. */
  update: (input: UpdateExpenseInput) => Promise<ExpenseRow>;
  /**
   * "Link this payee" (expense-entry-design.md section 2) — the ONE field
   * this service will change on a `recorded` expense, deliberately bypassing
   * the draft-only lock `update` enforces. The same narrow-bypass posture
   * `reattributeDefaults` already uses for entity attribution: attaching
   * provenance to an already-evidentiary row is not the same act as editing
   * the fact itself (amount/date/category), and an operator who discovers
   * days later which trading partner a receipt was from should not have to
   * void-and-re-record just to record that.
   *
   * `payeeCounterpartyId: null` unlinks WITHOUT touching `payeeName` — the
   * last-known text stays valid evidence. A non-null id resolves that
   * counterparty's current `display_name` and snapshots it into `payeeName`
   * in the same write. Refused on a `void` expense: a voided row is frozen
   * evidence of a mistake and its correction path is void-and-re-record, not
   * a follow-up edit.
   */
  linkPayee: (input: {
    expenseId: string;
    payeeCounterpartyId: string | null;
    actorUserId?: string | null;
    requestId?: string | null;
  }) => Promise<ExpenseRow>;
  /** `draft` → `recorded`, audited. The only lock this slice has. */
  submit: (input: {
    expenseId: string;
    actorUserId?: string | null;
    requestId?: string | null;
  }) => Promise<ExpenseRow>;
  /** Retire a row without deleting it; requires a reason and is audited. */
  voidExpense: (input: {
    expenseId: string;
    reason: string;
    actorUserId?: string | null;
    requestId?: string | null;
  }) => Promise<ExpenseRow>;
  /**
   * The void-and-promote writer for `expenses.acquisition_cost_id`
   * (loxep-ytu; `flipping-lifecycle-design.md`'s open question 2, and the
   * matching contradiction note in `expense-entry-design.md`). An operator
   * recorded plain spend that turns out to have bought goods for resale —
   * the acquisition seam (`flipping-lifecycle-design.md`, "the acquisition
   * seam: when an expense is really a purchase") says the corrected fact is
   * an acquisition and its cost row, NEVER a rewritten `expenses` row, so
   * this is `voidExpense`'s OWN state transition (`recorded` → `void`, kept
   * as evidence, never mutated in place, never deleted) with ONE addition:
   * `acquisition_cost_id` is stamped onto the SAME row, in the SAME
   * statement, recording where the voided expense's value went.
   *
   * The caller (`@/server/expense-functions.ts`'s
   * `promoteExpenseToAcquisitionCost`) creates the `acquisition_costs` row
   * FIRST, via `@loxep/inventory`'s `AcquisitionsService.addCost` — this
   * package does not and must not depend on `@loxep/inventory` (the same
   * seam-inversion posture `@loxep/documents` keeps toward `@loxep/accounting`
   * and `@loxep/inventory`), so `acquisitionCostId` arrives here as an
   * opaque, already-valid id, not something this function resolves itself.
   *
   * Deliberately a SEPARATE method from `voidExpense` rather than an
   * optional parameter on it: `voidExpense` is exercised by the shipped
   * void-and-re-record e2e flow and this method's own audit action
   * (`accounting.expense.promoted_to_acquisition_cost`) names a materially
   * different fact than a plain void (`accounting.expense.voided`) — kept
   * distinguishable in the audit log rather than folded into one action with
   * a sometimes-present field.
   *
   * Refuses exactly where `voidExpense` refuses (`posted` — a posted fact is
   * corrected by a reversing ledger entry, not by voiding the source) PLUS
   * an already-`void` row (promotion is the SAME action as voiding, never a
   * follow-up on a row already voided for some other reason — a second
   * `acquisition_cost_id` write on an already-frozen row would be silently
   * rewriting evidence). No new posting is invented: voiding makes the
   * `expense` source fact ineligible (the next posting-engine sweep reverses
   * whatever it already posted) and the new `acquisition_costs` row is a
   * fresh, as-yet-unposted `acquisition_cost` source fact the SAME sweep
   * picks up under the existing `acquisition_cost_capitalized` rule — see
   * `source-facts.ts`'s `readAcquisitionCost` for the reader that already
   * makes this promotion visible from the ledger side via
   * `superseded_expense_id`.
   */
  promoteToAcquisitionCost: (input: {
    expenseId: string;
    acquisitionCostId: string;
    reason: string;
    actorUserId?: string | null;
    requestId?: string | null;
  }) => Promise<ExpenseRow>;
  /**
   * Explicit, audited bulk re-attribution. Rewrites only rows whose
   * `entity_attribution_source` is `installation_default` or `unattributed`;
   * a `manual` row is never touched.
   */
  reattributeDefaults: (input: {
    economicEntityId: string;
    from?: string;
    to?: string;
    actorUserId?: string | null;
    requestId?: string | null;
  }) => Promise<{ updated: number }>;

  listAllocations: (expenseId: string) => Promise<ExpenseAllocationRow[]>;
  /** Replaces the whole set atomically; `[]` clears it. Draft only. */
  setAllocations: (input: {
    expenseId: string;
    allocations: AllocationInput[];
    actorUserId?: string | null;
    requestId?: string | null;
  }) => Promise<ExpenseAllocationRow[]>;
  addAllocation: (input: {
    expenseId: string;
    allocation: AllocationInput;
    actorUserId?: string | null;
    requestId?: string | null;
  }) => Promise<ExpenseAllocationRow>;
  removeAllocation: (input: {
    allocationId: string;
    actorUserId?: string | null;
    requestId?: string | null;
  }) => Promise<void>;
  allocationSummary: (expenseId: string) => Promise<AllocationSummary>;
}

export function createExpensesService(options: {
  db: LoxepDb;
}): ExpensesService {
  const { db } = options;

  async function loadExpense(
    executor: Executor,
    expenseId: string,
  ): Promise<ExpenseRow> {
    const result = await executor.execute(
      `select * from expenses where id = ${uuidLiteral(expenseId)}`,
    );
    const row = result.rows[0];
    if (row === undefined) {
      throw new AccountingNotFoundError(`unknown expense "${expenseId}"`);
    }
    return rowToExpense(row);
  }

  /**
   * `db.execute` returns untyped rows; the Drizzle relational API returns typed
   * ones but cannot be used inside `tx.execute`-based flows without a second
   * round trip. One narrowing function keeps the shape in one place.
   */
  function rowToExpense(row: Record<string, unknown>): ExpenseRow {
    return {
      id: row["id"] as string,
      economicEntityId: (row["economic_entity_id"] as string | null) ?? null,
      entityAttributionSource: row["entity_attribution_source"] as string,
      entityAttributedAt: toDateOrNull(row["entity_attributed_at"]),
      entityAttributedByUserId:
        (row["entity_attributed_by_user_id"] as string | null) ?? null,
      referenceCode: row["reference_code"] as string,
      expenseDate: toCalendarDate(row["expense_date"]),
      payeeName: (row["payee_name"] as string | null) ?? null,
      payeeCounterpartyId: (row["payee_counterparty_id"] as string | null) ?? null,
      category: row["category"] as string,
      description: (row["description"] as string | null) ?? null,
      currency: row["currency"] as string,
      amount: row["amount"] as string,
      taxAmount: row["tax_amount"] as string,
      paymentMethod: row["payment_method"] as string,
      acquisitionCostId: (row["acquisition_cost_id"] as string | null) ?? null,
      /** The nullable book OVERRIDE migration 0010 added; normally null. */
      accountingBookId: (row["accounting_book_id"] as string | null) ?? null,
      status: row["status"] as string,
      reimbursable: row["reimbursable"] as boolean,
      recurringGroupKey: (row["recurring_group_key"] as string | null) ?? null,
      notes: (row["notes"] as string | null) ?? null,
      createdByUserId: (row["created_by_user_id"] as string | null) ?? null,
      createdAt: toDate(row["created_at"]),
      updatedAt: toDate(row["updated_at"]),
    };
  }

  function assertEditable(expense: ExpenseRow): void {
    if (expense.status !== "draft") {
      throw new ExpenseNotEditableError(
        `expense "${expense.referenceCode}" is ${expense.status}, not draft: ` +
          "only a draft expense may be edited. A recorded expense is " +
          "evidence; correct it by voiding it and recording the corrected " +
          "fact, which is the same posture the ledger takes for a posted entry.",
      );
    }
  }

  /** Σ of an expense's allocations, exact, at money scale. */
  async function allocatedTotal(
    executor: Executor,
    expenseId: string,
    excludeAllocationId?: string,
  ): Promise<{ total: string; count: number }> {
    const exclusion =
      excludeAllocationId === undefined
        ? ""
        : ` and id <> ${uuidLiteral(excludeAllocationId)}`;
    const result = await executor.execute(
      `select amount::text as amount from expense_allocations
        where expense_id = ${uuidLiteral(expenseId)}${exclusion}`,
    );
    const amounts = result.rows.map((row) => row["amount"] as string);
    return { total: sumDecimals(amounts), count: amounts.length };
  }

  function assertFits(
    expense: ExpenseRow,
    allocated: string,
    context: string,
  ): void {
    if (allocationsFit(expense.amount, allocated)) return;
    throw new ExpenseOverAllocatedError(
      `${context}: allocations would total ${toMoneyString(allocated)} ` +
        `${expense.currency} against an expense of ` +
        `${toMoneyString(expense.amount)} ${expense.currency} ` +
        `(reference ${expense.referenceCode}). Under-allocation is a draft; ` +
        "over-allocation is arithmetic no later edit can make true.",
    );
  }

  /**
   * The payee snapshot, done in ONE place so create/update cannot drift.
   *
   * Direct SQL against `counterparties` rather than a call into
   * `@loxep/counterparties` — this package depends only on `@loxep/db`/
   * `@loxep/domain`/`@loxep/storage` (see this module's own PROVISIONAL
   * note's siblings), and reading one column off a table this package
   * already has a foreign key into is not the layering violation that
   * reimplementing `create`/`grant`/merge logic would be. Throws
   * {@link AccountingNotFoundError} for an unknown id — the FK would refuse
   * the write anyway, but resolving the name is needed BEFORE the insert.
   */
  async function resolvePayeeDisplayName(
    executor: Executor,
    payeeCounterpartyId: string,
  ): Promise<string> {
    const result = await executor.execute(
      `select display_name from counterparties where id = ${uuidLiteral(payeeCounterpartyId)}`,
    );
    const displayName = result.rows[0]?.["display_name"] as string | undefined;
    if (displayName === undefined) {
      throw new AccountingNotFoundError(
        `unknown payee counterparty "${payeeCounterpartyId}"`,
      );
    }
    return displayName;
  }

  async function nextLineNumber(
    executor: Executor,
    expenseId: string,
  ): Promise<number> {
    const result = await executor.execute(
      `select coalesce(max(line_number), 0)::text as max_line
         from expense_allocations where expense_id = ${uuidLiteral(expenseId)}`,
    );
    return Number(result.rows[0]?.["max_line"] ?? "0") + 1;
  }

  async function insertAllocations(
    executor: Executor,
    expense: ExpenseRow,
    allocations: z.output<typeof allocationSchema>[],
    startingLine: number,
  ): Promise<ExpenseAllocationRow[]> {
    if (allocations.length === 0) return [];
    const values = allocations.map((allocation, index) => ({
      expenseId: expense.id,
      lineNumber: allocation.lineNumber ?? startingLine + index,
      amount: toMoneyString(allocation.amount),
      economicEntityId: allocation.economicEntityId ?? null,
      acquisitionId: allocation.acquisitionId ?? null,
      catalogItemId: allocation.catalogItemId ?? null,
      channel: allocation.channel ?? null,
      ledgerAccountId: allocation.ledgerAccountId ?? null,
      dimensionValueId: allocation.dimensionValueId ?? null,
      note: allocation.note ?? null,
    }));
    return executor.insert(expenseAllocations).values(values).returning();
  }

  async function listAllocations(
    executor: Executor,
    expenseId: string,
  ): Promise<ExpenseAllocationRow[]> {
    return executor.query.expenseAllocations.findMany({
      where: (table, { eq }) => eq(table.expenseId, expenseId),
      orderBy: (table, { asc }) => [asc(table.lineNumber)],
    });
  }

  async function generateReferenceCode(
    executor: Executor,
    year: number,
  ): Promise<string> {
    const result = await executor.execute(
      `select coalesce(max(
                (substring(reference_code from '^EXP-[0-9]{4}-([0-9]+)$'))::integer
              ), 0)::text as max_seq
         from expenses
        where reference_code like ${textLiteral(`EXP-${year}-%`)}`,
    );
    const next = Number(result.rows[0]?.["max_seq"] ?? "0") + 1;
    return expenseReferenceCode(year, next);
  }

  return {
    get: async (expenseId) => loadExpense(db, expenseId),

    getByReferenceCode: async (referenceCode) => {
      const result = await db.execute(
        `select * from expenses where reference_code = ${textLiteral(referenceCode)}`,
      );
      const row = result.rows[0];
      if (row === undefined) {
        throw new AccountingNotFoundError(
          `unknown expense reference code "${referenceCode}"`,
        );
      }
      return rowToExpense(row);
    },

    create: async (input) => {
      const value = parse(createExpenseSchema, input);
      const attribution = resolveExpenseAttribution({
        ...(value.economicEntityId !== undefined
          ? { explicitEntityId: value.economicEntityId }
          : {}),
        installationDefaultEntityId: value.installationDefaultEntityId ?? null,
      });
      const currency = value.currency.toUpperCase();
      const amount = toMoneyString(value.amount);

      // The over-allocation guard applies at creation too: an expense created
      // WITH allocations must satisfy the same invariant an edited one does.
      const allocated = sumDecimals(
        value.allocations.map((allocation) => allocation.amount),
      );
      if (!allocationsFit(amount, allocated)) {
        throw new ExpenseOverAllocatedError(
          `cannot create an expense of ${amount} ${currency} with allocations ` +
            `totalling ${allocated} ${currency}`,
        );
      }

      const year = Number(value.expenseDate.slice(0, 4));

      return withCodeRetry(
        async () =>
          db.transaction(async (tx) => {
            const referenceCode =
              value.referenceCode ?? (await generateReferenceCode(tx, year));
            // "Both are written, always": a chosen payee's display_name
            // overrides any free-text payeeName in the same write.
            const payeeName =
              value.payeeCounterpartyId != null
                ? await resolvePayeeDisplayName(tx, value.payeeCounterpartyId)
                : (value.payeeName ?? null);
            const inserted = await tx
              .insert(expenses)
              .values({
                economicEntityId: attribution.economicEntityId,
                entityAttributionSource: attribution.entityAttributionSource,
                entityAttributedAt:
                  attribution.economicEntityId === null ? null : new Date(),
                entityAttributedByUserId:
                  attribution.entityAttributionSource === "manual"
                    ? (value.createdByUserId ?? null)
                    : null,
                referenceCode,
                expenseDate: value.expenseDate,
                payeeName,
                payeeCounterpartyId: value.payeeCounterpartyId ?? null,
                category: value.category,
                description: value.description ?? null,
                currency,
                amount,
                taxAmount: toMoneyString(value.taxAmount),
                paymentMethod: value.paymentMethod,
                acquisitionCostId: value.acquisitionCostId ?? null,
                status: value.status,
                reimbursable: value.reimbursable,
                recurringGroupKey: value.recurringGroupKey ?? null,
                notes: value.notes ?? null,
                createdByUserId: value.createdByUserId ?? null,
              })
              .returning();
            const expense = inserted[0];
            if (expense === undefined) {
              throw new AccountingConflictError(
                "expenses insert returned no row",
              );
            }

            const allocations = await insertAllocations(
              tx,
              expense,
              value.allocations,
              1,
            );

            await createAuditService({ db: tx }).append({
              actorUserId: value.createdByUserId ?? null,
              action: "accounting.expense.created",
              resourceType: "expense",
              resourceId: expense.id,
              after: {
                referenceCode: expense.referenceCode,
                expenseDate: expense.expenseDate,
                currency: expense.currency,
                amount: expense.amount,
                category: expense.category,
                status: expense.status,
                economicEntityId: expense.economicEntityId,
                entityAttributionSource: expense.entityAttributionSource,
                payeeCounterpartyId: expense.payeeCounterpartyId,
              },
              requestId: value.requestId ?? null,
              metadata: { allocationCount: allocations.length },
            });

            return { expense, allocations };
          }),
        { label: "expense reference code" },
      );
    },

    update: async (input) => {
      const value = parse(updateExpenseSchema, input);
      return db.transaction(async (tx) => {
        const before = await loadExpense(tx, value.expenseId);
        assertEditable(before);

        const assignments: string[] = ["updated_at = now()"];
        if (value.expenseDate !== undefined) {
          assignments.push(`expense_date = ${dateLiteral(value.expenseDate)}`);
        }
        // Resolved BEFORE the payeeName assignment below so a chosen payee's
        // display_name overrides any free-text payeeName in the same call —
        // "both are written, always" (create's same rule).
        let resolvedPayeeName: string | undefined;
        if (value.payeeCounterpartyId !== undefined) {
          assignments.push(
            `payee_counterparty_id = ${value.payeeCounterpartyId === null ? "null" : uuidLiteral(value.payeeCounterpartyId)}`,
          );
          if (value.payeeCounterpartyId !== null) {
            resolvedPayeeName = await resolvePayeeDisplayName(
              tx,
              value.payeeCounterpartyId,
            );
          }
        }
        if (resolvedPayeeName !== undefined) {
          assignments.push(`payee_name = ${textLiteral(resolvedPayeeName)}`);
        } else if (value.payeeName !== undefined) {
          assignments.push(
            `payee_name = ${value.payeeName === null ? "null" : textLiteral(value.payeeName)}`,
          );
        }
        if (value.category !== undefined) {
          assignments.push(`category = ${textLiteral(value.category)}`);
        }
        if (value.description !== undefined) {
          assignments.push(
            `description = ${value.description === null ? "null" : textLiteral(value.description)}`,
          );
        }
        if (value.paymentMethod !== undefined) {
          assignments.push(
            `payment_method = ${textLiteral(value.paymentMethod)}`,
          );
        }
        if (value.acquisitionCostId !== undefined) {
          assignments.push(
            `acquisition_cost_id = ${value.acquisitionCostId === null ? "null" : uuidLiteral(value.acquisitionCostId)}`,
          );
        }
        if (value.reimbursable !== undefined) {
          assignments.push(`reimbursable = ${value.reimbursable}`);
        }
        if (value.recurringGroupKey !== undefined) {
          assignments.push(
            `recurring_group_key = ${value.recurringGroupKey === null ? "null" : textLiteral(value.recurringGroupKey)}`,
          );
        }
        if (value.notes !== undefined) {
          assignments.push(
            `notes = ${value.notes === null ? "null" : textLiteral(value.notes)}`,
          );
        }
        if (value.taxAmount !== undefined) {
          assignments.push(
            `tax_amount = ${numericLiteral(toMoneyString(value.taxAmount))}`,
          );
        }

        const { total: allocated, count } = await allocatedTotal(
          tx,
          before.id,
        );

        if (value.currency !== undefined) {
          const currency = value.currency.toUpperCase();
          if (currency !== before.currency && count > 0) {
            throw new AccountingValidationError(
              `cannot change the currency of expense "${before.referenceCode}" ` +
                `from ${before.currency} to ${currency} while ${count} ` +
                "allocation(s) exist: allocations carry no currency of their " +
                "own and are denominated in the expense's, so the change " +
                "would silently redenominate every one of them. Clear the " +
                "allocations first.",
            );
          }
          assignments.push(`currency = ${textLiteral(currency)}`);
        }

        if (value.amount !== undefined) {
          const amount = toMoneyString(value.amount);
          // The other side of the guard: reducing the amount must not strand
          // allocations that already exist above it.
          assertFits(
            { ...before, amount },
            allocated,
            `cannot change the amount of expense "${before.referenceCode}"`,
          );
          assignments.push(`amount = ${numericLiteral(amount)}`);
        }

        await tx.execute(
          `update expenses set ${assignments.join(", ")}
            where id = ${uuidLiteral(before.id)}`,
        );
        const after = await loadExpense(tx, before.id);

        await createAuditService({ db: tx }).append({
          actorUserId: value.actorUserId ?? null,
          action: "accounting.expense.updated",
          resourceType: "expense",
          resourceId: before.id,
          before: {
            expenseDate: before.expenseDate,
            currency: before.currency,
            amount: before.amount,
            taxAmount: before.taxAmount,
            category: before.category,
            paymentMethod: before.paymentMethod,
          },
          after: {
            expenseDate: after.expenseDate,
            currency: after.currency,
            amount: after.amount,
            taxAmount: after.taxAmount,
            category: after.category,
            paymentMethod: after.paymentMethod,
          },
          requestId: value.requestId ?? null,
          metadata: { referenceCode: before.referenceCode },
        });
        return after;
      });
    },

    linkPayee: async (input) =>
      db.transaction(async (tx) => {
        const before = await loadExpense(tx, input.expenseId);
        if (before.status === "void") {
          throw new ExpenseNotEditableError(
            `expense "${before.referenceCode}" is void; a voided row is ` +
              "frozen evidence of a mistake and its correction path is " +
              "void-and-re-record, not a follow-up edit",
          );
        }
        const payeeName =
          input.payeeCounterpartyId !== null
            ? await resolvePayeeDisplayName(tx, input.payeeCounterpartyId)
            : before.payeeName;
        await tx.execute(
          `update expenses
              set payee_counterparty_id = ${input.payeeCounterpartyId === null ? "null" : uuidLiteral(input.payeeCounterpartyId)},
                  payee_name = ${payeeName === null ? "null" : textLiteral(payeeName)},
                  updated_at = now()
            where id = ${uuidLiteral(before.id)}`,
        );
        const after = await loadExpense(tx, before.id);
        await createAuditService({ db: tx }).append({
          actorUserId: input.actorUserId ?? null,
          action: "accounting.expense.payee_linked",
          resourceType: "expense",
          resourceId: before.id,
          before: {
            payeeCounterpartyId: before.payeeCounterpartyId,
            payeeName: before.payeeName,
          },
          after: {
            payeeCounterpartyId: after.payeeCounterpartyId,
            payeeName: after.payeeName,
          },
          requestId: input.requestId ?? null,
          metadata: { referenceCode: before.referenceCode },
        });
        return after;
      }),

    submit: async (input) =>
      db.transaction(async (tx) => {
        const before = await loadExpense(tx, input.expenseId);
        if (before.status !== "draft") {
          throw new ExpenseNotEditableError(
            `expense "${before.referenceCode}" is already ${before.status}; ` +
              "only a draft may be submitted",
          );
        }
        await tx.execute(
          `update expenses set status = 'recorded', updated_at = now()
            where id = ${uuidLiteral(before.id)}`,
        );
        const after = await loadExpense(tx, before.id);
        const { total: allocated, count } = await allocatedTotal(tx, before.id);
        await createAuditService({ db: tx }).append({
          actorUserId: input.actorUserId ?? null,
          action: "accounting.expense.submitted",
          resourceType: "expense",
          resourceId: before.id,
          before: { status: before.status },
          after: { status: after.status },
          requestId: input.requestId ?? null,
          metadata: {
            referenceCode: before.referenceCode,
            // Recorded on the lock so the report and the audit agree about
            // what was true at submission time.
            allocationCount: count,
            allocatedAmount: allocated,
            unallocatedAmount: unallocatedRemainder(before.amount, allocated),
          },
        });
        return after;
      }),

    voidExpense: async (input) => {
      const reason = input.reason.trim();
      if (reason.length === 0) {
        throw new AccountingValidationError(
          "voiding an expense requires a reason: the row is kept rather than " +
            "deleted precisely so that the record of the mistake survives, " +
            "and a void with no reason keeps the row and loses the point",
        );
      }
      return db.transaction(async (tx) => {
        const before = await loadExpense(tx, input.expenseId);
        if (before.status === POSTED_STATUS) {
          throw new ExpenseNotEditableError(
            `expense "${before.referenceCode}" is posted; a posted fact is ` +
              "corrected by a reversing entry in the ledger, not by voiding " +
              "the source. Only a posting engine sets this status, so nothing " +
              "in this milestone can reach it.",
          );
        }
        if (before.status === "void") return before;
        await tx.execute(
          `update expenses set status = 'void', updated_at = now()
            where id = ${uuidLiteral(before.id)}`,
        );
        const after = await loadExpense(tx, before.id);
        await createAuditService({ db: tx }).append({
          actorUserId: input.actorUserId ?? null,
          action: "accounting.expense.voided",
          resourceType: "expense",
          resourceId: before.id,
          before: { status: before.status, amount: before.amount },
          after: { status: after.status },
          requestId: input.requestId ?? null,
          metadata: { reason, referenceCode: before.referenceCode },
        });
        return after;
      });
    },

    promoteToAcquisitionCost: async (input) => {
      const reason = input.reason.trim();
      if (reason.length === 0) {
        throw new AccountingValidationError(
          "promoting an expense to an acquisition cost requires a reason: the row is kept " +
            "rather than deleted precisely so that the record of the mistake survives, and a " +
            "promotion with no reason keeps the row and loses the point",
        );
      }
      return db.transaction(async (tx) => {
        const before = await loadExpense(tx, input.expenseId);
        if (before.status === POSTED_STATUS) {
          throw new ExpenseNotEditableError(
            `expense "${before.referenceCode}" is posted; a posted fact is corrected by a ` +
              "reversing entry in the ledger, not by voiding the source. Only a posting engine " +
              "sets this status, so nothing in this milestone can reach it.",
          );
        }
        if (before.status === "void") {
          throw new ExpenseNotEditableError(
            `expense "${before.referenceCode}" is already void; promotion happens in the same ` +
              "action as voiding, not as a follow-up on a row already voided for some other " +
              "reason — a voided row is frozen evidence and its acquisition_cost_id is not a " +
              "field a later edit rewrites",
          );
        }
        await tx.execute(
          `update expenses
              set status = 'void',
                  acquisition_cost_id = ${uuidLiteral(input.acquisitionCostId)},
                  updated_at = now()
            where id = ${uuidLiteral(before.id)}`,
        );
        const after = await loadExpense(tx, before.id);
        await createAuditService({ db: tx }).append({
          actorUserId: input.actorUserId ?? null,
          action: "accounting.expense.promoted_to_acquisition_cost",
          resourceType: "expense",
          resourceId: before.id,
          before: { status: before.status, amount: before.amount },
          after: { status: after.status, acquisitionCostId: after.acquisitionCostId },
          requestId: input.requestId ?? null,
          metadata: {
            reason,
            referenceCode: before.referenceCode,
            acquisitionCostId: input.acquisitionCostId,
          },
        });
        return after;
      });
    },

    reattributeDefaults: async (input) => {
      const sources = REATTRIBUTABLE_SOURCES.map((source) =>
        textLiteral(source),
      ).join(", ");
      const range: string[] = [];
      if (input.from !== undefined) {
        range.push(`expense_date >= ${dateLiteral(input.from)}`);
      }
      if (input.to !== undefined) {
        range.push(`expense_date <= ${dateLiteral(input.to)}`);
      }
      const window = range.length === 0 ? "" : ` and ${range.join(" and ")}`;
      return db.transaction(async (tx) => {
        const result = await tx.execute(
          `update expenses
              set economic_entity_id = ${uuidLiteral(input.economicEntityId)},
                  entity_attribution_source = 'installation_default',
                  entity_attributed_at = now(),
                  updated_at = now()
            where entity_attribution_source in (${sources})
              and (economic_entity_id is distinct from ${uuidLiteral(input.economicEntityId)})
              ${window}
          returning id`,
        );
        if (result.rows.length > 0) {
          await createAuditService({ db: tx }).append({
            actorUserId: input.actorUserId ?? null,
            action: "accounting.expense.reattributed",
            resourceType: "expense",
            resourceId: null,
            after: { economicEntityId: input.economicEntityId },
            requestId: input.requestId ?? null,
            metadata: {
              updated: result.rows.length,
              from: input.from ?? null,
              to: input.to ?? null,
              // Stated explicitly because it is the rule the column exists for.
              neverRewrites: "manual",
            },
          });
        }
        return { updated: result.rows.length };
      });
    },

    listAllocations: async (expenseId) => listAllocations(db, expenseId),

    setAllocations: async (input) =>
      db.transaction(async (tx) => {
        const expense = await loadExpense(tx, input.expenseId);
        assertEditable(expense);
        const parsed = input.allocations.map((allocation) =>
          parse(allocationSchema, allocation),
        );
        const allocated = sumDecimals(
          parsed.map((allocation) => allocation.amount),
        );
        assertFits(
          expense,
          allocated,
          `cannot allocate expense "${expense.referenceCode}"`,
        );

        await tx.execute(
          `delete from expense_allocations
            where expense_id = ${uuidLiteral(expense.id)}`,
        );
        const rows = await insertAllocations(tx, expense, parsed, 1);

        await createAuditService({ db: tx }).append({
          actorUserId: input.actorUserId ?? null,
          action: "accounting.expense.allocations_set",
          resourceType: "expense",
          resourceId: expense.id,
          after: {
            allocationCount: rows.length,
            allocatedAmount: allocated,
            unallocatedAmount: unallocatedRemainder(expense.amount, allocated),
          },
          requestId: input.requestId ?? null,
          metadata: { referenceCode: expense.referenceCode },
        });
        return rows;
      }),

    addAllocation: async (input) =>
      db.transaction(async (tx) => {
        const expense = await loadExpense(tx, input.expenseId);
        assertEditable(expense);
        const allocation = parse(allocationSchema, input.allocation);
        const { total: existing } = await allocatedTotal(tx, expense.id);
        const allocated = sumDecimals([existing, allocation.amount]);
        assertFits(
          expense,
          allocated,
          `cannot add an allocation to expense "${expense.referenceCode}"`,
        );

        const line =
          allocation.lineNumber ?? (await nextLineNumber(tx, expense.id));
        const rows = await insertAllocations(
          tx,
          expense,
          [{ ...allocation, lineNumber: line }],
          line,
        );
        const row = rows[0];
        if (row === undefined) {
          throw new AccountingConflictError(
            "expense_allocations insert returned no row",
          );
        }
        await createAuditService({ db: tx }).append({
          actorUserId: input.actorUserId ?? null,
          action: "accounting.expense.allocation_added",
          resourceType: "expense",
          resourceId: expense.id,
          after: {
            allocationId: row.id,
            lineNumber: row.lineNumber,
            amount: row.amount,
            allocatedAmount: allocated,
          },
          requestId: input.requestId ?? null,
          metadata: { referenceCode: expense.referenceCode },
        });
        return row;
      }),

    removeAllocation: async (input) =>
      db.transaction(async (tx) => {
        const found = await tx.execute(
          `select expense_id::text as expense_id, line_number::text as line_number,
                  amount::text as amount
             from expense_allocations where id = ${uuidLiteral(input.allocationId)}`,
        );
        const row = found.rows[0];
        if (row === undefined) {
          throw new AccountingNotFoundError(
            `unknown expense allocation "${input.allocationId}"`,
          );
        }
        const expense = await loadExpense(tx, row["expense_id"] as string);
        assertEditable(expense);
        await tx.execute(
          `delete from expense_allocations
            where id = ${uuidLiteral(input.allocationId)}`,
        );
        await createAuditService({ db: tx }).append({
          actorUserId: input.actorUserId ?? null,
          action: "accounting.expense.allocation_removed",
          resourceType: "expense",
          resourceId: expense.id,
          before: {
            allocationId: input.allocationId,
            lineNumber: Number(row["line_number"]),
            amount: row["amount"],
          },
          requestId: input.requestId ?? null,
          metadata: { referenceCode: expense.referenceCode },
        });
      }),

    allocationSummary: async (expenseId) => {
      const expense = await loadExpense(db, expenseId);
      const { total, count } = await allocatedTotal(db, expenseId);
      const unallocated = unallocatedRemainder(expense.amount, total);
      return {
        expenseId: expense.id,
        currency: expense.currency,
        amount: toMoneyString(expense.amount),
        allocatedAmount: total,
        unallocatedAmount: unallocated,
        allocationCount: count,
        fullyAllocated: compareDecimals(unallocated, ZERO) === 0,
      };
    },
  };
}

/** Re-exported so callers can name the lifecycle without reaching into `@loxep/db`. */
export type { ExpenseStatus };

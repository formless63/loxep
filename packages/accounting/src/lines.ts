/**
 * `expense_lines` — WHAT WAS BOUGHT, not WHERE THE MONEY IS CHARGED.
 *
 * `expense-entry-design.md` section 4 draws the distinction this table
 * exists to keep separate from `expense_allocations`: a line comes off the
 * receipt (may have quantity and unit price, may name no target at all,
 * count fixed by the document); an allocation comes out of the operator's
 * head (has an amount and one or more targets, must name at least one,
 * count chosen by the operator). See `packages/db/src/schema/expenses.ts`'s
 * `expenseLines` table doc for the full case against widening allocations
 * instead of adding this table.
 *
 * Money as decimal strings only; every comparison runs through
 * `decimal.ts`'s exact scaled-`BigInt` arithmetic — the same discipline
 * `expenses.ts`'s allocation invariant already keeps.
 *
 * ## The over-transcription guard
 *
 * `sum(|line_amount|) <= |expenses.amount|` is a SERVICE rule and a report,
 * never a `CHECK` — the fourth time this documentation reaches that
 * conclusion, for the same reason each prior time did: a draft expense is
 * legitimately half-transcribed. This service refuses a write that would
 * make the absolute sum EXCEED the expense; it never refuses under-total.
 * Individual lines may still be mixed-sign (a coupon is negative, an item
 * is positive) — the guard sums ABSOLUTE values, not the signed total,
 * because a $10 item plus a $3 coupon is $13 of transcribed paper against a
 * $10 expense even though the signed total nets to $7.
 *
 * ## The draft-only lock, and its one exemption
 *
 * Lines may be added or removed through this service's `addLine`/
 * `removeLine`/`setLines` only while the parent expense is `draft` — the
 * same lock `expenses.ts` already applies to allocations, for the same
 * reason: a `recorded` expense is evidence, and editing evidence in place
 * is not the correction path (void-and-re-record is).
 *
 * The ONE exemption is {@link insertExpenseLinesRaw}, used by
 * `confirmCandidatesAsExpense` (`confirm.ts`) to write a brand-new
 * expense's initial lines inside the SAME transaction that creates it —
 * mirroring `expenses.ts`'s own `insertAllocations`, which
 * `ExpensesService.create` calls directly rather than through the
 * draft-only-gated `setAllocations`/`addAllocation`. An expense being
 * created with `status: 'recorded'` still needs its OWN first lines
 * written; the lock exists to stop a LATER edit, not the write that brings
 * the row into being.
 */
import { createAuditService } from "@loxep/domain";
import type { LoxepDb } from "@loxep/db";
import { expenseLines } from "@loxep/db/schema";
import { z } from "zod";
import { absDecimal, compareDecimals, sumDecimals, toMoneyString } from "./decimal.ts";
import {
  AccountingConflictError,
  AccountingNotFoundError,
  AccountingValidationError,
  ExpenseLinesOverTranscribedError,
  ExpenseNotEditableError,
} from "./errors.ts";
import { uuidLiteral } from "./sql.ts";

export type ExpenseLineRow = typeof expenseLines.$inferSelect;

/** Reads and writes work against a handle or an open transaction alike. */
type Executor = Pick<LoxepDb, "insert" | "execute" | "query">;

/* ------------------------------------------------------------------ unions */

/**
 * `expense_lines.line_kind` — closed, `CHECK`ed at the schema. Re-declared
 * here (not imported from `@loxep/db/schema`) matching this package's own
 * `EXPENSE_PAYMENT_METHODS`-style precedent of owning its input unions.
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

/* ------------------------------------------------------------------ schemas */

const decimalString = z
  .string()
  .regex(/^-?\d+(\.\d+)?$/, "expected a plain decimal string");

const lineInputSchema = z.strictObject({
  /** Assigned in order when omitted; explicit values must be unique per expense. */
  lineNumber: z.number().int().positive().optional(),
  description: z.string().trim().min(1).nullish(),
  quantity: decimalString.nullish(),
  unitAmount: decimalString.nullish(),
  /** May be zero (a free line) or negative (a coupon). Never omitted — a line with no total is not evidence of anything. */
  lineAmount: decimalString,
  lineKind: z.enum(EXPENSE_LINE_KINDS).default("item"),
  /**
   * Links this line back to the staged receipt row it was confirmed from —
   * `document_line_candidates.id`. `null`/omitted for a manually typed
   * line, which is the ordinary case this milestone.
   */
  documentLineCandidateId: z.uuid().nullish(),
  note: z.string().trim().min(1).nullish(),
});
export type ExpenseLineInput = z.input<typeof lineInputSchema>;

const addLineSchema = lineInputSchema.extend({
  expenseId: z.uuid(),
  actorUserId: z.string().min(1).nullish(),
  requestId: z.string().min(1).nullish(),
});
export type AddExpenseLineInput = z.input<typeof addLineSchema>;

const setLinesSchema = z.strictObject({
  expenseId: z.uuid(),
  /** Replaces the WHOLE set atomically; `[]` clears every line. */
  lines: z.array(lineInputSchema).default([]),
  actorUserId: z.string().min(1).nullish(),
  requestId: z.string().min(1).nullish(),
});
export type SetExpenseLinesInput = z.input<typeof setLinesSchema>;

function parse<T extends z.ZodType>(schema: T, input: unknown): z.output<T> {
  const parsed = schema.safeParse(input);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("; ");
    throw new AccountingValidationError(`invalid expense line input: ${issues}`);
  }
  return parsed.data;
}

/* --------------------------------------------------------------- arithmetic */

/** `Σ |amount|` across every line, exact, at money scale. */
export function absoluteLineTotal(lineAmounts: readonly string[]): string {
  return sumDecimals(lineAmounts.map((amount) => absDecimal(amount)));
}

/**
 * The over-transcription guard, stated once: `absoluteTotal <= |expenseAmount|`.
 * Mirrors `expenses.ts`'s `allocationsFit`, but unsigned — lines are
 * transcribed facts, not a directional split.
 */
export function linesFit(expenseAmount: string, absoluteTotal: string): boolean {
  return compareDecimals(absoluteTotal, absDecimal(expenseAmount)) <= 0;
}

/* ------------------------------------------------------------- raw helpers */

/**
 * Values for one `expense_lines` row, already money-scaled strings. A
 * narrower shape than this file's own Zod-validated line input,
 * deliberately — this is the function `confirm.ts` calls across the module
 * boundary, and it should not need to depend on this file's Zod schema
 * shape to do so.
 */
export interface RawExpenseLineValues {
  lineNumber?: number;
  description?: string | null;
  quantity?: string | null;
  unitAmount?: string | null;
  lineAmount: string;
  lineKind?: string;
  documentLineCandidateId?: string | null;
  note?: string | null;
}

/**
 * The UNGATED insert — no draft-only check, no over-transcription check.
 * Callers are responsible for both: `ExpenseLinesService`'s own methods
 * check before calling this, and `confirmCandidatesAsExpense` checks with
 * its own view of "existing plus new" before calling this directly for a
 * brand-new expense's initial lines. See the module doc's "one exemption".
 */
export async function insertExpenseLinesRaw(
  executor: Executor,
  expenseId: string,
  lines: readonly RawExpenseLineValues[],
  startingLine: number,
): Promise<ExpenseLineRow[]> {
  if (lines.length === 0) return [];
  const values = lines.map((line, index) => ({
    expenseId,
    lineNumber: line.lineNumber ?? startingLine + index,
    description: line.description ?? null,
    quantity: line.quantity ?? null,
    unitAmount: line.unitAmount ?? null,
    lineAmount: toMoneyString(line.lineAmount),
    lineKind: line.lineKind ?? "item",
    documentLineCandidateId: line.documentLineCandidateId ?? null,
    note: line.note ?? null,
  }));
  return executor.insert(expenseLines).values(values).returning();
}

async function loadExpenseForLines(
  executor: Executor,
  expenseId: string,
): Promise<{ id: string; referenceCode: string; status: string; amount: string; currency: string }> {
  const result = await executor.execute(
    `select id::text as id, reference_code, status, amount::text as amount, currency
       from expenses where id = ${uuidLiteral(expenseId)}`,
  );
  const row = result.rows[0];
  if (row === undefined) {
    throw new AccountingNotFoundError(`unknown expense "${expenseId}"`);
  }
  return {
    id: row["id"] as string,
    referenceCode: row["reference_code"] as string,
    status: row["status"] as string,
    amount: row["amount"] as string,
    currency: row["currency"] as string,
  };
}

function assertDraft(expense: { status: string; referenceCode: string }): void {
  if (expense.status !== "draft") {
    throw new ExpenseNotEditableError(
      `expense "${expense.referenceCode}" is ${expense.status}, not draft: lines may only be ` +
        "added, removed, or replaced on a draft expense — the same lock allocations already " +
        "carry. A recorded expense is evidence; correct it by voiding and re-recording.",
    );
  }
}

async function existingLineAmounts(
  executor: Executor,
  expenseId: string,
): Promise<string[]> {
  const result = await executor.execute(
    `select line_amount::text as line_amount from expense_lines
      where expense_id = ${uuidLiteral(expenseId)}`,
  );
  return result.rows.map((row) => row["line_amount"] as string);
}

async function nextLineNumber(executor: Executor, expenseId: string): Promise<number> {
  const result = await executor.execute(
    `select coalesce(max(line_number), 0)::text as max_line
       from expense_lines where expense_id = ${uuidLiteral(expenseId)}`,
  );
  return Number(result.rows[0]?.["max_line"] ?? "0") + 1;
}

function assertFits(
  expense: { amount: string; referenceCode: string },
  absoluteTotal: string,
  context: string,
): void {
  if (linesFit(expense.amount, absoluteTotal)) return;
  throw new ExpenseLinesOverTranscribedError(
    `${context}: lines would total ${toMoneyString(absoluteTotal)} (absolute) against an ` +
      `expense of ${toMoneyString(expense.amount)} (reference ${expense.referenceCode}). ` +
      "Under-transcription is a draft; exceeding the expense is arithmetic no later edit can " +
      "make true.",
  );
}

/* --------------------------------------------------------------- service */

export interface ExpenseLineSummary {
  expenseId: string;
  currency: string;
  expenseAmount: string;
  absoluteLineTotal: string;
  lineCount: number;
  fitsWithinExpense: boolean;
}

export interface ExpenseLinesService {
  listLines: (expenseId: string) => Promise<ExpenseLineRow[]>;
  /** Draft only. Refuses a line that would push the absolute total past the expense's amount. */
  addLine: (input: AddExpenseLineInput) => Promise<ExpenseLineRow>;
  /** Draft only. */
  removeLine: (input: {
    lineId: string;
    actorUserId?: string | null;
    requestId?: string | null;
  }) => Promise<void>;
  /** Replaces the whole set atomically; `[]` clears it. Draft only. */
  setLines: (input: SetExpenseLinesInput) => Promise<ExpenseLineRow[]>;
  lineSummary: (expenseId: string) => Promise<ExpenseLineSummary>;
}

export function createExpenseLinesService(options: { db: LoxepDb }): ExpenseLinesService {
  const { db } = options;

  return {
    listLines: async (expenseId) =>
      db.query.expenseLines.findMany({
        where: (table, { eq }) => eq(table.expenseId, expenseId),
        orderBy: (table, { asc }) => [asc(table.lineNumber)],
      }),

    addLine: async (input) => {
      const value = parse(addLineSchema, input);
      return db.transaction(async (tx) => {
        const expense = await loadExpenseForLines(tx, value.expenseId);
        assertDraft(expense);
        const existing = await existingLineAmounts(tx, value.expenseId);
        const absoluteTotal = absoluteLineTotal([...existing, value.lineAmount]);
        assertFits(expense, absoluteTotal, `cannot add a line to expense "${expense.referenceCode}"`);

        const lineNumber = value.lineNumber ?? (await nextLineNumber(tx, value.expenseId));
        const rows = await insertExpenseLinesRaw(
          tx,
          value.expenseId,
          [{ ...value, lineNumber }],
          lineNumber,
        );
        const row = rows[0];
        if (row === undefined) {
          throw new AccountingConflictError("expense_lines insert returned no row");
        }
        await createAuditService({ db: tx }).append({
          actorUserId: value.actorUserId ?? null,
          action: "accounting.expense.line_added",
          resourceType: "expense",
          resourceId: value.expenseId,
          after: {
            lineId: row.id,
            lineNumber: row.lineNumber,
            lineAmount: row.lineAmount,
            lineKind: row.lineKind,
          },
          requestId: value.requestId ?? null,
          metadata: { referenceCode: expense.referenceCode },
        });
        return row;
      });
    },

    removeLine: async (input) =>
      db.transaction(async (tx) => {
        const found = await tx.execute(
          `select expense_id::text as expense_id, line_number, line_amount::text as line_amount,
                  description
             from expense_lines where id = ${uuidLiteral(input.lineId)}`,
        );
        const row = found.rows[0];
        if (row === undefined) {
          throw new AccountingNotFoundError(`unknown expense line "${input.lineId}"`);
        }
        const expense = await loadExpenseForLines(tx, row["expense_id"] as string);
        assertDraft(expense);
        await tx.execute(`delete from expense_lines where id = ${uuidLiteral(input.lineId)}`);
        await createAuditService({ db: tx }).append({
          actorUserId: input.actorUserId ?? null,
          action: "accounting.expense.line_removed",
          resourceType: "expense",
          resourceId: expense.id,
          before: {
            lineId: input.lineId,
            lineNumber: Number(row["line_number"]),
            lineAmount: row["line_amount"],
            description: row["description"],
          },
          requestId: input.requestId ?? null,
          metadata: { referenceCode: expense.referenceCode },
        });
      }),

    setLines: async (input) => {
      const value = parse(setLinesSchema, input);
      return db.transaction(async (tx) => {
        const expense = await loadExpenseForLines(tx, value.expenseId);
        assertDraft(expense);
        const absoluteTotal = absoluteLineTotal(value.lines.map((line) => line.lineAmount));
        assertFits(expense, absoluteTotal, `cannot set lines on expense "${expense.referenceCode}"`);

        await tx.execute(
          `delete from expense_lines where expense_id = ${uuidLiteral(value.expenseId)}`,
        );
        const rows = await insertExpenseLinesRaw(tx, value.expenseId, value.lines, 1);

        await createAuditService({ db: tx }).append({
          actorUserId: value.actorUserId ?? null,
          action: "accounting.expense.lines_set",
          resourceType: "expense",
          resourceId: value.expenseId,
          after: { lineCount: rows.length, absoluteLineTotal: absoluteTotal },
          requestId: value.requestId ?? null,
          metadata: { referenceCode: expense.referenceCode },
        });
        return rows;
      });
    },

    lineSummary: async (expenseId) => {
      const expense = await loadExpenseForLines(db, expenseId);
      const amounts = await existingLineAmounts(db, expenseId);
      const total = absoluteLineTotal(amounts);
      return {
        expenseId: expense.id,
        currency: expense.currency,
        expenseAmount: toMoneyString(expense.amount),
        absoluteLineTotal: total,
        lineCount: amounts.length,
        fitsWithinExpense: linesFit(expense.amount, total),
      };
    },
  };
}

/**
 * `confirmCandidatesAsExpense` — the ONE confirm function both expense-entry
 * flows share (expense-entry-design.md section 4, "Line items: one shape,
 * three destinations", and the milestone's own build note 2).
 *
 * ## Moved DOWN from `apps/web`
 *
 * This is `apps/web/src/server/documents-functions.ts`'s `confirmLinesAsExpense`,
 * relocated per the design's package-ownership table ("confirmCandidatesAsExpense
 * @loxep/accounting — moved DOWN from apps/web") and taught to accept an
 * EXISTING expense id as well as creating one:
 *
 * ```text
 * FLOW 1 (/finance/import)        no expenseId given -> this function CREATES
 *                                  one expense from the confirmed candidates,
 *                                  summing their `lineAmount`s into the new
 *                                  expense's `amount` and writing one
 *                                  `expense_lines` row per candidate.
 *
 * FLOW 2 (/finance/expenses/new)  expenseId given (an expense the caller
 *                                  already created, in the SAME open
 *                                  transaction, moments earlier) -> this
 *                                  function adds candidate-derived lines to
 *                                  THAT expense and stamps the candidates,
 *                                  never creating a second row.
 * ```
 *
 * Either way: **1 confirmed candidate row -> 1 `expense_lines` row**, per the
 * design's connective field table.
 *
 * ## Why this file duplicates a few lines of `@loxep/documents`
 *
 * `@loxep/documents`'s `candidates.ts` module doc describes the intended
 * shape exactly: a consuming domain's confirm function requires a non-null
 * actor, opens its own transaction, writes its own record, then calls
 * `createCandidatesService({ db: tx }).stampConfirmed(...)`. This package
 * does not depend on `@loxep/documents` — adding that package.json edge is
 * OUT of this change's write fence, mirroring
 * `apps/web/src/server/documents-functions.ts`'s own documented
 * IMPLEMENTATION CHOICE one call site up the chain (a `@loxep/db` schema
 * dependency, which this package already has, is not the same layering
 * concern as reaching into another domain package's SERVICE surface).
 *
 * So this file reads/writes `document_line_candidates` and `documents`
 * directly through `@loxep/db`'s schema and query builder — exactly the
 * layer `@loxep/documents` itself is built on — and reproduces
 * `stampConfirmed`'s update + `recomputeDocumentCounters`'s counter
 * derivation + the `document_confirmed` notification emission inline.
 * **Note for a future pass:** once `packages/accounting/package.json` is
 * authorized to add `@loxep/documents`, replace the three local helpers
 * below (`stampCandidateConfirmed`, `recomputeDocumentCounters`,
 * `emitDocumentConfirmed`) with calls into that package's real services —
 * no other part of this file should need to change.
 *
 * ## The never-auto-commit rule, enforced here the same way
 *
 * `actorUserId` is a REQUIRED, non-nullable Zod field — a call with no actor
 * fails to type-check before it fails at runtime, the same structural
 * guarantee `stampConfirmed` documents. A Graphile Worker task has no
 * session and therefore no actor id to pass; there is no code path from a
 * job handler to this function succeeding.
 */
import {
  createAuditService,
  createTransactionalNotificationEnqueue,
  publishNotificationEvent,
} from "@loxep/domain";
import type { LoxepDb } from "@loxep/db";
import type { MediaService } from "@loxep/storage";
import { z } from "zod";
import { sumDecimals } from "./decimal.ts";
import { createExpensesService, type ExpenseRow } from "./expenses.ts";
import {
  absoluteLineTotal,
  insertExpenseLinesRaw,
  linesFit,
  type ExpenseLineRow,
  type RawExpenseLineValues,
} from "./lines.ts";
import { createReceiptsService } from "./receipts.ts";
import {
  AccountingNotFoundError,
  AccountingValidationError,
  ExpenseLinesOverTranscribedError,
} from "./errors.ts";
import { textLiteral, uuidLiteral } from "./sql.ts";

/** Re-declared, matching this package's own precedent of owning its input unions rather than importing `@loxep/db/schema`'s runtime arrays. */
const EXPENSE_PAYMENT_METHOD_VALUES = [
  "card",
  "cash",
  "bank_transfer",
  "marketplace_balance",
  "direct_debit",
  "other",
] as const;

/** Candidate dispositions this confirm accepts — `acquisition_cost`/`inventory_intake` need `confirmCandidatesAsAcquisition` (`@loxep/inventory`, a later milestone). */
const CONFIRMABLE_DISPOSITIONS = new Set(["expense", "supplies"]);

const decimalString = z
  .string()
  .regex(/^-?\d+(\.\d+)?$/, "expected a plain decimal string");
const calendarDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "expected YYYY-MM-DD");

const confirmInputSchema = z.strictObject({
  documentId: z.uuid(),
  candidateIds: z.array(z.uuid()).min(1),
  actorUserId: z.string().min(1),
  requestId: z.string().min(1).nullish(),

  /** When given, attach to this ALREADY-existing (same-transaction) expense instead of creating one. */
  expenseId: z.uuid().optional(),

  /** Required to CREATE a new expense (ignored when `expenseId` is given). */
  category: z.string().trim().min(1).optional(),
  paymentMethod: z.enum(EXPENSE_PAYMENT_METHOD_VALUES).optional(),
  economicEntityId: z.uuid().nullish(),
  payeeCounterpartyId: z.uuid().nullish(),
  payeeName: z.string().trim().min(1).nullish(),
  currency: z
    .string()
    .trim()
    .regex(/^[A-Za-z]{3}$/)
    .optional(),
  defaultCurrency: z
    .string()
    .trim()
    .regex(/^[A-Za-z]{3}$/)
    .default("USD"),
  expenseDate: calendarDate.optional(),
  status: z.enum(["draft", "recorded"]).default("recorded"),
  notes: z.string().trim().min(1).nullish(),
});
export type ConfirmCandidatesAsExpenseInput = z.input<typeof confirmInputSchema>;

export interface ConfirmCandidatesAsExpenseResult {
  /** `null` only when creating (no `expenseId` given) and every candidate was skipped — nothing was written. */
  expense: ExpenseRow | null;
  lines: ExpenseLineRow[];
  skipped: number;
}

export interface ExpenseConfirmService {
  confirmCandidatesAsExpense: (
    input: ConfirmCandidatesAsExpenseInput,
  ) => Promise<ConfirmCandidatesAsExpenseResult>;
}

function todayIsoDate(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Matches `expenses.ts`/`lines.ts`'s own `parse` — a Zod failure surfaces as this package's own error type, not a raw `ZodError`. */
function parse<T extends z.ZodType>(schema: T, input: unknown): z.output<T> {
  const parsed = schema.safeParse(input);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("; ");
    throw new AccountingValidationError(`invalid confirm-candidates input: ${issues}`);
  }
  return parsed.data;
}

/**
 * `stampConfirmed`'s update, reproduced — see the module doc's "why this
 * file duplicates" section. Idempotent the same way: a candidate already
 * confirmed (into ANY target) is treated as unconfirmable here and the
 * caller counts it as skipped rather than re-stamping or erroring —
 * matching the shipped `confirmLinesAsExpense`'s own behaviour, which is
 * how "the same candidate confirmed twice" already produced no duplicate
 * before this move.
 */
async function stampCandidateConfirmed(
  tx: LoxepDb,
  candidateId: string,
  expenseId: string,
  actorUserId: string,
  documentId: string,
  disposition: string,
): Promise<void> {
  await tx.execute(
    `update document_line_candidates
        set confirmed_at = now(),
            confirmed_by_user_id = ${textLiteral(actorUserId)},
            target_kind = 'expense',
            target_id = ${uuidLiteral(expenseId)},
            updated_at = now()
      where id = ${uuidLiteral(candidateId)}`,
  );
  await createAuditService({ db: tx }).append({
    actorUserId,
    action: "documents.candidate.confirmed",
    resourceType: "document_line_candidate",
    resourceId: candidateId,
    after: { targetKind: "expense", targetId: expenseId },
    metadata: { documentId, disposition },
  });
}

/** Mirrors `@loxep/documents/documents.ts`'s `recomputeDocumentCounters` exactly — see the module doc. */
async function recomputeDocumentCounters(
  tx: LoxepDb,
  documentId: string,
  actorUserId: string,
): Promise<void> {
  await tx.execute(
    `with counts as (
       select count(*)::int as total,
              count(*) filter (where confirmed_at is not null)::int as confirmed,
              count(*) filter (
                where confirmed_at is null
                  and disposition not in ('personal', 'not_mine', 'duplicate', 'discarded')
              )::int as pending
         from document_line_candidates
        where document_id = ${uuidLiteral(documentId)}
     )
     update documents d
        set line_count = counts.total,
            confirmed_count = counts.confirmed,
            status = case
              when counts.total = 0 then d.status
              when counts.pending = 0 then 'confirmed'
              when counts.confirmed > 0 then 'partially_confirmed'
              else 'review'
            end,
            confirmed_at = case
              when counts.total > 0 and counts.pending = 0 and d.confirmed_at is null
                then now() else d.confirmed_at end,
            confirmed_by_user_id = case
              when counts.total > 0 and counts.pending = 0 and d.confirmed_by_user_id is null
                then ${textLiteral(actorUserId)} else d.confirmed_by_user_id end,
            updated_at = now()
       from counts
      where d.id = ${uuidLiteral(documentId)}`,
  );
}

/** Mirrors `apps/web/src/server/documents-functions.ts`'s `emitDocumentConfirmed` — see that function's own doc for the SAVEPOINT/deduplication reasoning. */
async function emitDocumentConfirmed(tx: LoxepDb, documentId: string): Promise<void> {
  const result = await tx.execute<{
    status: string;
    confirmed_at: string | null;
    original_filename: string | null;
    line_count: number;
  }>(
    `select status, confirmed_at, original_filename, line_count
       from documents where id = ${uuidLiteral(documentId)}`,
  );
  const row = result.rows[0];
  if (row === undefined) return;
  const confirmedAt = row["confirmed_at"];
  if (row["status"] !== "confirmed" || confirmedAt == null) return;
  const occurredAt = new Date(String(confirmedAt));
  const event = {
    eventClass: "document" as const,
    eventType: "document_confirmed",
    subjectType: "document" as const,
    subjectId: documentId,
    occurredAt,
    payload: {
      ...(row["original_filename"] == null ? {} : { fileName: row["original_filename"] }),
      lineCount: Number(row["line_count"] ?? 0),
    },
    deduplicationKey: `document:${documentId}:confirmed:${occurredAt.toISOString()}`,
  };
  try {
    await tx.transaction(async (savepoint) => {
      await publishNotificationEvent({
        executor: savepoint,
        enqueue: createTransactionalNotificationEnqueue(),
        event,
      });
    });
  } catch {
    await tx
      .transaction(async (savepoint) => {
        await publishNotificationEvent({ executor: savepoint, event });
      })
      .catch(() => undefined);
  }
}

export function createExpenseConfirmService(options: {
  db: LoxepDb;
  media: MediaService;
}): ExpenseConfirmService {
  const { db, media } = options;

  return {
    confirmCandidatesAsExpense: async (input) => {
      const value = parse(confirmInputSchema, input);

      return db.transaction(async (tx) => {
        const expensesService = createExpensesService({ db: tx });
        const receiptsService = createReceiptsService({ db: tx, media });

        const documentRow = await tx.query.documents.findFirst({
          where: (table, { eq }) => eq(table.id, value.documentId),
          columns: { currency: true, documentDate: true, mediaObjectId: true },
        });
        if (documentRow === undefined) {
          throw new AccountingNotFoundError(`unknown document "${value.documentId}"`);
        }

        const confirmable: {
          id: string;
          description: string | null;
          quantity: string | null;
          unitAmount: string | null;
          lineAmount: string;
          lineDate: string | null;
          disposition: string;
        }[] = [];
        let skipped = 0;

        for (const candidateId of value.candidateIds) {
          const candidate = await tx.query.documentLineCandidates.findFirst({
            where: (table, { eq }) => eq(table.id, candidateId),
          });
          if (candidate === undefined || candidate.documentId !== value.documentId) {
            skipped += 1;
            continue;
          }
          if (candidate.confirmedAt !== null) {
            skipped += 1;
            continue;
          }
          if (!CONFIRMABLE_DISPOSITIONS.has(candidate.disposition)) {
            skipped += 1;
            continue;
          }
          if (candidate.lineAmount === null) {
            skipped += 1;
            continue;
          }
          confirmable.push({
            id: candidate.id,
            description: candidate.description,
            quantity: candidate.quantity,
            unitAmount: candidate.unitAmount,
            lineAmount: candidate.lineAmount,
            lineDate: candidate.lineDate,
            disposition: candidate.disposition,
          });
        }

        if (confirmable.length === 0 && value.expenseId === undefined) {
          return { expense: null, lines: [], skipped };
        }

        let expense: ExpenseRow;
        if (value.expenseId !== undefined) {
          expense = await expensesService.get(value.expenseId);
        } else {
          if (value.category === undefined || value.paymentMethod === undefined) {
            throw new AccountingValidationError(
              "confirmCandidatesAsExpense: category and paymentMethod are required to create " +
                "a new expense (omit them only when passing an existing expenseId)",
            );
          }
          const amount = sumDecimals(confirmable.map((candidate) => candidate.lineAmount));
          const currency =
            value.currency ?? documentRow.currency ?? value.defaultCurrency;
          const expenseDate =
            value.expenseDate ??
            documentRow.documentDate ??
            confirmable[0]?.lineDate ??
            todayIsoDate();
          const created = await expensesService.create({
            economicEntityId: value.economicEntityId ?? null,
            expenseDate,
            payeeName: value.payeeName ?? null,
            payeeCounterpartyId: value.payeeCounterpartyId ?? null,
            category: value.category,
            currency,
            amount,
            paymentMethod: value.paymentMethod,
            status: value.status,
            notes: value.notes ?? null,
            createdByUserId: value.actorUserId,
          });
          expense = created.expense;
        }

        // The over-transcription guard applies whether the expense is brand
        // new (existing lines = []) or pre-existing (flow 2's manual lines
        // may already have been inserted in this same transaction).
        const existingResult = await tx.execute(
          `select line_amount::text as line_amount from expense_lines
            where expense_id = ${uuidLiteral(expense.id)}`,
        );
        const existingAmounts = existingResult.rows.map((row) => row["line_amount"] as string);
        const absoluteTotal = absoluteLineTotal([
          ...existingAmounts,
          ...confirmable.map((candidate) => candidate.lineAmount),
        ]);
        if (!linesFit(expense.amount, absoluteTotal)) {
          throw new ExpenseLinesOverTranscribedError(
            `cannot confirm ${confirmable.length} candidate line(s) onto expense ` +
              `"${expense.referenceCode}": lines would total ${absoluteTotal} (absolute) ` +
              `against an expense of ${expense.amount}.`,
          );
        }

        const rawLines: RawExpenseLineValues[] = confirmable.map((candidate) => ({
          description: candidate.description,
          quantity: candidate.quantity,
          unitAmount: candidate.unitAmount,
          lineAmount: candidate.lineAmount,
          lineKind: "item",
          documentLineCandidateId: candidate.id,
        }));
        const startingLine = existingAmounts.length + 1;
        const lines = await insertExpenseLinesRaw(tx, expense.id, rawLines, startingLine);

        if (lines.length > 0) {
          await createAuditService({ db: tx }).append({
            actorUserId: value.actorUserId,
            action: "accounting.expense.lines_confirmed_from_candidates",
            resourceType: "expense",
            resourceId: expense.id,
            after: { lineCount: lines.length, candidateIds: confirmable.map((c) => c.id) },
            requestId: value.requestId ?? null,
            metadata: { referenceCode: expense.referenceCode, documentId: value.documentId },
          });
        }

        // The document's own receipt image (if any) attaches to the
        // expense every candidate confirmed out of it lands on — the
        // loxep-4mg regression guard, preserved verbatim from
        // `confirmLinesAsExpense`.
        if (documentRow.mediaObjectId !== null) {
          await receiptsService.attach({
            expenseId: expense.id,
            mediaObjectId: documentRow.mediaObjectId,
            purpose: "receipt",
            actorUserId: value.actorUserId,
          });
        }

        for (const candidate of confirmable) {
          await stampCandidateConfirmed(
            tx,
            candidate.id,
            expense.id,
            value.actorUserId,
            value.documentId,
            candidate.disposition,
          );
        }

        await recomputeDocumentCounters(tx, value.documentId, value.actorUserId);
        await emitDocumentConfirmed(tx, value.documentId);

        return { expense, lines, skipped };
      });
    },
  };
}

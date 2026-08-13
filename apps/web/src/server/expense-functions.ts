/**
 * Server functions for the /finance workspace surfaces (loxep-dgf.1, M1).
 *
 * `@loxep/accounting`'s `createExpensesService`/`createReceiptsService`/
 * `createExpenseReports` shipped complete and had zero callers before this
 * file — see the design's "the finding that reframes this phase"
 * (`apps/docs/src/content/docs/architecture/flipping-lifecycle-design.md`).
 *
 * Role gate: every handler here calls `requireSession` (any authenticated
 * member), not `requireAdmin` — recording a spend is ordinary operator work,
 * not an administrative action, and this file's own scope note says so
 * explicitly. `session.user.id` becomes the service's `actorUserId`/
 * `createdByUserId`, which the audit log and `entity_attributed_by_user_id`
 * both read.
 *
 * Handlers use dynamic imports so `@/server/admin` (and `@loxep/accounting`
 * behind it) stays out of the client bundle — mirrors
 * `@/server/market-functions.ts`. Unlike `@loxep/market`, `@loxep/accounting`
 * depends only on `@loxep/db`/`@loxep/domain`/`@loxep/storage` (verified
 * against its `package.json`) and pulls no `@loxep/jobs`, so `@/server/admin`
 * registers it as an eager/lazy-by-dependency singleton exactly like the
 * settings services, not behind a `@vite-ignore` dynamic module import.
 */
import { createServerFn } from '@tanstack/react-start';
import { z } from 'zod';

function iso(date: Date): string;
function iso(date: Date | null | undefined): string | null;
function iso(date: Date | null | undefined): string | null {
  return date ? date.toISOString() : null;
}

const calendarDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'expected a calendar date as YYYY-MM-DD');
const decimalString = z
  .string()
  .trim()
  .regex(/^-?\d+(\.\d+)?$/, 'expected a plain decimal amount');
const currencyCode = z
  .string()
  .trim()
  .regex(/^[A-Za-z]{3}$/, 'expected an ISO-4217 alphabetic code');

/**
 * Mirrors `EXPENSE_PAYMENT_METHODS` (`@loxep/db/schema/expenses.ts`) —
 * duplicated as a literal list rather than importing the schema module
 * client-side, matching how `@/server/market-functions.ts` treats closed
 * provider-side unions.
 */
const EXPENSE_PAYMENT_METHOD_VALUES = [
  'card',
  'cash',
  'bank_transfer',
  'marketplace_balance',
  'direct_debit',
  'other'
] as const;

/**
 * Excludes `posted` — still unreachable, but not because the engine is
 * missing. `@loxep/accounting`'s posting engine (`createPostingEngine` /
 * `evaluateFacts`, `packages/accounting/src/posting-engine.ts`) exists and,
 * as of loxep-6fm, runs on a cadence via `@loxep/app`'s
 * `accounting.post-facts` worker task. `expenses.status` still never becomes
 * `posted`, though: Phase 5 links a fact to the entry it produced by
 * SOURCE-FACT IDENTITY (`journal_entries.source_fact_type`/`source_fact_id`),
 * deliberately without a foreign key or a status write-back on the expense
 * row itself (`posting.ts`'s module doc — `expenses` gains no
 * `journal_entry_id`). "Did this expense post?" is answered by querying the
 * journal (`JournalService.findBySourceFact('expense', id)`), not by reading
 * this column, so excluding `posted` here reflects the shipped engine's
 * actual behaviour rather than standing in for one that doesn't exist yet.
 */
const EXPENSE_STATUS_VALUES = ['draft', 'recorded', 'void'] as const;

// ---------------------------------------------------------------------------
// List (loxep-dgf.1 acceptance: "list w/ filters the service supports")
// ---------------------------------------------------------------------------

export interface ExpenseListItemDto {
  id: string;
  referenceCode: string;
  expenseDate: string;
  economicEntityId: string | null;
  entityAttributionSource: string;
  payeeName: string | null;
  category: string;
  currency: string;
  amount: string;
  taxAmount: string;
  paymentMethod: string;
  status: string;
  allocatedAmount: string;
  unallocatedAmount: string;
  allocationCount: number;
  receiptCount: number;
}

/**
 * `listExpenses` (`@loxep/accounting/reports.ts`) has no offset/cursor — only
 * `limit`. This mirrors `/market/monitors`' fully-unbounded-then-client-
 * paginated shape rather than a server-paginated one: the server does the
 * filtering the service actually supports (entity/date/category/status),
 * capped at a generous limit, and the table sorts/pages the result in memory.
 */
const EXPENSE_LIST_LIMIT = 1000;

const expenseFilterInput = z.strictObject({
  economicEntityId: z.uuid().nullish(),
  from: calendarDate.optional(),
  to: calendarDate.optional(),
  category: z.string().trim().min(1).optional(),
  statuses: z.array(z.enum(EXPENSE_STATUS_VALUES)).optional()
});

export const fetchExpenses = createServerFn({ method: 'GET' })
  .inputValidator(expenseFilterInput)
  .handler(async ({ data }): Promise<ExpenseListItemDto[]> => {
    const { requireSession, getExpenseReports } = await import('@/server/admin');
    await requireSession();
    const rows = await getExpenseReports().listExpenses({
      ...(data.economicEntityId !== undefined ? { economicEntityId: data.economicEntityId } : {}),
      ...(data.from !== undefined ? { from: data.from } : {}),
      ...(data.to !== undefined ? { to: data.to } : {}),
      ...(data.category !== undefined ? { category: data.category } : {}),
      ...(data.statuses !== undefined ? { statuses: data.statuses } : {}),
      limit: EXPENSE_LIST_LIMIT
    });
    return rows.map((row) => ({
      id: row.expenseId,
      referenceCode: row.referenceCode,
      expenseDate: row.expenseDate,
      economicEntityId: row.economicEntityId,
      entityAttributionSource: row.entityAttributionSource,
      payeeName: row.payeeName,
      category: row.category,
      currency: row.currency,
      amount: row.amount,
      taxAmount: row.taxAmount,
      paymentMethod: row.paymentMethod,
      status: row.status,
      allocatedAmount: row.allocatedAmount,
      unallocatedAmount: row.unallocatedAmount,
      allocationCount: row.allocationCount,
      receiptCount: row.receiptCount
    }));
  });

// ---------------------------------------------------------------------------
// Detail
// ---------------------------------------------------------------------------

export interface ReceiptDto {
  mediaObjectId: string;
  purpose: string;
  sortOrder: number | null;
  originalFilename: string | null;
  mimeType: string | null;
  sizeBytes: number;
  createdAt: string;
  /** `GET`-able bytes behind the expense-scoped serving route (its OWN `metadata.purpose` gate). */
  servingUrl: string;
}

export interface ExpenseDetailDto {
  id: string;
  referenceCode: string;
  economicEntityId: string | null;
  entityAttributionSource: string;
  expenseDate: string;
  payeeName: string | null;
  category: string;
  description: string | null;
  currency: string;
  amount: string;
  taxAmount: string;
  paymentMethod: string;
  acquisitionCostId: string | null;
  status: string;
  reimbursable: boolean;
  notes: string | null;
  createdByUserId: string | null;
  createdAt: string;
  updatedAt: string;
  allocatedAmount: string;
  unallocatedAmount: string;
  allocationCount: number;
  fullyAllocated: boolean;
  receipts: ReceiptDto[];
}

export const fetchExpense = createServerFn({ method: 'GET' })
  .inputValidator(z.strictObject({ id: z.uuid() }))
  .handler(async ({ data }): Promise<ExpenseDetailDto> => {
    const { requireSession, getExpensesService, getReceiptsService, getMediaService } =
      await import('@/server/admin');
    await requireSession();
    const expensesService = getExpensesService();
    const [expense, summary, receiptsService, mediaService] = await Promise.all([
      expensesService.get(data.id),
      expensesService.allocationSummary(data.id),
      getReceiptsService(),
      getMediaService()
    ]);
    const links = await receiptsService.list(data.id);
    const receipts = await Promise.all(
      links.map(async (link): Promise<ReceiptDto> => {
        const mediaObject = await mediaService.getMediaObject(link.mediaObjectId);
        return {
          mediaObjectId: link.mediaObjectId,
          purpose: link.purpose,
          sortOrder: link.sortOrder,
          originalFilename: mediaObject.originalFilename,
          mimeType: mediaObject.mimeType,
          sizeBytes: mediaObject.sizeBytes,
          createdAt: iso(link.createdAt),
          servingUrl: `/api/media/receipt/${link.mediaObjectId}`
        };
      })
    );
    return {
      id: expense.id,
      referenceCode: expense.referenceCode,
      economicEntityId: expense.economicEntityId,
      entityAttributionSource: expense.entityAttributionSource,
      expenseDate: expense.expenseDate,
      payeeName: expense.payeeName,
      category: expense.category,
      description: expense.description,
      currency: expense.currency,
      amount: expense.amount,
      taxAmount: expense.taxAmount,
      paymentMethod: expense.paymentMethod,
      acquisitionCostId: expense.acquisitionCostId,
      status: expense.status,
      reimbursable: expense.reimbursable,
      notes: expense.notes,
      createdByUserId: expense.createdByUserId,
      createdAt: iso(expense.createdAt),
      updatedAt: iso(expense.updatedAt),
      allocatedAmount: summary.allocatedAmount,
      unallocatedAmount: summary.unallocatedAmount,
      allocationCount: summary.allocationCount,
      fullyAllocated: summary.fullyAllocated,
      // eslint-disable-next-line unicorn/no-array-sort -- `[...receipts]` copies first; `toSorted` needs a newer `lib` than this project targets.
      receipts: [...receipts].sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0))
    };
  });

// ---------------------------------------------------------------------------
// Create (quick entry) — writes `status: 'recorded'` in one call by default;
// `draft` stays reachable for the deliberate "finish this later" case.
// ---------------------------------------------------------------------------

const createExpenseInput = z.strictObject({
  amount: decimalString,
  expenseDate: calendarDate,
  category: z.string().trim().min(1),
  payeeName: z.string().trim().min(1).nullable(),
  paymentMethod: z.enum(EXPENSE_PAYMENT_METHOD_VALUES),
  currency: currencyCode,
  /**
   * ALWAYS sent explicitly by the quick-entry dialog — `null` means the
   * operator picked "Unattributed" and is never the same as omitting the
   * key (`resolveExpenseAttribution`, `@loxep/accounting/attribution.ts`).
   * The third rung, `installation_default`, has no registered application
   * setting to resolve it from yet (a documented gap — see the server-fn
   * doc above), so this surface only ever produces `manual` or
   * `unattributed`, which is the honest subset of the three.
   */
  economicEntityId: z.uuid().nullable(),
  status: z.enum(['draft', 'recorded']).default('recorded'),
  notes: z.string().trim().min(1).nullish()
});

export const createExpense = createServerFn({ method: 'POST' })
  .inputValidator(createExpenseInput)
  .handler(async ({ data }): Promise<{ id: string; referenceCode: string }> => {
    const { requireSession, getExpensesService } = await import('@/server/admin');
    const session = await requireSession();
    const { expense } = await getExpensesService().create({
      economicEntityId: data.economicEntityId,
      expenseDate: data.expenseDate,
      payeeName: data.payeeName,
      category: data.category,
      currency: data.currency,
      amount: data.amount,
      paymentMethod: data.paymentMethod,
      status: data.status,
      notes: data.notes ?? null,
      createdByUserId: session.user.id
    });
    return { id: expense.id, referenceCode: expense.referenceCode };
  });

/**
 * `draft` -> `recorded`. Draft stays reachable from quick entry ("save as
 * draft") for the deliberate "finish this later" case; this is how it later
 * becomes the locked, evidentiary fact — the service's only other lifecycle
 * transition besides create/void.
 */
export const submitExpense = createServerFn({ method: 'POST' })
  .inputValidator(z.strictObject({ expenseId: z.uuid() }))
  .handler(async ({ data }): Promise<{ status: string }> => {
    const { requireSession, getExpensesService } = await import('@/server/admin');
    const session = await requireSession();
    const after = await getExpensesService().submit({
      expenseId: data.expenseId,
      actorUserId: session.user.id
    });
    return { status: after.status };
  });

// ---------------------------------------------------------------------------
// Void — the ONLY correction path for a recorded expense (never edit-in-place)
// ---------------------------------------------------------------------------

export const voidExpense = createServerFn({ method: 'POST' })
  .inputValidator(z.strictObject({ expenseId: z.uuid(), reason: z.string().trim().min(1) }))
  .handler(async ({ data }): Promise<{ status: string }> => {
    const { requireSession, getExpensesService } = await import('@/server/admin');
    const session = await requireSession();
    const after = await getExpensesService().voidExpense({
      expenseId: data.expenseId,
      reason: data.reason,
      actorUserId: session.user.id
    });
    return { status: after.status };
  });

// ---------------------------------------------------------------------------
// Receipts — detach only; attach happens through the binary upload route
// (`routes/api.expenses.receipt.ts`), mirroring the avatar upload split.
// ---------------------------------------------------------------------------

export const detachReceipt = createServerFn({ method: 'POST' })
  .inputValidator(
    z.strictObject({
      expenseId: z.uuid(),
      mediaObjectId: z.uuid(),
      purpose: z.enum(['receipt', 'invoice', 'supporting_document']).default('receipt')
    })
  )
  .handler(async ({ data }): Promise<{ ok: true }> => {
    const { requireSession, getReceiptsService } = await import('@/server/admin');
    const session = await requireSession();
    const receiptsService = await getReceiptsService();
    await receiptsService.detach({
      expenseId: data.expenseId,
      mediaObjectId: data.mediaObjectId,
      purpose: data.purpose,
      actorUserId: session.user.id
    });
    return { ok: true };
  });

// ---------------------------------------------------------------------------
// Reports (`/finance/overview`) — render straight from the shipped `reports.ts`
// and `receipts.ts` read models.
// ---------------------------------------------------------------------------

export interface MissingReceiptRowDto {
  expenseId: string;
  referenceCode: string;
  expenseDate: string;
  currency: string;
  amount: string;
  category: string;
  payeeName: string | null;
}

export const fetchMissingReceipts = createServerFn({ method: 'GET' }).handler(
  async (): Promise<MissingReceiptRowDto[]> => {
    const { requireSession, getReceiptsService } = await import('@/server/admin');
    await requireSession();
    const receiptsService = await getReceiptsService();
    return receiptsService.missingReceipts();
  }
);

export interface UnallocatedExpenseRowDto {
  expenseId: string;
  referenceCode: string;
  expenseDate: string;
  currency: string;
  amount: string;
  allocatedAmount: string;
  unallocatedAmount: string;
  allocationCount: number;
  status: string;
}

export const fetchUnallocatedExpenses = createServerFn({ method: 'GET' }).handler(
  async (): Promise<UnallocatedExpenseRowDto[]> => {
    const { requireSession, getExpenseReports } = await import('@/server/admin');
    await requireSession();
    return getExpenseReports().unallocatedExpenses();
  }
);

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
import { mediaObjectPurpose, servingUrlFor } from '@/server/media-serving-url';

function iso(date: Date): string;
function iso(date: Date | null | undefined): string | null;
function iso(date: Date | null | undefined): string | null {
  return date ? date.toISOString() : null;
}

/** Standard single-quoted SQL text literal, embedded quotes doubled — mirrors `@/server/documents-functions.ts`'s own helper. */
function textLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
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

/** Mirrors `EXPENSE_LINE_KINDS` (`@loxep/accounting`/`packages/db/src/schema/expenses.ts`) — duplicated as a literal list per this file's own precedent above. */
const EXPENSE_LINE_KIND_VALUES = ['item', 'shipping', 'tax', 'fee', 'discount', 'other'] as const;

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
  payeeCounterpartyId: string | null;
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
  statuses: z.array(z.enum(EXPENSE_STATUS_VALUES)).optional(),
  /**
   * "Search receipt text" (design section 5, "What surfaces search it") —
   * deliberately separate from `category`/`payeeName`-style field filters: a
   * match here is a match inside an ATTACHED RECEIPT's extracted text, not a
   * match on the expense's own recorded fields. Applied as a POST-filter
   * below rather than inside `@loxep/accounting`'s `listExpenses` (that
   * service owns no join to `documents` and this change's write fence does
   * not extend into `packages/accounting`) — the join runs first, against
   * `media_links`/`media_objects`/`documents` directly, and its matched
   * expense-id set narrows the service's own (entity/date/category/status)
   * result.
   */
  q: z.string().trim().min(1).nullish()
});

/**
 * The expense ids whose attached receipt text matches `q` — the same join
 * the design's "How an expense's receipts are searched" section names:
 * `expenses -> media_links (resource_type='expense') -> media_objects ->
 * documents.parsed_text_tsv`. `media_links.resource_id` is stored as
 * `expenses.id::text` (the design's own words), so the comparison is a text
 * one throughout.
 */
async function matchingExpenseIdsForReceiptText(q: string): Promise<Set<string>> {
  const { getAdminServices } = await import('@/server/admin');
  const { handle } = getAdminServices();
  const result = await handle.db.execute(
    `select distinct ml.resource_id as expense_id
       from media_links ml
       join media_objects mo on mo.id = ml.media_object_id
       join documents d on d.media_object_id = mo.id
      where ml.resource_type = 'expense'
        and d.parsed_text_tsv @@ websearch_to_tsquery('simple', ${textLiteral(q)})`
  );
  return new Set(result.rows.map((row) => row['expense_id'] as string));
}

export const fetchExpenses = createServerFn({ method: 'GET' })
  .inputValidator(expenseFilterInput)
  .handler(async ({ data }): Promise<ExpenseListItemDto[]> => {
    const { requireSession, getExpenseReports } = await import('@/server/admin');
    await requireSession();
    const matchingReceiptTextIds = data.q ? await matchingExpenseIdsForReceiptText(data.q) : null;
    const rows = await getExpenseReports().listExpenses({
      ...(data.economicEntityId !== undefined ? { economicEntityId: data.economicEntityId } : {}),
      ...(data.from !== undefined ? { from: data.from } : {}),
      ...(data.to !== undefined ? { to: data.to } : {}),
      ...(data.category !== undefined ? { category: data.category } : {}),
      ...(data.statuses !== undefined ? { statuses: data.statuses } : {}),
      limit: EXPENSE_LIST_LIMIT
    });
    const filtered =
      matchingReceiptTextIds === null
        ? rows
        : rows.filter((row) => matchingReceiptTextIds.has(row.expenseId));
    return filtered.map((row) => ({
      id: row.expenseId,
      referenceCode: row.referenceCode,
      expenseDate: row.expenseDate,
      economicEntityId: row.economicEntityId,
      entityAttributionSource: row.entityAttributionSource,
      payeeName: row.payeeName,
      payeeCounterpartyId: row.payeeCounterpartyId,
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
  /**
   * `GET`-able bytes behind the media object's OWN `metadata.purpose`-gated
   * serving route — derived via `@/server/media-serving-url.ts`'s
   * `servingUrlFor`, never assumed to be `/api/media/receipt/*`. A receipt
   * attached from `/finance/expenses/new`'s evidence pane arrives through
   * `POST /api/documents/upload` and is stamped `metadata.purpose =
   * 'document'`, so it 404s behind the receipt route — see that module's doc
   * for the full trap. `null` when the object's purpose has no known route.
   */
  servingUrl: string | null;
  /**
   * The attached media object's own `documents` row, when one exists (a
   * receipt uploaded through the OLD `POST /api/expenses/receipt` route, or
   * one confirmed before OCR was ever enabled on this installation, has
   * none — design section 5's "text exists forward, not retroactively").
   * `null` end to end (`textExtractedAt`/`wordCount`/`snippet`) means
   * "nothing to show", never "the receipt has no text" — those are
   * different claims and the UI must not conflate them.
   */
  textExtractedAt: string | null;
  wordCount: number | null;
  /**
   * `ts_headline('simple', ...)` around the FIRST match of `fetchExpense`'s
   * own `q` argument — populated ONLY when the caller arrived from a search
   * (design: "the matched snippet highlighted via ts_headline when arriving
   * from a search"). `null` with no `q`, and `null` when `q` was given but
   * this receipt's text does not actually match it. Never the raw
   * `parsedText` dump — see this module's own doc.
   */
  snippet: string | null;
}

/**
 * One `expense_lines` row (loxep-cd3.3, M3) — WHAT WAS BOUGHT, never an
 * allocation. See `packages/db/src/schema/expenses.ts`'s `expenseLines`
 * table doc for the full case against a `tax_amount`/currency/date column
 * here: those are the expense's own fields, not the line's.
 */
export interface ExpenseLineDto {
  id: string;
  lineNumber: number;
  description: string | null;
  quantity: string | null;
  unitAmount: string | null;
  lineAmount: string;
  lineKind: string;
  documentLineCandidateId: string | null;
  note: string | null;
}

export interface ExpenseLinesSummaryDto {
  absoluteLineTotal: string;
  lineCount: number;
  fitsWithinExpense: boolean;
}

export interface ExpenseDetailDto {
  id: string;
  referenceCode: string;
  economicEntityId: string | null;
  entityAttributionSource: string;
  expenseDate: string;
  payeeName: string | null;
  payeeCounterpartyId: string | null;
  /**
   * The linked counterparty's CURRENT `display_name`, resolved through the
   * survivor pointer (`coalesce(merged_into_counterparty_id, id)` —
   * `@loxep/counterparties/merge.ts`'s `resolvedIdExpression`, reproduced
   * here as a direct SQL join since that package is not an `apps/web`
   * dependency — see `@/server/trading-partner-functions.ts`'s module doc
   * for why). `null` when `payeeCounterpartyId` is `null`, OR when the
   * linked row was somehow deleted (never happens today — nothing deletes a
   * counterparty), so `payeeName`'s own snapshot is the fallback display
   * text either way.
   */
  payeeCounterpartyDisplayName: string | null;
  category: string;
  description: string | null;
  currency: string;
  amount: string;
  taxAmount: string;
  paymentMethod: string;
  acquisitionCostId: string | null;
  /**
   * The lot this expense's `acquisitionCostId` (if any) belongs to — resolved
   * server-side so the detail page can link straight to `/inventory/acquisitions/$id`
   * instead of naming the cost row as inert prose (loxep-1zg). `null` whenever
   * `acquisitionCostId` is `null`; the cost row is expected to still exist
   * once it is set, since nothing deletes `acquisition_costs`.
   */
  acquisitionId: string | null;
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
  lines: ExpenseLineDto[];
  lineSummary: ExpenseLinesSummaryDto;
}

/**
 * `ts_headline`'s match markers, deliberately NOT `<b>`/`</b>` (its own
 * default). `parsed_text` is OCR/PDF-extracted text from an
 * OPERATOR-UPLOADED document, so it is untrusted content as far as HTML
 * rendering is concerned — a crafted image could plausibly print something
 * that looks like a tag. `SNIPPET_MATCH_START`/`SNIPPET_MATCH_STOP` are the
 * ASCII SOH/STX control characters (0x01/0x02) — never produced by OCR/PDF
 * text extraction, never meaningful in ordinary text. The client
 * (`receipt-gallery.tsx`'s `renderSnippet`) splits the returned string on
 * them and renders each side as plain React text (escaped by React itself)
 * with a real `<b>` element for the matched span — no
 * `dangerouslySetInnerHTML` anywhere in this path.
 */
export const SNIPPET_MATCH_START = '';
export const SNIPPET_MATCH_STOP = '';

/**
 * `documents.parsed_text`/`parsed_at` for one media object, plus a derived
 * word count and (only when `q` is given AND the text actually matches) a
 * `ts_headline` snippet. Word count is a plain whitespace split — good
 * enough for "412 words" as an orientation figure, not a claim of exact
 * tokenization. Returns all-nulls when no `documents` row references this
 * media object at all, or when one does but `parsed_text` is still null
 * (not yet parsed, or the `manual` backend).
 */
async function fetchDocumentTextInfo(
  mediaObjectId: string,
  q: string | null
): Promise<Pick<ReceiptDto, 'textExtractedAt' | 'wordCount' | 'snippet'>> {
  const { getAdminServices } = await import('@/server/admin');
  const { handle } = getAdminServices();
  // The query text is validated non-empty by `fetchExpense`'s own Zod
  // schema before it ever reaches here; `snippetClause` computes the
  // tsquery once and reuses it, rather than repeating the literal three
  // times in one statement.
  const snippetClause = q
    ? `case when parsed_text is not null
              and parsed_text_tsv @@ websearch_to_tsquery('simple', ${textLiteral(q)})
            then ts_headline('simple', parsed_text,
                   websearch_to_tsquery('simple', ${textLiteral(q)}),
                   ${textLiteral(
                     `MaxFragments=1, MinWords=15, MaxWords=40, StartSel=${SNIPPET_MATCH_START}, StopSel=${SNIPPET_MATCH_STOP}`
                   )})
            else null
       end`
    : 'null';
  const result = await handle.db.execute(
    `select parsed_text, parsed_at, ${snippetClause} as snippet
       from documents
      where media_object_id = ${textLiteral(mediaObjectId)}
      limit 1`
  );
  const row = result.rows[0];
  if (row === undefined) return { textExtractedAt: null, wordCount: null, snippet: null };
  const parsedText = row['parsed_text'] as string | null;
  const parsedAt = row['parsed_at'] as string | null;
  return {
    textExtractedAt: parsedAt ? iso(new Date(parsedAt)) : null,
    wordCount:
      parsedText === null
        ? null
        : parsedText.trim().length > 0
          ? parsedText.trim().split(/\s+/).length
          : 0,
    snippet: (row['snippet'] as string | null) ?? null
  };
}

export const fetchExpense = createServerFn({ method: 'GET' })
  .inputValidator(z.strictObject({ id: z.uuid(), q: z.string().trim().min(1).nullish() }))
  .handler(async ({ data }): Promise<ExpenseDetailDto> => {
    const {
      requireSession,
      getAdminServices,
      getExpensesService,
      getExpenseLinesService,
      getReceiptsService,
      getMediaService
    } = await import('@/server/admin');
    await requireSession();
    const expensesService = getExpensesService();
    const expenseLinesService = getExpenseLinesService();
    const [expense, summary, lines, lineSummary, receiptsService, mediaService] = await Promise.all(
      [
        expensesService.get(data.id),
        expensesService.allocationSummary(data.id),
        expenseLinesService.listLines(data.id),
        expenseLinesService.lineSummary(data.id),
        getReceiptsService(),
        getMediaService()
      ]
    );
    const acquisitionCost = expense.acquisitionCostId
      ? await getAdminServices().handle.db.query.acquisitionCosts.findFirst({
          where: (table, { eq }) => eq(table.id, expense.acquisitionCostId as string),
          columns: { acquisitionId: true }
        })
      : null;
    const payeeCounterparty = expense.payeeCounterpartyId
      ? await getAdminServices().handle.db.query.counterparties.findFirst({
          where: (table, { eq }) => eq(table.id, expense.payeeCounterpartyId as string),
          columns: { displayName: true, mergedIntoCounterpartyId: true }
        })
      : null;
    // Follows the survivor pointer ONE hop — the documented resolution
    // formula (`@loxep/counterparties/merge.ts`'s module doc: the pointer
    // graph is kept exactly one level deep by refusal + compression).
    const resolvedPayeeCounterparty =
      payeeCounterparty?.mergedIntoCounterpartyId != null
        ? await getAdminServices().handle.db.query.counterparties.findFirst({
            where: (table, { eq }) =>
              eq(table.id, payeeCounterparty.mergedIntoCounterpartyId as string),
            columns: { displayName: true }
          })
        : payeeCounterparty;
    const links = await receiptsService.list(data.id);
    const receipts = await Promise.all(
      links.map(async (link): Promise<ReceiptDto> => {
        const [mediaObject, textInfo] = await Promise.all([
          mediaService.getMediaObject(link.mediaObjectId),
          fetchDocumentTextInfo(link.mediaObjectId, data.q ?? null)
        ]);
        return {
          mediaObjectId: link.mediaObjectId,
          purpose: link.purpose,
          sortOrder: link.sortOrder,
          originalFilename: mediaObject.originalFilename,
          mimeType: mediaObject.mimeType,
          sizeBytes: mediaObject.sizeBytes,
          createdAt: iso(link.createdAt),
          servingUrl: servingUrlFor(mediaObjectPurpose(mediaObject.metadata), link.mediaObjectId),
          ...textInfo
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
      payeeCounterpartyId: expense.payeeCounterpartyId,
      payeeCounterpartyDisplayName: resolvedPayeeCounterparty?.displayName ?? null,
      category: expense.category,
      description: expense.description,
      currency: expense.currency,
      amount: expense.amount,
      taxAmount: expense.taxAmount,
      paymentMethod: expense.paymentMethod,
      acquisitionCostId: expense.acquisitionCostId,
      acquisitionId: acquisitionCost?.acquisitionId ?? null,
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
      receipts: [...receipts].sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0)),
      lines: lines.map((line): ExpenseLineDto => ({
        id: line.id,
        lineNumber: line.lineNumber,
        description: line.description,
        quantity: line.quantity,
        unitAmount: line.unitAmount,
        lineAmount: line.lineAmount,
        lineKind: line.lineKind,
        documentLineCandidateId: line.documentLineCandidateId,
        note: line.note
      })),
      lineSummary: {
        absoluteLineTotal: lineSummary.absoluteLineTotal,
        lineCount: lineSummary.lineCount,
        fitsWithinExpense: lineSummary.fitsWithinExpense
      }
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
  /**
   * The picker's resolved counterparty (loxep-cd3.1). When present,
   * `@loxep/accounting` overrides `payeeName` with the counterparty's
   * `display_name` in the same write — "both are written, always". `null`/
   * omitted leaves the free-text-only fast path untouched.
   */
  payeeCounterpartyId: z.uuid().nullish(),
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
      payeeCounterpartyId: data.payeeCounterpartyId ?? null,
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

// ---------------------------------------------------------------------------
// Create (full entry, `/finance/expenses/new`, loxep-cd3.2 M2) — the
// composition surface. Same expense fields as quick entry, plus `taxAmount`
// and evidence already sitting in the documents pipeline.
// ---------------------------------------------------------------------------

/**
 * The upload order of operations the design settled on
 * (`expense-entry-design.md`, "Upload order of operations, which is the real
 * design question here"): each file dropped in the evidence pane posts to
 * the EXISTING `POST /api/documents/upload` immediately — no expense exists
 * yet, so there is nothing to attach to — writing a `media_objects` row
 * (`metadata.purpose = 'document'`) and a `documents` row
 * (`source_kind = 'upload'`, `status = 'pending'`) exactly like
 * `/finance/import`'s pipeline. This function is the "thin wrapper" the
 * design calls for: it creates the expense via the SAME
 * `ExpensesService.create` quick entry uses, then attaches every uploaded
 * media object with the SAME `ReceiptsService.attach` `confirmLinesAsExpense`
 * uses — never a forked write path — inside ONE transaction, so the expense
 * and its evidence links commit or roll back together.
 *
 * `mediaObjectIds` are ids the evidence pane already uploaded (and therefore
 * already verified to exist) in this same session — an attach failure here
 * is a genuine anomaly, not a routine case, so it is allowed to abort the
 * whole transaction rather than silently drop evidence the operator saw
 * attached. `ReceiptsService.attach` itself already absorbs a duplicate
 * (`23505`) attach, matching `confirmLinesAsExpense`'s reuse.
 *
 * Abandoning the page without saving leaves any already-uploaded documents
 * `pending`, reachable through `/finance/import` exactly as the design
 * requires — nothing here deletes an orphaned upload.
 */
/**
 * `expense_lines` (loxep-cd3.3, M3) — optional, headline-only stays valid.
 * `lineAmount` is the only required field per row, matching the schema
 * (`packages/db/src/schema/expenses.ts`'s `expenseLines`); `quantity`/
 * `unitAmount` are informational and never derive it.
 */
const expenseLineInput = z.strictObject({
  description: z.string().trim().min(1).nullish(),
  quantity: decimalString.nullish(),
  unitAmount: decimalString.nullish(),
  lineAmount: decimalString,
  lineKind: z.enum(EXPENSE_LINE_KIND_VALUES).default('item')
});

const createExpenseWithEvidenceInput = z.strictObject({
  amount: decimalString,
  taxAmount: decimalString.nullish(),
  expenseDate: calendarDate,
  category: z.string().trim().min(1),
  payeeName: z.string().trim().min(1).nullable(),
  /** See `createExpenseInput.payeeCounterpartyId` above. */
  payeeCounterpartyId: z.uuid().nullish(),
  paymentMethod: z.enum(EXPENSE_PAYMENT_METHOD_VALUES),
  currency: currencyCode,
  economicEntityId: z.uuid().nullable(),
  status: z.enum(['draft', 'recorded']).default('recorded'),
  notes: z.string().trim().min(1).nullish(),
  /** Media object ids already uploaded through `POST /api/documents/upload` — attached as `purpose: 'receipt'` inside the same transaction. */
  mediaObjectIds: z.array(z.uuid()).max(20).default([]),
  /** The optional line-items editor's rows — inserted in the SAME transaction as the expense, UNGATED (the draft-only lock guards a LATER edit, not an expense's own initial lines; see `@loxep/accounting/lines.ts`'s module doc). */
  lines: z.array(expenseLineInput).max(100).default([])
});

export const createExpenseWithEvidence = createServerFn({ method: 'POST' })
  .inputValidator(createExpenseWithEvidenceInput)
  .handler(
    async ({
      data
    }): Promise<{
      id: string;
      referenceCode: string;
      attachedCount: number;
      lineCount: number;
    }> => {
      const { requireSession, getAdminServices, getStorageBackendsService } =
        await import('@/server/admin');
      const session = await requireSession();
      const {
        absoluteLineTotal,
        createExpensesService,
        createReceiptsService,
        insertExpenseLinesRaw,
        linesFit,
        ExpenseLinesOverTranscribedError
      } = await import('@loxep/accounting');
      const { createMediaService } = await import('@loxep/storage');
      const { handle } = getAdminServices();

      return handle.db.transaction(async (tx) => {
        // Re-instantiated against THIS transaction, exactly like
        // `confirmLinesAsExpense` (`@/server/documents-functions.ts`) does —
        // so the expense write and every evidence attachment commit or roll
        // back together, not the module-level singletons from `admin.ts`.
        const expensesService = createExpensesService({ db: tx });
        const backends = await getStorageBackendsService();
        const media = createMediaService({ db: tx, backends });
        const receiptsService = createReceiptsService({ db: tx, media });

        const { expense } = await expensesService.create({
          economicEntityId: data.economicEntityId,
          expenseDate: data.expenseDate,
          payeeName: data.payeeName,
          payeeCounterpartyId: data.payeeCounterpartyId ?? null,
          category: data.category,
          currency: data.currency,
          amount: data.amount,
          ...(data.taxAmount !== null && data.taxAmount !== undefined
            ? { taxAmount: data.taxAmount }
            : {}),
          paymentMethod: data.paymentMethod,
          status: data.status,
          notes: data.notes ?? null,
          createdByUserId: session.user.id
        });

        if (data.lines.length > 0) {
          const absoluteTotal = absoluteLineTotal(data.lines.map((line) => line.lineAmount));
          if (!linesFit(expense.amount, absoluteTotal)) {
            throw new ExpenseLinesOverTranscribedError(
              `the ${data.lines.length} line(s) entered total ${absoluteTotal} (absolute), which ` +
                `exceeds this expense's amount of ${expense.amount} — remove or reduce a line`
            );
          }
          await insertExpenseLinesRaw(
            tx,
            expense.id,
            data.lines.map((line) => ({
              description: line.description ?? null,
              quantity: line.quantity ?? null,
              unitAmount: line.unitAmount ?? null,
              lineAmount: line.lineAmount,
              lineKind: line.lineKind
            })),
            1
          );
        }

        for (const mediaObjectId of data.mediaObjectIds) {
          await receiptsService.attach({
            expenseId: expense.id,
            mediaObjectId,
            purpose: 'receipt',
            actorUserId: session.user.id
          });
        }

        return {
          id: expense.id,
          referenceCode: expense.referenceCode,
          attachedCount: data.mediaObjectIds.length,
          lineCount: data.lines.length
        };
      });
    }
  );

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
// Lines (`/finance/expenses/$id`, loxep-cd3.3 M3) — draft only, the same
// lock `@loxep/accounting`'s allocation methods already carry. The entry
// page's OWN lines (composed before the expense exists) go through
// `createExpenseWithEvidence` above, never through these — see
// `ExpenseLinesService`'s module doc for why that write is exempt from the
// gate these two enforce.
// ---------------------------------------------------------------------------

const addExpenseLineInput = z.strictObject({
  expenseId: z.uuid(),
  description: z.string().trim().min(1).nullish(),
  quantity: decimalString.nullish(),
  unitAmount: decimalString.nullish(),
  lineAmount: decimalString,
  lineKind: z.enum(EXPENSE_LINE_KIND_VALUES).default('item')
});

export const addExpenseLine = createServerFn({ method: 'POST' })
  .inputValidator(addExpenseLineInput)
  .handler(async ({ data }): Promise<ExpenseLineDto> => {
    const { requireSession, getExpenseLinesService } = await import('@/server/admin');
    const session = await requireSession();
    const line = await getExpenseLinesService().addLine({
      expenseId: data.expenseId,
      description: data.description ?? null,
      quantity: data.quantity ?? null,
      unitAmount: data.unitAmount ?? null,
      lineAmount: data.lineAmount,
      lineKind: data.lineKind,
      actorUserId: session.user.id
    });
    return {
      id: line.id,
      lineNumber: line.lineNumber,
      description: line.description,
      quantity: line.quantity,
      unitAmount: line.unitAmount,
      lineAmount: line.lineAmount,
      lineKind: line.lineKind,
      documentLineCandidateId: line.documentLineCandidateId,
      note: line.note
    };
  });

export const removeExpenseLine = createServerFn({ method: 'POST' })
  .inputValidator(z.strictObject({ lineId: z.uuid() }))
  .handler(async ({ data }): Promise<{ ok: true }> => {
    const { requireSession, getExpenseLinesService } = await import('@/server/admin');
    const session = await requireSession();
    await getExpenseLinesService().removeLine({
      lineId: data.lineId,
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

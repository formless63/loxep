/**
 * Server functions for the Documents intake/import surfaces (loxep-dgf.4,
 * M4): CSV expense import staging, manual receipt-line entry, disposition,
 * discard, and confirm-as-expense.
 *
 * ## IMPLEMENTATION CHOICE — no `@loxep/documents` dependency here
 *
 * `apps/web/package.json` does not declare `@loxep/documents` (unlike
 * `@loxep/accounting`/`@loxep/inventory`, which `@/server/admin` already
 * reaches), and adding that dependency edge is outside this change's write
 * fence — mirrors `@/server/order-sync-functions.ts`'s documented reasoning
 * for `@loxep/commerce` exactly. This module re-implements the SAME
 * `documents`/`document_line_candidates` operations `@loxep/documents`'s
 * `documents.ts`/`candidates.ts` already ship and test (against real
 * PostgreSQL, 64 passing tests) — the status-derivation SQL, the
 * `stampConfirmed` shape, and the fingerprint duplicate check are
 * deliberately IDENTICAL, so a future package.json edit that adds the
 * dependency can delete this file's raw SQL and call the real service with
 * no behavior change. **Note for the orchestrator:** once
 * `apps/web/package.json` lists `@loxep/documents`, replace this module's
 * hand-rolled `documents`/`document_line_candidates` SQL with
 * `createDocumentsService`/`createCandidatesService`.
 *
 * ## The never-auto-commit rule, enforced HERE the same way it is in the package
 *
 * `confirmLinesAsExpense` is the ONLY function in this file that writes an
 * `expenses` row, and it:
 *
 * 1. requires a real session (`requireSession` — no session, no call);
 * 2. opens ONE transaction covering every candidate in the batch;
 * 3. constructs `@loxep/accounting`'s `createExpensesService` bound to THAT
 *    transaction (`createExpensesService({ db: tx })` — the same
 *    re-instantiate-against-an-open-transaction pattern
 *    `createAuditService({ db: tx })` establishes) so the expense write and
 *    the candidate stamp commit or roll back together;
 * 4. stamps `confirmed_at`/`confirmed_by_user_id`/`target_kind`/`target_id`
 *    with `session.user.id` as the actor — never null, never omitted.
 *
 * A Graphile Worker task has no session and therefore cannot reach this
 * function's actor at all — the same structural guarantee
 * `@loxep/documents/candidates.ts`'s `stampConfirmed` documents.
 */
import { createServerFn } from '@tanstack/react-start';
import { z } from 'zod';
import type { DbHandle } from '@loxep/db';
import { createTransactionalNotificationEnqueue, publishNotificationEvent } from '@loxep/domain';

function iso(date: Date): string;
function iso(date: Date | null | undefined): string | null;
function iso(date: Date | null | undefined): string | null {
  return date ? date.toISOString() : null;
}

const uuid = z.uuid();
const decimalString = z
  .string()
  .trim()
  .regex(/^-?\d+(\.\d+)?$/, 'expected a plain decimal amount');
const calendarDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'expected YYYY-MM-DD');

/** Mirrors `DOCUMENT_STATUSES` (`@loxep/db/schema/documents.ts`). */
const DOCUMENT_STATUS_VALUES = [
  'pending',
  'parsing',
  'review',
  'partially_confirmed',
  'confirmed',
  'discarded',
  'failed'
] as const;

/** Mirrors `LINE_DISPOSITIONS`. */
const LINE_DISPOSITION_VALUES = [
  'pending',
  'expense',
  'acquisition_cost',
  'inventory_intake',
  'supplies',
  'personal',
  'not_mine',
  'duplicate',
  'discarded'
] as const;

/** Dispositions this milestone's UI can actually confirm — `acquisition_cost`/`inventory_intake` need an acquisition-lot picker this milestone does not build; see the docs update for the deferred note. */
const CONFIRMABLE_AS_EXPENSE = new Set(['expense', 'supplies']);

function textLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}
function uuidLiteral(value: string): string {
  if (!uuid.safeParse(value).success) throw new Error('expected a UUID value');
  return `'${value}'`;
}

// ---------------------------------------------------------------------------
// DTOs
// ---------------------------------------------------------------------------

export interface DocumentQueueRowDto {
  id: string;
  documentKind: string;
  sourceKind: string;
  status: string;
  originalFilename: string | null;
  currency: string | null;
  documentTotal: string | null;
  documentDate: string | null;
  counterpartyName: string | null;
  lineCount: number;
  confirmedCount: number;
  note: string | null;
  createdAt: string;
}

export interface CandidateDto {
  id: string;
  documentId: string;
  lineNumber: number;
  description: string | null;
  lineAmount: string | null;
  currency: string | null;
  lineDate: string | null;
  confidence: string | null;
  disposition: string;
  rowFingerprint: string | null;
  confirmedAt: string | null;
  targetKind: string | null;
  targetId: string | null;
}

export interface DocumentDetailDto extends DocumentQueueRowDto {
  candidates: CandidateDto[];
  mediaServingUrl: string | null;
}

function rowToDocumentDto(row: Record<string, unknown>): DocumentQueueRowDto {
  return {
    id: row['id'] as string,
    documentKind: row['document_kind'] as string,
    sourceKind: row['source_kind'] as string,
    status: row['status'] as string,
    originalFilename: (row['original_filename'] as string | null) ?? null,
    currency: (row['currency'] as string | null) ?? null,
    documentTotal: (row['document_total'] as string | null) ?? null,
    documentDate: (row['document_date'] as string | null) ?? null,
    counterpartyName: (row['counterparty_name'] as string | null) ?? null,
    lineCount: Number(row['line_count']),
    confirmedCount: Number(row['confirmed_count']),
    note: (row['note'] as string | null) ?? null,
    createdAt: iso(new Date(row['created_at'] as string))
  };
}

function rowToCandidateDto(row: Record<string, unknown>): CandidateDto {
  return {
    id: row['id'] as string,
    documentId: row['document_id'] as string,
    lineNumber: Number(row['line_number']),
    description: (row['description'] as string | null) ?? null,
    lineAmount: (row['line_amount'] as string | null) ?? null,
    currency: (row['currency'] as string | null) ?? null,
    lineDate: (row['line_date'] as string | null) ?? null,
    confidence: (row['confidence'] as string | null) ?? null,
    disposition: row['disposition'] as string,
    rowFingerprint: (row['row_fingerprint'] as string | null) ?? null,
    confirmedAt: row['confirmed_at'] ? iso(new Date(row['confirmed_at'] as string)) : null,
    targetKind: (row['target_kind'] as string | null) ?? null,
    targetId: (row['target_id'] as string | null) ?? null
  };
}

/**
 * The status-derivation mirror of `@loxep/documents`'s
 * `recomputeDocumentCounters` — see that function's doc for why "pending"
 * means UNRESOLVED (no confirmation and not a terminal disposition), not
 * literally `disposition = 'pending'`.
 */
async function recomputeDocumentCounters(
  tx: Pick<DbHandle['db'], 'execute'>,
  documentId: string,
  actorUserId: string | null
): Promise<void> {
  const actorLiteral = actorUserId ? textLiteral(actorUserId) : 'null';
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
                then ${actorLiteral} else d.confirmed_by_user_id end,
            updated_at = now()
       from counts
      where d.id = ${uuidLiteral(documentId)}`
  );
}

/**
 * Emit the `document`-class notification event when a recompute has just left
 * the document `confirmed` (ADR-0023).
 *
 * Idempotent by construction: `documents.confirmed_at` is stamped exactly
 * once, so the deduplication key is stable and a repeated confirm records
 * nothing. Runs in a SAVEPOINT because PostgreSQL aborts the whole
 * transaction on any statement error — without one, a notification problem
 * would roll back the confirmation it was reporting on. If the delivery
 * enqueue is unavailable (a worker that has never started has no
 * `graphile_worker` schema), the fact is still recorded, unrouted: detection
 * does not depend on delivery.
 */
async function emitDocumentConfirmed(tx: DbHandle['db'], documentId: string): Promise<void> {
  const result = await tx.execute<{
    status: string;
    confirmed_at: string | null;
    original_filename: string | null;
    line_count: number;
  }>(
    `select status, confirmed_at, original_filename, line_count
       from documents where id = ${uuidLiteral(documentId)}`
  );
  const row = result.rows[0];
  if (row === undefined) return;
  const confirmedAt = row['confirmed_at'];
  if (row['status'] !== 'confirmed' || confirmedAt == null) return;
  const occurredAt = new Date(String(confirmedAt));
  const event = {
    eventClass: 'document' as const,
    eventType: 'document_confirmed',
    subjectType: 'document' as const,
    subjectId: documentId,
    occurredAt,
    payload: {
      ...(row['original_filename'] == null ? {} : { fileName: row['original_filename'] }),
      lineCount: Number(row['line_count'] ?? 0)
    },
    deduplicationKey: `document:${documentId}:confirmed:${occurredAt.toISOString()}`
  };
  try {
    await tx.transaction(async (savepoint) => {
      await publishNotificationEvent({
        executor: savepoint,
        enqueue: createTransactionalNotificationEnqueue(),
        event
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

// ---------------------------------------------------------------------------
// Queue / detail
// ---------------------------------------------------------------------------

export const fetchDocumentQueue = createServerFn({ method: 'GET' }).handler(
  async (): Promise<DocumentQueueRowDto[]> => {
    const { requireSession, getAdminServices } = await import('@/server/admin');
    await requireSession();
    const { handle } = getAdminServices();
    const result = await handle.db.execute(
      `select * from documents where status not in ('confirmed', 'discarded') order by created_at desc`
    );
    return result.rows.map(rowToDocumentDto);
  }
);

export const fetchDocument = createServerFn({ method: 'GET' })
  .inputValidator(z.strictObject({ id: uuid }))
  .handler(async ({ data }): Promise<DocumentDetailDto> => {
    const { requireSession, getAdminServices } = await import('@/server/admin');
    await requireSession();
    const { handle } = getAdminServices();
    const docResult = await handle.db.execute(
      `select * from documents where id = ${uuidLiteral(data.id)}`
    );
    const docRow = docResult.rows[0];
    if (docRow === undefined) {
      throw new Error(`unknown document "${data.id}"`);
    }
    const candidatesResult = await handle.db.execute(
      `select * from document_line_candidates where document_id = ${uuidLiteral(data.id)} order by line_number asc`
    );
    const mediaObjectId = docRow['media_object_id'] as string | null;
    return {
      ...rowToDocumentDto(docRow),
      candidates: candidatesResult.rows.map(rowToCandidateDto),
      mediaServingUrl: mediaObjectId ? `/api/media/document/${mediaObjectId}` : null
    };
  });

// ---------------------------------------------------------------------------
// CSV import staging
// ---------------------------------------------------------------------------

const stagedCsvRowInput = z.strictObject({
  lineNumber: z.number().int().positive(),
  description: z.string().nullable(),
  lineAmount: decimalString.nullable(),
  lineDate: calendarDate.nullable(),
  currency: z
    .string()
    .regex(/^[A-Za-z]{3}$/)
    .nullable(),
  rowFingerprint: z.string().min(1),
  rowWarnings: z.array(z.string())
});

export const checkCommittedFingerprints = createServerFn({ method: 'POST' })
  .inputValidator(z.strictObject({ fingerprints: z.array(z.string()) }))
  .handler(async ({ data }): Promise<{ committed: string[] }> => {
    const { requireSession, getAdminServices } = await import('@/server/admin');
    await requireSession();
    if (data.fingerprints.length === 0) return { committed: [] };
    const { handle } = getAdminServices();
    const result = await handle.db.execute(
      `select distinct row_fingerprint
         from document_line_candidates
        where confirmed_at is not null
          and row_fingerprint is not null
          and row_fingerprint in (${data.fingerprints.map((f) => textLiteral(f)).join(', ')})`
    );
    return { committed: result.rows.map((row) => row['row_fingerprint'] as string) };
  });

export const stageCsvImport = createServerFn({ method: 'POST' })
  .inputValidator(
    z.strictObject({
      originalFilename: z.string().trim().min(1).nullish(),
      rows: z.array(stagedCsvRowInput).min(1)
    })
  )
  .handler(async ({ data }): Promise<{ documentId: string; candidates: CandidateDto[] }> => {
    const { requireSession, getAdminServices } = await import('@/server/admin');
    const session = await requireSession();
    const { handle } = getAdminServices();

    return handle.db.transaction(async (tx) => {
      const inserted = await tx.execute(
        `insert into documents (document_kind, source_kind, media_object_id, original_filename,
                                status, created_by_user_id)
         values ('csv_import', 'csv', null, ${data.originalFilename ? textLiteral(data.originalFilename) : 'null'},
                 'pending', ${textLiteral(session.user.id)})
         returning id`
      );
      const documentId = inserted.rows[0]?.['id'] as string | undefined;
      if (documentId === undefined) throw new Error('documents insert returned no row');

      const values = data.rows
        .map((row, index) => {
          const description = row.description ? textLiteral(row.description) : 'null';
          const lineAmount = row.lineAmount ? `${row.lineAmount}::numeric(20,6)` : 'null';
          const lineDate = row.lineDate ? `'${row.lineDate}'::date` : 'null';
          const currency = row.currency ? textLiteral(row.currency) : 'null';
          const disposition =
            row.rowWarnings.length === 0 && row.lineAmount !== null ? 'expense' : 'pending';
          return `(${uuidLiteral(documentId)}, ${index + 1}, ${textLiteral(row.rowFingerprint)}, ${description}, ${lineAmount}, ${currency}, ${lineDate}, '1.000', ${textLiteral(disposition)})`;
        })
        .join(',\n');

      const candidatesResult = await tx.execute(
        `insert into document_line_candidates
           (document_id, line_number, row_fingerprint, description, line_amount, currency, line_date, confidence, disposition)
         values ${values}
         returning *`
      );

      await recomputeDocumentCounters(tx, documentId, null);

      return {
        documentId,
        candidates: candidatesResult.rows.map(rowToCandidateDto)
      };
    });
  });

// ---------------------------------------------------------------------------
// Manual line entry (the receipt path — no OCR backend this milestone)
// ---------------------------------------------------------------------------

export const addManualLine = createServerFn({ method: 'POST' })
  .inputValidator(
    z.strictObject({
      documentId: uuid,
      description: z.string().trim().min(1).nullish(),
      lineAmount: decimalString.nullish(),
      lineDate: calendarDate.nullish(),
      currency: z
        .string()
        .trim()
        .regex(/^[A-Za-z]{3}$/)
        .nullish(),
      disposition: z.enum(LINE_DISPOSITION_VALUES).default('expense')
    })
  )
  .handler(async ({ data }): Promise<CandidateDto> => {
    const { requireSession, getAdminServices } = await import('@/server/admin');
    await requireSession();
    const { handle } = getAdminServices();
    return handle.db.transaction(async (tx) => {
      const nextLine = await tx.execute(
        `select coalesce(max(line_number), 0) + 1 as next_line
           from document_line_candidates where document_id = ${uuidLiteral(data.documentId)}`
      );
      const lineNumber = Number(nextLine.rows[0]?.['next_line'] ?? 1);
      const result = await tx.execute(
        `insert into document_line_candidates
           (document_id, line_number, description, line_amount, currency, line_date, confidence, disposition)
         values (${uuidLiteral(data.documentId)}, ${lineNumber},
                 ${data.description ? textLiteral(data.description) : 'null'},
                 ${data.lineAmount ? `${data.lineAmount}::numeric(20,6)` : 'null'},
                 ${data.currency ? textLiteral(data.currency.toUpperCase()) : 'null'},
                 ${data.lineDate ? `'${data.lineDate}'::date` : 'null'},
                 '1.000', ${textLiteral(data.disposition)})
         returning *`
      );
      const row = result.rows[0];
      if (row === undefined) throw new Error('document_line_candidates insert returned no row');
      await recomputeDocumentCounters(tx, data.documentId, null);
      return rowToCandidateDto(row);
    });
  });

// ---------------------------------------------------------------------------
// Disposition and discard
// ---------------------------------------------------------------------------

export const setLineDisposition = createServerFn({ method: 'POST' })
  .inputValidator(
    z.strictObject({ candidateId: uuid, disposition: z.enum(LINE_DISPOSITION_VALUES) })
  )
  .handler(async ({ data }): Promise<CandidateDto> => {
    const { requireSession, getAdminServices } = await import('@/server/admin');
    const session = await requireSession();
    const { handle } = getAdminServices();
    return handle.db.transaction(async (tx) => {
      const before = await tx.execute(
        `select document_id::text as document_id, confirmed_at
           from document_line_candidates where id = ${uuidLiteral(data.candidateId)}`
      );
      const beforeRow = before.rows[0];
      if (beforeRow === undefined) throw new Error(`unknown candidate "${data.candidateId}"`);
      if (beforeRow['confirmed_at'] !== null) {
        throw new Error(
          'this line is already confirmed — a confirmed line is evidence of a domain write and is never edited in place'
        );
      }
      await tx.execute(
        `update document_line_candidates
            set disposition = ${textLiteral(data.disposition)}, updated_at = now()
          where id = ${uuidLiteral(data.candidateId)}`
      );
      await recomputeDocumentCounters(tx, beforeRow['document_id'] as string, session.user.id);
      const after = await tx.execute(
        `select * from document_line_candidates where id = ${uuidLiteral(data.candidateId)}`
      );
      const row = after.rows[0];
      if (row === undefined) throw new Error('candidate vanished mid-update');
      return rowToCandidateDto(row);
    });
  });

export const discardDocument = createServerFn({ method: 'POST' })
  .inputValidator(z.strictObject({ documentId: uuid, reason: z.string().trim().min(1).nullish() }))
  .handler(async ({ data }): Promise<{ status: string }> => {
    const { requireSession, getAdminServices } = await import('@/server/admin');
    await requireSession();
    const { handle } = getAdminServices();
    return handle.db.transaction(async (tx) => {
      const before = await tx.execute(
        `select confirmed_count from documents where id = ${uuidLiteral(data.documentId)}`
      );
      const beforeRow = before.rows[0];
      if (beforeRow === undefined) throw new Error(`unknown document "${data.documentId}"`);
      if (Number(beforeRow['confirmed_count']) > 0) {
        throw new Error(
          'this document has confirmed lines; discard is for throwing out a review before anything ' +
            'was confirmed. Dispose individual not-yet-confirmed lines instead.'
        );
      }
      await tx.execute(
        `update document_line_candidates
            set disposition = 'discarded', updated_at = now()
          where document_id = ${uuidLiteral(data.documentId)}
            and confirmed_at is null
            and disposition not in ('personal', 'not_mine', 'duplicate', 'discarded')`
      );
      const noteLiteral = data.reason ? textLiteral(data.reason) : 'null';
      await tx.execute(
        `update documents
            set status = 'discarded', note = coalesce(${noteLiteral}, note), updated_at = now()
          where id = ${uuidLiteral(data.documentId)}`
      );
      return { status: 'discarded' };
    });
  });

// ---------------------------------------------------------------------------
// Confirm — the ONLY function here that writes a domain table
// ---------------------------------------------------------------------------

export const confirmLinesAsExpense = createServerFn({ method: 'POST' })
  .inputValidator(
    z.strictObject({
      documentId: uuid,
      candidateIds: z.array(uuid).min(1),
      category: z.string().trim().min(1),
      paymentMethod: z.enum([
        'card',
        'cash',
        'bank_transfer',
        'marketplace_balance',
        'direct_debit',
        'other'
      ]),
      economicEntityId: uuid.nullish(),
      defaultCurrency: z
        .string()
        .trim()
        .regex(/^[A-Za-z]{3}$/)
        .default('USD')
    })
  )
  .handler(async ({ data }): Promise<{ expenseIds: string[]; skipped: number }> => {
    const { requireSession, getAdminServices, getStorageBackendsService } =
      await import('@/server/admin');
    const session = await requireSession();
    const { createExpensesService, createReceiptsService } = await import('@loxep/accounting');
    const { createMediaService } = await import('@loxep/storage');
    const { handle } = getAdminServices();

    return handle.db.transaction(async (tx) => {
      // Re-instantiated against THIS transaction (not the singletons from
      // `admin.ts`) so the expense write, the receipt attachment, and the
      // candidate stamp below commit or roll back together — see the module
      // doc. `backends` itself needs no tx binding: `ReceiptsService.attach`
      // only reaches `MediaService.addLink`, a plain insert that never touches
      // a storage driver.
      const expensesService = createExpensesService({ db: tx });
      const backends = await getStorageBackendsService();
      const media = createMediaService({ db: tx, backends });
      const receiptsService = createReceiptsService({ db: tx, media });

      // The confirmed source document's receipt image, if it has one — every
      // expense line confirmed out of this document gets it attached below,
      // closing the seam where a confirmed, receipt-backed expense used to
      // read as "missing" on the receipts report (loxep-4mg).
      const documentRow = await tx.execute(
        `select media_object_id from documents where id = ${uuidLiteral(data.documentId)}`
      );
      const sourceMediaObjectId =
        (documentRow.rows[0]?.['media_object_id'] as string | null) ?? null;

      const expenseIds: string[] = [];
      let skipped = 0;

      for (const candidateId of data.candidateIds) {
        const found = await tx.execute(
          `select * from document_line_candidates
             where id = ${uuidLiteral(candidateId)} and document_id = ${uuidLiteral(data.documentId)}`
        );
        const row = found.rows[0];
        if (row === undefined) {
          skipped += 1;
          continue;
        }
        const candidate = rowToCandidateDto(row);
        if (candidate.confirmedAt !== null) {
          skipped += 1;
          continue;
        }
        if (!CONFIRMABLE_AS_EXPENSE.has(candidate.disposition)) {
          skipped += 1;
          continue;
        }
        if (candidate.lineAmount === null) {
          skipped += 1;
          continue;
        }

        const { expense } = await expensesService.create({
          economicEntityId: data.economicEntityId ?? null,
          expenseDate: candidate.lineDate ?? new Date().toISOString().slice(0, 10),
          payeeName: null,
          category: data.category,
          description: candidate.description,
          currency: candidate.currency ?? data.defaultCurrency,
          amount: candidate.lineAmount,
          paymentMethod: data.paymentMethod,
          status: 'recorded',
          createdByUserId: session.user.id
        });
        expenseIds.push(expense.id);

        if (sourceMediaObjectId !== null) {
          await receiptsService.attach({
            expenseId: expense.id,
            mediaObjectId: sourceMediaObjectId,
            purpose: 'receipt',
            actorUserId: session.user.id
          });
        }

        await tx.execute(
          `update document_line_candidates
              set confirmed_at = now(),
                  confirmed_by_user_id = ${textLiteral(session.user.id)},
                  target_kind = 'expense',
                  target_id = ${uuidLiteral(expense.id)},
                  updated_at = now()
            where id = ${uuidLiteral(candidateId)}`
        );
      }

      await recomputeDocumentCounters(tx, data.documentId, session.user.id);
      await emitDocumentConfirmed(tx, data.documentId);
      return { expenseIds, skipped };
    });
  });

export { DOCUMENT_STATUS_VALUES, LINE_DISPOSITION_VALUES };

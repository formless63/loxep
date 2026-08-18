/**
 * Server functions for the Documents intake/import surfaces (loxep-dgf.4,
 * M4; confirm moved out in loxep-cd3.3, M3): CSV expense import staging,
 * manual receipt-line entry, disposition, discard, and document queue/detail
 * reads.
 *
 * ## IMPLEMENTATION CHOICE — no `@loxep/documents` dependency here
 *
 * `apps/web/package.json` does not declare `@loxep/documents` (unlike
 * `@loxep/accounting`/`@loxep/inventory`, which `@/server/admin` already
 * reaches), and adding that dependency edge is outside this change's write
 * fence — mirrors `@/server/order-sync-functions.ts`'s documented reasoning
 * for `@loxep/commerce` exactly. This module re-implements the SAME
 * `documents`/`document_line_candidates` READ operations `@loxep/documents`'s
 * `documents.ts`/`candidates.ts` already ship and test (against real
 * PostgreSQL, 64 passing tests) — the status-derivation SQL and the
 * fingerprint duplicate check are deliberately IDENTICAL, so a future
 * package.json edit that adds the dependency can delete this file's raw SQL
 * and call the real service with no behavior change. **Note for the
 * orchestrator:** once `apps/web/package.json` lists `@loxep/documents`,
 * replace this module's hand-rolled `documents`/`document_line_candidates`
 * SQL with `createDocumentsService`/`createCandidatesService`.
 *
 * ## Confirm moved to `@loxep/accounting` (loxep-cd3.3)
 *
 * `confirmLinesAsExpense` — the only function that used to write an
 * `expenses` row from here — is now a thin wrapper around
 * `@loxep/accounting`'s `confirmCandidatesAsExpense` (`@/server/admin.ts`'s
 * `getExpenseConfirmService`). See that package's `confirm.ts` for the
 * never-auto-commit enforcement (a required, non-null `actorUserId`, one
 * transaction, `stampConfirmed`-equivalent write-back) — it is now
 * structural there, not here, and `/finance/expenses/new`'s
 * `createExpenseWithEvidence` (`@/server/expense-functions.ts`) calls the
 * SAME function for its own dragged-candidate case.
 */
import { createServerFn } from '@tanstack/react-start';
import { z } from 'zod';
import type { DbHandle } from '@loxep/db';
import { mediaObjectPurpose, servingUrlFor } from '@/server/media-serving-url';

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

function textLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}
function uuidLiteral(value: string): string {
  if (!uuid.safeParse(value).success) throw new Error('expected a UUID value');
  return `'${value}'`;
}

/**
 * `document_line_candidates.source_region`'s reader, mirroring
 * `@loxep/documents`'s `source-region.ts` `parseSourceRegion` — duplicated
 * here per this file's own documented IMPLEMENTATION CHOICE (no
 * `@loxep/documents` dependency; see the module doc). Deliberately lenient:
 * a corrupted or shape-mismatched value degrades to "no box drawn" rather
 * than throwing and breaking the review/evidence UI.
 */
export interface SourceRegionDto {
  page: number;
  x: number;
  y: number;
  w: number;
  h: number;
}
function parseSourceRegion(raw: string | null): SourceRegionDto | null {
  if (raw === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const value = parsed as Record<string, unknown>;
  const { page, x, y, w, h } = value;
  if (
    typeof page !== 'number' ||
    typeof x !== 'number' ||
    typeof y !== 'number' ||
    typeof w !== 'number' ||
    typeof h !== 'number' ||
    !Number.isInteger(page) ||
    page <= 0 ||
    x < 0 ||
    y < 0 ||
    w < 0 ||
    h < 0 ||
    Object.keys(value).length !== 5
  ) {
    return null;
  }
  return { page, x, y, w, h };
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
  /**
   * When extraction last ran (`documents.parsed_at`), or `null` if no
   * parser has touched this document yet. The UI keys its "waiting for
   * extraction" copy on THIS, never on `status`: a parse that yields zero
   * candidates deliberately leaves `status = 'pending'` (nothing to
   * review), and conflating the two showed a permanent "waiting" message
   * over a document whose text had long since extracted (found live,
   * 2026-08-17).
   */
  parsedAt: string | null;
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
  /** `document_line_candidates.source_region`, parsed — `null` for a manual/CSV-staged line, or a genuinely malformed value. Drives `<DocumentPreview>`'s overlay (loxep-cd3.5, M5). */
  sourceRegion: SourceRegionDto | null;
}

export interface DocumentDetailDto extends DocumentQueueRowDto {
  candidates: CandidateDto[];
  /** The attached media object's own MIME type — `null` when there is none. Drives `<DocumentPreview>`'s image-vs-PDF-vs-fallback branch. */
  mimeType: string | null;
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
    createdAt: iso(new Date(row['created_at'] as string)),
    parsedAt: row['parsed_at'] == null ? null : iso(new Date(row['parsed_at'] as string))
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
    sourceRegion: parseSourceRegion((row['source_region'] as string | null) ?? null),
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

// ---------------------------------------------------------------------------
// Queue / detail
// ---------------------------------------------------------------------------

/**
 * The review worklist, optionally filtered by `q` — a `websearch_to_tsquery`
 * search over `documents.parsed_text_tsv` (design section 5, "How an
 * expense's receipts are searched" / "What surfaces search it": "a `q`
 * filter on the document queue — the primary surface. Searching 'Milwaukee'
 * finds the receipt."). Scoped to the SAME worklist `fetchDocumentQueue`
 * already returns (`status not in ('confirmed', 'discarded')`) rather than
 * a universal archive search — this is the review queue, not a document
 * library. `websearch_to_tsquery` (not `plainto_tsquery`) so an operator's
 * search box behaves like a familiar search engine (quoted phrases, `-`
 * exclusion, bare `OR`) rather than requiring `&`/`|` tsquery syntax.
 * `'simple'` matches the config `parsed_text_tsv` itself is generated with —
 * see the migration's own header for why.
 */
export const fetchDocumentQueue = createServerFn({ method: 'GET' })
  .inputValidator(z.strictObject({ q: z.string().trim().min(1).nullish() }))
  .handler(async ({ data }): Promise<DocumentQueueRowDto[]> => {
    const { requireSession, getAdminServices } = await import('@/server/admin');
    await requireSession();
    const { handle } = getAdminServices();
    const searchClause = data.q
      ? ` and parsed_text_tsv @@ websearch_to_tsquery('simple', ${textLiteral(data.q)})`
      : '';
    const result = await handle.db.execute(
      `select * from documents where status not in ('confirmed', 'discarded')${searchClause} order by created_at desc`
    );
    return result.rows.map(rowToDocumentDto);
  });

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
    // The serving URL is derived from the OBJECT's own `metadata.purpose`,
    // never assumed from the resource it hangs off — see
    // `@/server/media-serving-url.ts`'s doc for the trap this avoids. A
    // document-sourced upload is always stamped 'document' today, but this
    // still goes through the one shared mapper rather than a literal string,
    // so every `servingUrl`-returning DTO derives it the same way.
    let mimeType: string | null = null;
    let mediaServingUrl: string | null = null;
    if (mediaObjectId !== null) {
      const mediaResult = await handle.db.execute(
        `select mime_type, metadata from media_objects where id = ${uuidLiteral(mediaObjectId)}`
      );
      const mediaRow = mediaResult.rows[0];
      mimeType = (mediaRow?.['mime_type'] as string | null) ?? null;
      mediaServingUrl = servingUrlFor(mediaObjectPurpose(mediaRow?.['metadata']), mediaObjectId);
    }
    return {
      ...rowToDocumentDto(docRow),
      candidates: candidatesResult.rows.map(rowToCandidateDto),
      mimeType,
      mediaServingUrl
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

/**
 * `CandidatesService.updateLine`/`removeLine`/`bulkSetDisposition`
 * (`@loxep/documents/candidates.ts:174-197`, loxep-wx3, A26) had no web
 * equivalent — a misread amount could not be fixed, a junk line could not be
 * removed, and `setLineDisposition` above is strictly single-candidate, so a
 * 40-line receipt was one dropdown at a time. Hand-rolled SQL for the SAME
 * reason `setLineDisposition`/`discardDocument` above already are — see this
 * file's own top doc ("no `@loxep/documents` dependency here"): the
 * assignment-list shape and the `confirmed_at is not null` refusal are
 * DELIBERATELY IDENTICAL to `CandidatesService.updateLine`/`removeLine`/
 * `bulkSetDisposition`, so a future `package.json` edit can delete this and
 * call the real service with no behavior change.
 */
export const updateCandidateLine = createServerFn({ method: 'POST' })
  .inputValidator(
    z.strictObject({
      candidateId: uuid,
      description: z.string().trim().min(1).nullish(),
      lineAmount: decimalString.nullish(),
      currency: z
        .string()
        .trim()
        .regex(/^[A-Za-z]{3}$/)
        .nullish(),
      lineDate: calendarDate.nullish()
    })
  )
  .handler(async ({ data }): Promise<CandidateDto> => {
    const { requireSession, getAdminServices } = await import('@/server/admin');
    await requireSession();
    const { handle } = getAdminServices();
    return handle.db.transaction(async (tx) => {
      const before = await tx.execute(
        `select confirmed_at from document_line_candidates where id = ${uuidLiteral(data.candidateId)}`
      );
      const beforeRow = before.rows[0];
      if (beforeRow === undefined) throw new Error(`unknown candidate "${data.candidateId}"`);
      if (beforeRow['confirmed_at'] !== null) {
        throw new Error(
          'this line is already confirmed — a confirmed line is evidence of a domain write and is never edited in place'
        );
      }

      const assignments: string[] = ['updated_at = now()'];
      if (data.description !== undefined) {
        assignments.push(
          `description = ${data.description === null ? 'null' : textLiteral(data.description)}`
        );
      }
      if (data.lineAmount !== undefined) {
        assignments.push(
          `line_amount = ${data.lineAmount === null ? 'null' : `${data.lineAmount}::numeric(20,6)`}`
        );
      }
      if (data.currency !== undefined) {
        assignments.push(
          `currency = ${data.currency === null ? 'null' : textLiteral(data.currency.toUpperCase())}`
        );
      }
      if (data.lineDate !== undefined) {
        assignments.push(
          `line_date = ${data.lineDate === null ? 'null' : `'${data.lineDate}'::date`}`
        );
      }

      await tx.execute(
        `update document_line_candidates set ${assignments.join(', ')}
          where id = ${uuidLiteral(data.candidateId)}`
      );
      const after = await tx.execute(
        `select * from document_line_candidates where id = ${uuidLiteral(data.candidateId)}`
      );
      const row = after.rows[0];
      if (row === undefined) throw new Error('candidate vanished mid-update');
      return rowToCandidateDto(row);
    });
  });

export const removeCandidateLine = createServerFn({ method: 'POST' })
  .inputValidator(z.strictObject({ candidateId: uuid }))
  .handler(async ({ data }): Promise<{ documentId: string }> => {
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
          'this line is already confirmed — a confirmed line is evidence of a domain write and is never removed'
        );
      }
      await tx.execute(
        `delete from document_line_candidates where id = ${uuidLiteral(data.candidateId)}`
      );
      const documentId = beforeRow['document_id'] as string;
      await recomputeDocumentCounters(tx, documentId, session.user.id);
      return { documentId };
    });
  });

export const bulkSetLineDisposition = createServerFn({ method: 'POST' })
  .inputValidator(
    z.strictObject({
      candidateIds: z.array(uuid).min(1),
      disposition: z.enum(LINE_DISPOSITION_VALUES)
    })
  )
  .handler(async ({ data }): Promise<{ updated: number; skipped: number }> => {
    const { requireSession, getAdminServices } = await import('@/server/admin');
    const session = await requireSession();
    const { handle } = getAdminServices();
    return handle.db.transaction(async (tx) => {
      const idList = data.candidateIds.map((id) => uuidLiteral(id)).join(', ');
      const result = await tx.execute(
        `update document_line_candidates
            set disposition = ${textLiteral(data.disposition)}, updated_at = now()
          where id in (${idList}) and confirmed_at is null
        returning document_id`
      );
      const documentIds = new Set(result.rows.map((row) => row['document_id'] as string));
      for (const documentId of documentIds) {
        await recomputeDocumentCounters(tx, documentId, session.user.id);
      }
      return {
        updated: result.rows.length,
        skipped: data.candidateIds.length - result.rows.length
      };
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
// Confirm (loxep-cd3.3, M3) — MOVED into `@loxep/accounting`'s
// `confirmCandidatesAsExpense`, per `expense-entry-design.md` section 4's
// package-ownership table. This is now a thin wrapper: the actual write
// (create-or-reuse the expense, insert `expense_lines` — ONE per confirmed
// candidate — attach the receipt, stamp the candidates, recompute the
// document's counters, emit the `document_confirmed` event) lives in the
// package, and `/finance/expenses/new`'s save action (`@/server/
// expense-functions.ts`'s `createExpenseWithEvidence`) calls the SAME
// function for its own dragged-candidate case — one confirm mechanism,
// two entry points, exactly what the design's "reconciling the two flows"
// section requires. This file no longer writes an `expenses`,
// `expense_lines`, or `document_line_candidates` (write) row anywhere.
// ---------------------------------------------------------------------------

export interface ConfirmLinesAsExpenseResultDto {
  /** `null` only when every candidate in the batch was skipped — nothing was written. */
  expenseId: string | null;
  lineCount: number;
  skipped: number;
}

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
  .handler(async ({ data }): Promise<ConfirmLinesAsExpenseResultDto> => {
    const { requireSession, getExpenseConfirmService } = await import('@/server/admin');
    const session = await requireSession();
    const confirmService = await getExpenseConfirmService();
    const result = await confirmService.confirmCandidatesAsExpense({
      documentId: data.documentId,
      candidateIds: data.candidateIds,
      actorUserId: session.user.id,
      category: data.category,
      paymentMethod: data.paymentMethod,
      economicEntityId: data.economicEntityId ?? null,
      defaultCurrency: data.defaultCurrency
    });
    return {
      expenseId: result.expense?.id ?? null,
      lineCount: result.lines.length,
      skipped: result.skipped
    };
  });

// ---------------------------------------------------------------------------
// Confirm as acquisition (loxep-cd3.6, M6) — the acquisition-side sibling of
// `confirmLinesAsExpense` above, wrapping `@loxep/inventory`'s
// `confirmCandidatesAsAcquisition`. A candidate dispositioned
// `acquisition_cost`/`inventory_intake` NEVER reaches `@loxep/accounting` —
// the acquisition seam (`flipping-lifecycle-design.md`) forbids the same
// dollar being deducted once as an expense and again as COGS at sale.
// ---------------------------------------------------------------------------

export interface ConfirmLinesAsAcquisitionResultDto {
  /** `null` only when every candidate in the batch was skipped and no `acquisitionId` was given — nothing was written. */
  acquisitionId: string | null;
  acquisitionReferenceCode: string | null;
  costCount: number;
  skipped: number;
}

export const confirmLinesAsAcquisition = createServerFn({ method: 'POST' })
  .inputValidator(
    z.strictObject({
      documentId: uuid,
      candidateIds: z.array(uuid).min(1),
      /** Attach to this ALREADY-existing acquisition (the lot picker's "attach" branch) instead of creating one. */
      acquisitionId: uuid.nullish(),
      /** Required to create a new acquisition — ignored when `acquisitionId` is given. */
      title: z.string().trim().min(1).nullish(),
      sourceKind: z.string().trim().min(1).nullish(),
      vendorName: z.string().trim().min(1).nullish(),
      currency: z
        .string()
        .trim()
        .regex(/^[A-Za-z]{3}$/)
        .nullish(),
      defaultCurrency: z
        .string()
        .trim()
        .regex(/^[A-Za-z]{3}$/)
        .default('USD')
    })
  )
  .handler(async ({ data }): Promise<ConfirmLinesAsAcquisitionResultDto> => {
    const { requireSession, getAcquisitionConfirmService } = await import('@/server/admin');
    const session = await requireSession();
    const confirmService = await getAcquisitionConfirmService();
    const result = await confirmService.confirmCandidatesAsAcquisition({
      documentId: data.documentId,
      candidateIds: data.candidateIds,
      actorUserId: session.user.id,
      ...(data.acquisitionId ? { acquisitionId: data.acquisitionId } : {}),
      ...(data.title ? { title: data.title } : {}),
      ...(data.sourceKind ? { sourceKind: data.sourceKind } : {}),
      vendorName: data.vendorName ?? null,
      ...(data.currency ? { currency: data.currency } : {}),
      defaultCurrency: data.defaultCurrency
    });
    return {
      acquisitionId: result.acquisition?.id ?? null,
      acquisitionReferenceCode: result.acquisition?.referenceCode ?? null,
      costCount: result.costs.length,
      skipped: result.skipped
    };
  });

// ---------------------------------------------------------------------------
// Confirm as intake (loxep-ytu) — the `inventory_intake`-disposition sibling
// of `confirmLinesAsAcquisition` above, wrapping `@loxep/inventory`'s
// `confirmCandidatesAsIntake`. A candidate dispositioned `inventory_intake`
// becomes an ACTUAL `inventory_items` row (physical stock), never an
// `acquisition_costs` row — see that package's `confirm.ts` top doc for why
// the two dispositions now route to different tables.
// ---------------------------------------------------------------------------

export interface ConfirmLinesAsIntakeResultDto {
  /** `null` only when every candidate in the batch was skipped and no `acquisitionId` was given — nothing was written. */
  acquisitionId: string | null;
  acquisitionReferenceCode: string | null;
  itemCount: number;
  skipped: number;
}

const CONDITION_CODE_VALUES = [
  'new_sealed',
  'new_open_box',
  'like_new',
  'very_good',
  'good',
  'acceptable',
  'for_parts',
  'damaged',
  'unknown'
] as const;

export const confirmLinesAsIntake = createServerFn({ method: 'POST' })
  .inputValidator(
    z.strictObject({
      documentId: uuid,
      candidateIds: z.array(uuid).min(1),
      /** Attach to this ALREADY-existing acquisition (the lot picker's "attach" branch) instead of creating one. */
      acquisitionId: uuid.nullish(),
      /** Required to create a new acquisition — ignored when `acquisitionId` is given. */
      title: z.string().trim().min(1).nullish(),
      sourceKind: z.string().trim().min(1).nullish(),
      vendorName: z.string().trim().min(1).nullish(),
      currency: z
        .string()
        .trim()
        .regex(/^[A-Za-z]{3}$/)
        .nullish(),
      defaultCurrency: z
        .string()
        .trim()
        .regex(/^[A-Za-z]{3}$/)
        .default('USD'),
      /** Applies to every item this batch mints — see `@loxep/inventory`'s `confirm.ts` for why this is batch-level, not per-line. */
      conditionCode: z.enum(CONDITION_CODE_VALUES).default('unknown'),
      locationId: uuid.nullish()
    })
  )
  .handler(async ({ data }): Promise<ConfirmLinesAsIntakeResultDto> => {
    const { requireSession, getIntakeConfirmService } = await import('@/server/admin');
    const session = await requireSession();
    const confirmService = await getIntakeConfirmService();
    const result = await confirmService.confirmCandidatesAsIntake({
      documentId: data.documentId,
      candidateIds: data.candidateIds,
      actorUserId: session.user.id,
      ...(data.acquisitionId ? { acquisitionId: data.acquisitionId } : {}),
      ...(data.title ? { title: data.title } : {}),
      ...(data.sourceKind ? { sourceKind: data.sourceKind } : {}),
      vendorName: data.vendorName ?? null,
      ...(data.currency ? { currency: data.currency } : {}),
      defaultCurrency: data.defaultCurrency,
      conditionCode: data.conditionCode,
      locationId: data.locationId ?? null
    });
    return {
      acquisitionId: result.acquisition?.id ?? null,
      acquisitionReferenceCode: result.acquisition?.referenceCode ?? null,
      itemCount: result.items.length,
      skipped: result.skipped
    };
  });

export { DOCUMENT_STATUS_VALUES, LINE_DISPOSITION_VALUES };

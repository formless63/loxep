/**
 * The `documents` row lifecycle: create (upload or CSV), record a parser's
 * output, list the review queue, get, and discard.
 *
 * Confirmation itself lives in `candidates.ts` (`stampConfirmed`) and, one
 * layer further out, in each CONSUMING domain — this module never writes an
 * expense, an acquisition, or an inventory item, and never will (see the
 * package doc in `index.ts`).
 *
 * ## Status is derived, not assigned
 *
 * `documents.status` is recomputed from `document_line_candidates` after
 * every mutation that could change it (a line added/removed, a disposition
 * set, a confirmation stamped) — see {@link recomputeDocumentCounters},
 * exported so `candidates.ts` can call it after its own writes without a
 * circular import (`candidates.ts` imports from here; this module never
 * imports back).
 *
 * ```text
 * total = 0                              status unchanged (stays 'pending')
 * an unresolved candidate remains        'review'      (confirmedCount = 0)
 *                                        'partially_confirmed' (confirmedCount > 0)
 * no candidate is unresolved             'confirmed' — every line has left
 *                                        the unresolved set
 * ```
 *
 * A candidate is UNRESOLVED when `confirmed_at is null` AND its disposition
 * is not one of the four TERMINAL non-confirming values (`personal`,
 * `not_mine`, `duplicate`, `discarded`). This is deliberately NOT the same
 * as `disposition = 'pending'`: a CSV row the importer stages with a
 * SUGGESTED disposition of `'expense'` is still unresolved — it is a
 * proposal, not a decision, until an operator confirms it (`stampConfirmed`)
 * or overrides it to a terminal value. Reading "unresolved" as "still
 * literally pending" would mark a document `'confirmed'` the instant a CSV
 * import stages its suggestions, before a human ever looked at them — the
 * exact bug the design's "the parser proposes, it never auto-commits" rule
 * exists to prevent, one level up from the domain-write guarantee.
 * 'confirmed' means "review is done", not "every line became a domain
 * record" — a document with every line dispositioned `personal`/`not_mine`
 * reaches `'confirmed'` having produced zero domain writes, which is
 * correct: the review is complete, there was simply nothing to confirm.
 *
 * `documents.confirmed_at`/`confirmed_by_user_id` are set once, the first
 * time a document's status computes to `'confirmed'`, and never overwritten
 * by a later recompute — they answer "when did review finish", not "when was
 * the document last touched".
 */
import { createAuditService } from "@loxep/domain";
import { documentLineCandidates, documents } from "@loxep/db/schema";
import type { LoxepDb } from "@loxep/db";
import { z } from "zod";
import { DocumentsNotFoundError, DocumentsValidationError } from "./errors.ts";
import type { ParseResult } from "./parser.ts";
import { PARSEABLE_DOCUMENT_KINDS } from "./parser.ts";
import type { CsvCandidateInput } from "./csv.ts";
import { MANUAL_LINE_CONFIDENCE } from "./manual-parser.ts";
import { numericLiteral, textLiteral, uuidLiteral, uuidList } from "./sql.ts";
import { serializeSourceRegion } from "./source-region.ts";

export type DocumentRow = typeof documents.$inferSelect;
export type CandidateRow = typeof documentLineCandidates.$inferSelect;

/**
 * Reads and writes work against a handle or an open transaction alike —
 * every service factory in this package accepts either, so a consuming
 * domain can do `createCandidatesService({ db: tx }).stampConfirmed(...)`
 * inside its OWN transaction (the pattern `@loxep/domain`'s
 * `createAuditService({ db: tx })` already establishes, extended here to
 * include `transaction` itself, since `stampConfirmed` opens one of its own
 * for its read-then-write sequence — a nested transaction/savepoint when the
 * caller already has one open).
 */
export type Executor = Pick<LoxepDb, "insert" | "execute" | "query" | "transaction">;

const uuid = z.uuid();

/* ------------------------------------------------------------------ schemas */

const createFromUploadSchema = z.strictObject({
  documentKind: z.enum(PARSEABLE_DOCUMENT_KINDS),
  mediaObjectId: uuid,
  originalFilename: z.string().trim().min(1).nullish(),
  economicEntityId: uuid.nullish(),
  createdByUserId: z.string().min(1).nullish(),
});
export type CreateFromUploadInput = z.input<typeof createFromUploadSchema>;

const createFromCsvSchema = z.strictObject({
  originalFilename: z.string().trim().min(1).nullish(),
  economicEntityId: uuid.nullish(),
  createdByUserId: z.string().min(1).nullish(),
});
export type CreateFromCsvInput = z.input<typeof createFromCsvSchema>;

const discardSchema = z.strictObject({
  documentId: uuid,
  actorUserId: z.string().min(1).nullish(),
  reason: z.string().trim().min(1).nullish(),
});
export type DiscardInput = z.input<typeof discardSchema>;

/* --------------------------------------------------------------- row mapping */

function rowToDocument(row: Record<string, unknown>): DocumentRow {
  return {
    id: row["id"] as string,
    documentKind: row["document_kind"] as string,
    sourceKind: row["source_kind"] as string,
    mediaObjectId: (row["media_object_id"] as string | null) ?? null,
    originalFilename: (row["original_filename"] as string | null) ?? null,
    economicEntityId: (row["economic_entity_id"] as string | null) ?? null,
    status: row["status"] as string,
    parserId: (row["parser_id"] as string | null) ?? null,
    parsedAt: row["parsed_at"] ? new Date(row["parsed_at"] as string) : null,
    parsedText: (row["parsed_text"] as string | null) ?? null,
    // Generated (`GENERATED ALWAYS AS ... STORED`) — PostgreSQL computes it;
    // this module never writes it, and no reader of `DocumentRow` consumes
    // it directly (full-text search reads the column in SQL, not through
    // this mapper) — carried through only so `DocumentRow` stays a faithful
    // mirror of `documents.$inferSelect`.
    parsedTextTsv: (row["parsed_text_tsv"] as string | null) ?? null,
    currency: (row["currency"] as string | null) ?? null,
    documentTotal: (row["document_total"] as string | null) ?? null,
    documentDate: (row["document_date"] as string | null) ?? null,
    counterpartyName: (row["counterparty_name"] as string | null) ?? null,
    lineCount: Number(row["line_count"]),
    confirmedCount: Number(row["confirmed_count"]),
    confirmedAt: row["confirmed_at"] ? new Date(row["confirmed_at"] as string) : null,
    confirmedByUserId: (row["confirmed_by_user_id"] as string | null) ?? null,
    note: (row["note"] as string | null) ?? null,
    createdByUserId: (row["created_by_user_id"] as string | null) ?? null,
    createdAt: new Date(row["created_at"] as string),
    updatedAt: new Date(row["updated_at"] as string),
  };
}

async function loadDocument(executor: Executor, documentId: string): Promise<DocumentRow> {
  const result = await executor.execute(
    `select * from documents where id = ${uuidLiteral(documentId)}`,
  );
  const row = result.rows[0];
  if (row === undefined) {
    throw new DocumentsNotFoundError(`unknown document "${documentId}"`);
  }
  return rowToDocument(row);
}

/**
 * Recompute `line_count`/`confirmed_count`/`status` (and, on first
 * completion, `confirmed_at`/`confirmed_by_user_id`) from the candidates
 * that actually exist — one atomic statement, safe to call repeatedly and
 * from either this module or `candidates.ts`. See the module doc for the
 * status derivation table.
 */
export async function recomputeDocumentCounters(
  executor: Executor,
  documentId: string,
  actorUserId?: string | null,
): Promise<DocumentRow> {
  const actorLiteral = actorUserId ? textLiteral(actorUserId) : "null";
  const result = await executor.execute(
    `with counts as (
       select count(*)::int as total,
              count(*) filter (where confirmed_at is not null)::int as confirmed,
              -- UNRESOLVED, not literally 'disposition = pending': a staged
              -- suggestion (disposition = 'expense'/'acquisition_cost'/
              -- 'inventory_intake'/'supplies') has NOT been reviewed until it
              -- is either confirmed or dispositioned to a terminal
              -- non-confirming value. Only the four terminal dispositions
              -- (personal/not_mine/duplicate/discarded) count as resolved
              -- without a confirmation — see candidates.ts's discard()/
              -- setDisposition() doc.
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
      where d.id = ${uuidLiteral(documentId)}
      returning d.*`,
  );
  const row = result.rows[0];
  if (row === undefined) {
    throw new DocumentsNotFoundError(`unknown document "${documentId}"`);
  }
  return rowToDocument(row);
}

/* --------------------------------------------------------------- candidate inserts */

interface CandidateInsertValue {
  description: string | null;
  quantity: string | null;
  unitAmount: string | null;
  lineAmount: string | null;
  currency: string | null;
  lineDate: string | null;
  confidence: string | null;
  sourceRegion: string | null;
  rowFingerprint: string | null;
  disposition: string;
}

async function insertCandidates(
  executor: Executor,
  documentId: string,
  startingLine: number,
  values: CandidateInsertValue[],
): Promise<CandidateRow[]> {
  if (values.length === 0) return [];
  return executor
    .insert(documentLineCandidates)
    .values(
      values.map((value, index) => ({
        documentId,
        lineNumber: startingLine + index,
        rowFingerprint: value.rowFingerprint,
        description: value.description,
        quantity: value.quantity,
        unitAmount: value.unitAmount,
        lineAmount: value.lineAmount,
        currency: value.currency,
        lineDate: value.lineDate,
        confidence: value.confidence,
        sourceRegion: value.sourceRegion,
        disposition: value.disposition,
      })),
    )
    .returning();
}

/* ----------------------------------------------------------------- service */

export interface DocumentsService {
  /**
   * The upload path's entry point — creates a `source_kind = 'upload'`
   * document row referencing an ALREADY-STORED media object. Named
   * `attachMedia` in the design's function list; `createFromUpload` is the
   * same operation under the name this module's other constructors share.
   */
  createFromUpload: (input: CreateFromUploadInput) => Promise<DocumentRow>;
  attachMedia: (input: CreateFromUploadInput) => Promise<DocumentRow>;

  /** `source_kind = 'csv'`, `document_kind = 'csv_import'`, `media_object_id` stays null (a CSV import is not a document you look at). */
  createFromCsv: (input: CreateFromCsvInput) => Promise<DocumentRow>;

  /**
   * Persist a `ReceiptParser`'s output as candidates. `result.lines.length
   * === 0` (the manual-assisted backend, always) advances `parser_id`/
   * `parsed_at` and leaves the document with no candidates — the operator
   * adds them by hand through `candidates.ts`'s `addLine`.
   */
  recordParseResult: (input: {
    documentId: string;
    result: ParseResult;
  }) => Promise<{ document: DocumentRow; candidates: CandidateRow[] }>;

  /**
   * Persist already-mapped CSV rows (`csv.ts`'s `mapCsvRows` output) as
   * candidates. A row whose amount failed to normalize stages as
   * `disposition: 'pending'` (needs operator attention before it can
   * confirm); a clean row stages as `disposition: 'expense'` — a SUGGESTION,
   * never a write to `expenses`.
   */
  stageCsvRows: (input: {
    documentId: string;
    rows: CsvCandidateInput[];
  }) => Promise<{ document: DocumentRow; candidates: CandidateRow[] }>;

  /** Fingerprints, among the ones given, that already belong to a CONFIRMED candidate somewhere in this installation. Detection, never a constraint. */
  findCommittedFingerprints: (fingerprints: string[]) => Promise<Set<string>>;

  get: (documentId: string) => Promise<DocumentRow>;

  /** The review worklist: everything not `confirmed`/`discarded` by default, newest first. */
  listQueue: (filter?: { statuses?: string[] }) => Promise<DocumentRow[]>;

  /** Refuses a document with any already-confirmed candidate — discard is for throwing out a review, not for undoing a domain write. */
  discard: (input: DiscardInput) => Promise<DocumentRow>;
}

export function createDocumentsService(options: { db: Executor }): DocumentsService {
  const { db } = options;

  async function createFromUpload(input: CreateFromUploadInput): Promise<DocumentRow> {
    const value = createFromUploadSchema.parse(input);
    return db.transaction(async (tx) => {
      const rows = await tx
        .insert(documents)
        .values({
          documentKind: value.documentKind,
          sourceKind: "upload",
          mediaObjectId: value.mediaObjectId,
          originalFilename: value.originalFilename ?? null,
          economicEntityId: value.economicEntityId ?? null,
          status: "pending",
          createdByUserId: value.createdByUserId ?? null,
        })
        .returning();
      const row = rows[0];
      if (row === undefined) {
        throw new DocumentsValidationError("documents insert returned no row");
      }
      await createAuditService({ db: tx }).append({
        actorUserId: value.createdByUserId ?? null,
        action: "documents.document.created",
        resourceType: "document",
        resourceId: row.id,
        after: { documentKind: row.documentKind, sourceKind: row.sourceKind, status: row.status },
      });
      return row;
    });
  }

  return {
    createFromUpload,
    attachMedia: createFromUpload,

    createFromCsv: async (input) => {
      const value = createFromCsvSchema.parse(input);
      return db.transaction(async (tx) => {
        const rows = await tx
          .insert(documents)
          .values({
            documentKind: "csv_import",
            sourceKind: "csv",
            mediaObjectId: null,
            originalFilename: value.originalFilename ?? null,
            economicEntityId: value.economicEntityId ?? null,
            status: "pending",
            createdByUserId: value.createdByUserId ?? null,
          })
          .returning();
        const row = rows[0];
        if (row === undefined) {
          throw new DocumentsValidationError("documents insert returned no row");
        }
        await createAuditService({ db: tx }).append({
          actorUserId: value.createdByUserId ?? null,
          action: "documents.document.created",
          resourceType: "document",
          resourceId: row.id,
          after: { documentKind: row.documentKind, sourceKind: row.sourceKind, status: row.status },
        });
        return row;
      });
    },

    recordParseResult: async (input) =>
      db.transaction(async (tx) => {
        const before = await loadDocument(tx, input.documentId);
        const startingLine = before.lineCount + 1;
        const inserted = await insertCandidates(
          tx,
          input.documentId,
          startingLine,
          input.result.lines.map((line) => ({
            description: line.description,
            quantity: line.quantity,
            unitAmount: line.unitAmount,
            lineAmount: line.lineAmount,
            currency: input.result.currency,
            lineDate: null,
            confidence: line.confidence.toFixed(3),
            sourceRegion: serializeSourceRegion(line.sourceRegion),
            rowFingerprint: null,
            disposition: "pending",
          })),
        );

        await tx.execute(
          `update documents
              set parser_id = ${textLiteral(input.result.parserId)},
                  parsed_at = now(),
                  parsed_text = coalesce(${input.result.text ? textLiteral(input.result.text) : "null"}, parsed_text),
                  currency = coalesce(${input.result.currency ? textLiteral(input.result.currency) : "null"}, currency),
                  document_total = coalesce(${input.result.documentTotal ? numericLiteral(input.result.documentTotal) : "null"}, document_total),
                  updated_at = now()
            where id = ${uuidLiteral(input.documentId)}`,
        );

        const document = await recomputeDocumentCounters(tx, input.documentId);
        return { document, candidates: inserted };
      }),

    stageCsvRows: async (input) =>
      db.transaction(async (tx) => {
        const before = await loadDocument(tx, input.documentId);
        const startingLine = before.lineCount + 1;
        const inserted = await insertCandidates(
          tx,
          input.documentId,
          startingLine,
          input.rows.map((row) => ({
            // `document_line_candidates` has no `payee` column (the design's
            // own DDL) — a CSV row's payee is folded into `description`
            // rather than silently dropped, "Payee — description" when both
            // are present.
            description:
              row.payeeName && row.description
                ? `${row.payeeName} — ${row.description}`
                : (row.description ?? row.payeeName),
            quantity: null,
            unitAmount: null,
            lineAmount: row.lineAmount,
            currency: row.currency,
            lineDate: row.lineDate,
            confidence: MANUAL_LINE_CONFIDENCE.toFixed(3),
            sourceRegion: null,
            rowFingerprint: row.rowFingerprint,
            disposition:
              row.rowWarnings.length === 0 && row.lineAmount !== null ? "expense" : "pending",
          })),
        );
        const document = await recomputeDocumentCounters(tx, input.documentId);
        return { document, candidates: inserted };
      }),

    findCommittedFingerprints: async (fingerprints) => {
      if (fingerprints.length === 0) return new Set();
      const result = await db.execute(
        `select distinct row_fingerprint
           from document_line_candidates
          where confirmed_at is not null
            and row_fingerprint is not null
            and row_fingerprint in (${fingerprints.map((f) => textLiteral(f)).join(", ")})`,
      );
      return new Set(result.rows.map((row) => row["row_fingerprint"] as string));
    },

    get: async (documentId) => loadDocument(db, documentId),

    listQueue: async (filter) => {
      const statuses = filter?.statuses;
      const where =
        statuses && statuses.length > 0
          ? `where status in (${statuses.map((s) => textLiteral(s)).join(", ")})`
          : `where status <> 'confirmed' and status <> 'discarded'`;
      const result = await db.execute(
        `select * from documents ${where} order by created_at desc`,
      );
      return result.rows.map(rowToDocument);
    },

    discard: async (input) => {
      const value = discardSchema.parse(input);
      return db.transaction(async (tx) => {
        const before = await loadDocument(tx, value.documentId);
        if (before.confirmedCount > 0) {
          throw new DocumentsValidationError(
            `document "${value.documentId}" has ${before.confirmedCount} confirmed candidate(s); ` +
              "discard is for throwing out a review before anything was confirmed, not for " +
              "undoing a domain write. Individual not-yet-confirmed lines can still be " +
              "dispositioned 'discarded' one at a time.",
          );
        }
        await tx.execute(
          `update document_line_candidates
              set disposition = 'discarded', updated_at = now()
            where document_id = ${uuidLiteral(value.documentId)}
              and confirmed_at is null
              and disposition not in ('personal', 'not_mine', 'duplicate', 'discarded')`,
        );
        const noteLiteral = value.reason ? textLiteral(value.reason) : "null";
        await tx.execute(
          `update documents
              set status = 'discarded', note = coalesce(${noteLiteral}, note), updated_at = now()
            where id = ${uuidLiteral(value.documentId)}`,
        );
        const after = await loadDocument(tx, value.documentId);
        await createAuditService({ db: tx }).append({
          actorUserId: value.actorUserId ?? null,
          action: "documents.document.discarded",
          resourceType: "document",
          resourceId: value.documentId,
          before: { status: before.status },
          after: { status: after.status },
          metadata: { reason: value.reason ?? null },
        });
        return after;
      });
    },
  };
}

/** Re-exported so a caller can build an `in (...)` list without importing `sql.ts` directly. */
export { uuidList };

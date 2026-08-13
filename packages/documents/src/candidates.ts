/**
 * `document_line_candidates` — line CRUD, disposition, and the one function
 * that makes "a parse is never a fact" structural: {@link stampConfirmed}.
 *
 * ## `stampConfirmed` is the whole enforcement mechanism
 *
 * This package writes NO expense, acquisition, acquisition cost, or
 * inventory item, ever. Each consuming domain (`@loxep/accounting`,
 * `@loxep/inventory`) owns its OWN confirm function, which:
 *
 * 1. requires a non-null `actorUserId` (a Zod-required field, not merely
 *    documented as required — a call with no actor fails to type-check
 *    before it fails at runtime);
 * 2. opens ITS OWN transaction;
 * 3. writes its own domain record inside that transaction;
 * 4. calls `createCandidatesService({ db: <that same transaction> }).stampConfirmed(...)`
 *    — the same "re-instantiate a service against an open transaction"
 *    pattern `@loxep/domain`'s `createAuditService({ db: tx })` already
 *    establishes — so the domain write and the stamp commit or roll back
 *    together.
 *
 * A background job (Graphile Worker) has no session and therefore no actor
 * id to pass at step 1. That is not a convention this module asks callers
 * to respect — it is why a worker task PHYSICALLY CANNOT confirm anything:
 * there is no code path from a job handler to a non-null `actorUserId`.
 *
 * `stampConfirmed` itself writes ONLY `document_line_candidates.confirmed_at`
 * / `confirmed_by_user_id` / `target_kind` / `target_id`, plus the document's
 * derived counters via `recomputeDocumentCounters` — never a domain table.
 */
import { createAuditService } from "@loxep/domain";
import { documentLineCandidates } from "@loxep/db/schema";
import { z } from "zod";
import { CANDIDATE_TARGET_KINDS, LINE_DISPOSITIONS } from "@loxep/db/schema";
import {
  DocumentNotEditableError,
  DocumentsConflictError,
  DocumentsNotFoundError,
} from "./errors.ts";
import type { CandidateRow, Executor } from "./documents.ts";
import { recomputeDocumentCounters } from "./documents.ts";
import { MANUAL_LINE_CONFIDENCE } from "./manual-parser.ts";
import { textLiteral, uuidLiteral } from "./sql.ts";

const uuid = z.uuid();
const decimalString = z.string().regex(/^-?\d+(\.\d+)?$/, "expected a plain decimal string");
const calendarDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "expected YYYY-MM-DD");

const addLineSchema = z.strictObject({
  documentId: uuid,
  description: z.string().trim().min(1).nullish(),
  quantity: decimalString.nullish(),
  unitAmount: decimalString.nullish(),
  lineAmount: decimalString.nullish(),
  currency: z
    .string()
    .trim()
    .regex(/^[A-Za-z]{3}$/)
    .nullish(),
  lineDate: calendarDate.nullish(),
  disposition: z.enum(LINE_DISPOSITIONS).default("pending"),
  note: z.string().trim().min(1).nullish(),
});
export type AddLineInput = z.input<typeof addLineSchema>;

const updateLineSchema = z.strictObject({
  candidateId: uuid,
  description: z.string().trim().min(1).nullish(),
  quantity: decimalString.nullish(),
  unitAmount: decimalString.nullish(),
  lineAmount: decimalString.nullish(),
  currency: z
    .string()
    .trim()
    .regex(/^[A-Za-z]{3}$/)
    .nullish(),
  lineDate: calendarDate.nullish(),
  note: z.string().trim().min(1).nullish(),
});
export type UpdateLineInput = z.input<typeof updateLineSchema>;

const setDispositionSchema = z.strictObject({
  candidateId: uuid,
  disposition: z.enum(LINE_DISPOSITIONS),
  note: z.string().trim().min(1).nullish(),
  actorUserId: z.string().min(1).nullish(),
});
export type SetDispositionInput = z.input<typeof setDispositionSchema>;

const bulkSetDispositionSchema = z.strictObject({
  candidateIds: z.array(uuid).min(1),
  disposition: z.enum(LINE_DISPOSITIONS),
  actorUserId: z.string().min(1).nullish(),
});
export type BulkSetDispositionInput = z.input<typeof bulkSetDispositionSchema>;

/** `actorUserId` is REQUIRED — see the module doc. This is the enforcement, not a convention. */
const stampConfirmedSchema = z.strictObject({
  candidateId: uuid,
  targetKind: z.enum(CANDIDATE_TARGET_KINDS),
  targetId: uuid,
  actorUserId: z.string().min(1),
});
export type StampConfirmedInput = z.input<typeof stampConfirmedSchema>;

async function loadCandidate(executor: Executor, candidateId: string): Promise<CandidateRow> {
  const result = await executor.execute(
    `select * from document_line_candidates where id = ${uuidLiteral(candidateId)}`,
  );
  const row = result.rows[0];
  if (row === undefined) {
    throw new DocumentsNotFoundError(`unknown document line candidate "${candidateId}"`);
  }
  return rowToCandidate(row);
}

function rowToCandidate(row: Record<string, unknown>): CandidateRow {
  return {
    id: row["id"] as string,
    documentId: row["document_id"] as string,
    lineNumber: Number(row["line_number"]),
    rowFingerprint: (row["row_fingerprint"] as string | null) ?? null,
    description: (row["description"] as string | null) ?? null,
    quantity: (row["quantity"] as string | null) ?? null,
    unitAmount: (row["unit_amount"] as string | null) ?? null,
    lineAmount: (row["line_amount"] as string | null) ?? null,
    currency: (row["currency"] as string | null) ?? null,
    lineDate: (row["line_date"] as string | null) ?? null,
    confidence: (row["confidence"] as string | null) ?? null,
    sourceRegion: (row["source_region"] as string | null) ?? null,
    disposition: row["disposition"] as string,
    targetKind: (row["target_kind"] as string | null) ?? null,
    targetId: (row["target_id"] as string | null) ?? null,
    confirmedAt: row["confirmed_at"] ? new Date(row["confirmed_at"] as string) : null,
    confirmedByUserId: (row["confirmed_by_user_id"] as string | null) ?? null,
    note: (row["note"] as string | null) ?? null,
    createdAt: new Date(row["created_at"] as string),
    updatedAt: new Date(row["updated_at"] as string),
  };
}

/**
 * PostgreSQL's `document_line_candidates_document_id_line_number_uq`
 * unique-violation (SQLSTATE `23505`), whether it arrives as the raw driver
 * error or wrapped in drizzle-orm's own error via `Error.cause` (its
 * `NodePgSession` wraps every query failure in a `DrizzleQueryError` that
 * chains the original `pg` `DatabaseError` as `.cause`).
 */
function isLineNumberConflictError(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 4 && current !== null && typeof current === "object"; depth += 1) {
    const candidate = current as { code?: unknown; constraint?: unknown; cause?: unknown };
    if (
      candidate.code === "23505" &&
      candidate.constraint === "document_line_candidates_document_id_line_number_uq"
    ) {
      return true;
    }
    current = candidate.cause;
  }
  return false;
}

function assertEditable(candidate: CandidateRow): void {
  if (candidate.confirmedAt !== null) {
    throw new DocumentNotEditableError(
      `document line candidate "${candidate.id}" is already confirmed (into ` +
        `${candidate.targetKind} "${candidate.targetId}"); a confirmed line is evidence of a ` +
        "domain write and is never edited in place.",
    );
  }
}

export interface CandidatesService {
  list: (documentId: string) => Promise<CandidateRow[]>;
  get: (candidateId: string) => Promise<CandidateRow>;
  /** Manual transcription — always `confidence: 1.0`, a human typed it. */
  addLine: (input: AddLineInput) => Promise<CandidateRow>;
  /** Refuses a confirmed candidate. */
  updateLine: (input: UpdateLineInput) => Promise<CandidateRow>;
  /** Refuses a confirmed candidate. */
  removeLine: (input: { candidateId: string; actorUserId?: string | null }) => Promise<void>;
  /** Refuses a confirmed candidate — disposition is the operator's INTENT, fixed once confirmed. */
  setDisposition: (input: SetDispositionInput) => Promise<CandidateRow>;
  /** Confirmed candidates in the batch are silently skipped, not errored. */
  bulkSetDisposition: (
    input: BulkSetDispositionInput,
  ) => Promise<{ updated: number; skipped: number }>;
  /**
   * Called by a CONSUMING domain's confirm function, inside that function's
   * OWN transaction, after it writes its own domain record. Idempotent when
   * called again with the SAME target; refuses a different target for an
   * already-confirmed candidate (a candidate confirms into exactly one
   * record, forever).
   */
  stampConfirmed: (input: StampConfirmedInput) => Promise<CandidateRow>;
}

export function createCandidatesService(options: { db: Executor }): CandidatesService {
  const { db } = options;

  return {
    list: async (documentId) => {
      const result = await db.execute(
        `select * from document_line_candidates
          where document_id = ${uuidLiteral(documentId)}
          order by line_number asc`,
      );
      return result.rows.map(rowToCandidate);
    },

    get: async (candidateId) => loadCandidate(db, candidateId),

    addLine: async (input) => {
      const value = addLineSchema.parse(input);
      // `line_number` is assigned by a read-then-insert against
      // `document_line_candidates_document_id_line_number_uq` — two
      // concurrent `addLine` calls on the SAME document can both read the
      // same "next" number under READ COMMITTED. Rather than serialize every
      // add behind an explicit lock (paid on every call for a race that is
      // rare — one operator transcribing one document), retry on the
      // specific unique-violation a handful of times, mirroring the
      // `withCodeRetry` pattern `@loxep/accounting`/`@loxep/inventory` use
      // for reference-code minting.
      const MAX_ATTEMPTS = 5;
      for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
        try {
          return await db.transaction(async (tx) => {
            const nextLine = await tx.execute(
              `select coalesce(max(line_number), 0) + 1 as next_line
                 from document_line_candidates where document_id = ${uuidLiteral(value.documentId)}`,
            );
            const lineNumber = Number(nextLine.rows[0]?.["next_line"] ?? 1);
            const inserted = await tx
              .insert(documentLineCandidates)
              .values({
                documentId: value.documentId,
                lineNumber,
                description: value.description ?? null,
                quantity: value.quantity ?? null,
                unitAmount: value.unitAmount ?? null,
                lineAmount: value.lineAmount ?? null,
                currency: value.currency ? value.currency.toUpperCase() : null,
                lineDate: value.lineDate ?? null,
                confidence: MANUAL_LINE_CONFIDENCE.toFixed(3),
                disposition: value.disposition,
                note: value.note ?? null,
              })
              .returning();
            const row = inserted[0];
            if (row === undefined) {
              throw new DocumentsConflictError("document_line_candidates insert returned no row");
            }
            await recomputeDocumentCounters(tx, value.documentId);
            return row;
          });
        } catch (error) {
          if (!isLineNumberConflictError(error) || attempt === MAX_ATTEMPTS) throw error;
        }
      }
      throw new DocumentsConflictError("addLine: exhausted retries assigning a line number");
    },

    updateLine: async (input) => {
      const value = updateLineSchema.parse(input);
      return db.transaction(async (tx) => {
        const before = await loadCandidate(tx, value.candidateId);
        assertEditable(before);

        const assignments: string[] = ["updated_at = now()"];
        if (value.description !== undefined) {
          assignments.push(
            `description = ${value.description === null ? "null" : textLiteral(value.description)}`,
          );
        }
        if (value.quantity !== undefined) {
          assignments.push(
            `quantity = ${value.quantity === null ? "null" : `${value.quantity}::numeric(20,6)`}`,
          );
        }
        if (value.unitAmount !== undefined) {
          assignments.push(
            `unit_amount = ${value.unitAmount === null ? "null" : `${value.unitAmount}::numeric(20,6)`}`,
          );
        }
        if (value.lineAmount !== undefined) {
          assignments.push(
            `line_amount = ${value.lineAmount === null ? "null" : `${value.lineAmount}::numeric(20,6)`}`,
          );
        }
        if (value.currency !== undefined) {
          assignments.push(
            `currency = ${value.currency === null ? "null" : textLiteral(value.currency.toUpperCase())}`,
          );
        }
        if (value.lineDate !== undefined) {
          assignments.push(
            `line_date = ${value.lineDate === null ? "null" : `'${value.lineDate}'::date`}`,
          );
        }
        if (value.note !== undefined) {
          assignments.push(`note = ${value.note === null ? "null" : textLiteral(value.note)}`);
        }

        await tx.execute(
          `update document_line_candidates set ${assignments.join(", ")}
            where id = ${uuidLiteral(before.id)}`,
        );
        return loadCandidate(tx, before.id);
      });
    },

    removeLine: async (input) => {
      await db.transaction(async (tx) => {
        const before = await loadCandidate(tx, input.candidateId);
        assertEditable(before);
        await tx.execute(
          `delete from document_line_candidates where id = ${uuidLiteral(before.id)}`,
        );
        await recomputeDocumentCounters(tx, before.documentId, input.actorUserId ?? null);
      });
    },

    setDisposition: async (input) => {
      const value = setDispositionSchema.parse(input);
      return db.transaction(async (tx) => {
        const before = await loadCandidate(tx, value.candidateId);
        assertEditable(before);
        const noteLiteral = value.note ? textLiteral(value.note) : "note";
        await tx.execute(
          `update document_line_candidates
              set disposition = ${textLiteral(value.disposition)},
                  note = ${noteLiteral},
                  updated_at = now()
            where id = ${uuidLiteral(before.id)}`,
        );
        await recomputeDocumentCounters(tx, before.documentId, value.actorUserId ?? null);
        return loadCandidate(tx, before.id);
      });
    },

    bulkSetDisposition: async (input) => {
      const value = bulkSetDispositionSchema.parse(input);
      return db.transaction(async (tx) => {
        const idList = value.candidateIds.map((id) => uuidLiteral(id)).join(", ");
        const result = await tx.execute(
          `update document_line_candidates
              set disposition = ${textLiteral(value.disposition)}, updated_at = now()
            where id in (${idList}) and confirmed_at is null
          returning document_id`,
        );
        const documentIds = new Set(result.rows.map((row) => row["document_id"] as string));
        for (const documentId of documentIds) {
          await recomputeDocumentCounters(tx, documentId, value.actorUserId ?? null);
        }
        return {
          updated: result.rows.length,
          skipped: value.candidateIds.length - result.rows.length,
        };
      });
    },

    stampConfirmed: async (input) => {
      const value = stampConfirmedSchema.parse(input);
      return db.transaction(async (tx) => {
        const before = await loadCandidate(tx, value.candidateId);
        if (before.confirmedAt !== null) {
          if (before.targetKind === value.targetKind && before.targetId === value.targetId) {
            // Same confirmation, called again — idempotent no-op (the
            // design's "same document confirmed twice" acceptance case).
            return before;
          }
          throw new DocumentsConflictError(
            `document line candidate "${before.id}" is already confirmed into ` +
              `${before.targetKind} "${before.targetId}"; it cannot also confirm into ` +
              `${value.targetKind} "${value.targetId}" — a candidate confirms into exactly one record.`,
          );
        }
        await tx.execute(
          `update document_line_candidates
              set confirmed_at = now(),
                  confirmed_by_user_id = ${textLiteral(value.actorUserId)},
                  target_kind = ${textLiteral(value.targetKind)},
                  target_id = ${uuidLiteral(value.targetId)},
                  updated_at = now()
            where id = ${uuidLiteral(before.id)}`,
        );
        await recomputeDocumentCounters(tx, before.documentId, value.actorUserId);
        const after = await loadCandidate(tx, before.id);
        await createAuditService({ db: tx }).append({
          actorUserId: value.actorUserId,
          action: "documents.candidate.confirmed",
          resourceType: "document_line_candidate",
          resourceId: after.id,
          after: { targetKind: after.targetKind, targetId: after.targetId },
          metadata: { documentId: after.documentId, disposition: after.disposition },
        });
        return after;
      });
    },
  };
}

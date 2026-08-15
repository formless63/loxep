/**
 * `confirmCandidatesAsAcquisition` — the M6 counterpart to
 * `@loxep/accounting`'s `confirmCandidatesAsExpense`
 * (`expense-entry-design.md` section 4, "How a line reaches inventory — and
 * the rule that stops it"). Closes the gap Phase 9's M4 flagged as
 * deliberately unshipped: `CONFIRMABLE_DISPOSITIONS`
 * (`@/features/documents/constants.ts`) only ever wrote `expenses`, and a
 * candidate dispositioned `acquisition_cost`/`inventory_intake` had nowhere
 * to go.
 *
 * ## The seam this function is not allowed to loosen
 *
 * `flipping-lifecycle-design.md`'s "acquisition seam": money that bought
 * goods for resale becomes an `acquisition` plus `acquisition_costs`, and
 * NEVER an `expenses` row — otherwise the same dollar is deducted once as an
 * expense and again as COGS at sale. A candidate dispositioned
 * `acquisition_cost` or `inventory_intake` therefore never reaches
 * `@loxep/accounting`; it reaches here, and becomes a capitalized cost row
 * against a lot, new or existing.
 *
 * ## Why this file duplicates the candidate-stamp/counter/event plumbing
 *
 * Same reasoning as `@loxep/accounting`'s `confirm.ts`, which this module
 * mirrors closely: `@loxep/documents` must continue to depend on NEITHER
 * `@loxep/accounting` NOR `@loxep/inventory` (the inversion is the
 * enforcement mechanism for the never-auto-commit rule, and a cycle here
 * would be the signal to merge packages, which would be wrong), so this
 * package does not take that dependency edge either — adding it is outside
 * this milestone's write fence. `document_line_candidates`/`documents` are
 * read and written directly through `@loxep/db`'s schema and query builder,
 * exactly the layer `@loxep/documents` itself is built on, and the three
 * local helpers below (`stampCandidateConfirmed`, `recomputeDocumentCounters`,
 * `emitDocumentConfirmed`) reproduce `@loxep/documents`'s `stampConfirmed`/
 * `recomputeDocumentCounters` and the `document_confirmed` notification. A
 * future pass that adds the dependency edge can delete these three helpers
 * and call the real services with no behaviour change.
 *
 * ## Where a candidate lands
 *
 * `target_kind = 'acquisition'`, `target_id = <the acquisition>` — NOT
 * `acquisition_cost`, even though each confirmed candidate becomes exactly
 * one `acquisition_costs` row. `acquisition_costs` carries no
 * `document_line_candidate_id` column (this milestone ships no migration —
 * see the module's own "no migration" constraint), so the stamp is the only
 * trace of the confirmation, and it points at the record an operator can
 * actually navigate to (`/inventory/acquisitions/$id`) — mirroring
 * `confirmCandidatesAsExpense`'s own choice of `target_id = expense.id`,
 * never a line id.
 *
 * ## The lot picker's two branches, both handled by ONE function
 *
 * `acquisitionId` given -> attach to that ALREADY-existing acquisition
 * (costs are added to it; it must not be `cancelled`). `acquisitionId`
 * omitted -> CREATE a new draft acquisition from `title`/`sourceKind`/etc,
 * defaulting `vendorName`/`currency`/`acquiredAt` from the source document
 * exactly as `confirmCandidatesAsExpense` defaults an expense's
 * payee/currency/date from it.
 *
 * ## Cost mapping (design build note 4)
 *
 * `description -> description`, `line_amount -> amount`,
 * `cost_class = 'goods'`, `capitalize = true` — every confirmed candidate,
 * whatever its own disposition among the two acceptable ones, becomes a
 * capitalized goods cost. No freight-splitting policy is invented here
 * (Phase 9 OQ9): the acquisition's own `allocateCosts` engine already does
 * the "allocate only across lines that became stock, capitalize=false
 * remainder" work, and duplicating it here would be a second policy for one
 * rule.
 *
 * ## The never-auto-commit rule, enforced here the same way
 *
 * `actorUserId` is a REQUIRED, non-nullable Zod field, exactly like
 * `confirmCandidatesAsExpense` — a Graphile Worker task has no session and
 * therefore no actor id to pass, so there is no code path from a job handler
 * to this function succeeding.
 */
import {
  createAuditService,
  createTransactionalNotificationEnqueue,
  publishNotificationEvent,
} from "@loxep/domain";
import type { LoxepDb } from "@loxep/db";
import { mediaLinks } from "@loxep/db/schema";
import { z } from "zod";
import {
  createAcquisitionsService,
  type AcquisitionCostRow,
  type AcquisitionRow,
  type CreateAcquisitionInput,
} from "./acquisitions.ts";
import { isUniqueViolation } from "./codes.ts";
import {
  InventoryConflictError,
  InventoryNotFoundError,
  InventoryValidationError,
} from "./errors.ts";
import { textLiteral, uuidLiteral } from "./sql.ts";

/**
 * `media_links.resource_type`/`purpose` for an acquisition's evidence.
 * Re-declared locally rather than added to `@loxep/db/schema` — this
 * package's own house style (`acquisitions.ts`'s `sourceKinds`, `sql.ts`'s
 * module doc) of owning small literal unions rather than reaching into
 * another package's schema module for one string, and `packages/db/**` is
 * outside this milestone's write fence. `resource_type`/`purpose` are plain
 * `text` columns with no `CHECK` (migration 0004), so this needs no DDL:
 * `flipping-lifecycle-design.md`'s relationship overview reserved
 * `media_links(resource_type ∈ {acquisition, inventory_item, shipment})`
 * for exactly this case, and this is the first writer of the `acquisition`
 * value.
 */
const ACQUISITION_MEDIA_RESOURCE_TYPE = "acquisition";
const ACQUISITION_INVOICE_PURPOSE = "invoice";

/** Candidate dispositions this confirm accepts — the sibling of `@loxep/accounting/confirm.ts`'s `CONFIRMABLE_DISPOSITIONS` for `expense`/`supplies`. */
const CONFIRMABLE_AS_ACQUISITION_DISPOSITIONS = new Set([
  "acquisition_cost",
  "inventory_intake",
]);

const currencyCode = z
  .string()
  .trim()
  .regex(/^[A-Za-z]{3}$/, "expected ISO-4217");
const calendarDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "expected YYYY-MM-DD");

const confirmInputSchema = z.strictObject({
  documentId: z.uuid(),
  candidateIds: z.array(z.uuid()).min(1),
  actorUserId: z.string().min(1),
  requestId: z.string().min(1).nullish(),

  /** When given, attach to this ALREADY-existing acquisition instead of creating one — the lot picker's "attach to an existing open lot" branch. */
  acquisitionId: z.uuid().optional(),

  /** Required to CREATE a new acquisition (ignored when `acquisitionId` is given). */
  title: z.string().trim().min(1).optional(),
  /** Validated against the real enum inside `acquisitionsService.create` — not re-declared here, matching this file's own "re-declare small unions, not whole enums twice" line. Defaults to `'other'`. */
  sourceKind: z.string().trim().min(1).optional(),
  vendorName: z.string().trim().min(1).nullish(),
  currency: currencyCode.optional(),
  defaultCurrency: currencyCode.default("USD"),
  economicEntityId: z.uuid().nullish(),
  acquiredAt: calendarDate.optional(),
  notes: z.string().trim().min(1).nullish(),
});
export type ConfirmCandidatesAsAcquisitionInput = z.input<typeof confirmInputSchema>;

export interface ConfirmCandidatesAsAcquisitionResult {
  /** `null` only when attaching to nothing new AND every candidate was skipped — nothing was written. */
  acquisition: AcquisitionRow | null;
  costs: AcquisitionCostRow[];
  skipped: number;
}

export interface AcquisitionConfirmService {
  confirmCandidatesAsAcquisition: (
    input: ConfirmCandidatesAsAcquisitionInput,
  ) => Promise<ConfirmCandidatesAsAcquisitionResult>;
}

/** Matches `@loxep/accounting/confirm.ts`'s own `parse` — a Zod failure surfaces as this package's own error type, not a raw `ZodError`. */
function parse<T extends z.ZodType>(schema: T, input: unknown): z.output<T> {
  const parsed = schema.safeParse(input);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("; ");
    throw new InventoryValidationError(
      `invalid confirm-candidates-as-acquisition input: ${issues}`,
    );
  }
  return parsed.data;
}

function dateFromCalendarDate(value: string): Date {
  return new Date(`${value}T00:00:00.000Z`);
}

/**
 * `stampConfirmed`'s update, reproduced — see the module doc's "why this
 * file duplicates" section. Idempotent the same way `confirmCandidatesAsExpense`
 * is: a candidate already confirmed (into ANY target) is unconfirmable here
 * and the caller counts it as skipped rather than re-stamping or erroring.
 */
async function stampCandidateConfirmed(
  tx: LoxepDb,
  candidateId: string,
  acquisitionId: string,
  actorUserId: string,
  documentId: string,
  disposition: string,
): Promise<void> {
  await tx.execute(
    `update document_line_candidates
        set confirmed_at = now(),
            confirmed_by_user_id = ${textLiteral(actorUserId)},
            target_kind = 'acquisition',
            target_id = ${uuidLiteral(acquisitionId)},
            updated_at = now()
      where id = ${uuidLiteral(candidateId)}`,
  );
  await createAuditService({ db: tx }).append({
    actorUserId,
    action: "documents.candidate.confirmed",
    resourceType: "document_line_candidate",
    resourceId: candidateId,
    after: { targetKind: "acquisition", targetId: acquisitionId },
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

/** Mirrors `@loxep/accounting/confirm.ts`'s `emitDocumentConfirmed` — see that function's own doc for the SAVEPOINT/deduplication reasoning. */
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

/**
 * Attaches the document's evidence file to the acquisition as `purpose =
 * 'invoice'` — the acquisition-side sibling of `ReceiptsService.attach`/
 * `InventoryMediaService.attach`, written directly against `media_links`
 * (see the module doc for why this package does not reach for
 * `@loxep/storage`'s `MediaService`: it is not a dependency of
 * `@loxep/inventory`, matching `media.ts`'s own precedent). Idempotent on
 * migration 0004's natural key, same as both of those.
 */
async function attachAcquisitionMedia(
  tx: LoxepDb,
  acquisitionId: string,
  mediaObjectId: string,
  actorUserId: string,
): Promise<void> {
  try {
    await tx.insert(mediaLinks).values({
      mediaObjectId,
      resourceType: ACQUISITION_MEDIA_RESOURCE_TYPE,
      resourceId: acquisitionId,
      purpose: ACQUISITION_INVOICE_PURPOSE,
    });
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
    // Already attached — the 0004 natural key fired, matching every other
    // idempotent attach in this codebase.
    return;
  }
  await createAuditService({ db: tx }).append({
    actorUserId,
    action: "inventory.acquisition.media_attached",
    resourceType: "acquisition",
    resourceId: acquisitionId,
    after: { mediaObjectId, purpose: ACQUISITION_INVOICE_PURPOSE },
  });
}

export function createAcquisitionConfirmService(options: {
  db: LoxepDb;
}): AcquisitionConfirmService {
  const { db } = options;

  return {
    confirmCandidatesAsAcquisition: async (input) => {
      const value = parse(confirmInputSchema, input);

      return db.transaction(async (tx) => {
        const acquisitionsService = createAcquisitionsService({ db: tx });

        const documentRow = await tx.query.documents.findFirst({
          where: (table, { eq }) => eq(table.id, value.documentId),
          columns: {
            currency: true,
            documentDate: true,
            mediaObjectId: true,
            counterpartyName: true,
            economicEntityId: true,
          },
        });
        if (documentRow === undefined) {
          throw new InventoryNotFoundError(`unknown document "${value.documentId}"`);
        }

        const confirmable: {
          id: string;
          description: string | null;
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
          if (!CONFIRMABLE_AS_ACQUISITION_DISPOSITIONS.has(candidate.disposition)) {
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
            lineAmount: candidate.lineAmount,
            lineDate: candidate.lineDate,
            disposition: candidate.disposition,
          });
        }

        if (confirmable.length === 0 && value.acquisitionId === undefined) {
          return { acquisition: null, costs: [], skipped };
        }

        let acquisition: AcquisitionRow;
        if (value.acquisitionId !== undefined) {
          acquisition = await acquisitionsService.get(value.acquisitionId);
          if (acquisition.status === "cancelled") {
            throw new InventoryConflictError(
              `cannot confirm candidates into "${acquisition.referenceCode}": it is cancelled. ` +
                "Pick a different lot, or create a new draft.",
            );
          }
        } else {
          if (value.title === undefined) {
            throw new InventoryValidationError(
              "confirmCandidatesAsAcquisition: title is required to create a new acquisition " +
                "(omit it only when passing an existing acquisitionId)",
            );
          }
          acquisition = await acquisitionsService.create({
            title: value.title,
            // Validated against the real enum inside `create` — a bad value
            // throws `InventoryValidationError` from there with a clear
            // message; this file does not re-declare the enum a third time.
            sourceKind: (value.sourceKind ?? "other") as CreateAcquisitionInput["sourceKind"],
            currency: value.currency ?? documentRow.currency ?? value.defaultCurrency,
            vendorName: value.vendorName ?? documentRow.counterpartyName ?? null,
            economicEntityId: value.economicEntityId ?? documentRow.economicEntityId ?? null,
            ...(value.acquiredAt !== undefined
              ? { acquiredAt: dateFromCalendarDate(value.acquiredAt) }
              : documentRow.documentDate !== null
                ? { acquiredAt: dateFromCalendarDate(documentRow.documentDate) }
                : {}),
            notes: value.notes ?? null,
            createdByUserId: value.actorUserId,
          });
        }

        const costs: AcquisitionCostRow[] = [];
        for (const candidate of confirmable) {
          const cost = await acquisitionsService.addCost({
            acquisitionId: acquisition.id,
            costType: "goods",
            costClass: "goods",
            amount: candidate.lineAmount,
            capitalize: true,
            description: candidate.description,
            currency: acquisition.currency,
            incurredAt: candidate.lineDate ? dateFromCalendarDate(candidate.lineDate) : null,
            createdByUserId: value.actorUserId,
          });
          costs.push(cost);
        }

        if (costs.length > 0) {
          await createAuditService({ db: tx }).append({
            actorUserId: value.actorUserId,
            action: "inventory.acquisition.costs_confirmed_from_candidates",
            resourceType: "acquisition",
            resourceId: acquisition.id,
            after: { costCount: costs.length, candidateIds: confirmable.map((c) => c.id) },
            requestId: value.requestId ?? null,
            metadata: { referenceCode: acquisition.referenceCode, documentId: value.documentId },
          });
        }

        // The document's own evidence file (if any) attaches to the
        // acquisition every candidate confirmed out of it lands on — the
        // `confirmCandidatesAsExpense`/loxep-4mg precedent, applied to the
        // acquisition side (flipping-lifecycle-design.md, "Where a receipt
        // attaches when the spend was a purchase").
        if (documentRow.mediaObjectId !== null) {
          await attachAcquisitionMedia(
            tx,
            acquisition.id,
            documentRow.mediaObjectId,
            value.actorUserId,
          );
        }

        for (const candidate of confirmable) {
          await stampCandidateConfirmed(
            tx,
            candidate.id,
            acquisition.id,
            value.actorUserId,
            value.documentId,
            candidate.disposition,
          );
        }

        await recomputeDocumentCounters(tx, value.documentId, value.actorUserId);
        await emitDocumentConfirmed(tx, value.documentId);

        return { acquisition, costs, skipped };
      });
    },
  };
}

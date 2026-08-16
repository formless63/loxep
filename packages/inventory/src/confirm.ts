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
 * This module also ships `confirmCandidatesAsIntake` (loxep-ytu, the tail of
 * this same epic) — the sibling that turns an `inventory_intake`-dispositioned
 * candidate into an ACTUAL `inventory_items` row, physical stock, rather than
 * a money fact. Before this pass, `CONFIRMABLE_AS_ACQUISITION_DISPOSITIONS`
 * routed BOTH `acquisition_cost` and `inventory_intake` through
 * `confirmCandidatesAsAcquisition`, treating an intake line as nothing more
 * than another cost row — which made `document_line_candidates`'s own
 * `target_kind` CHECK constraint's fourth member, `'inventory_item'`, dead
 * schema: reserved since migration 0017, never written. `inventory_intake`
 * is now EXCLUSIVELY `confirmCandidatesAsIntake`'s to confirm; a document's
 * "3 x shelving unit, $89 each" line becomes one `inventory_items` row with
 * `quantity = 3` — matching the design's connective field table exactly
 * (`inventory_items.quantity` ← candidate `quantity`) — while an
 * `acquisition_cost`-dispositioned line (freight, tax, a lump-sum lot price
 * the operator does not want itemized) still becomes an `acquisition_costs`
 * row via `confirmCandidatesAsAcquisition`. Both can appear on one receipt
 * and both target the SAME lot; each confirm stays homogeneous to its own
 * target, matching this file's own "mixing forbidden per batch" discipline.
 *
 * `confirmCandidatesAsIntake` does NOT also write an `acquisition_costs` row
 * for the item's own price — it seeds `inventory_items.acquisition_cost_amount`
 * directly from the candidate's `line_amount`, mirroring the ALREADY-SHIPPED
 * `createAcquisitionFromMarketItem` precedent (`apps/web/src/server/
 * inventory-functions.ts`: `goodsCostAmount` → `itemsService.create`'s
 * `acquisitionCostAmount`, no paired cost row). Writing both would double the
 * dollar the next time `AcquisitionsService.allocateCosts` runs: that engine
 * spreads a lot's `acquisition_costs` pool across every unlocked item, so an
 * item that already carries its own price directly must not ALSO have that
 * same price sitting in the pool waiting to be spread across it (and its
 * lot-mates) a second time. `acquisitionCostAmount` seeded here is therefore
 * provisional in exactly the way the manual "add item to intake" form's own
 * same-named field already is — the operator-facing precedent, not a new
 * one — and `allocateCosts` remains the one authority that reconciles it
 * against whatever the lot's OTHER (non-item-scoped) costs turn out to be.
 *
 * ## The seam this function is not allowed to loosen
 *
 * `flipping-lifecycle-design.md`'s "acquisition seam": money that bought
 * goods for resale becomes an `acquisition` plus `acquisition_costs`, and
 * NEVER an `expenses` row — otherwise the same dollar is deducted once as an
 * expense and again as COGS at sale. A candidate dispositioned
 * `acquisition_cost` or `inventory_intake` therefore never reaches
 * `@loxep/accounting`; it reaches here, and becomes either a capitalized cost
 * row against a lot (`acquisition_cost`) or an actual stock row
 * (`inventory_intake`), new lot or existing.
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
  type AcquisitionsService,
  type CreateAcquisitionInput,
} from "./acquisitions.ts";
import { isUniqueViolation } from "./codes.ts";
import { compareDecimals } from "./decimal.ts";
import {
  InventoryConflictError,
  InventoryNotFoundError,
  InventoryValidationError,
} from "./errors.ts";
import { createItemsService, type InventoryItemRow } from "./items.ts";
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

/**
 * Candidate dispositions `confirmCandidatesAsAcquisition` accepts — the
 * sibling of `@loxep/accounting/confirm.ts`'s `CONFIRMABLE_DISPOSITIONS` for
 * `expense`/`supplies`. `inventory_intake` moved OUT to
 * `CONFIRMABLE_AS_INTAKE_DISPOSITIONS` below (loxep-ytu) — see this module's
 * top doc for why the two dispositions now route to different tables.
 */
const CONFIRMABLE_AS_ACQUISITION_DISPOSITIONS = new Set(["acquisition_cost"]);

/** Candidate dispositions `confirmCandidatesAsIntake` accepts — physical stock, never a cost row. */
const CONFIRMABLE_AS_INTAKE_DISPOSITIONS = new Set(["inventory_intake"]);

/** `inventory_items.condition_code` — closed, `CHECK`ed (`@loxep/db/schema/inventory.ts`). Re-declared, matching this file's own "re-declare small unions" precedent rather than importing `items.ts`'s private `conditionCodes`. */
const CONDITION_CODES = [
  "new_sealed",
  "new_open_box",
  "like_new",
  "very_good",
  "good",
  "acceptable",
  "for_parts",
  "damaged",
  "unknown",
] as const;

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
function parse<T extends z.ZodType>(
  schema: T,
  input: unknown,
  label = "confirm-candidates-as-acquisition",
): z.output<T> {
  const parsed = schema.safeParse(input);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("; ");
    throw new InventoryValidationError(`invalid ${label} input: ${issues}`);
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
 *
 * `targetKind` is a parameter (not hardcoded `'acquisition'`) so both
 * confirm functions in this module share one stamp helper:
 * `confirmCandidatesAsAcquisition` stamps `'acquisition'` (an
 * `acquisition_costs` row carries no `document_line_candidate_id` column, so
 * the stamp points at the navigable acquisition instead — see that
 * function's own doc), `confirmCandidatesAsIntake` stamps `'inventory_item'`
 * directly at the record it created, since `inventory_items` needs no such
 * workaround.
 */
async function stampCandidateConfirmed(
  tx: LoxepDb,
  candidateId: string,
  targetKind: string,
  targetId: string,
  actorUserId: string,
  documentId: string,
  disposition: string,
): Promise<void> {
  await tx.execute(
    `update document_line_candidates
        set confirmed_at = now(),
            confirmed_by_user_id = ${textLiteral(actorUserId)},
            target_kind = ${textLiteral(targetKind)},
            target_id = ${uuidLiteral(targetId)},
            updated_at = now()
      where id = ${uuidLiteral(candidateId)}`,
  );
  await createAuditService({ db: tx }).append({
    actorUserId,
    action: "documents.candidate.confirmed",
    resourceType: "document_line_candidate",
    resourceId: candidateId,
    after: { targetKind, targetId },
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

/**
 * The lot picker's two branches, shared by BOTH confirm functions in this
 * module (`confirmCandidatesAsAcquisition` and `confirmCandidatesAsIntake`):
 * `acquisitionId` given → attach to that ALREADY-existing acquisition (must
 * not be `cancelled`); omitted → CREATE a new draft acquisition, defaulting
 * `vendorName`/`currency`/`acquiredAt` from the source document exactly as
 * `confirmCandidatesAsExpense` defaults an expense's payee/currency/date
 * from it. Extracted once both functions needed the identical branch rather
 * than duplicated a second time within this one file (cross-PACKAGE
 * duplication is this module's deliberate stance per the top doc;
 * within-file duplication is not the same tradeoff).
 */
async function resolveAcquisitionTarget(
  acquisitionsService: AcquisitionsService,
  value: {
    acquisitionId?: string;
    title?: string;
    sourceKind?: string;
    vendorName?: string | null;
    currency?: string;
    defaultCurrency: string;
    economicEntityId?: string | null;
    acquiredAt?: string;
    notes?: string | null;
    actorUserId: string;
  },
  documentRow: {
    currency: string | null;
    documentDate: string | null;
    counterpartyName: string | null;
    economicEntityId: string | null;
  },
): Promise<AcquisitionRow> {
  if (value.acquisitionId !== undefined) {
    const acquisition = await acquisitionsService.get(value.acquisitionId);
    if (acquisition.status === "cancelled") {
      throw new InventoryConflictError(
        `cannot confirm candidates into "${acquisition.referenceCode}": it is cancelled. ` +
          "Pick a different lot, or create a new draft.",
      );
    }
    return acquisition;
  }
  if (value.title === undefined) {
    throw new InventoryValidationError(
      "confirming candidates into an acquisition requires a title to create a new one " +
        "(omit it only when passing an existing acquisitionId)",
    );
  }
  return acquisitionsService.create({
    title: value.title,
    // Validated against the real enum inside `create` — a bad value throws
    // `InventoryValidationError` from there with a clear message; this file
    // does not re-declare the enum a third time.
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

        const acquisition = await resolveAcquisitionTarget(acquisitionsService, value, documentRow);

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
            "acquisition",
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

/* ------------------------------------------------------ confirm as intake */

const intakeInputSchema = z.strictObject({
  documentId: z.uuid(),
  candidateIds: z.array(z.uuid()).min(1),
  actorUserId: z.string().min(1),
  requestId: z.string().min(1).nullish(),

  /** When given, attach to this ALREADY-existing acquisition instead of creating one — the lot picker's "attach to an existing open lot" branch. */
  acquisitionId: z.uuid().optional(),

  /** Required to CREATE a new acquisition (ignored when `acquisitionId` is given). */
  title: z.string().trim().min(1).optional(),
  sourceKind: z.string().trim().min(1).optional(),
  vendorName: z.string().trim().min(1).nullish(),
  currency: currencyCode.optional(),
  defaultCurrency: currencyCode.default("USD"),
  economicEntityId: z.uuid().nullish(),
  acquiredAt: calendarDate.optional(),
  notes: z.string().trim().min(1).nullish(),

  /**
   * Applies to EVERY item this call mints — a receipt line has no per-line
   * condition/location of its own (`document_line_candidates` carries no such
   * columns, and this milestone ships no migration to add them). A batch
   * whose items genuinely differ in condition or location confirms in
   * separate calls, one per condition/location — a real but minor UX
   * limitation, not a silent misrecording.
   */
  conditionCode: z.enum(CONDITION_CODES).default("unknown"),
  locationId: z.uuid().nullish(),
});
export type ConfirmCandidatesAsIntakeInput = z.input<typeof intakeInputSchema>;

export interface ConfirmCandidatesAsIntakeResult {
  /** `null` only when attaching to nothing new AND every candidate was skipped — nothing was written. */
  acquisition: AcquisitionRow | null;
  items: InventoryItemRow[];
  skipped: number;
}

export interface IntakeConfirmService {
  confirmCandidatesAsIntake: (
    input: ConfirmCandidatesAsIntakeInput,
  ) => Promise<ConfirmCandidatesAsIntakeResult>;
}

/**
 * `confirmCandidatesAsIntake` (loxep-ytu) — a candidate dispositioned
 * `inventory_intake` becomes an ACTUAL `inventory_items` row: physical
 * stock, not a cost row (that is `confirmCandidatesAsAcquisition`'s path,
 * for `acquisition_cost`-dispositioned lines — see this module's top doc for
 * why the two dispositions now diverge). Mirrors
 * `confirmCandidatesAsAcquisition`'s shape and discipline exactly: one
 * transaction, a required non-null `actorUserId`, the SAME
 * create-new-or-attach-existing lot resolution
 * (`resolveAcquisitionTarget`), the SAME document-evidence attach
 * (`purpose = 'invoice'` on the acquisition — an item-level
 * `purpose = 'supporting_document'` attach is a genuinely open UI question,
 * not built here), the SAME candidate-stamp/counter/notify plumbing.
 *
 * Item creation itself goes through `@loxep/inventory`'s own
 * `ItemsService.create` — never a raw `INSERT` — so a confirmed intake item
 * gets exactly the same item-code generation, attribution resolution, and
 * `receipt` movement (which is what actually puts it `quantity_on_hand`) any
 * other intake gets. It lands in `status = 'intake'`, the same starting
 * state `IntakeForm`'s manual "add item to lot" and
 * `createAcquisitionFromMarketItem`'s "I bought this" both produce — leaving
 * `completeIntakeReview` as the one, deliberate, human-decided exit, exactly
 * as designed for every OTHER intake producer.
 */
export function createIntakeConfirmService(options: {
  db: LoxepDb;
}): IntakeConfirmService {
  const { db } = options;

  return {
    confirmCandidatesAsIntake: async (input) => {
      const value = parse(intakeInputSchema, input, "confirm-candidates-as-intake");

      return db.transaction(async (tx) => {
        const acquisitionsService = createAcquisitionsService({ db: tx });
        const itemsService = createItemsService({ db: tx });

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
          description: string;
          quantity: string | null;
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
          if (!CONFIRMABLE_AS_INTAKE_DISPOSITIONS.has(candidate.disposition)) {
            skipped += 1;
            continue;
          }
          // `inventory_items.label` is `not null` — an intake line with no
          // description is not a nameable physical thing yet.
          if (candidate.description === null) {
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
            lineAmount: candidate.lineAmount,
            lineDate: candidate.lineDate,
            disposition: candidate.disposition,
          });
        }

        if (confirmable.length === 0 && value.acquisitionId === undefined) {
          return { acquisition: null, items: [], skipped };
        }

        const acquisition = await resolveAcquisitionTarget(acquisitionsService, value, documentRow);

        const items: InventoryItemRow[] = [];
        for (const candidate of confirmable) {
          // A candidate line's `quantity` is optional and, if present, must
          // be positive (`ItemsService.create`'s own `positiveDecimal`
          // refinement would otherwise throw) — a bad or absent value
          // defaults to one unit rather than failing the whole batch, the
          // same "count is fixed by the document, but not every document is
          // clean" posture `unit_amount`'s own nullability already takes.
          const quantity =
            candidate.quantity !== null && compareDecimals(candidate.quantity, "0") > 0
              ? candidate.quantity
              : "1";
          const item = await itemsService.create({
            label: candidate.description,
            currency: acquisition.currency,
            acquisitionId: acquisition.id,
            locationId: value.locationId ?? null,
            conditionCode: value.conditionCode,
            quantity,
            // This item's own price, seeded directly — NOT a paired
            // `acquisition_costs` row. See this module's top doc for why
            // writing both would double-count the next time
            // `allocateCosts` runs.
            acquisitionCostAmount: candidate.lineAmount,
            ...(candidate.lineDate !== null
              ? { acquiredAt: dateFromCalendarDate(candidate.lineDate) }
              : {}),
            createdByUserId: value.actorUserId,
          });
          items.push(item);
        }

        if (items.length > 0) {
          await createAuditService({ db: tx }).append({
            actorUserId: value.actorUserId,
            action: "inventory.acquisition.items_confirmed_from_candidates",
            resourceType: "acquisition",
            resourceId: acquisition.id,
            after: { itemCount: items.length, candidateIds: confirmable.map((c) => c.id) },
            requestId: value.requestId ?? null,
            metadata: { referenceCode: acquisition.referenceCode, documentId: value.documentId },
          });
        }

        // The document's own evidence file (if any) attaches to the
        // acquisition every candidate confirmed out of it lands on — the
        // SAME `confirmCandidatesAsAcquisition`/loxep-4mg precedent. A
        // per-item `purpose = 'supporting_document'` attach
        // (flipping-lifecycle-design.md, "Where a receipt attaches when the
        // spend was a purchase") is a genuinely open UI question, not built
        // here.
        if (documentRow.mediaObjectId !== null) {
          await attachAcquisitionMedia(
            tx,
            acquisition.id,
            documentRow.mediaObjectId,
            value.actorUserId,
          );
        }

        for (let i = 0; i < confirmable.length; i += 1) {
          const candidate = confirmable[i];
          const item = items[i];
          if (candidate === undefined || item === undefined) continue;
          await stampCandidateConfirmed(
            tx,
            candidate.id,
            "inventory_item",
            item.id,
            value.actorUserId,
            value.documentId,
            candidate.disposition,
          );
        }

        await recomputeDocumentCounters(tx, value.documentId, value.actorUserId);
        await emitDocumentConfirmed(tx, value.documentId);

        return { acquisition, items, skipped };
      });
    },
  };
}

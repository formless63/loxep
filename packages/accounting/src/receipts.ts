/**
 * Receipts and supporting documents on an expense.
 *
 * ## Receipts need no new table
 *
 * `media_links` already attaches a `media_object` to any Loxep row by
 * `(resource_type, resource_id, purpose)`. Phase 5 adds the *values* `expense`
 * and `receipt` — text in application code, not DDL — which is the same
 * conclusion Phase 3 reached for product media and Phase 4 for lot photos. This
 * module is therefore a thin, typed, audited adapter over
 * `@loxep/storage`'s media service, and deliberately not a second link model.
 *
 * ## How links are written, verified against the shipped code
 *
 * `MediaService.addLink` inserts through the Drizzle insert builder and
 * validates that the `media_objects` row exists first (`getMediaObject`), so an
 * attach naming a media object that was never uploaded fails with
 * `MediaObjectNotFoundError` rather than a foreign-key error. Nothing here
 * bypasses that path or writes `media_links` directly.
 *
 * ## Idempotency, and why it is this module's job
 *
 * Migration 0004 gave `media_links` the natural key
 * `unique(media_object_id, resource_type, resource_id, purpose)` — its stated
 * purpose being that an at-least-once worker has an `ON CONFLICT` target,
 * because with no unique constraint a retried attachment silently doubled the
 * row. `addLink` itself does **not** use `ON CONFLICT`: it raises `23505`. Jobs
 * are at-least-once and handlers must be idempotent (implementation contract),
 * so {@link ReceiptsService.attach} absorbs that specific violation and returns
 * the link that already exists. The alternative — teaching the shared media
 * service to swallow conflicts — would change behaviour for every other
 * consumer to fix a rule only this one has.
 *
 * ## What this is not
 *
 * Document *semantics* — OCR text, structured extraction, amount matching — are
 * the Documents domain and are not Phase 5. Media knows how the file is stored;
 * Accounting knows the image is receipt evidence; **nobody here reads what it
 * says.**
 */
import { createAuditService } from "@loxep/domain";
import type { LoxepDb } from "@loxep/db";
import { EXPENSE_RESOURCE_TYPE } from "@loxep/db/schema";
import type { ExpenseMediaPurpose } from "@loxep/db/schema";
import type { MediaLinkRecord, MediaService } from "@loxep/storage";
import { isUniqueViolation } from "./codes.ts";
import { AccountingNotFoundError } from "./errors.ts";
import { textLiteral, uuidLiteral } from "./sql.ts";

export interface AttachReceiptInput {
  expenseId: string;
  mediaObjectId: string;
  /** Defaults to `receipt`. */
  purpose?: ExpenseMediaPurpose;
  sortOrder?: number;
  actorUserId?: string | null;
  requestId?: string | null;
}

export interface ReceiptsService {
  /** Idempotent: a repeated attach returns the existing link, not an error. */
  attach: (
    input: AttachReceiptInput,
  ) => Promise<{ link: MediaLinkRecord; created: boolean }>;
  list: (
    expenseId: string,
    purpose?: ExpenseMediaPurpose,
  ) => Promise<MediaLinkRecord[]>;
  detach: (input: {
    expenseId: string;
    mediaObjectId: string;
    purpose?: ExpenseMediaPurpose;
    actorUserId?: string | null;
    requestId?: string | null;
  }) => Promise<void>;
  /**
   * Recorded expenses carrying no receipt of any purpose.
   *
   * The one report this module owes an operator: an audit asks for the paper,
   * and "which of last quarter's expenses has none attached" should be a query
   * rather than a scroll.
   */
  missingReceipts: (filter?: {
    from?: string;
    to?: string;
  }) => Promise<
    {
      expenseId: string;
      referenceCode: string;
      expenseDate: string;
      currency: string;
      amount: string;
      category: string;
      payeeName: string | null;
    }[]
  >;
}

export function createReceiptsService(options: {
  db: LoxepDb;
  media: MediaService;
}): ReceiptsService {
  const { db, media } = options;

  async function assertExpenseExists(expenseId: string): Promise<string> {
    const result = await db.execute(
      `select reference_code from expenses where id = ${uuidLiteral(expenseId)}`,
    );
    const row = result.rows[0];
    if (row === undefined) {
      throw new AccountingNotFoundError(`unknown expense "${expenseId}"`);
    }
    return row["reference_code"] as string;
  }

  return {
    attach: async (input) => {
      const referenceCode = await assertExpenseExists(input.expenseId);
      const purpose = input.purpose ?? "receipt";
      let created = true;
      let link: MediaLinkRecord;
      try {
        link = await media.addLink({
          mediaObjectId: input.mediaObjectId,
          resourceType: EXPENSE_RESOURCE_TYPE,
          resourceId: input.expenseId,
          purpose,
          ...(input.sortOrder !== undefined
            ? { sortOrder: input.sortOrder }
            : {}),
        });
      } catch (error) {
        if (!isUniqueViolation(error)) throw error;
        // The 0004 natural key fired: this exact (object, expense, purpose)
        // fact is already recorded, which is what a retry is supposed to find.
        created = false;
        const existing = await media.listLinksForResource({
          resourceType: EXPENSE_RESOURCE_TYPE,
          resourceId: input.expenseId,
          purpose,
        });
        const found = existing.find(
          (candidate) => candidate.mediaObjectId === input.mediaObjectId,
        );
        if (found === undefined) throw error;
        link = found;
      }

      if (created) {
        await createAuditService({ db }).append({
          actorUserId: input.actorUserId ?? null,
          action: "accounting.expense.receipt_attached",
          resourceType: "expense",
          resourceId: input.expenseId,
          after: { mediaObjectId: input.mediaObjectId, purpose },
          requestId: input.requestId ?? null,
          metadata: { referenceCode },
        });
      }
      return { link, created };
    },

    list: async (expenseId, purpose) =>
      media.listLinksForResource({
        resourceType: EXPENSE_RESOURCE_TYPE,
        resourceId: expenseId,
        ...(purpose !== undefined ? { purpose } : {}),
      }),

    detach: async (input) => {
      const referenceCode = await assertExpenseExists(input.expenseId);
      const purpose = input.purpose ?? "receipt";
      await media.removeLink({
        mediaObjectId: input.mediaObjectId,
        resourceType: EXPENSE_RESOURCE_TYPE,
        resourceId: input.expenseId,
        purpose,
      });
      await createAuditService({ db }).append({
        actorUserId: input.actorUserId ?? null,
        action: "accounting.expense.receipt_detached",
        resourceType: "expense",
        resourceId: input.expenseId,
        before: { mediaObjectId: input.mediaObjectId, purpose },
        requestId: input.requestId ?? null,
        metadata: { referenceCode },
      });
    },

    missingReceipts: async (filter) => {
      const predicates = [`e.status = 'recorded'`];
      if (filter?.from !== undefined) {
        predicates.push(`e.expense_date >= ${textLiteral(filter.from)}::date`);
      }
      if (filter?.to !== undefined) {
        predicates.push(`e.expense_date <= ${textLiteral(filter.to)}::date`);
      }
      const result = await db.execute(
        `select e.id::text as id, e.reference_code, e.expense_date::text as expense_date,
                e.currency, e.amount::text as amount, e.category, e.payee_name
           from expenses e
          where ${predicates.join(" and ")}
            and not exists (
                  select 1 from media_links m
                   where m.resource_type = ${textLiteral(EXPENSE_RESOURCE_TYPE)}
                     and m.resource_id = e.id::text)
          order by e.expense_date desc, e.reference_code`,
      );
      return result.rows.map((row) => ({
        expenseId: row["id"] as string,
        referenceCode: row["reference_code"] as string,
        expenseDate: row["expense_date"] as string,
        currency: row["currency"] as string,
        amount: row["amount"] as string,
        category: row["category"] as string,
        payeeName: (row["payee_name"] as string | null) ?? null,
      }));
    },
  };
}

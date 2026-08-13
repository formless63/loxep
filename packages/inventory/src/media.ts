/**
 * Item-image gallery links over `media_links` (M3, loxep-dgf.3) — no new
 * table. `resource_type = 'inventory_item'`, `purpose ∈ {gallery,
 * condition_evidence, supporting_document}`: migration 0004's own
 * relationship overview reserved those values and nothing had ever written
 * them until this module.
 *
 * ## The gallery ordering rule, restated because it is easy to get backwards
 *
 * **Primary is `sort_order = 0`, never a `'primary'` purpose value.**
 * `purpose` is IN migration 0004's unique key
 * (`unique(media_object_id, resource_type, resource_id, purpose)`) and
 * `sort_order` is deliberately NOT — so a `primary` purpose would let one
 * photo be simultaneously primary and gallery as two rows for one fact, and
 * making a different photo primary would become a purpose rewrite instead of
 * a reorder. {@link InventoryMediaService.reorder} therefore only ever writes
 * `sort_order`, and NOTHING here ever rewrites `purpose` after attach. A
 * caller derives "primary" itself as whichever row in a `list()` result sorts
 * first — see `list`'s doc.
 *
 * ## Why this module talks to `media_links` directly rather than through
 * `@loxep/storage`'s `MediaService`
 *
 * Uploading and streaming the underlying bytes is the web layer's job,
 * exactly as the avatar and receipt precedents establish (`@/server/avatar.ts`,
 * `@/server/receipt-media.ts`: a `FormData` POST to a file route, not a
 * domain service call). This module owns only the domain-side link
 * bookkeeping — attach, list, detach, and the reorder verb `MediaService`
 * does not even expose (it has no "update a link's `sort_order`" method: a
 * link's natural key is already complete, so reordering is a plain column
 * update on it, not a new link). `@loxep/db`'s relational query object
 * already carries the full schema — `media_objects`/`media_links` included —
 * so no new package dependency is needed to reach them, the same reasoning
 * `sql.ts`'s literal helpers are re-declared here rather than imported from
 * `@loxep/storage` for.
 */
import { createAuditService } from "@loxep/domain";
import type { LoxepDb } from "@loxep/db";
import {
  INVENTORY_ITEM_MEDIA_RESOURCE_TYPE,
  mediaLinks,
} from "@loxep/db/schema";
import type { InventoryItemMediaPurpose } from "@loxep/db/schema";
import { z } from "zod";
import { isUniqueViolation } from "./codes.ts";
import { InventoryNotFoundError, InventoryValidationError } from "./errors.ts";
import { textLiteral, uuidLiteral } from "./sql.ts";

export type InventoryMediaLinkRow = typeof mediaLinks.$inferSelect;

/** `INVENTORY_ITEM_MEDIA_PURPOSES` re-declared as a Zod enum for input validation. */
const purposeSchema = z.enum([
  "gallery",
  "condition_evidence",
  "supporting_document",
]);

const attachSchema = z.strictObject({
  inventoryItemId: z.uuid(),
  mediaObjectId: z.uuid(),
  purpose: purposeSchema.default("gallery"),
  /** Defaults to the end of the (item, purpose) group. */
  sortOrder: z.number().int().min(0).max(100_000).optional(),
  actorUserId: z.string().min(1).nullish(),
  requestId: z.string().min(1).nullish(),
});

export type AttachInventoryMediaInput = z.input<typeof attachSchema>;

function parse<T extends z.ZodType>(
  schema: T,
  input: unknown,
  what: string,
): z.output<T> {
  const parsed = schema.safeParse(input);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("; ");
    throw new InventoryValidationError(`invalid ${what}: ${issues}`);
  }
  return parsed.data;
}

export interface InventoryMediaService {
  /**
   * Idempotent on the 0004 natural key: a repeated attach of the same
   * (media object, item, purpose) returns the existing link rather than
   * erroring — the `ReceiptsService.attach` precedent, for the identical
   * at-least-once reason.
   */
  attach: (
    input: AttachInventoryMediaInput,
  ) => Promise<{ link: InventoryMediaLinkRow; created: boolean }>;
  /**
   * Ordered by `sort_order` ascending (nulls-then-createdAt as the
   * tiebreak). The FIRST row of a `purpose: 'gallery'` list IS the primary
   * image — that is the whole rule, and it is a sort, never a flag.
   */
  list: (
    inventoryItemId: string,
    purpose?: InventoryItemMediaPurpose,
  ) => Promise<InventoryMediaLinkRow[]>;
  detach: (input: {
    inventoryItemId: string;
    mediaObjectId: string;
    purpose?: InventoryItemMediaPurpose;
    actorUserId?: string | null;
    requestId?: string | null;
  }) => Promise<void>;
  /**
   * Writes ONLY `sort_order` for one link. Never `purpose` — see the module
   * doc. Returns the purpose group's links in their new order, so a caller
   * (a drag-to-reorder gallery, or the simple up/down buttons the M3 UI
   * uses) can re-render directly from the result.
   */
  reorder: (input: {
    inventoryItemId: string;
    mediaObjectId: string;
    purpose?: InventoryItemMediaPurpose;
    sortOrder: number;
  }) => Promise<InventoryMediaLinkRow[]>;
}

export function createInventoryMediaService(options: {
  db: LoxepDb;
}): InventoryMediaService {
  const { db } = options;

  async function assertItemExists(inventoryItemId: string): Promise<void> {
    const row = await db.query.inventoryItems.findFirst({
      where: (table, { eq }) => eq(table.id, inventoryItemId),
      columns: { id: true },
    });
    if (row === undefined) {
      throw new InventoryNotFoundError(
        `unknown inventory item "${inventoryItemId}"`,
      );
    }
  }

  async function assertMediaObjectExists(mediaObjectId: string): Promise<void> {
    const row = await db.query.mediaObjects.findFirst({
      where: (table, { eq }) => eq(table.id, mediaObjectId),
      columns: { id: true },
    });
    if (row === undefined) {
      throw new InventoryNotFoundError(
        `unknown media object "${mediaObjectId}"`,
      );
    }
  }

  async function list(
    inventoryItemId: string,
    purpose?: InventoryItemMediaPurpose,
  ): Promise<InventoryMediaLinkRow[]> {
    return db.query.mediaLinks.findMany({
      where: (table, { and, eq }) =>
        purpose !== undefined
          ? and(
              eq(table.resourceType, INVENTORY_ITEM_MEDIA_RESOURCE_TYPE),
              eq(table.resourceId, inventoryItemId),
              eq(table.purpose, purpose),
            )
          : and(
              eq(table.resourceType, INVENTORY_ITEM_MEDIA_RESOURCE_TYPE),
              eq(table.resourceId, inventoryItemId),
            ),
      orderBy: (table, { asc }) => [asc(table.sortOrder), asc(table.createdAt)],
    });
  }

  return {
    attach: async (rawInput) => {
      const input = parse(attachSchema, rawInput, "inventory item media attach");
      await Promise.all([
        assertItemExists(input.inventoryItemId),
        assertMediaObjectExists(input.mediaObjectId),
      ]);

      let sortOrder = input.sortOrder;
      if (sortOrder === undefined) {
        const existing = await list(input.inventoryItemId, input.purpose);
        sortOrder = existing.reduce(
          (max, link) => Math.max(max, (link.sortOrder ?? -1) + 1),
          0,
        );
      }

      let created = true;
      let link: InventoryMediaLinkRow;
      try {
        const rows = await db
          .insert(mediaLinks)
          .values({
            mediaObjectId: input.mediaObjectId,
            resourceType: INVENTORY_ITEM_MEDIA_RESOURCE_TYPE,
            resourceId: input.inventoryItemId,
            purpose: input.purpose,
            sortOrder,
          })
          .returning();
        const row = rows[0];
        if (row === undefined) {
          throw new InventoryValidationError(
            "media_links insert returned no row",
          );
        }
        link = row;
      } catch (error) {
        if (!isUniqueViolation(error)) throw error;
        // The 0004 natural key fired: this exact (object, item, purpose)
        // fact is already recorded, which is what a retry is supposed to find.
        created = false;
        const existing = await db.query.mediaLinks.findFirst({
          where: (table, { and, eq }) =>
            and(
              eq(table.mediaObjectId, input.mediaObjectId),
              eq(table.resourceType, INVENTORY_ITEM_MEDIA_RESOURCE_TYPE),
              eq(table.resourceId, input.inventoryItemId),
              eq(table.purpose, input.purpose),
            ),
        });
        if (existing === undefined) throw error;
        link = existing;
      }

      if (created) {
        await createAuditService({ db }).append({
          actorUserId: input.actorUserId ?? null,
          action: "inventory.item.media_attached",
          resourceType: "inventory_item",
          resourceId: input.inventoryItemId,
          after: { mediaObjectId: input.mediaObjectId, purpose: input.purpose },
          requestId: input.requestId ?? null,
        });
      }
      return { link, created };
    },

    list,

    detach: async (input) => {
      const purpose = input.purpose ?? "gallery";
      await db.execute(
        `delete from media_links
          where media_object_id = ${uuidLiteral(input.mediaObjectId)}
            and resource_type = ${textLiteral(INVENTORY_ITEM_MEDIA_RESOURCE_TYPE)}
            and resource_id = ${textLiteral(input.inventoryItemId)}
            and purpose = ${textLiteral(purpose)}`,
      );
      await createAuditService({ db }).append({
        actorUserId: input.actorUserId ?? null,
        action: "inventory.item.media_detached",
        resourceType: "inventory_item",
        resourceId: input.inventoryItemId,
        before: { mediaObjectId: input.mediaObjectId, purpose },
        requestId: input.requestId ?? null,
      });
    },

    reorder: async (input) => {
      const purpose = input.purpose ?? "gallery";
      if (!Number.isInteger(input.sortOrder) || input.sortOrder < 0) {
        throw new InventoryValidationError(
          "sortOrder must be a non-negative integer",
        );
      }
      await db.execute(
        `update media_links
            set sort_order = ${input.sortOrder}
          where media_object_id = ${uuidLiteral(input.mediaObjectId)}
            and resource_type = ${textLiteral(INVENTORY_ITEM_MEDIA_RESOURCE_TYPE)}
            and resource_id = ${textLiteral(input.inventoryItemId)}
            and purpose = ${textLiteral(purpose)}`,
      );
      return list(input.inventoryItemId, purpose);
    },
  };
}

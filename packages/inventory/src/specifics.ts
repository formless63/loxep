/**
 * Typed key/value product specifics on a physical unit (M3, loxep-dgf.3) —
 * `packages/db/src/schema/inventory.ts`'s `inventory_item_specifics`. See
 * that table's doc for the full shape argument (multi-value falls out of the
 * unique key rather than a `text[]` column; no Loxep-owned category/aspect
 * taxonomy — a channel's own metadata is fetched at authoring time by its
 * adapter, never mirrored here).
 *
 * This module is the SINGLE WRITER of `value_numeric` alongside `value` —
 * the identical single-writer argument that keeps
 * `inventory_items.quantity_on_hand` safe as a cache. Nothing else in Loxep
 * may insert or update this table.
 */
import { createAuditService } from "@loxep/domain";
import type { LoxepDb } from "@loxep/db";
import { inventoryItemSpecifics } from "@loxep/db/schema";
import { z } from "zod";
import { isUniqueViolation } from "./codes.ts";
import { InventoryNotFoundError, InventoryValidationError } from "./errors.ts";
import { textLiteral, uuidLiteral } from "./sql.ts";

export type ItemSpecificRow = typeof inventoryItemSpecifics.$inferSelect;

/** `ITEM_SPECIFIC_SOURCES` re-declared as a Zod enum for input validation. */
const sourceSchema = z.enum([
  "manual",
  "parsed",
  "channel_suggested",
  "catalog_default",
]);

const setSpecificSchema = z.strictObject({
  inventoryItemId: z.uuid(),
  name: z.string().trim().min(1).max(200),
  value: z.string().trim().min(1).max(2000),
  unit: z.string().trim().min(1).max(32).nullish(),
  sortOrder: z.number().int().min(0).max(100_000).optional(),
  source: sourceSchema.default("manual"),
  actorUserId: z.string().min(1).nullish(),
  requestId: z.string().min(1).nullish(),
});

export type SetSpecificInput = z.input<typeof setSpecificSchema>;

/**
 * `value_numeric` parses `value` as a PLAIN decimal, and only a plain
 * decimal — no unit suffix, no thousands separator, no scientific notation.
 * "9.8", "PSA 9.8", and "9.8 (qualified)" are three different claims (the
 * design's own example); only the first parses, and the other two correctly
 * leave `value_numeric` null rather than guessing.
 */
const PLAIN_DECIMAL = /^-?\d+(\.\d+)?$/;

function deriveValueNumeric(value: string): string | null {
  const trimmed = value.trim();
  return PLAIN_DECIMAL.test(trimmed) ? trimmed : null;
}

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

export interface SpecificsService {
  /**
   * Upsert on the natural key `(inventory_item_id, name, value)`. A repeat
   * `set` of the identical (item, name, value) triple updates
   * `unit`/`sort_order`/`source`/`value_numeric` in place rather than
   * erroring — an at-least-once caller (a resubmitted form, a re-run parser)
   * expects a retry to converge, matching the `media_links` /
   * `ReceiptsService.attach` precedent for the same natural-key shape.
   */
  set: (
    input: SetSpecificInput,
  ) => Promise<{ specific: ItemSpecificRow; created: boolean }>;
  /** Ordered by `sort_order` ascending, then `name` — stable for an editor list. */
  list: (inventoryItemId: string) => Promise<ItemSpecificRow[]>;
  remove: (input: {
    inventoryItemId: string;
    name: string;
    value: string;
    actorUserId?: string | null;
    requestId?: string | null;
  }) => Promise<void>;
}

export function createSpecificsService(options: {
  db: LoxepDb;
}): SpecificsService {
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

  return {
    set: async (rawInput) => {
      const input = parse(setSpecificSchema, rawInput, "item specific");
      await assertItemExists(input.inventoryItemId);
      const valueNumeric = deriveValueNumeric(input.value);
      const sortOrder = input.sortOrder ?? 0;

      let created = true;
      let specific: ItemSpecificRow;
      try {
        const rows = await db
          .insert(inventoryItemSpecifics)
          .values({
            inventoryItemId: input.inventoryItemId,
            name: input.name,
            value: input.value,
            valueNumeric,
            unit: input.unit ?? null,
            sortOrder,
            source: input.source,
          })
          .returning();
        const row = rows[0];
        if (row === undefined) {
          throw new InventoryValidationError(
            "inventory_item_specifics insert returned no row",
          );
        }
        specific = row;
      } catch (error) {
        if (!isUniqueViolation(error)) throw error;
        // The natural key fired: this exact (item, name, value) fact already
        // exists — update its shadow columns in place rather than erroring.
        created = false;
        await db.execute(
          `update inventory_item_specifics
              set unit = ${input.unit ? textLiteral(input.unit) : "null"},
                  sort_order = ${sortOrder},
                  source = ${textLiteral(input.source)},
                  value_numeric = ${
                    valueNumeric === null
                      ? "null"
                      : `${textLiteral(valueNumeric)}::numeric(20, 6)`
                  },
                  updated_at = now()
            where inventory_item_id = ${uuidLiteral(input.inventoryItemId)}
              and name = ${textLiteral(input.name)}
              and value = ${textLiteral(input.value)}`,
        );
        const existing = await db.query.inventoryItemSpecifics.findFirst({
          where: (table, { and, eq }) =>
            and(
              eq(table.inventoryItemId, input.inventoryItemId),
              eq(table.name, input.name),
              eq(table.value, input.value),
            ),
        });
        if (existing === undefined) throw error;
        specific = existing;
      }

      if (created) {
        await createAuditService({ db }).append({
          actorUserId: input.actorUserId ?? null,
          action: "inventory.item.specific_set",
          resourceType: "inventory_item",
          resourceId: input.inventoryItemId,
          after: { name: input.name, value: input.value, source: input.source },
          requestId: input.requestId ?? null,
        });
      }
      return { specific, created };
    },

    list: async (inventoryItemId) =>
      db.query.inventoryItemSpecifics.findMany({
        where: (table, { eq }) => eq(table.inventoryItemId, inventoryItemId),
        orderBy: (table, { asc }) => [asc(table.sortOrder), asc(table.name)],
      }),

    remove: async (input) => {
      await db.execute(
        `delete from inventory_item_specifics
          where inventory_item_id = ${uuidLiteral(input.inventoryItemId)}
            and name = ${textLiteral(input.name)}
            and value = ${textLiteral(input.value)}`,
      );
      await createAuditService({ db }).append({
        actorUserId: input.actorUserId ?? null,
        action: "inventory.item.specific_removed",
        resourceType: "inventory_item",
        resourceId: input.inventoryItemId,
        before: { name: input.name, value: input.value },
        requestId: input.requestId ?? null,
      });
    },
  };
}

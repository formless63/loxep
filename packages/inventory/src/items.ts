/**
 * Inventory items: the stock row, its condition and grading, its location, and
 * the two paired-movement operations that make a location change and an
 * ownership change expressible without ever rewriting a fact.
 *
 * ## An item row IS the cost layer
 *
 * `acquisition_cost_amount` and `landed_cost_amount` live on the row. There is
 * no cost-layer table and no running average, because an item row already has
 * everything a layer needs: a quantity, acquired at one moment, from one lot, at
 * one unit cost, in one condition, at one location. Commodity stock is one row
 * with `quantity = 100`; next month's case is a second row. The costing METHOD
 * is decided at allocation time by what the allocation identifies, so moving
 * from specific identification to FIFO is a picker change and NO migration.
 *
 * ## Two paired-movement operations
 *
 * ```text
 * moveToLocation    transfer_out at the source + transfer_in at the destination,
 *                   one transfer_group_id. A WHOLE-item move points both halves
 *                   at the same row (net zero on-hand, location_id updated); a
 *                   PARTIAL move splits into a new row, which is honest — the
 *                   two halves genuinely have different locations and can
 *                   diverge in condition and basis afterwards.
 *
 * transferEntity    the same mechanism, one level up. Moving stock from personal
 *                   ownership to an LLC does NOT update economic_entity_id. It
 *                   creates a new item row owned by the receiving entity, linked
 *                   by origin_item_id and sharing a transfer_group_id. The
 *                   original row remains, depleted, with its history and its
 *                   basis intact.
 * ```
 *
 * Why the harder thing is the right thing, verbatim from the design: the
 * pre-transfer holding period, cost basis, and realized history of the original
 * entity survive; the ledger contains the transfer as an EVENT, so "when did
 * this leave personal ownership" is a query rather than audit-log archaeology;
 * it forces the open and correct question — carried-over basis or fair market
 * value? — to be answered explicitly on the new row instead of silently
 * inherited; and it preserves the Phase 3 invariant that entity attribution,
 * once written, is never rewritten.
 *
 * **Phase 4 refuses to choose the basis treatment.** `transferEntity` requires
 * an explicit `basisTreatment`, because whether a transferred item's basis
 * carries over or is restated at fair market value is a TAX question, not a
 * modeling one, and the design flags it as needing a human decision. A default
 * here would be that decision, made silently.
 */
import type { LoxepDb } from "@loxep/db";
import { createAuditService } from "@loxep/domain";
import { inventoryItems } from "@loxep/db/schema";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  REATTRIBUTABLE_SOURCES,
  resolveItemAttribution,
} from "./attribution.ts";
import { itemCode, withCodeRetry } from "./codes.ts";
import {
  ZERO,
  compareDecimals,
  distributeByWeights,
  subtractDecimals,
  toMoneyString,
} from "./decimal.ts";
import {
  InventoryConflictError,
  InventoryImmutableFactError,
  InventoryNotFoundError,
  InventoryValidationError,
} from "./errors.ts";
import { movementKeys, recordMovement } from "./movements.ts";
import type { Executor } from "./movements.ts";
import { textLiteral, uuidLiteral } from "./sql.ts";

export type InventoryItemRow = typeof inventoryItems.$inferSelect;

/* ---------------------------------------------------------------- schemas */

const decimalString = z
  .string()
  .regex(/^-?\d+(\.\d+)?$/, "expected a plain decimal string");
const positiveDecimal = decimalString.refine(
  (value) => compareDecimals(value, "0") > 0,
  "must be greater than zero",
);
const currencyCode = z.string().regex(/^[A-Za-z]{3}$/, "expected ISO-4217");

const conditionCodes = [
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

const createItemSchema = z
  .strictObject({
    label: z.string().trim().min(1),
    currency: currencyCode,
    acquisitionId: z.uuid().nullish(),
    catalogItemId: z.uuid().nullish(),
    locationId: z.uuid().nullish(),
    economicEntityId: z.uuid().nullish(),
    /** Overrides the generated `ITM-…`; for imports of pre-existing labels. */
    itemCode: z.string().trim().min(1).max(64).optional(),
    lotReference: z.string().trim().min(1).nullish(),
    serialNumber: z.string().trim().min(1).nullish(),
    conditionCode: z.enum(conditionCodes).default("unknown"),
    conditionNotes: z.string().nullish(),
    gradingAuthority: z.string().trim().min(1).nullish(),
    gradeLabel: z.string().trim().min(1).nullish(),
    gradeNumeric: decimalString.nullish(),
    certificateNumber: z.string().trim().min(1).nullish(),
    quantity: positiveDecimal.default("1"),
    acquisitionCostAmount: decimalString.optional(),
    landedCostAmount: decimalString.optional(),
    costAllocationWeight: decimalString.nullish(),
    estimatedValueAmount: decimalString.nullish(),
    acquiredAt: z.date().optional(),
    receivedAt: z.date().nullish(),
    status: z.string().min(1).default("intake"),
    /**
     * Write the `receipt` movement that puts the stock on hand. Default true:
     * an item created without one has `quantity_on_hand = 0`, which is a real
     * state (a lot recorded before it is physically received) but not the
     * common one.
     */
    receive: z.boolean().default(true),
    /** Distinguishes one intake session for the `found` deduplication key. */
    receiptSessionKey: z.string().min(1).optional(),
    createdByUserId: z.string().min(1).nullish(),
    installationDefaultEntityId: z.uuid().nullish(),
  })
  .refine(
    (item) =>
      item.gradeLabel === undefined ||
      item.gradeLabel === null ||
      (item.gradingAuthority !== undefined && item.gradingAuthority !== null),
    {
      message:
        "a grade label requires a grading authority (inventory_items_grade_authority_check)",
      path: ["gradingAuthority"],
    },
  );

export type CreateItemInput = z.input<typeof createItemSchema>;

const gradingSchema = z.strictObject({
  inventoryItemId: z.uuid(),
  conditionCode: z.enum(conditionCodes).optional(),
  conditionNotes: z.string().nullish(),
  gradingAuthority: z.string().trim().min(1).nullish(),
  gradeLabel: z.string().trim().min(1).nullish(),
  gradeNumeric: decimalString.nullish(),
  certificateNumber: z.string().trim().min(1).nullish(),
});

export type SetConditionInput = z.input<typeof gradingSchema>;

function parse<T extends z.ZodType>(schema: T, input: unknown, what: string): z.output<T> {
  const parsed = schema.safeParse(input);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("; ");
    throw new InventoryValidationError(`invalid ${what}: ${issues}`);
  }
  return parsed.data;
}

/* ---------------------------------------------------------------- results */

export interface TransferResult {
  /** Shared by the `transfer_out` / `transfer_in` pair. */
  transferGroupId: string;
  sourceItem: InventoryItemRow;
  /** The receiving row. Same row as `sourceItem` for a whole-item location move. */
  destinationItem: InventoryItemRow;
  outMovementId: string;
  inMovementId: string;
}

export interface ItemsService {
  create: (input: CreateItemInput) => Promise<InventoryItemRow>;
  get: (id: string) => Promise<InventoryItemRow>;
  getByCode: (code: string) => Promise<InventoryItemRow>;
  /** Condition and grading are ordinary mutable facts about the unit. */
  setCondition: (input: SetConditionInput) => Promise<InventoryItemRow>;
  /**
   * Move stock to another location as a `transfer_out` / `transfer_in` pair.
   * A partial quantity splits the row.
   */
  moveToLocation: (input: {
    inventoryItemId: string;
    toLocationId: string;
    quantity?: string;
    occurredAt?: Date;
    note?: string | null;
    actorUserId?: string | null;
  }) => Promise<TransferResult>;
  /**
   * Move OWNERSHIP to another economic entity. Never an `UPDATE`: a new item
   * row is created for the receiving entity and the pair is written.
   */
  transferEntity: (input: {
    inventoryItemId: string;
    toEconomicEntityId: string;
    /**
     * Required, with no default. `carryover` keeps the original basis;
     * `fair_market_value` restates it to `fairMarketValueAmount`. Which is
     * correct is a tax determination Phase 4 declines to make for the operator.
     */
    basisTreatment: "carryover" | "fair_market_value";
    fairMarketValueAmount?: string;
    quantity?: string;
    toLocationId?: string | null;
    occurredAt?: Date;
    note?: string | null;
    actorUserId?: string | null;
  }) => Promise<TransferResult>;
  /**
   * Explicit, audited bulk re-attribution. Rewrites only rows whose source is
   * a DEFAULT; `manual` rows are never touched. This corrects a default that
   * was never a decision — it is not a change of ownership, which is
   * {@link ItemsService.transferEntity}.
   */
  reattribute: (input: {
    economicEntityId: string | null;
    acquisitionId?: string;
    acquiredBefore?: Date;
    actorUserId?: string | null;
  }) => Promise<{ updated: number }>;
  /**
   * The design's escape hatch for a lot discovered to be mis-costed AFTER a
   * sale (open question 5).
   *
   * Once `cost_basis_locked_at` is set, `allocateCosts` will not touch the row —
   * a silent lot re-run would retroactively change reported margin on a closed
   * sale. This is the other path the design names: "an explicit, audited basis
   * correction on the individual item". It therefore requires a `reason`, it
   * writes `audit_events` with the before/after basis, and it is the ONLY way
   * a locked basis changes.
   */
  correctCostBasis: (input: {
    inventoryItemId: string;
    landedCostAmount: string;
    acquisitionCostAmount?: string;
    reason: string;
    actorUserId?: string | null;
    requestId?: string | null;
  }) => Promise<InventoryItemRow>;
  /**
   * `quantity_on_hand − sum(open reservations)`. Computed, never cached: one
   * cache is one thing that can drift instead of two.
   */
  availableToSell: (inventoryItemId: string) => Promise<string>;
  /**
   * The ONLY exit from `intake`. {@link deriveItemStatus} deliberately
   * preserves `intake` across every movement while stock remains — leaving
   * review is a human decision, never a side effect of the receipt movement
   * that put the stock on hand (see that function's doc; found live by the
   * first `/inventory` e2e run, which showed every hand-entered item
   * silently skipping the review screen the moment it was created). This
   * touches `status` ONLY — never `quantity_on_hand` or a movement row,
   * because quantities and movements remain the authority and this is
   * purely the human-decision half `deriveItemStatus` refuses to infer.
   * Refuses (does not silently no-op) when the item is not currently
   * `intake`, so a stale UI action can't quietly relabel an item that has
   * since been listed, sold, or written off.
   */
  completeIntakeReview: (inventoryItemId: string) => Promise<InventoryItemRow>;
}

export function createItemsService(options: { db: LoxepDb }): ItemsService {
  const { db } = options;

  async function get(id: string): Promise<InventoryItemRow> {
    const row = await db.query.inventoryItems.findFirst({
      where: (table, { eq }) => eq(table.id, id),
    });
    if (row === undefined) {
      throw new InventoryNotFoundError(`unknown inventory item "${id}"`);
    }
    return row;
  }

  return {
    get,

    getByCode: async (code) => {
      const row = await db.query.inventoryItems.findFirst({
        where: (table, { eq }) => eq(table.itemCode, code),
      });
      if (row === undefined) {
        throw new InventoryNotFoundError(`unknown item code "${code}"`);
      }
      return row;
    },

    create: async (input) => {
      const value = parse(createItemSchema, input, "inventory item");
      const now = new Date();
      return db.transaction(async (tx) => {
        const acquisition =
          value.acquisitionId === undefined || value.acquisitionId === null
            ? undefined
            : await tx.query.acquisitions.findFirst({
                where: (table, { eq }) =>
                  eq(table.id, value.acquisitionId ?? ""),
                columns: {
                  id: true,
                  economicEntityId: true,
                  currency: true,
                  acquiredAt: true,
                },
              });
        if (
          value.acquisitionId !== undefined &&
          value.acquisitionId !== null &&
          acquisition === undefined
        ) {
          throw new InventoryNotFoundError(
            `unknown acquisition "${value.acquisitionId}"`,
          );
        }

        const attribution = resolveItemAttribution({
          ...(value.economicEntityId === undefined
            ? {}
            : { explicitEntityId: value.economicEntityId }),
          ...(acquisition === undefined
            ? {}
            : { acquisitionEntityId: acquisition.economicEntityId }),
          ...(value.installationDefaultEntityId === undefined
            ? {}
            : { installationDefaultEntityId: value.installationDefaultEntityId }),
          actorUserId: value.createdByUserId ?? null,
          now,
        });

        const acquiredAt =
          value.acquiredAt ?? acquisition?.acquiredAt ?? now;

        const item = await withCodeRetry(
          async () => {
            const rows = await tx
              .insert(inventoryItems)
              .values({
                itemCode: value.itemCode ?? itemCode(),
                acquisitionId: value.acquisitionId ?? null,
                catalogItemId: value.catalogItemId ?? null,
                economicEntityId: attribution.economicEntityId,
                entityAttributionSource: attribution.entityAttributionSource,
                entityAttributedAt: attribution.entityAttributedAt,
                entityAttributedByUserId: attribution.entityAttributedByUserId,
                locationId: value.locationId ?? null,
                label: value.label,
                lotReference: value.lotReference ?? null,
                serialNumber: value.serialNumber ?? null,
                status: value.status,
                conditionCode: value.conditionCode,
                conditionNotes: value.conditionNotes ?? null,
                gradingAuthority: value.gradingAuthority ?? null,
                gradeLabel: value.gradeLabel ?? null,
                gradeNumeric: value.gradeNumeric ?? null,
                certificateNumber: value.certificateNumber ?? null,
                quantity: value.quantity,
                quantityOnHand: ZERO,
                currency: value.currency.toUpperCase(),
                acquisitionCostAmount: value.acquisitionCostAmount ?? ZERO,
                landedCostAmount: value.landedCostAmount ?? ZERO,
                costAllocationWeight: value.costAllocationWeight ?? null,
                estimatedValueAmount: value.estimatedValueAmount ?? null,
                acquiredAt,
                receivedAt: value.receivedAt ?? null,
                createdByUserId: value.createdByUserId ?? null,
              })
              .returning();
            const row = rows[0];
            if (row === undefined) {
              throw new InventoryConflictError("item insert returned no row");
            }
            return row;
          },
          { label: "item code" },
        );

        if (value.receive) {
          const dedupKey =
            acquisition === undefined
              ? movementKeys.found(
                  value.receiptSessionKey ?? item.id,
                  item.id,
                )
              : movementKeys.receipt(acquisition.id, item.id);
          await recordMovement(tx, {
            inventoryItemId: item.id,
            movementKind: acquisition === undefined ? "found" : "receipt",
            quantity: value.quantity,
            locationId: value.locationId ?? null,
            acquisitionId: acquisition?.id ?? null,
            deduplicationKey: dedupKey,
            occurredAt: value.receivedAt ?? acquiredAt,
            actorUserId: value.createdByUserId ?? null,
          });
          const refreshed = await tx.query.inventoryItems.findFirst({
            where: (table, { eq }) => eq(table.id, item.id),
          });
          if (refreshed !== undefined) return refreshed;
        }
        return item;
      });
    },

    setCondition: async (input) => {
      const value = parse(gradingSchema, input, "condition update");
      return db.transaction(async (tx) => {
        const item = await tx.query.inventoryItems.findFirst({
          where: (table, { eq }) => eq(table.id, value.inventoryItemId),
        });
        if (item === undefined) {
          throw new InventoryNotFoundError(
            `unknown inventory item "${value.inventoryItemId}"`,
          );
        }
        const gradingAuthority =
          value.gradingAuthority === undefined
            ? item.gradingAuthority
            : value.gradingAuthority;
        const gradeLabel =
          value.gradeLabel === undefined ? item.gradeLabel : value.gradeLabel;
        if (
          gradeLabel !== null &&
          (gradingAuthority === null || gradingAuthority === undefined)
        ) {
          throw new InventoryValidationError(
            "a grade label requires a grading authority: half-grades and " +
              "qualifiers do not survive a lossy numeric conversion, and the " +
              "label is meaningless without whose scale it is on",
          );
        }
        // `@loxep/inventory` takes no direct `drizzle-orm` dependency (the
        // @loxep/domain / @loxep/commerce precedent), so updates are first-class
        // SQL with strictly escaped literals rather than the update builder.
        const assignments = [
          `grading_authority = ${nullableText(gradingAuthority)}`,
          `grade_label = ${nullableText(gradeLabel)}`,
          "updated_at = now()",
        ];
        if (value.conditionCode !== undefined) {
          assignments.push(`condition_code = ${textLiteral(value.conditionCode)}`);
        }
        if (value.conditionNotes !== undefined) {
          assignments.push(
            `condition_notes = ${nullableText(value.conditionNotes)}`,
          );
        }
        if (value.gradeNumeric !== undefined) {
          assignments.push(
            `grade_numeric = ${
              value.gradeNumeric === null
                ? "null"
                : `${numeric(value.gradeNumeric)}`
            }`,
          );
        }
        if (value.certificateNumber !== undefined) {
          assignments.push(
            `certificate_number = ${nullableText(value.certificateNumber)}`,
          );
        }
        await tx.execute(
          `update inventory_items
              set ${assignments.join(",\n                  ")}
            where id = ${uuidLiteral(value.inventoryItemId)}`,
        );
        return loadItem(tx, value.inventoryItemId);
      });
    },

    moveToLocation: async (input) =>
      db.transaction(async (tx) => {
        const item = await loadItem(tx, input.inventoryItemId);
        if (item.locationId === input.toLocationId) {
          throw new InventoryValidationError(
            "the item is already at that location; a move that moves nothing " +
              "would put two movements in the ledger describing no event",
          );
        }
        const moveQuantity = input.quantity ?? item.quantityOnHand;
        assertMovable(item.quantityOnHand, moveQuantity);
        const transferGroupId = randomUUID();
        const occurredAt = input.occurredAt ?? new Date();
        const whole = compareDecimals(moveQuantity, item.quantityOnHand) === 0;

        const destination = whole
          ? item
          : await splitItem(tx, item, moveQuantity, {
              locationId: input.toLocationId,
              economicEntityId: item.economicEntityId,
              entityAttributionSource: item.entityAttributionSource,
              // A location move carries basis across unchanged: what leaves the
              // source is exactly what lands on the destination.
              landedCostAmount: proRataBasis(item, moveQuantity),
              acquisitionCostAmount: proRataAcquisitionCost(item, moveQuantity),
              removeLandedCostAmount: proRataBasis(item, moveQuantity),
              removeAcquisitionCostAmount: proRataAcquisitionCost(
                item,
                moveQuantity,
              ),
            });

        const out = await recordMovement(tx, {
          inventoryItemId: item.id,
          movementKind: "transfer_out",
          quantity: `-${moveQuantity}`,
          locationId: item.locationId,
          transferGroupId,
          deduplicationKey: movementKeys.transfer(transferGroupId, "out"),
          note: input.note ?? null,
          occurredAt,
          actorUserId: input.actorUserId ?? null,
        });
        const into = await recordMovement(tx, {
          inventoryItemId: destination.id,
          movementKind: "transfer_in",
          quantity: moveQuantity,
          locationId: input.toLocationId,
          transferGroupId,
          deduplicationKey: movementKeys.transfer(transferGroupId, "in"),
          note: input.note ?? null,
          occurredAt,
          actorUserId: input.actorUserId ?? null,
        });

        if (whole) {
          await tx.execute(
            `update inventory_items
                set location_id = ${uuidLiteral(input.toLocationId)},
                    updated_at = now()
              where id = ${uuidLiteral(item.id)}`,
          );
        }

        return {
          transferGroupId,
          sourceItem: await loadItem(tx, item.id),
          destinationItem: await loadItem(tx, destination.id),
          outMovementId: out.movement.id,
          inMovementId: into.movement.id,
        };
      }),

    transferEntity: async (input) =>
      db.transaction(async (tx) => {
        const item = await loadItem(tx, input.inventoryItemId);
        if (item.economicEntityId === input.toEconomicEntityId) {
          throw new InventoryValidationError(
            "the item already belongs to that economic entity",
          );
        }
        if (
          input.basisTreatment === "fair_market_value" &&
          input.fairMarketValueAmount === undefined
        ) {
          throw new InventoryValidationError(
            "basisTreatment 'fair_market_value' requires fairMarketValueAmount: " +
              "restating basis without a stated value would invent a number",
          );
        }
        const moveQuantity = input.quantity ?? item.quantityOnHand;
        assertMovable(item.quantityOnHand, moveQuantity);
        const transferGroupId = randomUUID();
        const occurredAt = input.occurredAt ?? new Date();

        const carriedBasis = proRataBasis(item, moveQuantity);
        const carriedGoods = proRataAcquisitionCost(item, moveQuantity);
        const landed =
          input.basisTreatment === "carryover"
            ? carriedBasis
            : toMoneyString(input.fairMarketValueAmount ?? ZERO);
        const goods =
          input.basisTreatment === "carryover" ? carriedGoods : landed;

        // The receiving row is NEW and owned by the receiving entity. The
        // original row keeps its entity, its basis, and its history verbatim —
        // that is exactly what a change of tax ownership needs.
        const destination = await splitItem(tx, item, moveQuantity, {
          locationId:
            input.toLocationId === undefined
              ? item.locationId
              : input.toLocationId,
          economicEntityId: input.toEconomicEntityId,
          entityAttributionSource: "manual",
          entityAttributedAt: occurredAt,
          entityAttributedByUserId: input.actorUserId ?? null,
          landedCostAmount: landed,
          acquisitionCostAmount: goods,
          // Whatever the receiving entity's basis is restated to, the SENDING
          // entity gives up the basis it carried. Under `carryover` these are
          // the same number; under `fair_market_value` they differ, and that
          // difference is the step-up or step-down.
          removeLandedCostAmount: carriedBasis,
          removeAcquisitionCostAmount: carriedGoods,
        });

        const out = await recordMovement(tx, {
          inventoryItemId: item.id,
          movementKind: "transfer_out",
          quantity: `-${moveQuantity}`,
          locationId: item.locationId,
          transferGroupId,
          deduplicationKey: movementKeys.transfer(transferGroupId, "out"),
          reasonCode: "entity_transfer",
          note: input.note ?? null,
          occurredAt,
          actorUserId: input.actorUserId ?? null,
        });
        const into = await recordMovement(tx, {
          inventoryItemId: destination.id,
          movementKind: "transfer_in",
          quantity: moveQuantity,
          locationId: destination.locationId,
          transferGroupId,
          deduplicationKey: movementKeys.transfer(transferGroupId, "in"),
          reasonCode: "entity_transfer",
          note: input.note ?? null,
          occurredAt,
          actorUserId: input.actorUserId ?? null,
        });

        return {
          transferGroupId,
          sourceItem: await loadItem(tx, item.id),
          destinationItem: await loadItem(tx, destination.id),
          outMovementId: out.movement.id,
          inMovementId: into.movement.id,
        };
      }),

    reattribute: async (input) => {
      const predicates = [
        `entity_attribution_source in (${REATTRIBUTABLE_SOURCES.map((source) => textLiteral(source)).join(", ")})`,
      ];
      if (input.acquisitionId !== undefined) {
        predicates.push(`acquisition_id = ${uuidLiteral(input.acquisitionId)}`);
      }
      if (input.acquiredBefore !== undefined) {
        predicates.push(
          `acquired_at < '${input.acquiredBefore.toISOString()}'::timestamptz`,
        );
      }
      const result = await db.execute(
        `update inventory_items
            set economic_entity_id = ${
              input.economicEntityId === null
                ? "null"
                : uuidLiteral(input.economicEntityId)
            },
                entity_attribution_source = 'manual',
                entity_attributed_at = now(),
                entity_attributed_by_user_id = ${
                  input.actorUserId === undefined || input.actorUserId === null
                    ? "null"
                    : textLiteral(input.actorUserId)
                },
                updated_at = now()
          where ${predicates.join(" and ")}
        returning id`,
      );
      return { updated: result.rows.length };
    },

    correctCostBasis: async (input) => {
      const reason = input.reason.trim();
      if (reason.length === 0) {
        throw new InventoryImmutableFactError(
          "correcting a cost basis requires a reason: this is the one path " +
            "that rewrites a figure a closed sale has already reported, and " +
            "an unexplained correction is indistinguishable from a bug",
        );
      }
      if (!/^-?\d+(\.\d+)?$/.test(input.landedCostAmount)) {
        throw new InventoryValidationError("expected a plain decimal string");
      }
      return db.transaction(async (tx) => {
        const before = await loadItem(tx, input.inventoryItemId);
        const landed = toMoneyString(input.landedCostAmount);
        const goods = toMoneyString(
          input.acquisitionCostAmount ?? input.landedCostAmount,
        );
        await tx.execute(
          `update inventory_items
              set landed_cost_amount = ${numeric(landed)},
                  acquisition_cost_amount = ${numeric(goods)},
                  updated_at = now()
            where id = ${uuidLiteral(input.inventoryItemId)}`,
        );
        await createAuditService({ db: tx }).append({
          actorUserId: input.actorUserId ?? null,
          action: "inventory.item.cost_basis_corrected",
          resourceType: "inventory_item",
          resourceId: before.id,
          before: {
            landedCostAmount: before.landedCostAmount,
            acquisitionCostAmount: before.acquisitionCostAmount,
            costBasisLockedAt: before.costBasisLockedAt?.toISOString() ?? null,
          },
          after: {
            landedCostAmount: landed,
            acquisitionCostAmount: goods,
          },
          requestId: input.requestId ?? null,
          metadata: { reason, itemCode: before.itemCode },
        });
        return loadItem(tx, input.inventoryItemId);
      });
    },

    availableToSell: async (inventoryItemId) => {
      const result = await db.execute(
        `select (i.quantity_on_hand - coalesce(a.reserved, 0))::numeric(20, 6)::text
                  as available
           from inventory_items i
           left join (select inventory_item_id, sum(quantity) as reserved
                        from inventory_allocations
                       where status = 'reserved'
                       group by inventory_item_id) a
                  on a.inventory_item_id = i.id
          where i.id = ${uuidLiteral(inventoryItemId)}`,
      );
      const value = result.rows[0]?.["available"] as string | undefined;
      if (value === undefined) {
        throw new InventoryNotFoundError(
          `unknown inventory item "${inventoryItemId}"`,
        );
      }
      return value;
    },

    completeIntakeReview: async (inventoryItemId) =>
      db.transaction(async (tx) => {
        const item = await loadItem(tx, inventoryItemId);
        if (item.status !== "intake") {
          throw new InventoryValidationError(
            `cannot complete intake review for "${item.itemCode}": its status ` +
              `is "${item.status}", not "intake" — review is a one-way exit, ` +
              "not a general status setter",
          );
        }
        await tx.execute(
          `update inventory_items
              set status = 'available',
                  updated_at = now()
            where id = ${uuidLiteral(inventoryItemId)}`,
        );
        return loadItem(tx, inventoryItemId);
      }),
  };
}

/* -------------------------------------------------------------- internals */

async function loadItem(
  exec: Executor,
  id: string,
): Promise<InventoryItemRow> {
  const row = await exec.query.inventoryItems.findFirst({
    where: (table, { eq }) => eq(table.id, id),
  });
  if (row === undefined) {
    throw new InventoryNotFoundError(`unknown inventory item "${id}"`);
  }
  return row;
}

function assertMovable(onHand: string, moveQuantity: string): void {
  if (compareDecimals(moveQuantity, "0") <= 0) {
    throw new InventoryValidationError("a transfer quantity must be positive");
  }
  if (compareDecimals(moveQuantity, onHand) > 0) {
    throw new InventoryConflictError(
      `cannot transfer ${moveQuantity} of an item holding ${onHand}: a ` +
        "transfer moves stock that exists, and inventing it would corrupt " +
        "both locations' balances",
    );
  }
}

/**
 * A split's share of basis: `landed × moved / quantity`, rounded to
 * `numeric(20,6)`, with the REMAINDER left on the original row.
 *
 * Rounding down on the moving half rather than up is the conservative choice
 * for the row that is leaving: it never over-consumes the original's basis, so
 * two successive splits can never sum past the lot's landed cost.
 */
function proRataBasis(item: InventoryItemRow, moved: string): string {
  return proRata(item.landedCostAmount, moved, item.quantity);
}

function proRataAcquisitionCost(
  item: InventoryItemRow,
  moved: string,
): string {
  return proRata(item.acquisitionCostAmount, moved, item.quantity);
}

function proRata(amount: string, moved: string, quantity: string): string {
  if (compareDecimals(quantity, "0") === 0) return ZERO;
  if (compareDecimals(moved, quantity) >= 0) return toMoneyString(amount);
  const { shares } = distributeByWeights(amount, [
    moved,
    subtractDecimals(quantity, moved),
  ]);
  return shares[0] ?? ZERO;
}

/**
 * Create the receiving row of a partial transfer or an entity transfer.
 *
 * `origin_item_id` points back at the source, so lineage is a recursive walk
 * when anyone needs it. Basis on the new row is passed in explicitly rather
 * than inherited, which is the whole point of the entity-transfer rule: the
 * open question (carried-over cost or fair market value?) gets ANSWERED on the
 * row instead of silently defaulted.
 */
async function splitItem(
  exec: Executor,
  source: InventoryItemRow,
  quantity: string,
  overrides: {
    locationId: string | null;
    economicEntityId: string | null;
    entityAttributionSource: string;
    entityAttributedAt?: Date | null;
    entityAttributedByUserId?: string | null;
    /** Basis ASSIGNED to the new row. */
    landedCostAmount: string;
    acquisitionCostAmount: string;
    /**
     * Basis REMOVED from the source. Equal to the assigned amount for an
     * ordinary split, and deliberately DIFFERENT under a fair-market-value
     * entity transfer: the sending entity relinquishes the basis it actually
     * carried, while the receiving entity's basis is restated. The gap between
     * the two is the step-up or step-down, which is a real economic event and
     * must not be silently absorbed by leaving basis stranded on a row that
     * holds no stock.
     */
    removeLandedCostAmount: string;
    removeAcquisitionCostAmount: string;
  },
): Promise<InventoryItemRow> {
  const created = await withCodeRetry(
    async () => {
      const rows = await exec
        .insert(inventoryItems)
        .values({
          itemCode: itemCode(),
          acquisitionId: source.acquisitionId,
          catalogItemId: source.catalogItemId,
          economicEntityId: overrides.economicEntityId,
          entityAttributionSource: overrides.entityAttributionSource,
          entityAttributedAt: overrides.entityAttributedAt ?? null,
          entityAttributedByUserId: overrides.entityAttributedByUserId ?? null,
          locationId: overrides.locationId,
          originItemId: source.id,
          label: source.label,
          lotReference: source.lotReference,
          serialNumber: source.serialNumber,
          status: "intake",
          conditionCode: source.conditionCode,
          conditionNotes: source.conditionNotes,
          gradingAuthority: source.gradingAuthority,
          gradeLabel: source.gradeLabel,
          gradeNumeric: source.gradeNumeric,
          certificateNumber: source.certificateNumber,
          quantity,
          quantityOnHand: ZERO,
          currency: source.currency,
          acquisitionCostAmount: overrides.acquisitionCostAmount,
          landedCostAmount: overrides.landedCostAmount,
          costAllocationBasis: source.costAllocationBasis,
          costAllocationWeight: source.costAllocationWeight,
          estimatedValueAmount: source.estimatedValueAmount,
          acquiredAt: source.acquiredAt,
          receivedAt: source.receivedAt,
        })
        .returning();
      const row = rows[0];
      if (row === undefined) {
        throw new InventoryConflictError("split insert returned no row");
      }
      return row;
    },
    { label: "item code" },
  );

  // The source keeps only the remainder of its basis; the moved share went
  // with the new row. `quantity` itself never changes — it is what makes the
  // row a cost layer — so only the money moves.
  await exec.execute(
    `update inventory_items
        set landed_cost_amount =
              (landed_cost_amount - ${numeric(overrides.removeLandedCostAmount)}),
            acquisition_cost_amount =
              (acquisition_cost_amount - ${numeric(overrides.removeAcquisitionCostAmount)}),
            updated_at = now()
      where id = ${uuidLiteral(source.id)}`,
  );

  return created;
}

function nullableText(value: string | null | undefined): string {
  return value === null || value === undefined ? "null" : textLiteral(value);
}

function numeric(value: string): string {
  if (!/^-?\d+(\.\d+)?$/.test(value)) {
    throw new InventoryValidationError("expected a plain decimal string");
  }
  return `${value}::numeric(20, 6)`;
}

/**
 * Reservations against Phase 3 `order_lines`, and depletion on fulfillment.
 *
 * ## Allocation is not a movement
 *
 * A reservation does not move stock and writes NOTHING to
 * `inventory_movements`. This is a rule, not an implementation detail: the
 * ledger records what HAPPENED, and a reservation is an INTENTION that may be
 * released, expired, or cancelled without anything ever having physically
 * occurred. Putting reservations in the ledger would fill an append-only record
 * of facts with events that turned out not to be events, and would make on-hand
 * and available-to-sell the same number when their whole purpose is to differ.
 *
 * ```text
 * quantity_on_hand    sum(inventory_movements.quantity)   cached on the item
 * quantity_reserved   sum(open inventory_allocations)     computed, never cached
 * available_to_sell   on_hand − reserved
 * ```
 *
 * ## Depletion on fulfillment
 *
 * The trigger is a Phase 3 `order_fulfillment_lines` row appearing or
 * increasing — the channel said it shipped. **Not order placement, and not
 * payment: a reseller's stock leaves when it leaves.**
 *
 * ```text
 * order_fulfillment_lines (order_fulfillment_id, order_line_id, quantity)
 *         |
 *         v
 * resolve allocations reserved against that order_line, OLDEST FIRST
 *         |
 *         +-- allocation found  -> depletion_sale movement(s), signed negative,
 *         |                        keyed ffl:<fulfillment>:<line>:alloc:<alloc>,
 *         |                        allocation.status = 'fulfilled',
 *         |                        cost_basis_locked_at set if null,
 *         |                        depleted_at set when on-hand reaches 0
 *         |
 *         +-- no allocation     -> NO movement; the line enters the
 *                                  unmatched-depletion backlog
 * ```
 *
 * **The no-allocation branch never raises**, and that is the load-bearing
 * design rule of this module. It is the COMMON case early in Phase 4: a
 * reseller lists items before Loxep knows about them, sells goods that were
 * never entered, and imports order history from before inventory existed. An
 * order whose stock cannot be found is a visible backlog to resolve, exactly as
 * an unattributed order is in Phase 3.
 *
 * Over-allocation at RESERVE time, by contrast, IS rejected: a reservation is
 * ours to refuse, nobody outside is asserting it, and quietly reserving stock
 * that does not exist is how available-to-sell becomes fiction.
 *
 * All of it — the movement, the allocation status change, the cache update, the
 * basis lock — happens in one transaction.
 */
import type { LoxepDb } from "@loxep/db";
import { inventoryAllocations } from "@loxep/db/schema";
import { z } from "zod";
import {
  ZERO,
  compareDecimals,
  subtractDecimals,
  sumDecimals,
  toMoneyString,
} from "./decimal.ts";
import {
  InventoryAllocationError,
  InventoryNotFoundError,
  InventoryValidationError,
} from "./errors.ts";
import { movementKeys, recordMovement } from "./movements.ts";
import type { Executor } from "./movements.ts";
import { textLiteral, uuidLiteral } from "./sql.ts";

export type InventoryAllocationRow = typeof inventoryAllocations.$inferSelect;

const decimalString = z
  .string()
  .regex(/^-?\d+(\.\d+)?$/, "expected a plain decimal string");

const reserveSchema = z
  .strictObject({
    inventoryItemId: z.uuid(),
    allocationKind: z
      .enum(["order_line", "manual_hold", "transfer", "project"])
      .default("order_line"),
    orderLineId: z.uuid().nullish(),
    quantity: decimalString.default("1"),
    expiresAt: z.date().nullish(),
    createdByUserId: z.string().min(1).nullish(),
    /**
     * Reserve the requested quantity even when it exceeds available-to-sell.
     * Off by default and deliberately awkward to reach: it exists for the
     * operator who KNOWS the physical stock is there and that the ledger is
     * behind, not for a job that finds refusal inconvenient.
     */
    allowOverAllocation: z.boolean().default(false),
  })
  .refine(
    (input) =>
      (input.allocationKind === "order_line") ===
      (input.orderLineId !== undefined && input.orderLineId !== null),
    {
      message:
        "allocationKind 'order_line' requires orderLineId, and vice versa " +
        "(inventory_allocations_kind_reference_check)",
      path: ["orderLineId"],
    },
  );

export type ReserveInput = z.input<typeof reserveSchema>;

export interface DepleteOnFulfillmentInput {
  orderFulfillmentId: string;
  orderLineId: string;
  /** How much the channel said shipped on this line. */
  quantity: string;
  occurredAt?: Date;
  shipmentId?: string | null;
  actorUserId?: string | null;
}

export interface DepletionResult {
  /** One entry per allocation consumed; empty for an unmatched depletion. */
  depletions: {
    allocationId: string;
    inventoryItemId: string;
    quantity: string;
    movementId: string;
    /** False when the deduplication key already existed (a retried job). */
    created: boolean;
    oversell: boolean;
  }[];
  /** Quantity the channel reported that no reservation covered. */
  unmatchedQuantity: string;
  /**
   * True when NOTHING was allocated against this line. Not an error — it is the
   * unmatched-depletion backlog, which an operator resolves.
   */
  unmatched: boolean;
}

export interface AllocationsService {
  /** Reserve stock. Idempotent per (order line, item) while the hold is open. */
  reserve: (input: ReserveInput) => Promise<InventoryAllocationRow>;
  /** Release a `reserved` hold. Frees the partial unique for a later hold. */
  release: (input: {
    allocationId: string;
    reason?: string | null;
    status?: "released" | "cancelled" | "expired";
  }) => Promise<InventoryAllocationRow>;
  /** Consume reservations against a fulfilled line. Never raises on no match. */
  depleteOnFulfillment: (
    input: DepleteOnFulfillmentInput,
  ) => Promise<DepletionResult>;
  /** Sweep `manual_hold` allocations past `expires_at`. */
  expireStaleHolds: (asOf?: Date) => Promise<{ expired: number }>;
  /** Open reservation quantity for one item. */
  reservedQuantity: (inventoryItemId: string) => Promise<string>;
}

export function createAllocationsService(options: {
  db: LoxepDb;
}): AllocationsService {
  const { db } = options;

  return {
    reserve: async (input) => {
      const parsed = reserveSchema.safeParse(input);
      if (!parsed.success) {
        const issues = parsed.error.issues
          .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
          .join("; ");
        throw new InventoryValidationError(`invalid reservation: ${issues}`);
      }
      const value = parsed.data;
      if (compareDecimals(value.quantity, "0") <= 0) {
        throw new InventoryValidationError(
          "a reservation quantity must be positive",
        );
      }

      return db.transaction(async (tx) => {
        const item = await tx.query.inventoryItems.findFirst({
          where: (table, { eq }) => eq(table.id, value.inventoryItemId),
          columns: { id: true, quantityOnHand: true },
        });
        if (item === undefined) {
          throw new InventoryNotFoundError(
            `unknown inventory item "${value.inventoryItemId}"`,
          );
        }

        // The partial unique makes a retried allocation job idempotent rather
        // than a conflict: an open hold for the same (line, item) IS the
        // reservation the caller is asking for.
        if (value.orderLineId !== undefined && value.orderLineId !== null) {
          const open = await tx.query.inventoryAllocations.findFirst({
            where: (table, { and, eq, inArray }) =>
              and(
                eq(table.orderLineId, value.orderLineId ?? ""),
                eq(table.inventoryItemId, value.inventoryItemId),
                inArray(table.status, ["reserved", "fulfilled"]),
              ),
          });
          if (open !== undefined) return open;
        }

        const reserved = await reservedQuantityFor(tx, value.inventoryItemId);
        const available = subtractDecimals(item.quantityOnHand, reserved);
        if (
          !value.allowOverAllocation &&
          compareDecimals(value.quantity, available) > 0
        ) {
          throw new InventoryAllocationError(
            `cannot reserve ${value.quantity}: available-to-sell is ${available} ` +
              `(on hand ${item.quantityOnHand} − reserved ${reserved})`,
          );
        }

        const rows = await tx
          .insert(inventoryAllocations)
          .values({
            inventoryItemId: value.inventoryItemId,
            allocationKind: value.allocationKind,
            orderLineId: value.orderLineId ?? null,
            quantity: value.quantity,
            status: "reserved",
            allocatedAt: new Date(),
            expiresAt: value.expiresAt ?? null,
            createdByUserId: value.createdByUserId ?? null,
          })
          .returning();
        const row = rows[0];
        if (row === undefined) {
          throw new InventoryAllocationError(
            "allocation insert returned no row",
          );
        }
        return row;
      });
    },

    release: async (input) =>
      db.transaction(async (tx) => {
        const allocation = await tx.query.inventoryAllocations.findFirst({
          where: (table, { eq }) => eq(table.id, input.allocationId),
        });
        if (allocation === undefined) {
          throw new InventoryNotFoundError(
            `unknown allocation "${input.allocationId}"`,
          );
        }
        if (allocation.status !== "reserved") {
          throw new InventoryAllocationError(
            `allocation "${input.allocationId}" is ${allocation.status}, not ` +
              "reserved; a fulfilled allocation is history and is corrected " +
              "with a reversal movement, not by releasing it",
          );
        }
        const status = input.status ?? "released";
        await tx.execute(
          `update inventory_allocations
              set status = ${textLiteral(status)},
                  released_at = now(),
                  release_reason = ${
                    input.reason === undefined || input.reason === null
                      ? "null"
                      : textLiteral(input.reason)
                  },
                  updated_at = now()
            where id = ${uuidLiteral(input.allocationId)}`,
        );
        const updated = await tx.query.inventoryAllocations.findFirst({
          where: (table, { eq }) => eq(table.id, input.allocationId),
        });
        if (updated === undefined) {
          throw new InventoryNotFoundError("allocation vanished during release");
        }
        return updated;
      }),

    depleteOnFulfillment: async (input) => {
      if (compareDecimals(input.quantity, "0") <= 0) {
        throw new InventoryValidationError(
          "a fulfilled quantity must be positive",
        );
      }
      return db.transaction(async (tx) => {
        // Oldest first: the reservation that has been waiting longest is the
        // one the operator most likely picked.
        const allocations = await tx.query.inventoryAllocations.findMany({
          where: (table, { and, eq }) =>
            and(
              eq(table.orderLineId, input.orderLineId),
              eq(table.status, "reserved"),
            ),
          orderBy: (table, { asc }) => [asc(table.allocatedAt), asc(table.id)],
        });

        const depletions: DepletionResult["depletions"] = [];
        let remaining = input.quantity;

        for (const allocation of allocations) {
          if (compareDecimals(remaining, "0") <= 0) break;
          const alreadyDepleted = await depletedAgainstAllocation(
            tx,
            allocation.id,
          );
          const outstanding = subtractDecimals(
            allocation.quantity,
            alreadyDepleted,
          );
          if (compareDecimals(outstanding, "0") <= 0) continue;
          // Normalized to numeric(20,6) so a caller-supplied "4" and a
          // database-echoed "4.000000" are one value, not two.
          const take = toMoneyString(
            compareDecimals(outstanding, remaining) <= 0
              ? outstanding
              : remaining,
          );

          const result = await recordMovement(tx, {
            inventoryItemId: allocation.inventoryItemId,
            movementKind: "depletion_sale",
            quantity: `-${take}`,
            inventoryAllocationId: allocation.id,
            orderLineId: input.orderLineId,
            orderFulfillmentId: input.orderFulfillmentId,
            shipmentId: input.shipmentId ?? null,
            deduplicationKey: movementKeys.depletionSale(
              input.orderFulfillmentId,
              input.orderLineId,
              allocation.id,
            ),
            ...(input.occurredAt === undefined
              ? {}
              : { occurredAt: input.occurredAt }),
            actorUserId: input.actorUserId ?? null,
          });

          // Mark fulfilled only once the whole reservation has been consumed;
          // a reservation split across two fulfillments stays open in between,
          // and its two depletions carry two distinct deduplication keys.
          const consumed = sumDecimals([alreadyDepleted, take]);
          if (compareDecimals(consumed, allocation.quantity) >= 0) {
            await tx.execute(
              `update inventory_allocations
                  set status = 'fulfilled',
                      fulfilled_at = now(),
                      updated_at = now()
                where id = ${uuidLiteral(allocation.id)}`,
            );
          }

          depletions.push({
            allocationId: allocation.id,
            inventoryItemId: allocation.inventoryItemId,
            quantity: take,
            movementId: result.movement.id,
            created: result.created,
            oversell: result.oversell,
          });
          remaining = subtractDecimals(remaining, take);
        }

        return {
          depletions,
          unmatchedQuantity:
            compareDecimals(remaining, "0") > 0 ? toMoneyString(remaining) : ZERO,
          unmatched: depletions.length === 0,
        };
      });
    },

    expireStaleHolds: async (asOf) => {
      const cutoff = asOf ?? new Date();
      const result = await db.execute(
        `update inventory_allocations
            set status = 'expired',
                released_at = now(),
                release_reason = 'expired',
                updated_at = now()
          where status = 'reserved'
            and allocation_kind = 'manual_hold'
            and expires_at is not null
            and expires_at < '${cutoff.toISOString()}'::timestamptz
        returning id`,
      );
      return { expired: result.rows.length };
    },

    reservedQuantity: (inventoryItemId) =>
      reservedQuantityFor(db, inventoryItemId),
  };
}

/* -------------------------------------------------------------- internals */

async function reservedQuantityFor(
  exec: Executor | LoxepDb,
  inventoryItemId: string,
): Promise<string> {
  const result = await exec.execute(
    `select coalesce(sum(quantity), 0)::numeric(20, 6)::text as q
       from inventory_allocations
      where inventory_item_id = ${uuidLiteral(inventoryItemId)}
        and status = 'reserved'`,
  );
  return (result.rows[0]?.["q"] as string | undefined) ?? ZERO;
}

/**
 * How much of one allocation the ledger has already consumed, net of any
 * reversal that pointed back at those depletions.
 */
async function depletedAgainstAllocation(
  exec: Executor,
  allocationId: string,
): Promise<string> {
  const result = await exec.execute(
    `select coalesce(-sum(m.quantity + coalesce(r.reversed, 0)), 0)
              ::numeric(20, 6)::text as q
       from inventory_movements m
       left join (select reverses_movement_id, sum(quantity) as reversed
                    from inventory_movements
                   where movement_kind = 'reversal'
                   group by reverses_movement_id) r
              on r.reverses_movement_id = m.id
      where m.inventory_allocation_id = ${uuidLiteral(allocationId)}
        and m.movement_kind = 'depletion_sale'`,
  );
  return (result.rows[0]?.["q"] as string | undefined) ?? ZERO;
}

/** Exposed for the reconciliation read models; see `profitability.ts`. */
export { reservedQuantityFor };

/**
 * The append-only movement ledger, and the SINGLE WRITER of
 * `inventory_items.quantity_on_hand`.
 *
 * ## Why one writer matters (design open question 3)
 *
 * `quantity_on_hand` is a CACHE. The truth is `sum(inventory_movements.quantity)`
 * for the item; the cache exists because that sum sits on the hot path of every
 * listing render and every availability check while the ledger only grows. The
 * design's recommendation — cache it, maintain it in the same transaction as
 * every movement, reconcile nightly — is safe precisely because there is
 * exactly one writer, and this module is it. Nothing else in Loxep may write
 * that column, and nothing else may insert into `inventory_movements`.
 *
 * ### The cache is RECOMPUTED, not incremented
 *
 * {@link recordMovement} writes the movement and then sets
 * `quantity_on_hand = (select coalesce(sum(quantity), 0) from
 * inventory_movements where inventory_item_id = …)` in the same transaction,
 * rather than adding a delta.
 *
 * The design says "maintained as a cache in the same transaction as every
 * movement" without saying how, and the recompute is strictly the better of the
 * two readings at Phase 4 volumes: an item carries a handful of movements, the
 * per-item sum is an index-only range scan on
 * `inventory_movements_item_occurred_at_idx`, and the result cannot drift from
 * this writer's own arithmetic under partial failure or reordering. An
 * increment would be marginally cheaper and would carry the one bug class this
 * whole mechanism exists to avoid.
 *
 * The reconciliation function below still earns its place, because the
 * recompute only guarantees consistency for movements written THROUGH here.
 * A row inserted by a migration, a psql session, or a future service that
 * forgets this rule leaves the cache stale, and that is exactly the drift
 * {@link reconcileQuantityOnHand} is designed to find.
 *
 * ## Append-only is enforced in the database
 *
 * Migration 0005 installs a `BEFORE UPDATE OR DELETE` trigger on
 * `inventory_movements` that raises (design open question 2). This module never
 * attempts either, and neither may anything else: corrections are `reversal`
 * rows naming the movement they reverse. The trigger is not defense in depth
 * for this module — it is the invariant, and this module is merely one of its
 * well-behaved callers.
 *
 * ## Idempotency
 *
 * Every movement carries a deterministic `deduplication_key` computed from the
 * CAUSING FACT (see {@link movementKeys}). Graphile Worker is at-least-once, so
 * {@link recordMovement} probes for the key first and returns the existing
 * movement unchanged rather than writing a second one. A double-fired
 * fulfillment therefore depletes once.
 */
import type { LoxepDb } from "@loxep/db";
import { inventoryMovements } from "@loxep/db/schema";
import type { MovementKind } from "@loxep/db/schema";
import { z } from "zod";
import { ZERO, compareDecimals } from "./decimal.ts";
import { InventoryNotFoundError, InventoryValidationError } from "./errors.ts";
import { numericLiteral, uuidLiteral } from "./sql.ts";

export type MovementRow = typeof inventoryMovements.$inferSelect;

/**
 * Minimal executor interface so every service in this package works with both
 * a database handle and an open transaction — the @loxep/domain
 * `AuditExecutor` pattern, widened to the operations inventory needs.
 */
export type Executor = Parameters<Parameters<LoxepDb["transaction"]>[0]>[0];

/* ------------------------------------------------------- deduplication keys */

/**
 * The design's deduplication key conventions, as functions so no caller has to
 * remember the string shape. Keys are deterministic and computed from the
 * causing fact — NEVER from a timestamp or a random value, because a key that
 * changes between attempts is not a key.
 */
export const movementKeys = {
  receipt: (acquisitionId: string, inventoryItemId: string): string =>
    `acq:${acquisitionId}:item:${inventoryItemId}`,
  /** A receipt with no acquisition (found stock, opening balance). */
  found: (sessionKey: string, inventoryItemId: string): string =>
    `found:${sessionKey}:item:${inventoryItemId}`,
  depletionSale: (
    orderFulfillmentId: string,
    orderLineId: string,
    allocationId: string,
  ): string => `ffl:${orderFulfillmentId}:${orderLineId}:alloc:${allocationId}`,
  returnIn: (orderRefundLineId: string, inventoryItemId: string): string =>
    `rfl:${orderRefundLineId}:item:${inventoryItemId}`,
  transfer: (transferGroupId: string, half: "in" | "out"): string =>
    `xfer:${transferGroupId}:${half}`,
  adjustment: (sessionKey: string, inventoryItemId: string): string =>
    `adj:${sessionKey}:item:${inventoryItemId}`,
  reversal: (reversesMovementId: string): string =>
    `rev:${reversesMovementId}`,
  /** Disposal, shrinkage, and consumption share the adjustment shape. */
  event: (kind: string, sessionKey: string, inventoryItemId: string): string =>
    `${kind}:${sessionKey}:item:${inventoryItemId}`,
} as const;

/* ------------------------------------------------------------------ inputs */

const decimalString = z
  .string()
  .regex(/^-?\d+(\.\d+)?$/, "expected a plain decimal string");

const recordMovementSchema = z.strictObject({
  inventoryItemId: z.uuid(),
  movementKind: z.enum([
    "receipt",
    "transfer_in",
    "return_in",
    "adjustment_in",
    "found",
    "transfer_out",
    "depletion_sale",
    "adjustment_out",
    "shrinkage",
    "disposal",
    "consumption",
    "reversal",
  ]),
  /** SIGNED. Positive increases on-hand, negative decreases it. */
  quantity: decimalString,
  locationId: z.uuid().nullish(),
  transferGroupId: z.uuid().nullish(),
  acquisitionId: z.uuid().nullish(),
  inventoryAllocationId: z.uuid().nullish(),
  orderLineId: z.uuid().nullish(),
  orderFulfillmentId: z.uuid().nullish(),
  shipmentId: z.uuid().nullish(),
  reversesMovementId: z.uuid().nullish(),
  reasonCode: z.string().min(1).nullish(),
  note: z.string().nullish(),
  deduplicationKey: z.string().min(1),
  occurredAt: z.date().optional(),
  actorUserId: z.string().min(1).nullish(),
});

export type RecordMovementInput = z.input<typeof recordMovementSchema>;

export interface RecordMovementResult {
  movement: MovementRow;
  /** False when the deduplication key already existed; nothing was written. */
  created: boolean;
  /** The item's on-hand balance after this movement (or as it already stood). */
  quantityOnHand: string;
  /**
   * True when this write left the item's on-hand balance below zero — the
   * oversell exception. The write SUCCEEDS anyway: blocking it at the database
   * would fail an ingestion job over a business problem the operator must
   * resolve in the physical world. It is surfaced here, loudly, so a caller can
   * report it.
   */
  oversell: boolean;
}

/* ------------------------------------------------------------------- write */

/** Movement kinds whose sign must be positive, per the table's `CHECK`. */
const INBOUND = new Set<MovementKind>([
  "receipt",
  "transfer_in",
  "return_in",
  "adjustment_in",
  "found",
]);

function assertSign(kind: MovementKind, quantity: string): void {
  if (kind === "reversal") return;
  const positive = compareDecimals(quantity, "0") > 0;
  if (INBOUND.has(kind) !== positive) {
    throw new InventoryValidationError(
      `movement kind "${kind}" requires a ${INBOUND.has(kind) ? "positive" : "negative"} quantity`,
    );
  }
}

/**
 * Item status maintenance.
 *
 * `inventory_items.status` is a CONVENIENCE INDEX TARGET, not an authority —
 * quantities and movements are the authority, and any disagreement is a
 * reconciliation finding rather than a constraint violation. So this function
 * is deliberately conservative: it moves an item among the three quantity-derived
 * states and refuses to stomp a state a human or another workflow set.
 *
 * ```text
 * written_off / archived   never touched — a decision, not a quantity
 * listed / reserved        preserved while stock remains; a channel state
 *                          outlives a balance change
 * intake                   preserved while stock remains; leaving review is a
 *                          human decision, not a side effect of the receipt
 *                          movement that put the stock on hand (found live by
 *                          the first /inventory e2e: the create-time default
 *                          receipt was silently promoting every new item past
 *                          the intake review screen)
 * anything else            available | partially_depleted | depleted
 * ```
 */
export function deriveItemStatus(
  current: string,
  quantityOnHand: string,
  quantity: string,
): string {
  if (current === "written_off" || current === "archived") return current;
  if (compareDecimals(quantityOnHand, "0") <= 0) return "depleted";
  if (compareDecimals(quantityOnHand, quantity) < 0) return "partially_depleted";
  if (current === "listed" || current === "reserved" || current === "intake") {
    return current;
  }
  return "available";
}

/**
 * Write one movement and maintain the item's cached balance, in the caller's
 * transaction.
 *
 * Side effects, all inside that one transaction:
 *
 * 1. the movement row (or nothing, if the deduplication key already exists);
 * 2. `inventory_items.quantity_on_hand`, recomputed from the ledger;
 * 3. `inventory_items.status`, per {@link deriveItemStatus};
 * 4. `inventory_items.depleted_at`, set when the balance reaches zero and
 *    CLEARED when a `return_in` or `adjustment_in` brings it back above zero —
 *    a restocked unit is not depleted, and leaving the timestamp would make
 *    every aging report lie about it;
 * 5. `inventory_items.cost_basis_locked_at`, set on the first `depletion_sale`
 *    (design open question 5) if it is still null.
 */
export async function recordMovement(
  exec: Executor,
  input: RecordMovementInput,
): Promise<RecordMovementResult> {
  const parsed = recordMovementSchema.safeParse(input);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("; ");
    throw new InventoryValidationError(`invalid movement: ${issues}`);
  }
  const value = parsed.data;
  if (compareDecimals(value.quantity, "0") === 0) {
    throw new InventoryValidationError("a movement quantity may not be zero");
  }
  assertSign(value.movementKind, value.quantity);

  const item = await exec.query.inventoryItems.findFirst({
    where: (table, { eq }) => eq(table.id, value.inventoryItemId),
    columns: {
      id: true,
      quantity: true,
      status: true,
      costBasisLockedAt: true,
    },
  });
  if (item === undefined) {
    throw new InventoryNotFoundError(
      `unknown inventory item "${value.inventoryItemId}"`,
    );
  }

  const existing = await exec.query.inventoryMovements.findFirst({
    where: (table, { eq }) => eq(table.deduplicationKey, value.deduplicationKey),
  });
  if (existing !== undefined) {
    const onHand = await readOnHand(exec, value.inventoryItemId);
    return {
      movement: existing,
      created: false,
      quantityOnHand: onHand,
      oversell: compareDecimals(onHand, "0") < 0,
    };
  }

  const occurredAt = value.occurredAt ?? new Date();
  const rows = await exec
    .insert(inventoryMovements)
    .values({
      inventoryItemId: value.inventoryItemId,
      movementKind: value.movementKind,
      quantity: value.quantity,
      locationId: value.locationId ?? null,
      transferGroupId: value.transferGroupId ?? null,
      acquisitionId: value.acquisitionId ?? null,
      inventoryAllocationId: value.inventoryAllocationId ?? null,
      orderLineId: value.orderLineId ?? null,
      orderFulfillmentId: value.orderFulfillmentId ?? null,
      shipmentId: value.shipmentId ?? null,
      reversesMovementId: value.reversesMovementId ?? null,
      reasonCode: value.reasonCode ?? null,
      note: value.note ?? null,
      deduplicationKey: value.deduplicationKey,
      occurredAt,
      recordedAt: new Date(),
      actorUserId: value.actorUserId ?? null,
    })
    .returning();
  const movement = rows[0];
  if (movement === undefined) {
    throw new InventoryValidationError("movement insert returned no row");
  }

  const quantityOnHand = await refreshItemBalance(exec, value.inventoryItemId, {
    lockBasis: value.movementKind === "depletion_sale",
  });

  return {
    movement,
    created: true,
    quantityOnHand,
    oversell: compareDecimals(quantityOnHand, "0") < 0,
  };
}

async function readOnHand(exec: Executor, itemId: string): Promise<string> {
  const result = await exec.execute(
    `select quantity_on_hand::text as q from inventory_items
      where id = ${uuidLiteral(itemId)}`,
  );
  return (result.rows[0]?.["q"] as string | undefined) ?? ZERO;
}

/**
 * Recompute one item's cached balance from the ledger and reconcile the
 * quantity-derived columns with it. Returns the new balance.
 *
 * This is the ONLY statement in Loxep that writes `quantity_on_hand`.
 */
export async function refreshItemBalance(
  exec: Executor,
  itemId: string,
  options: { lockBasis?: boolean } = {},
): Promise<string> {
  const item = await exec.query.inventoryItems.findFirst({
    where: (table, { eq }) => eq(table.id, itemId),
    columns: { id: true, quantity: true, status: true },
  });
  if (item === undefined) {
    throw new InventoryNotFoundError(`unknown inventory item "${itemId}"`);
  }

  const summed = await exec.execute(
    `select coalesce(sum(quantity), 0)::numeric(20, 6)::text as q
       from inventory_movements
      where inventory_item_id = ${uuidLiteral(itemId)}`,
  );
  const onHand = (summed.rows[0]?.["q"] as string | undefined) ?? ZERO;
  const status = deriveItemStatus(item.status, onHand, item.quantity);
  const depleted = compareDecimals(onHand, "0") <= 0;

  await exec.execute(
    `update inventory_items
        set quantity_on_hand = ${numericLiteral(onHand)},
            status = '${status}',
            depleted_at = ${depleted ? "coalesce(depleted_at, now())" : "null"},
            cost_basis_locked_at = ${
              options.lockBasis === true
                ? "coalesce(cost_basis_locked_at, now())"
                : "cost_basis_locked_at"
            },
            updated_at = now()
      where id = ${uuidLiteral(itemId)}`,
  );
  return onHand;
}

/* --------------------------------------------------------- reconciliation */

/** One item whose cached balance disagrees with its ledger. */
export interface QuantityDrift {
  inventoryItemId: string;
  itemCode: string;
  /** What `inventory_items.quantity_on_hand` claimed. */
  cachedQuantityOnHand: string;
  /** What `sum(inventory_movements.quantity)` actually is. */
  ledgerQuantityOnHand: string;
  /** `ledger − cached`; the amount the cache was wrong by. */
  difference: string;
}

export interface ReconcileResult {
  itemsChecked: number;
  drift: QuantityDrift[];
  /** True when `apply` was requested and every drifted cache was rewritten. */
  repaired: boolean;
}

/**
 * Compare every item's cached balance against its ledger and report the drift
 * (design open question 3's "nightly reconciliation job compares them and
 * reports drift").
 *
 * Read-only by default. `apply: true` rewrites the caches from the ledger,
 * which is always safe in the correct direction — the ledger is the truth and
 * the cache is not — but it is opt-in, because a silent repair would hide the
 * fact that something wrote a movement without going through
 * {@link recordMovement}. Finding drift in normal operation is the design's
 * stated trigger to revisit caching at all, and that signal must not be
 * swallowed by a job that quietly fixes it.
 */
export async function reconcileQuantityOnHand(
  db: LoxepDb,
  options: { apply?: boolean; inventoryItemId?: string } = {},
): Promise<ReconcileResult> {
  const scope =
    options.inventoryItemId === undefined
      ? ""
      : ` and i.id = ${uuidLiteral(options.inventoryItemId)}`;
  const counted = await db.execute(
    `select count(*)::int as n from inventory_items i where true${scope}`,
  );
  const drifted = await db.execute(
    `select i.id::text as id,
            i.item_code,
            i.quantity_on_hand::text as cached,
            coalesce(l.total, 0)::numeric(20, 6)::text as ledger,
            (coalesce(l.total, 0) - i.quantity_on_hand)::numeric(20, 6)::text
              as difference
       from inventory_items i
       left join (select inventory_item_id, sum(quantity) as total
                    from inventory_movements
                   group by inventory_item_id) l
              on l.inventory_item_id = i.id
      where coalesce(l.total, 0) <> i.quantity_on_hand${scope}
      order by i.item_code`,
  );

  const drift: QuantityDrift[] = drifted.rows.map((row) => ({
    inventoryItemId: row["id"] as string,
    itemCode: row["item_code"] as string,
    cachedQuantityOnHand: row["cached"] as string,
    ledgerQuantityOnHand: row["ledger"] as string,
    difference: row["difference"] as string,
  }));

  if (options.apply === true && drift.length > 0) {
    await db.transaction(async (tx) => {
      for (const entry of drift) {
        await refreshItemBalance(tx, entry.inventoryItemId);
      }
    });
  }

  return {
    itemsChecked: Number(counted.rows[0]?.["n"] ?? 0),
    drift,
    repaired: options.apply === true && drift.length > 0,
  };
}

/* ------------------------------------------------------------------ service */

export interface MovementsService {
  /** Write one movement and maintain the cache. Idempotent on the dedup key. */
  record: (input: RecordMovementInput) => Promise<RecordMovementResult>;
  /**
   * Correct one prior movement with a `reversal` row of the opposite sign.
   * There is no other correction path: the table is append-only and the
   * database enforces it.
   */
  reverse: (input: {
    movementId: string;
    reasonCode?: string | null;
    note?: string | null;
    actorUserId?: string | null;
    occurredAt?: Date;
  }) => Promise<RecordMovementResult>;
  /** On-hand balance straight from the ledger, ignoring the cache. */
  ledgerBalance: (inventoryItemId: string) => Promise<string>;
  reconcile: (options?: {
    apply?: boolean;
    inventoryItemId?: string;
  }) => Promise<ReconcileResult>;
}

export function createMovementsService(options: {
  db: LoxepDb;
}): MovementsService {
  const { db } = options;

  return {
    record: (input) => db.transaction((tx) => recordMovement(tx, input)),

    reverse: async (input) =>
      db.transaction(async (tx) => {
        const original = await tx.query.inventoryMovements.findFirst({
          where: (table, { eq }) => eq(table.id, input.movementId),
        });
        if (original === undefined) {
          throw new InventoryNotFoundError(
            `unknown movement "${input.movementId}"`,
          );
        }
        return recordMovement(tx, {
          inventoryItemId: original.inventoryItemId,
          movementKind: "reversal",
          quantity: original.quantity.startsWith("-")
            ? original.quantity.slice(1)
            : `-${original.quantity}`,
          locationId: original.locationId,
          acquisitionId: original.acquisitionId,
          orderLineId: original.orderLineId,
          reversesMovementId: original.id,
          reasonCode: input.reasonCode ?? null,
          note: input.note ?? null,
          deduplicationKey: movementKeys.reversal(original.id),
          ...(input.occurredAt === undefined
            ? {}
            : { occurredAt: input.occurredAt }),
          actorUserId: input.actorUserId ?? null,
        });
      }),

    ledgerBalance: async (inventoryItemId) => {
      const result = await db.execute(
        `select coalesce(sum(quantity), 0)::numeric(20, 6)::text as q
           from inventory_movements
          where inventory_item_id = ${uuidLiteral(inventoryItemId)}`,
      );
      return (result.rows[0]?.["q"] as string | undefined) ?? ZERO;
    },

    reconcile: (reconcileOptions) =>
      reconcileQuantityOnHand(db, reconcileOptions ?? {}),
  };
}

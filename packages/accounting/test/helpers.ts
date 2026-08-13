/**
 * Scratch-database lifecycle and seed helpers for the @loxep/accounting suite.
 *
 * Real PostgreSQL/TimescaleDB (docker/compose.dev.yml, host port 5433), never a
 * SQLite substitute — every `CHECK` in migration 0006, the `media_links`
 * natural key from 0004, `num_nonnulls`, and exact `numeric(20,6)` arithmetic
 * have no meaning anywhere else. Each test file provisions its own scratch
 * database so files run in parallel and never depend on leftover state.
 *
 * `pg` is not a direct dependency of this package, so maintenance queries go
 * through @loxep/db's pooled handle — the @loxep/commerce, @loxep/market, and
 * @loxep/inventory pattern.
 */
import { Buffer } from "node:buffer";
import { randomBytes } from "node:crypto";
import { closeDb, createDb, runMigrations } from "@loxep/db";
import type { DbHandle } from "@loxep/db";
import {
  acquisitionCosts,
  acquisitions,
  catalogItems,
  connections,
  economicEntities,
  inventoryItems,
  inventoryMovements,
  orderFees,
  orderLines,
  orderRefunds,
  orders,
  user,
} from "@loxep/db/schema";
import type { createSecretsService } from "@loxep/domain";
import { createMediaService, createStorageBackendsService } from "@loxep/storage";
import type { MediaService } from "@loxep/storage";

const DEFAULT_TEST_DATABASE_URL =
  "postgres://postgres:loxep-dev@localhost:5433/loxep_test";

export const baseDatabaseUrl =
  process.env["LOXEP_TEST_DATABASE_URL"] ?? DEFAULT_TEST_DATABASE_URL;

function maintenanceUrl(): string {
  const url = new URL(baseDatabaseUrl);
  url.pathname = "/postgres";
  return url.toString();
}

function databaseUrlFor(databaseName: string): string {
  const url = new URL(baseDatabaseUrl);
  url.pathname = `/${databaseName}`;
  return url.toString();
}

export function scratchDbName(prefix: string): string {
  return `${prefix}_${randomBytes(4).toString("hex")}`;
}

export const silentLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
};

export interface ScratchDb {
  name: string;
  handle: DbHandle;
  close: () => Promise<void>;
}

async function withMaintenanceDb(sql: string): Promise<void> {
  const handle = createDb(maintenanceUrl());
  try {
    await handle.pool.query(sql);
  } finally {
    await closeDb(handle);
  }
}

/** Create a migrated scratch database and a pooled handle bound to it. */
export async function createMigratedScratchDb(
  prefix: string,
): Promise<ScratchDb> {
  const name = scratchDbName(prefix);
  await withMaintenanceDb(`create database "${name}"`);
  const databaseUrl = databaseUrlFor(name);
  await runMigrations({ databaseUrl, logger: silentLogger });
  const handle = createDb(databaseUrl);
  return {
    name,
    handle,
    close: async () => {
      await closeDb(handle);
      await withMaintenanceDb(`drop database if exists "${name}" with (force)`);
    },
  };
}

export async function seedEntity(
  scratch: ScratchDb,
  name: string,
  kind = "llc",
): Promise<string> {
  const rows = await scratch.handle.db
    .insert(economicEntities)
    .values({ name, kind })
    .returning({ id: economicEntities.id });
  const id = rows[0]?.id;
  if (id === undefined) throw new Error("entity insert returned no row");
  return id;
}

/**
 * An assumed name INSIDE another entity — the shape the owner's book answer is
 * about. Its activity is viewable on its own and its totals land in the
 * parent's book.
 */
export async function seedChildEntity(
  scratch: ScratchDb,
  name: string,
  parentEntityId: string,
  kind = "assumed_name",
): Promise<string> {
  const rows = await scratch.handle.db
    .insert(economicEntities)
    .values({ name, kind, parentEntityId })
    .returning({ id: economicEntities.id });
  const id = rows[0]?.id;
  if (id === undefined) throw new Error("child entity insert returned no row");
  return id;
}

/** A Better Auth user row usable as an FK-valid actor (ADR-0020). */
export async function seedUser(
  scratch: ScratchDb,
  id: string,
): Promise<string> {
  await scratch.handle.db.insert(user).values({
    id,
    name: `Test User ${id}`,
    email: `${id}@example.test`,
  });
  return id;
}

/** A Phase 4 lot, so allocation and cost-reference foreign keys are real. */
export async function seedAcquisition(
  scratch: ScratchDb,
  referenceCode: string,
): Promise<{ acquisitionId: string; acquisitionCostId: string }> {
  const rows = await scratch.handle.db
    .insert(acquisitions)
    .values({
      entityAttributionSource: "unattributed",
      sourceKind: "estate_sale",
      status: "open",
      referenceCode,
      title: `Lot ${referenceCode}`,
      currency: "USD",
      costAllocationBasis: "equal",
      costAllocationStatus: "pending",
      acquiredAt: new Date("2026-03-01T12:00:00Z"),
    })
    .returning({ id: acquisitions.id });
  const acquisitionId = rows[0]?.id;
  if (acquisitionId === undefined) {
    throw new Error("acquisition insert returned no row");
  }
  const costRows = await scratch.handle.db
    .insert(acquisitionCosts)
    .values({
      acquisitionId,
      costScope: "lot",
      costType: "fuel_mileage",
      costClass: "ancillary",
      capitalize: false,
      currency: "USD",
      amount: "24.500000",
    })
    .returning({ id: acquisitionCosts.id });
  const acquisitionCostId = costRows[0]?.id;
  if (acquisitionCostId === undefined) {
    throw new Error("acquisition cost insert returned no row");
  }
  return { acquisitionId, acquisitionCostId };
}

/* ------------------------------------------- Phase 4 facts, for COGS posting */

/**
 * A lot, its capitalized cost, and one item carrying that cost as basis.
 *
 * `@loxep/inventory` is deliberately **not** a dependency of `@loxep/accounting`
 * (see `src/decimal.ts` on why this package does not acquire package edges to
 * reach a handful of functions), so the fixture writes the rows that package's
 * services would write, including the two pieces of state the COGS reader
 * depends on: `landed_cost_amount` as its allocation engine would have set it,
 * and `quantity_on_hand` as `recordMovement` recomputes it. The COGS assertions
 * are then about the READER's arithmetic against real PostgreSQL `numeric`,
 * which is what this suite can honestly own.
 */
export async function seedLotWithItem(
  scratch: ScratchDb,
  input: {
    referenceCode: string;
    itemCode: string;
    /** The capitalized cost of the goods; becomes the item's landed basis. */
    goodsAmount: string;
    /** A `capitalize = false` row, when the fixture wants one. */
    nonCapitalizedAmount?: string;
    quantity?: string;
    economicEntityId?: string | null;
    currency?: string;
    costCurrency?: string;
    acquiredAt?: string;
    sourceKind?: string;
    status?: string;
  },
): Promise<{
  acquisitionId: string;
  goodsCostId: string;
  nonCapitalizedCostId: string | null;
  inventoryItemId: string;
}> {
  const currency = input.currency ?? "USD";
  const quantity = input.quantity ?? "1";
  const acquiredAt = new Date(input.acquiredAt ?? "2025-07-01T12:00:00Z");

  const lotRows = await scratch.handle.db
    .insert(acquisitions)
    .values({
      economicEntityId: input.economicEntityId ?? null,
      entityAttributionSource:
        input.economicEntityId == null ? "unattributed" : "manual",
      sourceKind: input.sourceKind ?? "estate_sale",
      status: input.status ?? "open",
      referenceCode: input.referenceCode,
      title: `Lot ${input.referenceCode}`,
      currency,
      costAllocationBasis: "equal",
      costAllocationStatus: "final",
      acquiredAt,
    })
    .returning({ id: acquisitions.id });
  const acquisitionId = lotRows[0]?.id;
  if (acquisitionId === undefined) {
    throw new Error("acquisition insert returned no row");
  }

  const goodsRows = await scratch.handle.db
    .insert(acquisitionCosts)
    .values({
      acquisitionId,
      costScope: "lot",
      costType: "goods",
      costClass: "goods",
      capitalize: true,
      currency: input.costCurrency ?? currency,
      amount: input.goodsAmount,
      incurredAt: acquiredAt,
    })
    .returning({ id: acquisitionCosts.id });
  const goodsCostId = goodsRows[0]?.id;
  if (goodsCostId === undefined) {
    throw new Error("acquisition cost insert returned no row");
  }

  let nonCapitalizedCostId: string | null = null;
  if (input.nonCapitalizedAmount !== undefined) {
    const rows = await scratch.handle.db
      .insert(acquisitionCosts)
      .values({
        acquisitionId,
        costScope: "lot",
        costType: "fuel_mileage",
        costClass: "ancillary",
        capitalize: false,
        currency,
        amount: input.nonCapitalizedAmount,
        incurredAt: acquiredAt,
      })
      .returning({ id: acquisitionCosts.id });
    nonCapitalizedCostId = rows[0]?.id ?? null;
  }

  const itemRows = await scratch.handle.db
    .insert(inventoryItems)
    .values({
      itemCode: input.itemCode,
      acquisitionId,
      economicEntityId: input.economicEntityId ?? null,
      entityAttributionSource:
        input.economicEntityId == null ? "unattributed" : "manual",
      label: `Item ${input.itemCode}`,
      status: "available",
      conditionCode: "good",
      quantity,
      quantityOnHand: quantity,
      currency,
      acquisitionCostAmount: input.goodsAmount,
      landedCostAmount: input.goodsAmount,
      costAllocationBasis: "equal",
      acquiredAt,
    })
    .returning({ id: inventoryItems.id });
  const inventoryItemId = itemRows[0]?.id;
  if (inventoryItemId === undefined) {
    throw new Error("inventory item insert returned no row");
  }

  return { acquisitionId, goodsCostId, nonCapitalizedCostId, inventoryItemId };
}

/** One order line, so a depletion can name the sale it belongs to. */
export async function seedOrderLine(
  scratch: ScratchDb,
  input: {
    orderId: string;
    lineNumber?: number;
    quantity?: string;
    unitPrice: string;
    lineTotal?: string;
  },
): Promise<string> {
  const rows = await scratch.handle.db
    .insert(orderLines)
    .values({
      orderId: input.orderId,
      lineNumber: input.lineNumber ?? 1,
      quantity: input.quantity ?? "1",
      unitPrice: input.unitPrice,
      lineSubtotal: input.lineTotal ?? input.unitPrice,
      lineTotal: input.lineTotal ?? input.unitPrice,
    })
    .returning({ id: orderLines.id });
  const id = rows[0]?.id;
  if (id === undefined) throw new Error("order line insert returned no row");
  return id;
}

/**
 * A movement, written the way `@loxep/inventory`'s `recordMovement` writes one:
 * the row, the recomputed `quantity_on_hand`, and — on a `depletion_sale` — the
 * `cost_basis_locked_at` freeze that is the whole reason COGS can be an exact
 * number rather than a recomputation.
 */
export async function seedMovement(
  scratch: ScratchDb,
  input: {
    inventoryItemId: string;
    movementKind: string;
    /** SIGNED, as the table's own CHECK requires. */
    quantity: string;
    occurredAt: string;
    orderLineId?: string | null;
    reversesMovementId?: string | null;
    transferGroupId?: string | null;
    deduplicationKey?: string;
  },
): Promise<string> {
  const rows = await scratch.handle.db
    .insert(inventoryMovements)
    .values({
      inventoryItemId: input.inventoryItemId,
      movementKind: input.movementKind,
      quantity: input.quantity,
      orderLineId: input.orderLineId ?? null,
      reversesMovementId: input.reversesMovementId ?? null,
      transferGroupId: input.transferGroupId ?? null,
      deduplicationKey:
        input.deduplicationKey ??
        `test:${input.movementKind}:${input.inventoryItemId}:${input.occurredAt}`,
      occurredAt: new Date(input.occurredAt),
    })
    .returning({ id: inventoryMovements.id });
  const id = rows[0]?.id;
  if (id === undefined) throw new Error("movement insert returned no row");

  await scratch.handle.pool.query(
    `update inventory_items
        set quantity_on_hand = (select coalesce(sum(quantity), 0)
                                  from inventory_movements
                                 where inventory_item_id = $1),
            cost_basis_locked_at = case when $2 = 'depletion_sale'
                                        then coalesce(cost_basis_locked_at, now())
                                        else cost_basis_locked_at end,
            updated_at = now()
      where id = $1`,
    [input.inventoryItemId, input.movementKind],
  );
  return id;
}

export async function seedCatalogItem(
  scratch: ScratchDb,
  sku: string,
): Promise<string> {
  const rows = await scratch.handle.db
    .insert(catalogItems)
    .values({ sku, kind: "simple", name: `Item ${sku}`, status: "active" })
    .returning({ id: catalogItems.id });
  const id = rows[0]?.id;
  if (id === undefined) throw new Error("catalog item insert returned no row");
  return id;
}

type Keyring = Parameters<typeof createSecretsService>[0]["keyring"];

/** Deterministic structural test keyring (ADR-0019 shape). */
function testKeyring(): Keyring {
  return { activeVersion: 1, keys: new Map([[1, Buffer.alloc(32, 1)]]) };
}

/**
 * A real {@link MediaService} bound to the scratch database, plus a
 * `media_objects` row to attach.
 *
 * The bytes are never written: receipt attachment exercises `addLink` /
 * `listLinksForResource` / `removeLink`, none of which resolve a storage
 * driver. Seeding the rows directly keeps the receipt tests about the
 * `media_links` contract — which is what Phase 5 actually relies on — rather
 * than about local-filesystem I/O that `@loxep/storage`'s own conformance
 * suite already covers.
 */
export async function seedMedia(
  scratch: ScratchDb,
  sha256: string,
): Promise<{ media: MediaService; mediaObjectId: string }> {
  const backend = await scratch.handle.pool.query<{ id: string }>(
    `insert into storage_backends (name, driver, config)
     values ('local-test', 'local', '{"root":"/tmp/loxep-accounting-test"}'::jsonb)
     on conflict do nothing
     returning id`,
  );
  const backendId =
    backend.rows[0]?.id ??
    (
      await scratch.handle.pool.query<{ id: string }>(
        `select id from storage_backends limit 1`,
      )
    ).rows[0]?.id;
  if (backendId === undefined) throw new Error("no storage backend seeded");

  const media = await scratch.handle.pool.query<{ id: string }>(
    `insert into media_objects (storage_backend_id, storage_key, original_filename,
                                mime_type, size_bytes, sha256)
     values ($1, $2, 'receipt.jpg', 'image/jpeg', 1024, $3)
     returning id`,
    [backendId, `media/${sha256}.jpg`, sha256],
  );
  const mediaObjectId = media.rows[0]?.id;
  if (mediaObjectId === undefined) {
    throw new Error("media object insert returned no row");
  }

  return {
    media: createMediaService({
      db: scratch.handle.db,
      backends: createStorageBackendsService({
        db: scratch.handle.db,
        keyring: testKeyring(),
      }),
    }),
    mediaObjectId,
  };
}

/** Every `audit_events` row for one action, newest first. */
export async function auditEventsFor(
  scratch: ScratchDb,
  action: string,
): Promise<
  { resourceId: string | null; before: unknown; after: unknown; metadata: unknown }[]
> {
  const result = await scratch.handle.pool.query(
    `select resource_id, before, after, metadata
       from audit_events where action = $1
      order by occurred_at desc, id desc`,
    [action],
  );
  return result.rows.map((row) => ({
    resourceId: (row["resource_id"] as string | null) ?? null,
    before: row["before"],
    after: row["after"],
    metadata: row["metadata"],
  }));
}

/* ----------------------------------------------- Phase 3 facts, for the rules */

/**
 * A provider connection, because `orders.connection_id` is `not null`: Phase 3
 * ingestion is the only way an order can arrive, and the posting rules read
 * real orders rather than a fixture shape of their own.
 */
export async function seedConnection(
  scratch: ScratchDb,
  provider = "ebay",
): Promise<string> {
  const rows = await scratch.handle.db
    .insert(connections)
    .values({
      provider,
      kind: "marketplace",
      name: `${provider} test`,
      status: "active",
    })
    .returning({ id: connections.id });
  const id = rows[0]?.id;
  if (id === undefined) throw new Error("connection insert returned no row");
  return id;
}

export interface SeedOrderInput {
  connectionId: string;
  economicEntityId?: string | null;
  externalOrderId: string;
  placedAt?: string;
  currency?: string;
  subtotal: string;
  shipping?: string;
  discount?: string;
  tax?: string;
  fee?: string;
  refunded?: string;
  total: string;
  status?: string;
  provider?: string;
  channel?: string;
}

export async function seedOrder(
  scratch: ScratchDb,
  input: SeedOrderInput,
): Promise<string> {
  const rows = await scratch.handle.db
    .insert(orders)
    .values({
      connectionId: input.connectionId,
      provider: input.provider ?? "ebay",
      channel: input.channel ?? "ebay",
      sourceAccountKey: "ebay:test-seller",
      externalOrderId: input.externalOrderId,
      externalOrderNumber: input.externalOrderId,
      economicEntityId: input.economicEntityId ?? null,
      entityAttributionSource:
        input.economicEntityId == null ? "unattributed" : "manual",
      status: input.status ?? "completed",
      paymentStatus: "paid",
      fulfillmentStatus: "fulfilled",
      currency: input.currency ?? "USD",
      subtotalAmount: input.subtotal,
      shippingAmount: input.shipping ?? "0",
      discountAmount: input.discount ?? "0",
      taxAmount: input.tax ?? "0",
      feeAmount: input.fee ?? "0",
      refundedAmount: input.refunded ?? "0",
      totalAmount: input.total,
      placedAt: new Date(input.placedAt ?? "2026-02-10T12:00:00Z"),
    })
    .returning({ id: orders.id });
  const id = rows[0]?.id;
  if (id === undefined) throw new Error("order insert returned no row");
  return id;
}

export async function seedOrderFee(
  scratch: ScratchDb,
  input: {
    orderId: string;
    feeDirection: "seller_charge" | "buyer_surcharge";
    feeType: string;
    amount: string;
    currency?: string;
    chargedAt?: string;
    externalFeeId?: string;
  },
): Promise<string> {
  const rows = await scratch.handle.db
    .insert(orderFees)
    .values({
      orderId: input.orderId,
      feeScope: "order",
      feeDirection: input.feeDirection,
      feeType: input.feeType,
      externalFeeId: input.externalFeeId ?? null,
      currency: input.currency ?? "USD",
      amount: input.amount,
      chargedAt: new Date(input.chargedAt ?? "2026-02-11T12:00:00Z"),
    })
    .returning({ id: orderFees.id });
  const id = rows[0]?.id;
  if (id === undefined) throw new Error("order fee insert returned no row");
  return id;
}

export async function seedOrderRefund(
  scratch: ScratchDb,
  input: {
    orderId: string;
    amount: string;
    status?: string;
    kind?: string;
    currency?: string;
    refundedAt?: string;
  },
): Promise<string> {
  const rows = await scratch.handle.db
    .insert(orderRefunds)
    .values({
      orderId: input.orderId,
      kind: input.kind ?? "full",
      status: input.status ?? "completed",
      currency: input.currency ?? "USD",
      amount: input.amount,
      refundedAt: new Date(input.refundedAt ?? "2026-02-15T12:00:00Z"),
    })
    .returning({ id: orderRefunds.id });
  const id = rows[0]?.id;
  if (id === undefined) throw new Error("order refund insert returned no row");
  return id;
}

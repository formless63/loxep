/**
 * eBay purchase-history ingestion tests (loxep-dgf.5).
 *
 * SANDBOX-UNVERIFIABLE NOTE: these tests exercise `@loxep/inventory`'s own
 * ingestion/sync machinery against a real scratch database with a FAKE
 * `EbayPurchasePageIterator` — they say nothing about whether
 * `@loxep/integration-ebay`'s `WonList` mapper matches eBay's real payload
 * shape (see that package's `purchases.ts`/`purchases.test.ts` module docs
 * for why that cannot be verified in this environment at all).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  EBAY_PURCHASES_TARGET_TYPE,
  PURCHASE_SYNC_CONFIG_KEY,
  createEbayPurchaseSync,
  createPurchaseIngestionService,
  ensurePurchaseSyncTarget,
  purchaseSyncTargetConfigSchema,
  readPurchaseSyncCursor,
  writePurchaseSyncCursor,
} from "../src/purchase-sync.ts";
import type { EbayPurchaseFactLike } from "../src/purchase-sync.ts";
import { InventoryValidationError } from "../src/errors.ts";
import { createMigratedScratchDb, seedConnection, seedEntity } from "./helpers.ts";
import type { ScratchDb } from "./helpers.ts";

let scratch: ScratchDb;

beforeAll(async () => {
  scratch = await createMigratedScratchDb("inv_purchase_sync");
}, 60_000);

afterAll(async () => {
  await scratch.close();
});

function fact(
  externalOrderId: string,
  overrides: Partial<EbayPurchaseFactLike> = {},
): EbayPurchaseFactLike {
  return {
    externalOrderId,
    sellerExternalId: "sandbox_seller",
    currency: "USD",
    title: `eBay purchase ${externalOrderId}`,
    itemPriceAmount: "19.99",
    shippingAmount: "4.50",
    taxAmount: "1.75",
    totalAmount: "26.24",
    purchasedAt: "2026-08-10T12:00:00.000Z",
    raw: [{ Transaction: { TransactionID: externalOrderId } }],
    ...overrides,
  };
}

describe("ensurePurchaseSyncTarget / cursor round trip", () => {
  it("creates one target per connection and finds it again", async () => {
    const connectionId = await seedConnection(scratch, {
      name: "eBay buyer account",
      provider: "ebay",
    });
    const first = await ensurePurchaseSyncTarget(scratch.handle.db, { connectionId });
    const second = await ensurePurchaseSyncTarget(scratch.handle.db, { connectionId });
    expect(second.monitorTargetId).toBe(first.monitorTargetId);

    const row = await scratch.handle.db.query.monitorTargets.findFirst({
      where: (table, { eq }) => eq(table.id, first.monitorTargetId),
    });
    expect(row?.targetType).toBe(EBAY_PURCHASES_TARGET_TYPE);
    // Cadence is hours, not the 60-second monitor baseline.
    expect(row?.intervalSeconds).toBeGreaterThanOrEqual(3600);
  });

  it("round-trips a null watermark without poisoning the config (regression)", async () => {
    const connectionId = await seedConnection(scratch, {
      name: "null watermark account",
      provider: "ebay",
    });
    const cursor = await ensurePurchaseSyncTarget(scratch.handle.db, { connectionId });

    // A sync that saw zero purchases writes an explicit null watermark.
    await writePurchaseSyncCursor(scratch.handle.db, cursor.monitorTargetId, {
      lastPurchasedAt: null,
      lastSyncedAt: new Date("2026-08-13T00:00:00.000Z"),
      lastPurchaseCount: 0,
    });

    const read = await readPurchaseSyncCursor(scratch.handle.db, connectionId);
    expect(read?.lastPurchasedAt).toBeNull();
    expect(read?.lastPurchaseCount).toBe(0);

    // The config this wrote must also validate on a SECOND read — the exact
    // shape of the historical bug (a schema that rejects a stored null on a
    // later read of its own row).
    const row = await scratch.handle.db.query.monitorTargets.findFirst({
      where: (table, { eq }) => eq(table.id, cursor.monitorTargetId),
    });
    expect(() => purchaseSyncTargetConfigSchema.parse(row?.config)).not.toThrow();
  });

  it("accepts a config carrying the scheduler's own adaptive namespace untouched", () => {
    const config = {
      [PURCHASE_SYNC_CONFIG_KEY]: { lastPurchasedAt: null, lastSyncedAt: "2026-08-13T00:00:00.000Z" },
      adaptive: { streak: 3, enabled: true },
    };
    expect(() => purchaseSyncTargetConfigSchema.parse(config)).not.toThrow();
  });
});

describe("createPurchaseIngestionService", () => {
  it("creates a draft acquisition with goods/shipping/tax costs from a purchase fact", async () => {
    const entityId = await seedEntity(scratch, "Flip LLC");
    const connectionId = await seedConnection(scratch, {
      name: "attributed ebay buyer",
      provider: "ebay",
      economicEntityId: entityId,
    });
    const ingestion = createPurchaseIngestionService({ db: scratch.handle.db });

    const result = await ingestion.ingestEbayPurchase({
      connectionId,
      fact: fact("ORDER-1"),
    });

    expect(result.created).toBe(true);
    expect(result.skipped).toBe(false);
    expect(result.acquisition.status).toBe("draft");
    expect(result.acquisition.sourceKind).toBe("online_marketplace");
    expect(result.acquisition.externalReference).toBe("ORDER-1");
    expect(result.acquisition.vendorName).toBe("sandbox_seller");
    // Connection-default attribution: the payoff of the pre-widened CHECK.
    expect(result.acquisition.economicEntityId).toBe(entityId);
    expect(result.acquisition.entityAttributionSource).toBe("connection_default");

    const costs = await scratch.handle.db.query.acquisitionCosts.findMany({
      where: (table, { eq }) => eq(table.acquisitionId, result.acquisition.id),
    });
    expect(costs).toHaveLength(3);
    const byType = new Map(costs.map((cost) => [cost.costType, cost]));
    expect(byType.get("goods")).toMatchObject({ costClass: "goods", amount: "19.990000" });
    expect(byType.get("inbound_freight")).toMatchObject({ costClass: "ancillary", amount: "4.500000" });
    expect(byType.get("sales_tax")).toMatchObject({ costClass: "ancillary", amount: "1.750000" });

    const providerObjectRows = await scratch.handle.db.execute(
      `select object_type, external_object_id from provider_objects where connection_id = '${connectionId}'`,
    );
    expect(providerObjectRows.rows).toEqual([
      { object_type: "ebay.purchase", external_object_id: "ORDER-1" },
    ]);
  });

  it("skips zero-amount cost rows rather than writing empty ones", async () => {
    const connectionId = await seedConnection(scratch, { name: "no-tax buyer", provider: "ebay" });
    const ingestion = createPurchaseIngestionService({ db: scratch.handle.db });
    const result = await ingestion.ingestEbayPurchase({
      connectionId,
      fact: fact("ORDER-NOTAX", { taxAmount: "0.00" }),
    });
    const costs = await scratch.handle.db.query.acquisitionCosts.findMany({
      where: (table, { eq }) => eq(table.acquisitionId, result.acquisition.id),
    });
    expect(costs.map((cost) => cost.costType).sort()).toEqual(["goods", "inbound_freight"]);
  });

  it("is idempotent on (connection, externalReference): a re-poll is a no-op skip", async () => {
    const connectionId = await seedConnection(scratch, { name: "idempotency buyer", provider: "ebay" });
    const ingestion = createPurchaseIngestionService({ db: scratch.handle.db });

    const first = await ingestion.ingestEbayPurchase({ connectionId, fact: fact("ORDER-DUP") });
    const second = await ingestion.ingestEbayPurchase({ connectionId, fact: fact("ORDER-DUP") });

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.skipped).toBe(true);
    expect(second.acquisition.id).toBe(first.acquisition.id);

    const acquisitionRows = await scratch.handle.db.execute(
      `select count(*)::int as n from acquisitions where connection_id = '${connectionId}' and external_reference = 'ORDER-DUP'`,
    );
    expect(acquisitionRows.rows[0]?.["n"]).toBe(1);
  });

  it("dedups an unchanged provider_objects payload by hash", async () => {
    const connectionId = await seedConnection(scratch, { name: "dedup buyer", provider: "ebay" });
    const ingestion = createPurchaseIngestionService({ db: scratch.handle.db });
    await ingestion.ingestEbayPurchase({ connectionId, fact: fact("ORDER-DEDUP") });
    await ingestion.ingestEbayPurchase({ connectionId, fact: fact("ORDER-DEDUP") });
    const rows = await scratch.handle.db.execute(
      `select count(*)::int as n from provider_objects where connection_id = '${connectionId}' and external_object_id = 'ORDER-DEDUP'`,
    );
    expect(rows.rows[0]?.["n"]).toBe(1);
  });

  it("rejects a malformed fact rather than writing a partial acquisition", async () => {
    const connectionId = await seedConnection(scratch, { name: "bad fact buyer", provider: "ebay" });
    const ingestion = createPurchaseIngestionService({ db: scratch.handle.db });
    await expect(
      ingestion.ingestEbayPurchase({
        connectionId,
        fact: fact("ORDER-BAD", { itemPriceAmount: "not-a-number" }),
      }),
    ).rejects.toThrowError(InventoryValidationError);
  });
});

describe("createEbayPurchaseSync", () => {
  it("syncs a page of purchase facts and advances the watermark", async () => {
    const connectionId = await seedConnection(scratch, { name: "sync buyer", provider: "ebay" });
    const facts = [
      fact("SYNC-1", { purchasedAt: "2026-08-01T00:00:00.000Z" }),
      fact("SYNC-2", { purchasedAt: "2026-08-05T00:00:00.000Z" }),
    ];
    const sync = createEbayPurchaseSync({
      db: scratch.handle.db,
      fetchPurchases: async () => ({ purchases: facts, pages: 1, truncated: false }),
    });

    const result = await sync.syncConnection({ connectionId });
    expect(result).toMatchObject({
      created: 2,
      skipped: 0,
      purchasesSeen: 2,
      currencies: ["USD"],
    });
    expect(result.lastPurchasedAt?.toISOString()).toBe("2026-08-05T00:00:00.000Z");

    const cursor = await sync.readCursor(connectionId);
    expect(cursor?.lastPurchaseCount).toBe(2);
    expect(cursor?.lastPurchasedAt?.toISOString()).toBe("2026-08-05T00:00:00.000Z");

    // A second run against the same provider data is a full idempotent skip.
    const rerun = await sync.syncConnection({ connectionId });
    expect(rerun).toMatchObject({ created: 0, skipped: 2 });
  });

  it("persists an explicit null watermark after a run that sees zero purchases", async () => {
    const connectionId = await seedConnection(scratch, { name: "empty sync buyer", provider: "ebay" });
    const sync = createEbayPurchaseSync({
      db: scratch.handle.db,
      fetchPurchases: async () => ({ purchases: [], pages: 1, truncated: false }),
    });
    await sync.syncConnection({ connectionId });
    const cursor = await sync.readCursor(connectionId);
    expect(cursor?.lastPurchasedAt).toBeNull();
    expect(cursor?.lastPurchaseCount).toBe(0);

    // Reading it again must not throw — the null-watermark regression.
    await expect(sync.readCursor(connectionId)).resolves.not.toThrow();
  });
});

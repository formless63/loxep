/**
 * Historical analytics read-model tests (loxep-7dp.4): time-bucketed
 * price/availability series against the REAL Timescale hypertable, the pure
 * restock/sellout pairing matrix (no DB needed), the DB-backed
 * `restockSellout` wrapper, `itemActivitySummary` decimal math, and a
 * performance sanity check over a few hundred rows (no timing assertions).
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeDb, createDb, runMigrations } from "@loxep/db";
import type { DbHandle } from "@loxep/db";
import { marketEvents } from "@loxep/db/schema";
import {
  availabilityHistory,
  computePriceChangePercent,
  deriveRestockSelloutIntervals,
  deriveSellThroughDeltas,
  itemActivitySummary,
  priceHistory,
  recordObservationBatch,
  restockSellout,
  upsertMarketplaceItem,
} from "../src/index.ts";
import type { RestockSelloutEvent, SellThroughBucket } from "../src/index.ts";
import {
  createScratchDb,
  dropScratchDb,
  scratchDbName,
  silentLogger,
} from "./helpers.ts";

const dbName = scratchDbName("loxep_test_metrics");
let handle: DbHandle;

beforeAll(async () => {
  const databaseUrl = await createScratchDb(dbName);
  await runMigrations({ databaseUrl, logger: silentLogger });
  handle = createDb(databaseUrl);
});

afterAll(async () => {
  await closeDb(handle);
  await dropScratchDb(dbName);
});

async function makeItem(externalItemId: string, seenAt = new Date("2026-08-11T00:00:00.000Z")) {
  return upsertMarketplaceItem({
    db: handle.db,
    item: {
      provider: "ebay",
      marketplace: "EBAY_US",
      externalItemId,
      seenAt,
    },
  });
}

async function observe(options: {
  marketplaceItemId: string;
  observedAt: Date;
  price?: string;
  shippingPrice?: string;
  quantityAvailable?: number;
  quantitySold?: number;
  watchCount?: number;
  availability?: string;
  listingState?: string;
}): Promise<void> {
  await recordObservationBatch({
    db: handle.db,
    batch: {
      observationBatchId: randomUUID(),
      observedAt: options.observedAt,
      source: "ebay_item",
      items: [
        {
          marketplaceItemId: options.marketplaceItemId,
          ...(options.price !== undefined ? { price: options.price } : {}),
          ...(options.shippingPrice !== undefined
            ? { shippingPrice: options.shippingPrice }
            : {}),
          ...(options.quantityAvailable !== undefined
            ? { quantityAvailable: options.quantityAvailable }
            : {}),
          ...(options.quantitySold !== undefined
            ? { quantitySold: options.quantitySold }
            : {}),
          ...(options.watchCount !== undefined ? { watchCount: options.watchCount } : {}),
          ...(options.availability !== undefined
            ? { availability: options.availability }
            : {}),
          ...(options.listingState !== undefined
            ? { listingState: options.listingState }
            : {}),
        },
      ],
    },
  });
}

/** Insert one market event directly, bypassing derivation (matches opportunities.test.ts). */
async function seedEvent(options: {
  marketplaceItemId: string;
  eventType: "restocked" | "sold_out" | string;
  detectedAt: Date;
  toObservedAt: Date;
}): Promise<void> {
  const dedupe = `${options.marketplaceItemId}:${options.eventType}:${randomUUID()}`;
  await handle.db.insert(marketEvents).values({
    marketplaceItemId: options.marketplaceItemId,
    monitorTargetId: null,
    eventType: options.eventType,
    detectedAt: options.detectedAt,
    fromObservedAt: options.detectedAt,
    toObservedAt: options.toObservedAt,
    payload: {},
    deduplicationKey: dedupe,
  });
}

const HOUR = 3600 * 1000;
const MIN = 60 * 1000;

describe("priceHistory", () => {
  it("buckets min/max/last/observationCount and leaves gaps absent", async () => {
    const item = await makeItem("price-hist-basic");
    const base = new Date("2026-08-11T00:00:00.000Z");
    // Bucket A: 00:00–01:00
    await observe({ marketplaceItemId: item.id, observedAt: new Date(base.getTime() + 5 * MIN), price: "10.00" });
    await observe({ marketplaceItemId: item.id, observedAt: new Date(base.getTime() + 30 * MIN), price: "12.00" });
    await observe({ marketplaceItemId: item.id, observedAt: new Date(base.getTime() + 45 * MIN), price: "8.00" });
    // Unpriced poll in the same bucket: counts toward observationCount, not min/max/last.
    await observe({ marketplaceItemId: item.id, observedAt: new Date(base.getTime() + 50 * MIN), availability: "in_stock" });
    // Gap: nothing in 01:00–02:00.
    // Bucket C: 02:00–03:00
    await observe({ marketplaceItemId: item.id, observedAt: new Date(base.getTime() + 2 * HOUR + 15 * MIN), price: "20.00" });

    const buckets = await priceHistory(handle.db, { marketplaceItemId: item.id, bucketSeconds: 3600 });
    expect(buckets).toHaveLength(2);

    const [bucketA, bucketC] = buckets;
    expect(bucketA?.bucketStart.getTime()).toBe(base.getTime());
    expect(bucketA?.minPrice).toBe("8.000000");
    expect(bucketA?.maxPrice).toBe("12.000000");
    // Last by observed_at desc within the bucket is the 00:45 observation (the
    // 00:50 poll has no price and is skipped for min/max/last).
    expect(bucketA?.lastPrice).toBe("8.000000");
    expect(bucketA?.observationCount).toBe(4);

    expect(bucketC?.bucketStart.getTime()).toBe(base.getTime() + 2 * HOUR);
    expect(bucketC?.minPrice).toBe("20.000000");
    expect(bucketC?.maxPrice).toBe("20.000000");
    expect(bucketC?.lastPrice).toBe("20.000000");
    expect(bucketC?.observationCount).toBe(1);
  });

  it("lastLandedPrice is price+shipping from the SAME observation as lastPrice, and null when that observation has no shipping price", async () => {
    const item = await makeItem("price-hist-landed");
    const base = new Date("2026-08-11T00:00:00.000Z");
    // Earlier in the bucket: priced with shipping.
    await observe({
      marketplaceItemId: item.id,
      observedAt: new Date(base.getTime() + 5 * MIN),
      price: "10.00",
      shippingPrice: "3.50",
    });
    // Most recent priced observation in the bucket has NO shipping price
    // recorded — lastLandedPrice must be null, not fabricated as lastPrice+0.
    await observe({
      marketplaceItemId: item.id,
      observedAt: new Date(base.getTime() + 45 * MIN),
      price: "8.00",
    });

    const buckets = await priceHistory(handle.db, { marketplaceItemId: item.id, bucketSeconds: 3600 });
    expect(buckets).toHaveLength(1);
    expect(buckets[0]?.lastPrice).toBe("8.000000");
    expect(buckets[0]?.lastLandedPrice).toBeNull();

    // A second bucket where the last priced observation DOES carry shipping.
    const item2 = await makeItem("price-hist-landed-2");
    await observe({
      marketplaceItemId: item2.id,
      observedAt: new Date(base.getTime() + 45 * MIN),
      price: "8.00",
      shippingPrice: "4.25",
    });
    const buckets2 = await priceHistory(handle.db, { marketplaceItemId: item2.id, bucketSeconds: 3600 });
    expect(buckets2[0]?.lastLandedPrice).toBe("12.250000");
  });

  it("half-open range filtering: from inclusive, to exclusive", async () => {
    const item = await makeItem("price-hist-range");
    const base = new Date("2026-08-11T00:00:00.000Z");
    await observe({ marketplaceItemId: item.id, observedAt: new Date(base.getTime() + 5 * MIN), price: "10.00" });
    await observe({ marketplaceItemId: item.id, observedAt: new Date(base.getTime() + 30 * MIN), price: "12.00" });
    await observe({ marketplaceItemId: item.id, observedAt: new Date(base.getTime() + 45 * MIN), price: "8.00" });
    await observe({ marketplaceItemId: item.id, observedAt: new Date(base.getTime() + 2 * HOUR + 15 * MIN), price: "20.00" });

    const buckets = await priceHistory(handle.db, {
      marketplaceItemId: item.id,
      bucketSeconds: 3600,
      from: new Date(base.getTime() + 30 * MIN), // inclusive: keeps 00:30
      to: new Date(base.getTime() + 2 * HOUR), // exclusive: drops the 02:15 bucket
    });
    expect(buckets).toHaveLength(1);
    expect(buckets[0]?.minPrice).toBe("8.000000");
    expect(buckets[0]?.maxPrice).toBe("12.000000");
    expect(buckets[0]?.observationCount).toBe(2);
  });
});

describe("availabilityHistory", () => {
  it("reports last quantity/state per bucket and wentUnavailable across the whole bucket", async () => {
    const item = await makeItem("avail-hist");
    const base = new Date("2026-08-11T00:00:00.000Z");
    await observe({
      marketplaceItemId: item.id,
      observedAt: new Date(base.getTime() + 5 * MIN),
      quantityAvailable: 5,
      availability: "in_stock",
      listingState: "active",
    });
    await observe({
      marketplaceItemId: item.id,
      observedAt: new Date(base.getTime() + 15 * MIN),
      quantityAvailable: 0,
      availability: "out_of_stock",
      listingState: "active",
    });
    // Recovers within the SAME bucket — wentUnavailable stays true even
    // though the bucket's last-observed state is back in stock.
    await observe({
      marketplaceItemId: item.id,
      observedAt: new Date(base.getTime() + 25 * MIN),
      quantityAvailable: 3,
      availability: "in_stock",
      listingState: "active",
    });

    const buckets = await availabilityHistory(handle.db, { marketplaceItemId: item.id, bucketSeconds: 3600 });
    expect(buckets).toHaveLength(1);
    expect(buckets[0]?.lastQuantityAvailable).toBe(3);
    expect(buckets[0]?.lastListingState).toBe("active");
    expect(buckets[0]?.wentUnavailable).toBe(true);
  });

  it("wentUnavailable is false for a bucket that never dipped to zero/out_of_stock", async () => {
    const item = await makeItem("avail-hist-ok");
    const base = new Date("2026-08-11T00:00:00.000Z");
    await observe({ marketplaceItemId: item.id, observedAt: new Date(base.getTime() + 5 * MIN), quantityAvailable: 5, availability: "in_stock" });
    await observe({ marketplaceItemId: item.id, observedAt: new Date(base.getTime() + 15 * MIN), quantityAvailable: 4, availability: "in_stock" });

    const buckets = await availabilityHistory(handle.db, { marketplaceItemId: item.id, bucketSeconds: 3600 });
    expect(buckets).toHaveLength(1);
    expect(buckets[0]?.wentUnavailable).toBe(false);
    expect(buckets[0]?.lastQuantityAvailable).toBe(4);
  });

  it("reports lastWatchCount/lastQuantitySold from the bucket's most recent observation of each, independently", async () => {
    const item = await makeItem("avail-hist-demand");
    const base = new Date("2026-08-11T00:00:00.000Z");
    await observe({
      marketplaceItemId: item.id,
      observedAt: new Date(base.getTime() + 5 * MIN),
      watchCount: 3,
      quantitySold: 12,
    });
    // A later poll in the same bucket updates watchCount but omits
    // quantitySold entirely — NULL preservation means the earlier
    // quantitySold reading (12) still wins as "most recent NON-NULL".
    await observe({
      marketplaceItemId: item.id,
      observedAt: new Date(base.getTime() + 40 * MIN),
      watchCount: 7,
    });

    const buckets = await availabilityHistory(handle.db, { marketplaceItemId: item.id, bucketSeconds: 3600 });
    expect(buckets).toHaveLength(1);
    expect(buckets[0]?.lastWatchCount).toBe(7);
    expect(buckets[0]?.lastQuantitySold).toBe(12);
  });

  it("lastWatchCount/lastQuantitySold are null for a bucket that never observed them", async () => {
    const item = await makeItem("avail-hist-no-demand");
    const base = new Date("2026-08-11T00:00:00.000Z");
    await observe({ marketplaceItemId: item.id, observedAt: new Date(base.getTime() + 5 * MIN), quantityAvailable: 2 });

    const buckets = await availabilityHistory(handle.db, { marketplaceItemId: item.id, bucketSeconds: 3600 });
    expect(buckets[0]?.lastWatchCount).toBeNull();
    expect(buckets[0]?.lastQuantitySold).toBeNull();
  });
});

describe("deriveSellThroughDeltas (pure cumulative→delta conversion)", () => {
  const at = (minutesFromEpoch: number) => new Date(minutesFromEpoch * MIN);

  it("empty series", () => {
    expect(deriveSellThroughDeltas([])).toEqual([]);
  });

  it("a single point has no prior baseline, so its delta is null", () => {
    const buckets: SellThroughBucket[] = [{ bucketStart: at(0), lastQuantitySold: 5 }];
    expect(deriveSellThroughDeltas(buckets)).toEqual([{ bucketStart: at(0), unitsSold: null }]);
  });

  it("a rising cumulative series produces per-bucket deltas from the previous known value", () => {
    const buckets: SellThroughBucket[] = [
      { bucketStart: at(0), lastQuantitySold: 5 },
      { bucketStart: at(60), lastQuantitySold: 9 },
      { bucketStart: at(120), lastQuantitySold: 9 }, // unchanged: 0 units this bucket
      { bucketStart: at(180), lastQuantitySold: 15 },
    ];
    expect(deriveSellThroughDeltas(buckets)).toEqual([
      { bucketStart: at(0), unitsSold: null },
      { bucketStart: at(60), unitsSold: 4 },
      { bucketStart: at(120), unitsSold: 0 },
      { bucketStart: at(180), unitsSold: 6 },
    ]);
  });

  it("a null reading mid-series gets a null delta and does not corrupt the running baseline", () => {
    const buckets: SellThroughBucket[] = [
      { bucketStart: at(0), lastQuantitySold: 5 },
      { bucketStart: at(60), lastQuantitySold: null }, // poll recorded no quantitySold that bucket
      { bucketStart: at(120), lastQuantitySold: 8 }, // delta measured against the last KNOWN value (5), not null
    ];
    expect(deriveSellThroughDeltas(buckets)).toEqual([
      { bucketStart: at(0), unitsSold: null },
      { bucketStart: at(60), unitsSold: null },
      { bucketStart: at(120), unitsSold: 3 },
    ]);
  });

  it("a downward reset (relist/correction) never produces a negative delta, and re-baselines going forward", () => {
    const buckets: SellThroughBucket[] = [
      { bucketStart: at(0), lastQuantitySold: 20 },
      { bucketStart: at(60), lastQuantitySold: 2 }, // reset: counter dropped
      { bucketStart: at(120), lastQuantitySold: 6 }, // genuine post-reset sale, measured from the new baseline (2)
    ];
    expect(deriveSellThroughDeltas(buckets)).toEqual([
      { bucketStart: at(0), unitsSold: null },
      { bucketStart: at(60), unitsSold: null },
      { bucketStart: at(120), unitsSold: 4 },
    ]);
  });

  it("a gap between buckets (an absent hour, per the module's gaps-are-absent-rows convention) still yields a correct delta across the gap", () => {
    const buckets: SellThroughBucket[] = [
      { bucketStart: at(0), lastQuantitySold: 5 },
      // Buckets at(60)/at(120) are simply absent — no observations that hour.
      { bucketStart: at(180), lastQuantitySold: 11 },
    ];
    expect(deriveSellThroughDeltas(buckets)).toEqual([
      { bucketStart: at(0), unitsSold: null },
      { bucketStart: at(180), unitsSold: 6 },
    ]);
  });
});

describe("deriveRestockSelloutIntervals (pure pairing matrix)", () => {
  const at = (minutesFromEpoch: number) => new Date(minutesFromEpoch * MIN);

  it("empty input", () => {
    const result = deriveRestockSelloutIntervals([]);
    expect(result).toEqual({
      selloutCount: 0,
      restockCount: 0,
      avgOutOfStockSeconds: null,
      avgInStockSeconds: null,
      currentState: "unknown",
      intervals: [],
    });
  });

  it("a single sold_out → restocked pair measures the out-of-stock interval", () => {
    const events: RestockSelloutEvent[] = [
      { eventType: "sold_out", at: at(0) },
      { eventType: "restocked", at: at(60) }, // 60 min later
    ];
    const result = deriveRestockSelloutIntervals(events);
    expect(result.selloutCount).toBe(1);
    expect(result.restockCount).toBe(1);
    expect(result.avgOutOfStockSeconds).toBe(60 * 60);
    expect(result.avgInStockSeconds).toBeNull();
    expect(result.currentState).toBe("in_stock");
    // Closed out_of_stock interval PLUS the always-present trailing open
    // interval representing the current (in_stock) state since the last event.
    expect(result.intervals).toEqual([
      { from: at(0), to: at(60), state: "out_of_stock" },
      { from: at(60), to: null, state: "in_stock" },
    ]);
  });

  it("leading restock: no preceding interval is closed, but a new in_stock interval opens", () => {
    const events: RestockSelloutEvent[] = [
      { eventType: "restocked", at: at(0) },
      { eventType: "sold_out", at: at(30) },
    ];
    const result = deriveRestockSelloutIntervals(events);
    expect(result.restockCount).toBe(1);
    expect(result.selloutCount).toBe(1);
    // The restocked→sold_out span IS a bounded in_stock interval.
    expect(result.avgInStockSeconds).toBe(30 * 60);
    expect(result.avgOutOfStockSeconds).toBeNull();
    expect(result.currentState).toBe("out_of_stock");
    expect(result.intervals).toEqual([
      { from: at(0), to: at(30), state: "in_stock" },
      { from: at(30), to: null, state: "out_of_stock" },
    ]);
  });

  it("trailing sellout with no rangeEnd: open interval, excluded from the average", () => {
    const events: RestockSelloutEvent[] = [{ eventType: "sold_out", at: at(0) }];
    const result = deriveRestockSelloutIntervals(events);
    expect(result.currentState).toBe("out_of_stock");
    expect(result.avgOutOfStockSeconds).toBeNull();
    expect(result.intervals).toEqual([{ from: at(0), to: null, state: "out_of_stock" }]);
  });

  it("trailing sellout WITH rangeEnd: open interval closes there and counts toward the average", () => {
    const events: RestockSelloutEvent[] = [{ eventType: "sold_out", at: at(0) }];
    const result = deriveRestockSelloutIntervals(events, { rangeEnd: at(10) });
    expect(result.currentState).toBe("out_of_stock");
    expect(result.avgOutOfStockSeconds).toBe(10 * 60);
    expect(result.intervals).toEqual([{ from: at(0), to: at(10), state: "out_of_stock" }]);
  });

  it("duplicate/missing-pair events: a repeated sold_out is a no-op on interval tracking", () => {
    const events: RestockSelloutEvent[] = [
      { eventType: "sold_out", at: at(0) },
      { eventType: "sold_out", at: at(5) }, // duplicate — no restocked in between
      { eventType: "restocked", at: at(20) },
    ];
    const result = deriveRestockSelloutIntervals(events);
    // Raw counts include the duplicate.
    expect(result.selloutCount).toBe(2);
    expect(result.restockCount).toBe(1);
    // Duration measured from the FIRST sold_out (at(0)), not the duplicate.
    expect(result.avgOutOfStockSeconds).toBe(20 * 60);
    expect(result.intervals).toEqual([
      { from: at(0), to: at(20), state: "out_of_stock" },
      { from: at(20), to: null, state: "in_stock" },
    ]);
  });

  it("duplicate restocked while already in_stock is also a no-op", () => {
    const events: RestockSelloutEvent[] = [
      { eventType: "restocked", at: at(0) },
      { eventType: "restocked", at: at(5) }, // duplicate
      { eventType: "sold_out", at: at(20) },
    ];
    const result = deriveRestockSelloutIntervals(events);
    expect(result.restockCount).toBe(2);
    expect(result.selloutCount).toBe(1);
    expect(result.avgInStockSeconds).toBe(20 * 60);
    expect(result.intervals).toEqual([
      { from: at(0), to: at(20), state: "in_stock" },
      { from: at(20), to: null, state: "out_of_stock" },
    ]);
  });

  it("multiple complete cycles average across all bounded intervals", () => {
    const events: RestockSelloutEvent[] = [
      { eventType: "sold_out", at: at(0) },
      { eventType: "restocked", at: at(10) }, // out_of_stock: 10 min
      { eventType: "sold_out", at: at(40) }, // in_stock: 30 min
      { eventType: "restocked", at: at(70) }, // out_of_stock: 30 min
    ];
    const result = deriveRestockSelloutIntervals(events);
    expect(result.avgOutOfStockSeconds).toBe(((10 + 30) / 2) * 60);
    expect(result.avgInStockSeconds).toBe(30 * 60);
    expect(result.currentState).toBe("in_stock");
    // 3 closed intervals + 1 trailing open interval since the last restocked.
    expect(result.intervals).toHaveLength(4);
    expect(result.intervals[3]).toEqual({ from: at(70), to: null, state: "in_stock" });
  });

  it("sorts unsorted input by `at` before pairing", () => {
    const events: RestockSelloutEvent[] = [
      { eventType: "restocked", at: at(60) },
      { eventType: "sold_out", at: at(0) },
    ];
    const result = deriveRestockSelloutIntervals(events);
    expect(result.intervals).toEqual([
      { from: at(0), to: at(60), state: "out_of_stock" },
      { from: at(60), to: null, state: "in_stock" },
    ]);
  });
});

describe("restockSellout (DB-backed)", () => {
  it("reads market_events, pairs them, and defaults `to` to the query boundary supplied", async () => {
    const item = await makeItem("restock-db");
    const base = new Date("2026-08-11T00:00:00.000Z");
    await seedEvent({ marketplaceItemId: item.id, eventType: "sold_out", detectedAt: base, toObservedAt: base });
    await seedEvent({
      marketplaceItemId: item.id,
      eventType: "restocked",
      detectedAt: new Date(base.getTime() + HOUR),
      toObservedAt: new Date(base.getTime() + HOUR),
    });
    await seedEvent({
      marketplaceItemId: item.id,
      eventType: "sold_out",
      detectedAt: new Date(base.getTime() + 2 * HOUR),
      toObservedAt: new Date(base.getTime() + 2 * HOUR),
    });

    const rangeEnd = new Date(base.getTime() + 2 * HOUR + 30 * MIN);
    const result = await restockSellout(handle.db, { marketplaceItemId: item.id, to: rangeEnd });
    expect(result.selloutCount).toBe(2);
    expect(result.restockCount).toBe(1);
    expect(result.currentState).toBe("out_of_stock");
    // out_of_stock spans: 0→1h (3600s) and the trailing 2h→2h30m (1800s).
    expect(result.avgOutOfStockSeconds).toBe((3600 + 1800) / 2);
    // in_stock span: 1h→2h (3600s).
    expect(result.avgInStockSeconds).toBe(3600);
    expect(result.intervals).toHaveLength(3);
  });

  it("`from` filters out earlier events, producing a leading-restock edge case", async () => {
    const item = await makeItem("restock-db-from");
    const base = new Date("2026-08-11T00:00:00.000Z");
    await seedEvent({ marketplaceItemId: item.id, eventType: "sold_out", detectedAt: base, toObservedAt: base });
    await seedEvent({
      marketplaceItemId: item.id,
      eventType: "restocked",
      detectedAt: new Date(base.getTime() + HOUR),
      toObservedAt: new Date(base.getTime() + HOUR),
    });
    await seedEvent({
      marketplaceItemId: item.id,
      eventType: "sold_out",
      detectedAt: new Date(base.getTime() + 2 * HOUR),
      toObservedAt: new Date(base.getTime() + 2 * HOUR),
    });

    const rangeEnd = new Date(base.getTime() + 2 * HOUR + 30 * MIN);
    const result = await restockSellout(handle.db, {
      marketplaceItemId: item.id,
      from: new Date(base.getTime() + HOUR), // drops the first sold_out
      to: rangeEnd,
    });
    expect(result.restockCount).toBe(1);
    expect(result.selloutCount).toBe(1);
    // Leading restock at +1h closes nothing; the in_stock span is 1h (from +1h to +2h).
    expect(result.avgInStockSeconds).toBe(3600);
    // Trailing out_of_stock span is 30 min.
    expect(result.avgOutOfStockSeconds).toBe(1800);
  });

  it("defaults `to` to now for an open trailing interval", async () => {
    const item = await makeItem("restock-db-now");
    const oneHourAgo = new Date(Date.now() - HOUR);
    await seedEvent({ marketplaceItemId: item.id, eventType: "sold_out", detectedAt: oneHourAgo, toObservedAt: oneHourAgo });

    const result = await restockSellout(handle.db, { marketplaceItemId: item.id });
    expect(result.currentState).toBe("out_of_stock");
    expect(result.avgOutOfStockSeconds).not.toBeNull();
    // Roughly an hour, allowing generous slack for test execution time.
    expect(result.avgOutOfStockSeconds ?? 0).toBeGreaterThan(3500);
    expect(result.avgOutOfStockSeconds ?? 0).toBeLessThan(3700);
  });
});

describe("itemActivitySummary", () => {
  it("counts events/observations inside the window and computes priceChangePct without float math", async () => {
    const item = await makeItem("activity-summary");
    const now = new Date();
    const windowSeconds = 3600;
    const insideWindowStart = new Date(now.getTime() - windowSeconds * 1000 + 5 * MIN);

    await observe({ marketplaceItemId: item.id, observedAt: insideWindowStart, price: "10.00" });
    await observe({ marketplaceItemId: item.id, observedAt: new Date(insideWindowStart.getTime() + 10 * MIN), price: "12.50" });

    await seedEvent({
      marketplaceItemId: item.id,
      eventType: "price_changed",
      detectedAt: new Date(insideWindowStart.getTime() + 10 * MIN),
      toObservedAt: new Date(insideWindowStart.getTime() + 10 * MIN),
    });
    // Outside the window: must not be counted.
    await seedEvent({
      marketplaceItemId: item.id,
      eventType: "price_dropped",
      detectedAt: new Date(now.getTime() - (windowSeconds + 3600) * 1000),
      toObservedAt: new Date(now.getTime() - (windowSeconds + 3600) * 1000),
    });

    const summary = await itemActivitySummary(handle.db, { marketplaceItemId: item.id, windowSeconds });
    expect(summary.eventCounts["price_changed"]).toBe(1);
    expect(summary.eventCounts["price_dropped"]).toBe(0);
    expect(summary.eventCounts["restocked"]).toBe(0);
    expect(summary.observationCount).toBe(2);
    // (12.50 - 10.00) / 10.00 * 100 = 25
    expect(summary.priceChangePct).toBe(25);
    expect(summary.lastObservedAt?.getTime()).toBe(
      new Date(insideWindowStart.getTime() + 10 * MIN).getTime(),
    );
  });

  it("priceChangePct is null with no priced observations in the window; 0 for textually-different-but-equal decimals", async () => {
    const item = await makeItem("activity-summary-null");
    const summary = await itemActivitySummary(handle.db, { marketplaceItemId: item.id, windowSeconds: 3600 });
    expect(summary.priceChangePct).toBeNull();
    expect(summary.observationCount).toBe(0);
    expect(summary.lastObservedAt).toBeNull();

    const item2 = await makeItem("activity-summary-equal");
    const now = new Date();
    await observe({ marketplaceItemId: item2.id, observedAt: new Date(now.getTime() - 30 * MIN), price: "10.00" });
    await observe({ marketplaceItemId: item2.id, observedAt: new Date(now.getTime() - 10 * MIN), price: "10" });
    const summary2 = await itemActivitySummary(handle.db, { marketplaceItemId: item2.id, windowSeconds: 3600 });
    expect(summary2.priceChangePct).toBe(0);
  });

  it("lastObservedAt is NOT window-limited even when observationCount is", async () => {
    const item = await makeItem("activity-summary-freshness");
    const longAgo = new Date(Date.now() - 6 * HOUR);
    await observe({ marketplaceItemId: item.id, observedAt: longAgo, price: "5.00" });

    // A 60-second window excludes the 6-hour-old observation entirely.
    const summary = await itemActivitySummary(handle.db, { marketplaceItemId: item.id, windowSeconds: 60 });
    expect(summary.observationCount).toBe(0);
    expect(summary.priceChangePct).toBeNull();
    // ...but lastObservedAt still reports it — freshness is not window-scoped.
    expect(summary.lastObservedAt?.getTime()).toBe(longAgo.getTime());
  });
});

describe("computePriceChangePercent", () => {
  it("computes exact percentages via BigInt, never float parsing", () => {
    expect(computePriceChangePercent("10.00", "12.50")).toBe(25);
    expect(computePriceChangePercent("10.00", "5.00")).toBe(-50);
    expect(computePriceChangePercent("10.00", "10")).toBe(0);
    // (1 - 3) / 3 * 100 = -66.666666... truncated toward zero at 6 fractional digits.
    expect(computePriceChangePercent("3", "1")).toBeCloseTo(-66.666666, 6);
  });

  it("returns null for a zero base — a percentage change from zero is undefined", () => {
    expect(computePriceChangePercent("0", "5.00")).toBeNull();
    expect(computePriceChangePercent("0.00", "0.00")).toBe(0); // equal-first fast path short-circuits before the zero check
  });
});

describe("performance sanity (a few hundred rows, no timing assertions)", () => {
  it("priceHistory, availabilityHistory, restockSellout, and itemActivitySummary all complete over a larger seeded history", async () => {
    const item = await makeItem("perf-sanity");
    const base = new Date("2026-08-01T00:00:00.000Z");
    const rowCount = 300;
    for (let i = 0; i < rowCount; i += 1) {
      const observedAt = new Date(base.getTime() + i * 10 * MIN);
      const quantity = i % 20;
      await observe({
        marketplaceItemId: item.id,
        observedAt,
        price: `${10 + (i % 7)}.00`,
        quantityAvailable: quantity,
        availability: quantity === 0 ? "out_of_stock" : "in_stock",
      });
      if (quantity === 0) {
        await seedEvent({
          marketplaceItemId: item.id,
          eventType: "sold_out",
          detectedAt: observedAt,
          toObservedAt: observedAt,
        });
      } else if (i % 20 === 1) {
        await seedEvent({
          marketplaceItemId: item.id,
          eventType: "restocked",
          detectedAt: observedAt,
          toObservedAt: observedAt,
        });
      }
    }

    const [priceRows, availRows, restock, summary] = await Promise.all([
      priceHistory(handle.db, { marketplaceItemId: item.id, bucketSeconds: 3600 }),
      availabilityHistory(handle.db, { marketplaceItemId: item.id, bucketSeconds: 3600 }),
      restockSellout(handle.db, { marketplaceItemId: item.id, to: new Date(base.getTime() + rowCount * 10 * MIN) }),
      itemActivitySummary(handle.db, { marketplaceItemId: item.id, windowSeconds: 365 * 24 * 3600 }),
    ]);

    expect(priceRows.length).toBeGreaterThan(0);
    expect(availRows.length).toBeGreaterThan(0);
    expect(restock.selloutCount).toBeGreaterThan(0);
    expect(restock.restockCount).toBeGreaterThan(0);
    expect(summary.observationCount).toBe(rowCount);
  });
});

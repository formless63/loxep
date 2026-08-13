/**
 * `biggestPriceMovers` read-model tests (loxep-jwm): latest-vs-prior priced
 * observation per item, ranked by absolute percent change, against the REAL
 * Timescale hypertable.
 *
 * Its own scratch database rather than a `describe` inside `metrics.test.ts`:
 * this read is installation-wide (it ranks EVERY marketplace item), so any
 * item seeded by a neighbouring test would silently compete for the top-N
 * slots this file asserts on.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeDb, createDb, runMigrations } from "@loxep/db";
import type { DbHandle } from "@loxep/db";
import {
  DEFAULT_PRICE_MOVERS_LIMIT,
  biggestPriceMovers,
  recordObservationBatch,
  upsertMarketplaceItem,
} from "../src/index.ts";
import {
  createScratchDb,
  dropScratchDb,
  scratchDbName,
  silentLogger,
} from "./helpers.ts";

const dbName = scratchDbName("loxep_test_price_movers");
let handle: DbHandle;

const MIN = 60 * 1000;
const BASE = new Date("2026-08-13T00:00:00.000Z");

beforeAll(async () => {
  const databaseUrl = await createScratchDb(dbName);
  await runMigrations({ databaseUrl, logger: silentLogger });
  handle = createDb(databaseUrl);
});

afterAll(async () => {
  await closeDb(handle);
  await dropScratchDb(dbName);
});

async function makeItem(externalItemId: string, title?: string) {
  return upsertMarketplaceItem({
    db: handle.db,
    item: {
      provider: "ebay",
      marketplace: "EBAY_US",
      externalItemId,
      seenAt: BASE,
      ...(title === undefined ? {} : { title }),
    },
  });
}

async function observe(options: {
  marketplaceItemId: string;
  observedAt: Date;
  price?: string;
  currency?: string;
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
          ...(options.currency !== undefined ? { currency: options.currency } : {}),
        },
      ],
    },
  });
}

/** Seed a two-point price history: `prices[0]` first, `prices[1]` most recent. */
async function seedPair(
  externalItemId: string,
  prices: [string, string],
  options: { title?: string; currency?: string; firstOffsetMin?: number } = {},
): Promise<string> {
  const item = await makeItem(externalItemId, options.title);
  const firstOffset = options.firstOffsetMin ?? 120;
  await observe({
    marketplaceItemId: item.id,
    observedAt: new Date(BASE.getTime() - firstOffset * MIN),
    price: prices[0],
    ...(options.currency === undefined ? {} : { currency: options.currency }),
  });
  await observe({
    marketplaceItemId: item.id,
    observedAt: new Date(BASE.getTime() - 10 * MIN),
    price: prices[1],
    ...(options.currency === undefined ? {} : { currency: options.currency }),
  });
  return item.id;
}

describe("biggestPriceMovers", () => {
  it("ranks by ABSOLUTE percent change, keeps the sign, and honours the limit", async () => {
    const crash = await seedPair("mover-crash", ["100.00", "40.00"], {
      title: "Crashing lens",
      currency: "USD",
    }); // -60%
    const spike = await seedPair("mover-spike", ["10.00", "17.00"]); // +70%
    const drift = await seedPair("mover-drift", ["50.00", "51.00"]); // +2%

    const movers = await biggestPriceMovers(handle.db);

    expect(movers.map((mover) => mover.marketplaceItemId)).toEqual([
      spike,
      crash,
      drift,
    ]);
    expect(movers[0]?.priceChangePct).toBe(70);
    expect(movers[1]?.priceChangePct).toBe(-60);
    expect(movers[2]?.priceChangePct).toBe(2);

    const top = await biggestPriceMovers(handle.db, { limit: 1 });
    expect(top).toHaveLength(1);
    expect(top[0]?.marketplaceItemId).toBe(spike);
  });

  it("carries title, currency, prices as decimal strings, and both observation instants", async () => {
    const movers = await biggestPriceMovers(handle.db);
    const crash = movers.find((mover) => mover.title === "Crashing lens");

    expect(crash).toBeDefined();
    expect(crash?.currency).toBe("USD");
    expect(crash?.currentState).toBe("active");
    // Money crosses the API as an exact decimal STRING, never a JS number.
    expect(typeof crash?.latestPrice).toBe("string");
    expect(Number(crash?.latestPrice)).toBe(40);
    expect(Number(crash?.previousPrice)).toBe(100);
    expect(crash?.observedAt.getTime()).toBeGreaterThan(
      crash?.previousObservedAt.getTime() ?? 0,
    );
  });

  it("excludes items with fewer than two priced observations", async () => {
    const single = await makeItem("mover-single");
    await observe({
      marketplaceItemId: single.id,
      observedAt: new Date(BASE.getTime() - 5 * MIN),
      price: "99.00",
    });
    const never = await makeItem("mover-unpriced");
    await observe({
      marketplaceItemId: never.id,
      observedAt: new Date(BASE.getTime() - 5 * MIN),
    });

    const ids = (await biggestPriceMovers(handle.db, { limit: 50 })).map(
      (mover) => mover.marketplaceItemId,
    );
    expect(ids).not.toContain(single.id);
    expect(ids).not.toContain(never.id);
  });

  it("ignores NULL-price observations when choosing the latest and prior price", async () => {
    const item = await makeItem("mover-null-gap");
    await observe({
      marketplaceItemId: item.id,
      observedAt: new Date(BASE.getTime() - 90 * MIN),
      price: "20.00",
    });
    await observe({
      marketplaceItemId: item.id,
      observedAt: new Date(BASE.getTime() - 60 * MIN),
      price: "30.00",
    });
    // A poll that recorded no price is not a $0 price and is not a step.
    await observe({
      marketplaceItemId: item.id,
      observedAt: new Date(BASE.getTime() - 30 * MIN),
    });

    const mover = (await biggestPriceMovers(handle.db, { limit: 50 })).find(
      (row) => row.marketplaceItemId === item.id,
    );
    expect(mover?.previousPrice).toBe("20.000000");
    expect(mover?.latestPrice).toBe("30.000000");
    expect(mover?.priceChangePct).toBe(50);
  });

  it("excludes a zero change and an undefined-percentage zero base", async () => {
    const flat = await seedPair("mover-flat", ["25.00", "25.00"]);
    const fromZero = await seedPair("mover-zero-base", ["0.00", "5.00"]);

    const ids = (await biggestPriceMovers(handle.db, { limit: 50 })).map(
      (mover) => mover.marketplaceItemId,
    );
    expect(ids).not.toContain(flat);
    expect(ids).not.toContain(fromZero);
  });

  it("`since` bounds the window, so an out-of-window prior price is not a move", async () => {
    const stale = await seedPair("mover-stale-prior", ["10.00", "80.00"], {
      firstOffsetMin: 60 * 24 * 30,
    });

    const wide = await biggestPriceMovers(handle.db, { limit: 50 });
    expect(wide.map((mover) => mover.marketplaceItemId)).toContain(stale);

    const recent = await biggestPriceMovers(handle.db, {
      limit: 50,
      since: new Date(BASE.getTime() - 24 * 60 * MIN),
    });
    expect(recent.map((mover) => mover.marketplaceItemId)).not.toContain(stale);
  });

  it("defaults to five movers and rejects an invalid limit", async () => {
    for (let index = 0; index < 8; index += 1) {
      await seedPair(`mover-bulk-${index}`, ["10.00", `${11 + index}.00`]);
    }

    const movers = await biggestPriceMovers(handle.db);
    expect(DEFAULT_PRICE_MOVERS_LIMIT).toBe(5);
    expect(movers).toHaveLength(DEFAULT_PRICE_MOVERS_LIMIT);

    await expect(biggestPriceMovers(handle.db, { limit: 0 })).rejects.toThrow();
    await expect(
      biggestPriceMovers(handle.db, { limit: 1.5 }),
    ).rejects.toThrow();
  });
});

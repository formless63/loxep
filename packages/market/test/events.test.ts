/**
 * Market event derivation tests (loxep-ubx.3): the pure comparison matrix,
 * the deduplication-key convention, and retry-safe insertion against the
 * real schema.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeDb, createDb, runMigrations } from "@loxep/db";
import type { DbHandle } from "@loxep/db";
import {
  compareDecimalStrings,
  compareObservations,
  deduplicationKeyFor,
  deriveMarketEvents,
  latestObservations,
  recordObservationBatch,
  upsertMarketplaceItem,
} from "../src/index.ts";
import type { ObservationSnapshot } from "../src/index.ts";
import {
  createScratchDb,
  dropScratchDb,
  scratchDbName,
  silentLogger,
} from "./helpers.ts";

const dbName = scratchDbName("loxep_test_events");
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

const t1 = new Date("2026-08-11T10:00:00.000Z");
const t2 = new Date("2026-08-11T10:05:00.000Z");

function snap(
  fields: Omit<ObservationSnapshot, "observedAt">,
  observedAt = t2,
): ObservationSnapshot {
  return { observedAt, ...fields };
}

describe("compareDecimalStrings", () => {
  it("compares exactly without float math", () => {
    expect(compareDecimalStrings("10.00", "10")).toBe(0);
    expect(compareDecimalStrings("10.10", "10.1")).toBe(0);
    expect(compareDecimalStrings("0.1", "0.2")).toBe(-1);
    expect(compareDecimalStrings("19.99", "20.00")).toBe(-1);
    expect(compareDecimalStrings("-1.5", "1.5")).toBe(-1);
    expect(compareDecimalStrings("12345678901234567890.000001", "12345678901234567890")).toBe(1);
  });
});

describe("compareObservations matrix", () => {
  const prev = (fields: Omit<ObservationSnapshot, "observedAt">) =>
    snap(fields, t1);

  it("price_changed on any price difference; price_dropped additionally on decrease", () => {
    const up = compareObservations(
      prev({ price: "10.00" }),
      snap({ price: "12.00" }),
    );
    expect(up.map((e) => e.eventType)).toEqual(["price_changed"]);

    const down = compareObservations(
      prev({ price: "10.00", currency: "USD" }),
      snap({ price: "9.99", currency: "USD" }),
    );
    expect(down.map((e) => e.eventType)).toEqual([
      "price_changed",
      "price_dropped",
    ]);
    expect(down[0]?.payload).toEqual({
      from: "10.00",
      to: "9.99",
      currency: "USD",
    });
  });

  it("no price event when either price is NULL or values are equal", () => {
    expect(
      compareObservations(prev({ price: null }), snap({ price: "9.99" })),
    ).toEqual([]);
    expect(
      compareObservations(prev({ price: "9.99" }), snap({ price: null })),
    ).toEqual([]);
    // Textually different but numerically equal decimal strings: no event.
    expect(
      compareObservations(prev({ price: "10.00" }), snap({ price: "10" })),
    ).toEqual([]);
  });

  it("quantity_changed on any observed quantity difference", () => {
    const events = compareObservations(
      prev({ quantityAvailable: 5 }),
      snap({ quantityAvailable: 3 }),
    );
    expect(events.map((e) => e.eventType)).toEqual(["quantity_changed"]);
    expect(events[0]?.payload).toEqual({ from: 5, to: 3 });
    expect(
      compareObservations(
        prev({ quantityAvailable: null }),
        snap({ quantityAvailable: 3 }),
      ),
    ).toEqual([]);
  });

  it("restocked on 0→>0 quantity or out_of_stock→in_stock availability", () => {
    const byQty = compareObservations(
      prev({ quantityAvailable: 0 }),
      snap({ quantityAvailable: 4 }),
    );
    expect(byQty.map((e) => e.eventType)).toEqual([
      "quantity_changed",
      "restocked",
    ]);
    const byAvail = compareObservations(
      prev({ availability: "out_of_stock" }),
      snap({ availability: "in_stock" }),
    );
    expect(byAvail.map((e) => e.eventType)).toEqual(["restocked"]);
  });

  it("sold_out on >0→0 quantity or in_stock→out_of_stock availability", () => {
    const byQty = compareObservations(
      prev({ quantityAvailable: 2 }),
      snap({ quantityAvailable: 0 }),
    );
    expect(byQty.map((e) => e.eventType)).toEqual([
      "quantity_changed",
      "sold_out",
    ]);
    const byAvail = compareObservations(
      prev({ availability: "in_stock" }),
      snap({ availability: "out_of_stock" }),
    );
    expect(byAvail.map((e) => e.eventType)).toEqual(["sold_out"]);
  });

  it("listing_ended only on a non-NULL non-ended → ended transition", () => {
    expect(
      compareObservations(
        prev({ listingState: "active" }),
        snap({ listingState: "ended" }),
      ).map((e) => e.eventType),
    ).toEqual(["listing_ended"]);
    // First sighting already ended: no transition, no event.
    expect(
      compareObservations(
        prev({ listingState: null }),
        snap({ listingState: "ended" }),
      ),
    ).toEqual([]);
    expect(
      compareObservations(
        prev({ listingState: "ended" }),
        snap({ listingState: "ended" }),
      ),
    ).toEqual([]);
  });

  it("identical observations derive nothing", () => {
    expect(
      compareObservations(
        prev({
          price: "10.00",
          quantityAvailable: 5,
          availability: "in_stock",
          listingState: "active",
        }),
        snap({
          price: "10.00",
          quantityAvailable: 5,
          availability: "in_stock",
          listingState: "active",
        }),
      ),
    ).toEqual([]);
  });
});

describe("deriveMarketEvents", () => {
  it("uses the documented deduplication key convention", () => {
    const id = "00000000-0000-4000-8000-000000000001";
    expect(deduplicationKeyFor(id, "price_dropped", t2)).toBe(
      `${id}:price_dropped:2026-08-11T10:05:00.000Z`,
    );
  });

  it("persists derived events once; re-derivation inserts nothing (dedupe)", async () => {
    const item = await upsertMarketplaceItem({
      db: handle.db,
      item: {
        provider: "ebay",
        marketplace: "EBAY_US",
        externalItemId: "derive-1",
        seenAt: t1,
      },
    });
    const previous = snap({ price: "20.00", quantityAvailable: 1 }, t1);
    const current = snap({ price: "15.00", quantityAvailable: 0 }, t2);

    const first = await deriveMarketEvents({
      db: handle.db,
      marketplaceItemId: item.id,
      previous,
      current,
    });
    const types = first.inserted.map((e) => e.eventType).sort();
    expect(types).toEqual([
      "price_changed",
      "price_dropped",
      "quantity_changed",
      "sold_out",
    ]);
    for (const row of first.inserted) {
      expect(row.deduplicationKey).toBe(
        deduplicationKeyFor(item.id, row.eventType as never, t2),
      );
      expect(row.fromObservedAt?.getTime()).toBe(t1.getTime());
      expect(row.toObservedAt.getTime()).toBe(t2.getTime());
    }

    // At-least-once retry re-derives the same transition: nothing inserted.
    const retry = await deriveMarketEvents({
      db: handle.db,
      marketplaceItemId: item.id,
      previous,
      current,
    });
    expect(retry.detected).toHaveLength(4);
    expect(retry.inserted).toHaveLength(0);

    const stored = await handle.db.query.marketEvents.findMany({
      where: (table, { eq }) => eq(table.marketplaceItemId, item.id),
    });
    expect(stored).toHaveLength(4);
  });

  it("derives nothing from a first observation (previous null)", async () => {
    const item = await upsertMarketplaceItem({
      db: handle.db,
      item: {
        provider: "ebay",
        marketplace: "EBAY_US",
        externalItemId: "derive-first",
        seenAt: t1,
      },
    });
    const result = await deriveMarketEvents({
      db: handle.db,
      marketplaceItemId: item.id,
      previous: null,
      current: snap({ price: "10.00" }),
    });
    expect(result.detected).toEqual([]);
    expect(result.inserted).toEqual([]);
  });
});

describe("latestObservations", () => {
  it("reads the hypertable newest-first with a limit", async () => {
    const item = await upsertMarketplaceItem({
      db: handle.db,
      item: {
        provider: "ebay",
        marketplace: "EBAY_US",
        externalItemId: "latest-obs",
        seenAt: t1,
      },
    });
    for (let i = 0; i < 3; i += 1) {
      await recordObservationBatch({
        db: handle.db,
        batch: {
          observationBatchId: randomUUID(),
          observedAt: new Date(t1.getTime() + i * 60_000),
          source: "ebay_item",
          items: [{ marketplaceItemId: item.id, price: `${10 + i}.00` }],
        },
      });
    }
    const rows = await latestObservations(handle.db, item.id, 2);
    expect(rows).toHaveLength(2);
    expect(rows[0]?.price).toBe("12.000000");
    expect(rows[1]?.price).toBe("11.000000");
    expect(rows[0]!.observedAt.getTime()).toBeGreaterThan(
      rows[1]!.observedAt.getTime(),
    );
  });
});

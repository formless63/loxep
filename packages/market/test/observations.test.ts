/**
 * Observation write-path integration tests (loxep-ubx.2) against the REAL
 * Timescale hypertable: batch idempotency, NULL preservation, marketplace
 * item identity, and monitor link maintenance.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeDb, createDb, runMigrations } from "@loxep/db";
import type { DbHandle } from "@loxep/db";
import {
  createMonitorService,
  deactivateAbsentMonitorItems,
  latestObservations,
  linkItemToMonitor,
  listWatchedItemIds,
  recordObservationBatch,
  upsertMarketplaceItem,
} from "../src/index.ts";
import {
  createScratchDb,
  dropScratchDb,
  scratchDbName,
  silentLogger,
} from "./helpers.ts";

const dbName = scratchDbName("loxep_test_observations");
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

async function makeItem(externalItemId: string) {
  return upsertMarketplaceItem({
    db: handle.db,
    item: {
      provider: "ebay",
      marketplace: "EBAY_US",
      externalItemId,
      seenAt: new Date("2026-08-11T10:00:00.000Z"),
    },
  });
}

describe("hypertable reality check", () => {
  it("marketplace_item_observations is a real Timescale hypertable", async () => {
    const result = await handle.pool.query(
      `select hypertable_name from timescaledb_information.hypertables
        where hypertable_name = 'marketplace_item_observations'`,
    );
    expect(result.rows).toHaveLength(1);
  });
});

describe("recordObservationBatch", () => {
  it("re-recording the same batch inserts 0 new rows; a different batch at the same instant inserts", async () => {
    const item = await makeItem("obs-idempotent");
    const observedAt = new Date("2026-08-11T10:00:00.000Z");
    const batch = {
      observationBatchId: randomUUID(),
      observedAt,
      source: "ebay_watchlist",
      items: [{ marketplaceItemId: item.id, price: "19.99", currency: "USD" }],
    };
    const first = await recordObservationBatch({ db: handle.db, batch });
    expect(first.inserted).toBe(1);

    // At-least-once retry: identical batch id + observed_at → no-op.
    const retry = await recordObservationBatch({ db: handle.db, batch });
    expect(retry.inserted).toBe(0);

    // A second connection legitimately observing the same item at the same
    // instant is a DIFFERENT batch and must land.
    const second = await recordObservationBatch({
      db: handle.db,
      batch: { ...batch, observationBatchId: randomUUID() },
    });
    expect(second.inserted).toBe(1);

    const rows = await latestObservations(handle.db, item.id, 10);
    expect(rows).toHaveLength(2);
  });

  it("preserves NULL for absent metrics — never 0", async () => {
    const item = await makeItem("obs-nulls");
    const result = await recordObservationBatch({
      db: handle.db,
      batch: {
        observationBatchId: randomUUID(),
        observedAt: new Date("2026-08-11T10:05:00.000Z"),
        source: "ebay_item",
        items: [
          // Only availability observed; every other metric is absent.
          { marketplaceItemId: item.id, availability: "in_stock" },
        ],
      },
    });
    expect(result.inserted).toBe(1);
    const [row] = await latestObservations(handle.db, item.id, 1);
    expect(row).toBeDefined();
    expect(row?.availability).toBe("in_stock");
    expect(row?.price).toBeNull();
    expect(row?.shippingPrice).toBeNull();
    expect(row?.quantityAvailable).toBeNull();
    expect(row?.quantitySold).toBeNull();
    expect(row?.watchCount).toBeNull();
    expect(row?.currency).toBeNull();
    expect(row?.listingState).toBeNull();
    expect(row?.connectionId).toBeNull();
  });

  it("writes a multi-item batch in one statement and keeps numeric strings exact", async () => {
    const a = await makeItem("obs-multi-a");
    const b = await makeItem("obs-multi-b");
    const observedAt = new Date("2026-08-11T10:10:00.000Z");
    const result = await recordObservationBatch({
      db: handle.db,
      batch: {
        observationBatchId: randomUUID(),
        observedAt,
        source: "ebay_watchlist",
        items: [
          {
            marketplaceItemId: a.id,
            price: "1234.567891",
            shippingPrice: "0.01",
            currency: "USD",
            quantityAvailable: 3,
          },
          { marketplaceItemId: b.id, price: "0.99", currency: "EUR" },
        ],
      },
    });
    expect(result.inserted).toBe(2);
    const [rowA] = await latestObservations(handle.db, a.id, 1);
    // numeric(20,6) round-trips as an exact decimal string.
    expect(rowA?.price).toBe("1234.567891");
    expect(rowA?.shippingPrice).toBe("0.010000");
    expect(rowA?.quantityAvailable).toBe(3);
  });

  it("rejects malformed batches before touching the database", async () => {
    await expect(
      recordObservationBatch({
        db: handle.db,
        batch: {
          observationBatchId: "not-a-uuid",
          observedAt: new Date(),
          source: "x",
          items: [],
        },
      }),
    ).rejects.toThrow();
    const item = await makeItem("obs-invalid-price");
    await expect(
      recordObservationBatch({
        db: handle.db,
        batch: {
          observationBatchId: randomUUID(),
          observedAt: new Date(),
          source: "x",
          items: [{ marketplaceItemId: item.id, price: "12,99" }],
        },
      }),
    ).rejects.toThrow();
  });

  it("returns 0 for an empty batch", async () => {
    const result = await recordObservationBatch({
      db: handle.db,
      batch: {
        observationBatchId: randomUUID(),
        observedAt: new Date(),
        source: "ebay_watchlist",
        items: [],
      },
    });
    expect(result.inserted).toBe(0);
  });
});

describe("upsertMarketplaceItem", () => {
  it("keeps one row per provider/marketplace/external id and maintains seen bounds", async () => {
    const t1 = new Date("2026-08-10T00:00:00.000Z");
    const t2 = new Date("2026-08-11T00:00:00.000Z");
    const first = await upsertMarketplaceItem({
      db: handle.db,
      item: {
        provider: "ebay",
        marketplace: "EBAY_US",
        externalItemId: "identity-1",
        seenAt: t1,
        title: "Original title",
      },
    });
    const second = await upsertMarketplaceItem({
      db: handle.db,
      item: {
        provider: "ebay",
        marketplace: "EBAY_US",
        externalItemId: "identity-1",
        seenAt: t2,
      },
    });
    expect(second.id).toBe(first.id);
    expect(second.firstSeenAt.getTime()).toBe(t1.getTime());
    expect(second.lastSeenAt.getTime()).toBe(t2.getTime());
    // Absent descriptive fields never wipe stored values.
    expect(second.title).toBe("Original title");

    // Replaying an OLD batch regresses neither bound (retry safety).
    const replay = await upsertMarketplaceItem({
      db: handle.db,
      item: {
        provider: "ebay",
        marketplace: "EBAY_US",
        externalItemId: "identity-1",
        seenAt: t1,
      },
    });
    expect(replay.firstSeenAt.getTime()).toBe(t1.getTime());
    expect(replay.lastSeenAt.getTime()).toBe(t2.getTime());

    // A different marketplace is a different canonical item.
    const other = await upsertMarketplaceItem({
      db: handle.db,
      item: {
        provider: "ebay",
        marketplace: "EBAY_DE",
        externalItemId: "identity-1",
        seenAt: t1,
      },
    });
    expect(other.id).not.toBe(first.id);
  });
});

describe("linkItemToMonitor", () => {
  it("links idempotently and bumps last_matched_at monotonically", async () => {
    const service = createMonitorService({ db: handle.db });
    const target = await service.createTarget({
      targetType: "ebay_watchlist",
      name: "link test",
      intervalSeconds: 300,
    });
    const item = await makeItem("link-item");
    const t1 = new Date("2026-08-11T09:00:00.000Z");
    const t2 = new Date("2026-08-11T09:30:00.000Z");

    await linkItemToMonitor(handle.db, {
      monitorTargetId: target.id,
      marketplaceItemId: item.id,
      at: t1,
    });
    await linkItemToMonitor(handle.db, {
      monitorTargetId: target.id,
      marketplaceItemId: item.id,
      at: t2,
    });
    // Replay with the older timestamp must not regress last_matched_at.
    await linkItemToMonitor(handle.db, {
      monitorTargetId: target.id,
      marketplaceItemId: item.id,
      at: t1,
    });

    const links = await handle.db.query.monitorItems.findMany({
      where: (table, { eq }) => eq(table.monitorTargetId, target.id),
    });
    expect(links).toHaveLength(1);
    expect(links[0]?.firstDiscoveredAt.getTime()).toBe(t1.getTime());
    expect(links[0]?.lastMatchedAt.getTime()).toBe(t2.getTime());
    expect(links[0]?.active).toBe(true);
  });
});

describe("deactivateAbsentMonitorItems", () => {
  async function linkedTarget() {
    const service = createMonitorService({ db: handle.db });
    return service.createTarget({
      targetType: "ebay_watchlist",
      name: "absence test",
      intervalSeconds: 300,
    });
  }

  async function activeFlag(targetId: string, marketplaceItemId: string) {
    const link = await handle.db.query.monitorItems.findFirst({
      where: (table, { and, eq }) =>
        and(
          eq(table.monitorTargetId, targetId),
          eq(table.marketplaceItemId, marketplaceItemId),
        ),
    });
    return link?.active;
  }

  it("deactivates links absent from the present set and leaves present links untouched", async () => {
    const target = await linkedTarget();
    const present = await makeItem("absence-present");
    const absent = await makeItem("absence-absent");
    const t1 = new Date("2026-08-12T09:00:00.000Z");
    await linkItemToMonitor(handle.db, {
      monitorTargetId: target.id,
      marketplaceItemId: present.id,
      at: t1,
    });
    await linkItemToMonitor(handle.db, {
      monitorTargetId: target.id,
      marketplaceItemId: absent.id,
      at: t1,
    });

    const t2 = new Date("2026-08-12T09:30:00.000Z");
    const result = await deactivateAbsentMonitorItems(handle.db, {
      monitorTargetId: target.id,
      presentMarketplaceItemIds: [present.id],
      at: t2,
    });

    expect(result.deactivated).toBe(1);
    expect(await activeFlag(target.id, present.id)).toBe(true);
    expect(await activeFlag(target.id, absent.id)).toBe(false);
  });

  it("deactivates every active link when presentMarketplaceItemIds is empty", async () => {
    const target = await linkedTarget();
    const item = await makeItem("absence-empty-present");
    const t1 = new Date("2026-08-12T10:00:00.000Z");
    await linkItemToMonitor(handle.db, {
      monitorTargetId: target.id,
      marketplaceItemId: item.id,
      at: t1,
    });

    const t2 = new Date("2026-08-12T10:30:00.000Z");
    const result = await deactivateAbsentMonitorItems(handle.db, {
      monitorTargetId: target.id,
      presentMarketplaceItemIds: [],
      at: t2,
    });

    expect(result.deactivated).toBe(1);
    expect(await activeFlag(target.id, item.id)).toBe(false);
  });

  it("is idempotent: replaying the same call a second time deactivates 0 more", async () => {
    const target = await linkedTarget();
    const absent = await makeItem("absence-idempotent");
    const t1 = new Date("2026-08-12T11:00:00.000Z");
    await linkItemToMonitor(handle.db, {
      monitorTargetId: target.id,
      marketplaceItemId: absent.id,
      at: t1,
    });

    const t2 = new Date("2026-08-12T11:30:00.000Z");
    const options = {
      monitorTargetId: target.id,
      presentMarketplaceItemIds: [],
      at: t2,
    };
    const first = await deactivateAbsentMonitorItems(handle.db, options);
    expect(first.deactivated).toBe(1);

    // At-least-once retry: the link is already inactive, so this is a no-op.
    const retry = await deactivateAbsentMonitorItems(handle.db, options);
    expect(retry.deactivated).toBe(0);
    expect(await activeFlag(target.id, absent.id)).toBe(false);
  });
});

describe("listWatchedItemIds (loxep-foi.7)", () => {
  async function upsert(externalItemId: string, seenAt: Date) {
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

  async function observe(marketplaceItemId: string, observedAt: Date) {
    await recordObservationBatch({
      db: handle.db,
      batch: {
        observationBatchId: randomUUID(),
        observedAt,
        source: "ebay_watchlist",
        items: [{ marketplaceItemId, price: "10.00" }],
      },
    });
  }

  it("defaults to last_seen_at DESC", async () => {
    const older = await upsert("watched-default-older", new Date("2026-08-12T12:00:00.000Z"));
    const newer = await upsert("watched-default-newer", new Date("2026-08-12T13:00:00.000Z"));
    const ids = await listWatchedItemIds(handle.db, {
      allowedItemIds: [older.id, newer.id],
    });
    expect(ids.map((row) => row.id)).toEqual([newer.id, older.id]);
  });

  it("sortBy 'lastObserved' orders by the true latest OBSERVATION, not last_seen_at — they can diverge", async () => {
    const t1 = new Date("2026-08-12T14:00:00.000Z");
    const t2 = new Date("2026-08-12T15:00:00.000Z");
    const t3 = new Date("2026-08-12T16:00:00.000Z");

    // A: last_seen_at bumped to t3 (e.g. a watchlist membership sync), but
    // its only actual OBSERVATION is the earlier t1 — this poll's
    // rate-limited snapshot pass never touched it this cycle.
    const a = await upsert("watched-diverge-a", t3);
    await observe(a.id, t1);

    // B: last_seen_at is the older t1, but its real observation (t2) is
    // more recent than A's.
    const b = await upsert("watched-diverge-b", t1);
    await observe(b.id, t2);

    const allowedItemIds = [a.id, b.id];

    // Default order (last_seen_at desc): A (t3) before B (t1).
    const byLastSeen = await listWatchedItemIds(handle.db, { allowedItemIds });
    expect(byLastSeen.map((row) => row.id)).toEqual([a.id, b.id]);

    // lastObserved desc: B's real observation (t2) is newer than A's (t1) —
    // the opposite order from last_seen_at.
    const byObservedDesc = await listWatchedItemIds(handle.db, {
      allowedItemIds,
      sortBy: "lastObserved",
      sortDir: "desc",
    });
    expect(byObservedDesc.map((row) => row.id)).toEqual([b.id, a.id]);

    const byObservedAsc = await listWatchedItemIds(handle.db, {
      allowedItemIds,
      sortBy: "lastObserved",
      sortDir: "asc",
    });
    expect(byObservedAsc.map((row) => row.id)).toEqual([a.id, b.id]);
  });

  it("sorts an item with no observation last, in either direction", async () => {
    const observed = await upsert("watched-noobs-observed", new Date("2026-08-12T09:00:00.000Z"));
    await observe(observed.id, new Date("2026-08-12T09:30:00.000Z"));
    // last_seen_at pushed later than `observed`'s, but never actually observed.
    const neverObserved = await upsert(
      "watched-noobs-never",
      new Date("2026-08-12T10:00:00.000Z"),
    );

    const allowedItemIds = [observed.id, neverObserved.id];
    const desc = await listWatchedItemIds(handle.db, {
      allowedItemIds,
      sortBy: "lastObserved",
      sortDir: "desc",
    });
    expect(desc.map((row) => row.id)).toEqual([observed.id, neverObserved.id]);

    const asc = await listWatchedItemIds(handle.db, {
      allowedItemIds,
      sortBy: "lastObserved",
      sortDir: "asc",
    });
    expect(asc.map((row) => row.id)).toEqual([observed.id, neverObserved.id]);
  });

  it("restricts to allowedItemIds, and returns [] without querying when it's empty", async () => {
    const kept = await upsert("watched-restrict-kept", new Date("2026-08-12T11:00:00.000Z"));
    await upsert("watched-restrict-excluded", new Date("2026-08-12T11:30:00.000Z"));

    const restricted = await listWatchedItemIds(handle.db, { allowedItemIds: [kept.id] });
    expect(restricted.map((row) => row.id)).toEqual([kept.id]);

    const empty = await listWatchedItemIds(handle.db, { allowedItemIds: [] });
    expect(empty).toEqual([]);
  });
});

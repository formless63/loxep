/**
 * Discovery tests (loxep-7dp.1/.2): the pure diff matrix, the new Phase 2
 * monitor config schemas, and `new_listing` derivation against real
 * PostgreSQL — idempotence, the deduplication-key convention, and the
 * first-global-discovery semantics under re-discovery by a second monitor.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeDb, createDb, runMigrations } from "@loxep/db";
import type { DbHandle } from "@loxep/db";
import {
  MARKET_EVENT_TYPES,
  MarketValidationError,
  NEW_LISTING_EVENT_TYPE,
  createMonitorService,
  deduplicationKeyFor,
  deriveNewListingEvents,
  diffDiscoveredItems,
  knownExternalItemIds,
  linkItemToMonitor,
  upsertMarketplaceItem,
} from "../src/index.ts";
import type { MonitorService } from "../src/index.ts";
import {
  createScratchDb,
  dropScratchDb,
  scratchDbName,
  silentLogger,
} from "./helpers.ts";

const dbName = scratchDbName("loxep_test_discovery");
let handle: DbHandle;
let service: MonitorService;

beforeAll(async () => {
  const databaseUrl = await createScratchDb(dbName);
  await runMigrations({ databaseUrl, logger: silentLogger });
  handle = createDb(databaseUrl);
  service = createMonitorService({ db: handle.db });
});

afterAll(async () => {
  await closeDb(handle);
  await dropScratchDb(dbName);
});

// ---------------------------------------------------------------------------
// Pure diff
// ---------------------------------------------------------------------------

describe("diffDiscoveredItems", () => {
  const s = (id: string, title = id) => ({ externalItemId: id, title });

  it("splits a fetched page into never-seen and already-known, in fetch order", () => {
    const result = diffDiscoveredItems({
      knownExternalIds: ["b", "d"],
      fetchedSummaries: [s("a"), s("b"), s("c"), s("d")],
    });
    expect(result.newItems.map((i) => i.externalItemId)).toEqual(["a", "c"]);
    expect(result.seenItems.map((i) => i.externalItemId)).toEqual(["b", "d"]);
  });

  it("treats everything as new when nothing is known", () => {
    const result = diffDiscoveredItems({
      knownExternalIds: [],
      fetchedSummaries: [s("a"), s("b")],
    });
    expect(result.newItems).toHaveLength(2);
    expect(result.seenItems).toEqual([]);
  });

  it("treats everything as seen when everything is known", () => {
    const result = diffDiscoveredItems({
      knownExternalIds: new Set(["a", "b"]),
      fetchedSummaries: [s("a"), s("b")],
    });
    expect(result.newItems).toEqual([]);
    expect(result.seenItems).toHaveLength(2);
  });

  it("counts an id repeated inside one page as new only once (paging overlap)", () => {
    const result = diffDiscoveredItems({
      knownExternalIds: [],
      fetchedSummaries: [s("a", "first"), s("a", "again"), s("b")],
    });
    expect(result.newItems.map((i) => i.title)).toEqual(["first", "b"]);
    expect(result.seenItems.map((i) => i.title)).toEqual(["again"]);
  });

  it("handles an empty page", () => {
    expect(
      diffDiscoveredItems({ knownExternalIds: ["a"], fetchedSummaries: [] }),
    ).toEqual({ newItems: [], seenItems: [] });
  });

  it("preserves the caller's summary objects by identity", () => {
    const one = s("a");
    const result = diffDiscoveredItems({
      knownExternalIds: [],
      fetchedSummaries: [one],
    });
    expect(result.newItems[0]).toBe(one);
  });

  it("refuses a summary with no external id", () => {
    expect(() =>
      diffDiscoveredItems({
        knownExternalIds: [],
        fetchedSummaries: [{ externalItemId: "" }],
      }),
    ).toThrow(MarketValidationError);
  });

  it("does not mutate the caller's known-id collection", () => {
    const known = new Set(["b"]);
    diffDiscoveredItems({
      knownExternalIds: known,
      fetchedSummaries: [s("a")],
    });
    expect([...known]).toEqual(["b"]);
  });
});

// ---------------------------------------------------------------------------
// Phase 2 monitor config schemas
// ---------------------------------------------------------------------------

describe("Phase 2 monitor target types", () => {
  it("accepts an ebay_search target anchored by a query", async () => {
    const target = await service.createTarget({
      targetType: "ebay_search",
      name: "vintage nikon",
      intervalSeconds: 900,
      config: {
        query: "nikon fm2",
        filters: {
          priceMax: "250.00",
          priceCurrency: "USD",
          conditions: ["USED"],
          buyingOptions: ["FIXED_PRICE", "BEST_OFFER"],
          listedAfter: "2026-08-01T00:00:00.000Z",
        },
        maxItems: 200,
      },
    });
    expect(target.targetType).toBe("ebay_search");
    expect(target.config).toMatchObject({
      query: "nikon fm2",
      maxItems: 200,
    });
  });

  it("accepts an ebay_search target anchored by a category alone", async () => {
    const target = await service.createTarget({
      targetType: "ebay_search",
      name: "whole category",
      intervalSeconds: 900,
      config: { categoryId: "625" },
    });
    expect(target.config).toEqual({ categoryId: "625" });
  });

  it("rejects an ebay_search target with neither query nor category", async () => {
    await expect(
      service.createTarget({
        targetType: "ebay_search",
        name: "unbounded crawl",
        intervalSeconds: 900,
        config: { filters: { priceMax: "20.00", priceCurrency: "USD" } },
      }),
    ).rejects.toThrow(MarketValidationError);
  });

  it("rejects malformed search filters", async () => {
    for (const filters of [
      { priceMax: "twenty", priceCurrency: "USD" },
      { priceCurrency: "usd" },
      { conditions: ["BROKEN"] },
      { buyingOptions: [] },
      { conditionIds: ["NEW"] },
      { listedAfter: "yesterday" },
      { unknownKey: true },
    ]) {
      await expect(
        service.createTarget({
          targetType: "ebay_search",
          name: "bad filters",
          intervalSeconds: 900,
          config: { query: "nikon", filters },
        }),
      ).rejects.toThrow(MarketValidationError);
    }
  });

  it("accepts an ebay_seller target and requires the username", async () => {
    const target = await service.createTarget({
      targetType: "ebay_seller",
      name: "camera shop",
      intervalSeconds: 1800,
      config: { sellerUsername: "camera_shop", maxItems: 500 },
    });
    expect(target.config).toEqual({
      sellerUsername: "camera_shop",
      maxItems: 500,
    });
    await expect(
      service.createTarget({
        targetType: "ebay_seller",
        name: "no seller",
        intervalSeconds: 1800,
        config: {},
      }),
    ).rejects.toThrow(MarketValidationError);
  });

  it("accepts optional narrowing on an ebay_seller target and rejects unknown keys", async () => {
    const target = await service.createTarget({
      targetType: "ebay_seller",
      name: "camera shop, cameras only",
      intervalSeconds: 1800,
      config: {
        sellerUsername: "camera_shop",
        categoryId: "625",
        query: "nikon",
      },
    });
    expect(target.config).toMatchObject({ categoryId: "625", query: "nikon" });
    await expect(
      service.createTarget({
        targetType: "ebay_seller",
        name: "stray key",
        intervalSeconds: 1800,
        config: { sellerUsername: "camera_shop", sellers: ["someone_else"] },
      }),
    ).rejects.toThrow(MarketValidationError);
  });

  it("still accepts the adaptive opt-out on the new types", async () => {
    const target = await service.createTarget({
      targetType: "ebay_seller",
      name: "flat cadence seller",
      intervalSeconds: 1800,
      config: { sellerUsername: "flat_shop", adaptive: { enabled: false } },
    });
    expect(target.config).toMatchObject({ adaptive: { enabled: false } });
  });
});

// ---------------------------------------------------------------------------
// new_listing derivation
// ---------------------------------------------------------------------------

describe("new_listing event type", () => {
  it("is part of the derived event vocabulary", () => {
    expect(MARKET_EVENT_TYPES).toContain(NEW_LISTING_EVENT_TYPE);
    expect(NEW_LISTING_EVENT_TYPE).toBe("new_listing");
  });
});

let itemSeq = 0;

async function makeItem(seenAt: Date): Promise<{
  id: string;
  externalItemId: string;
}> {
  itemSeq += 1;
  const externalItemId = `v1|9900000${itemSeq}|0`;
  const record = await upsertMarketplaceItem({
    db: handle.db,
    item: {
      provider: "ebay",
      marketplace: "EBAY_US",
      externalItemId,
      seenAt,
      title: `Discovered item ${itemSeq}`,
    },
  });
  return { id: record.id, externalItemId };
}

async function makeTarget(
  name: string,
  targetType: "ebay_search" | "ebay_seller" | "ebay_watchlist" = "ebay_search",
): Promise<string> {
  const target = await service.createTarget({
    targetType,
    name,
    intervalSeconds: 900,
    config:
      targetType === "ebay_search"
        ? { query: name }
        : targetType === "ebay_seller"
          ? { sellerUsername: name }
          : {},
  });
  return target.id;
}

describe("knownExternalItemIds", () => {
  it("reports exactly the identities that already exist", async () => {
    const at = new Date("2026-08-11T09:00:00.000Z");
    const existing = await makeItem(at);
    const known = await knownExternalItemIds(handle.db, {
      provider: "ebay",
      marketplace: "EBAY_US",
      externalItemIds: [existing.externalItemId, "v1|does-not-exist|0"],
    });
    expect([...known]).toEqual([existing.externalItemId]);
  });

  it("scopes to provider and marketplace, and short-circuits an empty ask", async () => {
    const existing = await makeItem(new Date("2026-08-11T09:00:00.000Z"));
    expect(
      [
        ...(await knownExternalItemIds(handle.db, {
          provider: "ebay",
          marketplace: "EBAY_GB",
          externalItemIds: [existing.externalItemId],
        })),
      ],
    ).toEqual([]);
    expect(
      [
        ...(await knownExternalItemIds(handle.db, {
          provider: "ebay",
          marketplace: "EBAY_US",
          externalItemIds: [],
        })),
      ],
    ).toEqual([]);
  });

  it("survives ids containing quotes without breaking the statement", async () => {
    const known = await knownExternalItemIds(handle.db, {
      provider: "ebay",
      marketplace: "EBAY_US",
      externalItemIds: ["v1|o'brien|0"],
    });
    expect(known.size).toBe(0);
  });
});

describe("deriveNewListingEvents", () => {
  it("emits one event per first-global discovery, keyed by the documented convention", async () => {
    const discoveredAt = new Date("2026-08-11T10:00:00.000Z");
    const targetId = await makeTarget("first discovery search");
    const item = await makeItem(discoveredAt);
    await linkItemToMonitor(handle.db, {
      monitorTargetId: targetId,
      marketplaceItemId: item.id,
      at: discoveredAt,
    });

    const result = await deriveNewListingEvents(handle.db, {
      monitorTargetId: targetId,
      newlyLinkedItems: [
        {
          marketplaceItemId: item.id,
          externalItemId: item.externalItemId,
          title: "Discovered item",
          price: "19.99",
          currency: "USD",
          canonicalUrl: "https://www.ebay.com/itm/1",
          sellerExternalId: "camera_shop",
        },
      ],
      detectedAt: new Date("2026-08-11T10:00:05.000Z"),
    });

    expect(result.inserted).toHaveLength(1);
    expect(result.rediscovered).toEqual([]);
    const event = result.inserted[0]!;
    expect(event.eventType).toBe("new_listing");
    expect(event.marketplaceItemId).toBe(item.id);
    expect(event.monitorTargetId).toBe(targetId);
    // No previous observation to compare against.
    expect(event.fromObservedAt).toBeNull();
    expect(event.toObservedAt?.toISOString()).toBe(discoveredAt.toISOString());
    // The SQL-side key must equal the JS-side convention exactly.
    expect(event.deduplicationKey).toBe(
      deduplicationKeyFor(item.id, "new_listing", discoveredAt),
    );
    expect(event.payload).toMatchObject({
      discoveredByMonitorTargetId: targetId,
      externalItemId: item.externalItemId,
      price: "19.99",
      currency: "USD",
      sellerExternalId: "camera_shop",
      firstDiscoveredAt: discoveredAt.toISOString(),
    });
  });

  it("is idempotent under an at-least-once retry", async () => {
    const discoveredAt = new Date("2026-08-11T11:00:00.000Z");
    const targetId = await makeTarget("retry search");
    const item = await makeItem(discoveredAt);
    await linkItemToMonitor(handle.db, {
      monitorTargetId: targetId,
      marketplaceItemId: item.id,
      at: discoveredAt,
    });
    const input = {
      monitorTargetId: targetId,
      newlyLinkedItems: [{ marketplaceItemId: item.id }],
    };
    const first = await deriveNewListingEvents(handle.db, input);
    // A retry re-links (bumping last_matched_at, not first_discovered_at) and
    // re-derives with a different wall clock.
    await linkItemToMonitor(handle.db, {
      monitorTargetId: targetId,
      marketplaceItemId: item.id,
      at: new Date("2026-08-11T11:00:30.000Z"),
    });
    const second = await deriveNewListingEvents(handle.db, {
      ...input,
      detectedAt: new Date("2026-08-11T11:00:31.000Z"),
    });
    expect(first.inserted).toHaveLength(1);
    expect(second.inserted).toHaveLength(0);
    expect(second.rediscovered).toEqual([item.id]);

    const rows = await handle.db.query.marketEvents.findMany({
      where: (table, { and, eq }) =>
        and(
          eq(table.marketplaceItemId, item.id),
          eq(table.eventType, "new_listing"),
        ),
    });
    expect(rows).toHaveLength(1);
  });

  it("emits nothing when a SECOND monitor re-discovers an item (first global discovery wins)", async () => {
    const firstAt = new Date("2026-08-11T12:00:00.000Z");
    const secondAt = new Date("2026-08-11T12:30:00.000Z");
    const searchId = await makeTarget("re-discovery search");
    const sellerId = await makeTarget("re_discovery_seller", "ebay_seller");
    const item = await makeItem(firstAt);

    await linkItemToMonitor(handle.db, {
      monitorTargetId: searchId,
      marketplaceItemId: item.id,
      at: firstAt,
    });
    const discovery = await deriveNewListingEvents(handle.db, {
      monitorTargetId: searchId,
      newlyLinkedItems: [{ marketplaceItemId: item.id }],
    });
    expect(discovery.inserted).toHaveLength(1);

    await linkItemToMonitor(handle.db, {
      monitorTargetId: sellerId,
      marketplaceItemId: item.id,
      at: secondAt,
    });
    const rediscovery = await deriveNewListingEvents(handle.db, {
      monitorTargetId: sellerId,
      newlyLinkedItems: [{ marketplaceItemId: item.id }],
    });
    expect(rediscovery.inserted).toEqual([]);
    expect(rediscovery.rediscovered).toEqual([item.id]);

    const rows = await handle.db.query.marketEvents.findMany({
      where: (table, { and, eq }) =>
        and(
          eq(table.marketplaceItemId, item.id),
          eq(table.eventType, "new_listing"),
        ),
    });
    expect(rows).toHaveLength(1);
    // Provenance stays with whoever got there first.
    expect(rows[0]?.monitorTargetId).toBe(searchId);
  });

  it("emits nothing for an item a watchlist had already introduced", async () => {
    const watchlistAt = new Date("2026-08-11T13:00:00.000Z");
    const searchAt = new Date("2026-08-11T13:30:00.000Z");
    const watchlistId = await makeTarget("prior watchlist", "ebay_watchlist");
    const searchId = await makeTarget("late search");
    const item = await makeItem(watchlistAt);

    // The watchlist executor links but never derives new_listing.
    await linkItemToMonitor(handle.db, {
      monitorTargetId: watchlistId,
      marketplaceItemId: item.id,
      at: watchlistAt,
    });
    await linkItemToMonitor(handle.db, {
      monitorTargetId: searchId,
      marketplaceItemId: item.id,
      at: searchAt,
    });
    const result = await deriveNewListingEvents(handle.db, {
      monitorTargetId: searchId,
      newlyLinkedItems: [{ marketplaceItemId: item.id }],
    });
    expect(result.inserted).toEqual([]);
    expect(result.rediscovered).toEqual([item.id]);
  });

  it("collapses a same-instant race between two monitors to one event", async () => {
    const at = new Date("2026-08-11T14:00:00.000Z");
    const a = await makeTarget("race a");
    const b = await makeTarget("race b");
    const item = await makeItem(at);
    for (const targetId of [a, b]) {
      await linkItemToMonitor(handle.db, {
        monitorTargetId: targetId,
        marketplaceItemId: item.id,
        at,
      });
    }
    const first = await deriveNewListingEvents(handle.db, {
      monitorTargetId: a,
      newlyLinkedItems: [{ marketplaceItemId: item.id }],
    });
    const second = await deriveNewListingEvents(handle.db, {
      monitorTargetId: b,
      newlyLinkedItems: [{ marketplaceItemId: item.id }],
    });
    // Both links ARE the global minimum, so both pass the predicate; the
    // shared deduplication key is what collapses them.
    expect(first.inserted).toHaveLength(1);
    expect(second.inserted).toHaveLength(0);
    expect(first.inserted[0]?.deduplicationKey).toBe(
      deduplicationKeyFor(item.id, "new_listing", at),
    );
  });

  it("derives a whole page in one statement and de-duplicates repeated ids", async () => {
    const at = new Date("2026-08-11T15:00:00.000Z");
    const targetId = await makeTarget("batch search");
    const items = [await makeItem(at), await makeItem(at), await makeItem(at)];
    for (const item of items) {
      await linkItemToMonitor(handle.db, {
        monitorTargetId: targetId,
        marketplaceItemId: item.id,
        at,
      });
    }
    const result = await deriveNewListingEvents(handle.db, {
      monitorTargetId: targetId,
      newlyLinkedItems: [
        ...items.map((item) => ({ marketplaceItemId: item.id })),
        // A duplicate entry must not produce a second row.
        { marketplaceItemId: items[0]!.id },
      ],
    });
    expect(result.inserted).toHaveLength(3);
    expect(new Set(result.inserted.map((e) => e.marketplaceItemId)).size).toBe(
      3,
    );
  });

  it("reports an unlinked item as re-discovered rather than inventing a discovery", async () => {
    const targetId = await makeTarget("unlinked search");
    const item = await makeItem(new Date("2026-08-11T16:00:00.000Z"));
    const result = await deriveNewListingEvents(handle.db, {
      monitorTargetId: targetId,
      newlyLinkedItems: [{ marketplaceItemId: item.id }],
    });
    expect(result.inserted).toEqual([]);
    expect(result.rediscovered).toEqual([item.id]);
  });

  it("does nothing for an empty page", async () => {
    const targetId = await makeTarget("empty search");
    expect(
      await deriveNewListingEvents(handle.db, {
        monitorTargetId: targetId,
        newlyLinkedItems: [],
      }),
    ).toEqual({ inserted: [], rediscovered: [] });
  });

  it("keeps NULL facts out of the payload instead of writing nulls", async () => {
    const at = new Date("2026-08-11T17:00:00.000Z");
    const targetId = await makeTarget("sparse search");
    const item = await makeItem(at);
    await linkItemToMonitor(handle.db, {
      monitorTargetId: targetId,
      marketplaceItemId: item.id,
      at,
    });
    const result = await deriveNewListingEvents(handle.db, {
      monitorTargetId: targetId,
      newlyLinkedItems: [
        { marketplaceItemId: item.id, title: null, price: null },
      ],
    });
    expect(result.inserted[0]?.payload).toEqual({
      discoveredByMonitorTargetId: targetId,
      firstDiscoveredAt: at.toISOString(),
    });
  });

  it("refuses a non-UUID item id rather than interpolating it", async () => {
    const targetId = await makeTarget("bad id search");
    await expect(
      deriveNewListingEvents(handle.db, {
        monitorTargetId: targetId,
        newlyLinkedItems: [{ marketplaceItemId: "'; drop table market_events;--" }],
      }),
    ).rejects.toThrow(MarketValidationError);
  });
});

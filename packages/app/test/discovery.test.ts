/**
 * Discovery-pipeline integration tests (loxep-7dp.7) through the REAL
 * Graphile Worker runtime and the REAL composed registry:
 *
 *   due `ebay_search`/`ebay_seller` target
 *     → market.dispatch-due-monitors → market.poll-target
 *     → discovery executor → marketplace_items + monitor_items
 *     → observation batch → new_listing → notifications.deliver → transport
 *
 * The ONLY mocks are the two provider paging calls (`fakeDiscoveryBackend`,
 * which still runs the real `mapSearchSummary` normalization and the real
 * unknown-seller refusal rule) and the adapter factory. PostgreSQL, the
 * observation hypertable, the worker, and the market/notifications/domain
 * packages are the real thing.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeDb, createDb, runMigrations } from "@loxep/db";
import type { DbHandle } from "@loxep/db";
import { user } from "@loxep/db/schema";
import { startWorkerRuntime } from "@loxep/jobs";
import type { WorkerRuntime } from "@loxep/jobs";
import { createMarketTasks, createMonitorService } from "@loxep/market";
import type { MonitorService, MonitorTargetRow } from "@loxep/market";
import { createNotificationService } from "@loxep/notifications";
import type {
  NotificationTransport,
  TransportSendInput,
} from "@loxep/notifications";
import {
  ebayRateBudgetSetting,
  monitorDefaultsSetting,
  monitorObservationCapsSetting,
} from "@loxep/domain";
import {
  EBAY_ABSOLUTE_MIN_INTERVAL_SECONDS,
  EBAY_KEYSET_SECRET_KEY,
  buildAppServices,
  buildWorkerRegistry,
  createEbayAdapterFactory,
} from "../src/index.ts";
import type { AppServices, WorkerComposition } from "../src/index.ts";
import type { EbayAdapter } from "@loxep/integration-ebay";
import {
  browseSummaryPayload,
  createScratchDb,
  dropScratchDb,
  fakeConnectionAdapter,
  fakeDiscoveryBackend,
  fakeEbayState,
  scratchDbName,
  silentJobsLogger,
  silentLogger,
  testConfig,
  waitFor,
} from "./helpers.ts";
import type { FakeEbayState } from "./helpers.ts";

const dbName = scratchDbName("loxep_test_app_discovery");
let databaseUrl = "";
let handle: DbHandle;
let services: AppServices;
let composition: WorkerComposition;
let runtime: WorkerRuntime;
let monitors: MonitorService;
let connectionId = "";

const states = new Map<string, FakeEbayState>();
const sent: TransportSendInput[] = [];

const captureTransport: NotificationTransport = {
  provider: "ntfy",
  send: async (input) => {
    sent.push(input);
    return { providerMessageId: "fake-message-id" };
  },
};

function stateFor(id: string): FakeEbayState {
  let state = states.get(id);
  if (state === undefined) {
    state = fakeEbayState();
    states.set(id, state);
  }
  return state;
}

async function dispatch(): Promise<void> {
  const market = createMarketTasks({ db: handle.db });
  await runtime.addJob(market.dispatchDueMonitorsTask, {});
}

async function pollOnce(targetId: string): Promise<MonitorTargetRow> {
  const before = (await monitors.getTarget(targetId)).lastSuccessAt;
  await monitors.updateTarget(targetId, {
    nextPollAt: new Date(Date.now() - 1000),
  });
  await dispatch();
  return waitFor(
    async () => {
      const row = await monitors.getTarget(targetId);
      const advanced =
        row.lastSuccessAt !== null &&
        (before === null || row.lastSuccessAt.getTime() > before.getTime());
      return advanced ? row : undefined;
    },
    { label: `poll of monitor target ${targetId}` },
  );
}

async function pollOnceExpectingFailure(
  targetId: string,
): Promise<MonitorTargetRow> {
  const before = (await monitors.getTarget(targetId)).consecutiveErrors;
  await monitors.updateTarget(targetId, {
    nextPollAt: new Date(Date.now() - 1000),
  });
  await dispatch();
  return waitFor(
    async () => {
      const row = await monitors.getTarget(targetId);
      return row.consecutiveErrors > before ? row : undefined;
    },
    { label: `poll failure of monitor target ${targetId}` },
  );
}

async function itemByExternalId(externalItemId: string) {
  return handle.db.query.marketplaceItems.findFirst({
    where: (table, { eq }) => eq(table.externalItemId, externalItemId),
  });
}

async function observationsFor(marketplaceItemId: string) {
  return handle.db.query.marketplaceItemObservations.findMany({
    where: (table, { eq }) => eq(table.marketplaceItemId, marketplaceItemId),
    orderBy: (table, { asc }) => [asc(table.observedAt)],
  });
}

async function newListingEvents(marketplaceItemId: string) {
  return handle.db.query.marketEvents.findMany({
    where: (table, { and, eq }) =>
      and(
        eq(table.marketplaceItemId, marketplaceItemId),
        eq(table.eventType, "new_listing"),
      ),
  });
}

async function linksFor(monitorTargetId: string) {
  return handle.db.query.monitorItems.findMany({
    where: (table, { eq }) => eq(table.monitorTargetId, monitorTargetId),
  });
}

function adaptiveState(target: MonitorTargetRow): Record<string, unknown> {
  const config = target.config as Record<string, unknown> | null;
  const adaptive = config?.["adaptive"];
  return typeof adaptive === "object" && adaptive !== null
    ? (adaptive as Record<string, unknown>)
    : {};
}

beforeAll(async () => {
  databaseUrl = await createScratchDb(dbName);
  await runMigrations({ databaseUrl, logger: silentLogger });
  handle = createDb(databaseUrl);
  const config = testConfig(databaseUrl);

  // ttlMs 0: a settings change must be visible to the very next poll.
  const real = buildAppServices({
    config,
    logger: silentJobsLogger,
    settingsCacheTtlMs: 0,
  });
  services = {
    ...real,
    getEbayAdapterForConnection: async (id) =>
      fakeConnectionAdapter(id, stateFor(id)),
    invalidateEbayAdapter: () => {},
  };

  composition = buildWorkerRegistry({
    config,
    services,
    transport: captureTransport,
    logger: silentJobsLogger,
    discovery: fakeDiscoveryBackend,
  });

  runtime = await startWorkerRuntime({
    databaseUrl,
    logger: silentJobsLogger,
    concurrency: 2,
    pollInterval: 200,
    registry: composition.registry,
    cronItems: [],
  });

  await handle.db.insert(user).values({
    id: "test-user",
    name: "Test User",
    email: "discovery@example.invalid",
    emailVerified: true,
    createdAt: new Date(),
    updatedAt: new Date(),
  });

  const connection = await services.connections.createConnection({
    provider: "ebay",
    kind: "marketplace",
    name: "sandbox buyer",
    createdByUserId: "test-user",
  });
  connectionId = connection.id;

  monitors = createMonitorService({ db: handle.db });

  const notifications = createNotificationService({
    db: handle.db,
    secrets: services.secrets,
  });
  const endpoint = await notifications.createEndpoint({
    provider: "ntfy",
    name: "test topic",
    config: { baseUrl: "https://ntfy.example.invalid", topic: "loxep-test" },
  });
  await notifications.createRule({
    name: "every new listing",
    endpointId: endpoint.id,
    eventClass: "market",
    eventType: "new_listing",
  });
}, 120_000);

afterAll(async () => {
  await runtime?.stop();
  await composition?.close();
  await services?.close();
  await closeDb(handle);
  await dropScratchDb(dbName);
});

describe("ebay_search poll executor", () => {
  const ids = ["v1|210000000001|0", "v1|210000000002|0", "v1|210000000003|0"];

  it("discovers listings, links them, observes them, and derives new_listing once", async () => {
    const state = stateFor(connectionId);
    state.searchSummaries = ids.map((itemId, index) =>
      browseSummaryPayload({
        itemId,
        title: `Vintage Nikon ${index}`,
        price: `${100 + index}.00`,
        itemWebUrl: `https://www.ebay.com/itm/${index}`,
      }),
    );

    const target = await monitors.createTarget({
      targetType: "ebay_search",
      name: "vintage nikon",
      connectionId,
      intervalSeconds: 300,
      config: { query: "vintage nikon", maxItems: 10 },
      nextPollAt: new Date(Date.now() - 1000),
    });

    const after = await pollOnce(target.id);

    // Every fetched summary got a canonical identity and a discovery link.
    const items = await Promise.all(ids.map((id) => itemByExternalId(id)));
    expect(items.every((item) => item !== undefined)).toBe(true);
    expect(items[0]!.title).toBe("Vintage Nikon 0");
    expect(items[0]!.sellerExternalId).toBe("fake-seller");
    const links = await linksFor(target.id);
    expect(links).toHaveLength(3);
    expect(links.every((link) => link.active)).toBe(true);

    // Observations: one batch, summary facts only — quantity/availability
    // stay NULL because a search summary does not report them.
    const observationBatchIds = new Set<string>();
    for (const item of items) {
      const observations = await observationsFor(item!.id);
      expect(observations).toHaveLength(1);
      observationBatchIds.add(observations[0]!.observationBatchId);
      expect(observations[0]!.source).toBe("ebay:search");
      expect(observations[0]!.connectionId).toBe(connectionId);
      expect(observations[0]!.quantityAvailable).toBeNull();
      expect(observations[0]!.availability).toBeNull();
      expect(observations[0]!.price).toMatch(/^-?\d+(\.\d+)?$/u);
    }
    expect(observationBatchIds.size).toBe(1);

    // Exactly one new_listing per item, attributed to the discovering monitor.
    for (const item of items) {
      const events = await newListingEvents(item!.id);
      expect(events).toHaveLength(1);
      expect(events[0]!.monitorTargetId).toBe(target.id);
      expect(events[0]!.fromObservedAt).toBeNull();
      const payload = events[0]!.payload as Record<string, unknown>;
      expect(payload["discoveredByMonitorTargetId"]).toBe(target.id);
      expect(payload["canonicalUrl"]).toBeTypeOf("string");
    }

    // The detection → delivery bridge ran for a discovery event too.
    const firstEvent = (await newListingEvents(items[0]!.id))[0]!;
    const delivery = await waitFor(
      async () => {
        // ADR-0023: deliveries are keyed on the notification EVENT; a
        // market event reaches the ledger under `market_event:<id>`.
        const ledgerRow = await handle.db.query.notificationEvents.findFirst({
          where: (table, { eq }) =>
            eq(table.deduplicationKey, `market_event:${firstEvent.id}`),
        });
        if (ledgerRow === undefined) return undefined;
        const row = await handle.db.query.notificationDeliveries.findFirst({
          where: (table, { eq }) =>
            eq(table.notificationEventId, ledgerRow.id),
        });
        return row !== undefined && row.deliveredAt !== null ? row : undefined;
      },
      { label: "new_listing notification delivered" },
    );
    expect(delivery.status).toBe("delivered");

    // Adaptive: a discovery is activity, and the floor is the budget's.
    const adaptive = adaptiveState(after);
    expect(adaptive["unchangedStreak"]).toBe(0);
    expect(Number(adaptive["lastComputedInterval"])).toBeGreaterThanOrEqual(
      EBAY_ABSOLUTE_MIN_INTERVAL_SECONDS,
    );
    expect(after.consecutiveErrors).toBe(0);
  });

  it("re-polling the same search discovers nothing new and derives no second new_listing", async () => {
    const target = (await monitors.listTargets({ targetType: "ebay_search" }))
      .find((row) => row.name === "vintage nikon")!;

    const after = await pollOnce(target.id);

    for (const id of ids) {
      const item = await itemByExternalId(id);
      // A second observation landed (a new batch), but no second discovery.
      expect(await observationsFor(item!.id)).toHaveLength(2);
      expect(await newListingEvents(item!.id)).toHaveLength(1);
    }
    // Same listings, same state, nothing new: the relaxation streak grew.
    expect(adaptiveState(after)["unchangedStreak"]).toBe(1);
  });

  it("emits exactly one new_listing when a second monitor re-discovers the same item", async () => {
    const overlapping = await monitors.createTarget({
      targetType: "ebay_search",
      name: "overlapping nikon",
      connectionId,
      intervalSeconds: 300,
      config: { query: "nikon", maxItems: 10 },
      nextPollAt: new Date(Date.now() - 1000),
    });

    await pollOnce(overlapping.id);

    const links = await linksFor(overlapping.id);
    expect(links).toHaveLength(3);
    for (const id of ids) {
      const item = await itemByExternalId(id);
      const events = await newListingEvents(item!.id);
      // Still ONE: `new_listing` is a fact about the item, not the monitor.
      expect(events).toHaveLength(1);
      expect(events[0]!.monitorTargetId).not.toBe(overlapping.id);
    }
  });

  it("refuses a page whose filter eBay ignored (12002) without ingesting it", async () => {
    const state = stateFor(connectionId);
    const ignoredId = "v1|219999999999|0";
    state.searchSummaries = [browseSummaryPayload({ itemId: ignoredId })];
    state.searchWarnings = [
      { errorId: 12002, message: "The 'filter' value is invalid." },
    ];

    const target = await monitors.createTarget({
      targetType: "ebay_search",
      name: "bad filter",
      connectionId,
      intervalSeconds: 300,
      config: { query: "anything", maxItems: 10 },
      nextPollAt: new Date(Date.now() - 1000),
    });

    try {
      const failed = await pollOnceExpectingFailure(target.id);
      expect(failed.backoffUntil!.getTime()).toBeGreaterThan(Date.now());
      // Nothing was ingested from an unfiltered result set.
      expect(await itemByExternalId(ignoredId)).toBeUndefined();
      expect(await linksFor(target.id)).toHaveLength(0);
      // The CONNECTION is not at fault for a monitor's bad filter.
      const connection = await services.connections.getConnection(connectionId);
      expect(connection.status).toBe("active");
    } finally {
      state.searchWarnings = [];
      state.searchSummaries = [];
    }
  });
});

describe("ebay_seller poll executor", () => {
  const sellerIds = ["v1|220000000001|0", "v1|220000000002|0"];

  it("enumerates one seller's listings into the same pipeline", async () => {
    const state = stateFor(connectionId);
    state.sellerSummaries.set(
      "vintage-camera-shop",
      sellerIds.map((itemId, index) =>
        browseSummaryPayload({
          itemId,
          seller: "vintage-camera-shop",
          price: `${50 + index}.00`,
        }),
      ),
    );

    const target = await monitors.createTarget({
      targetType: "ebay_seller",
      name: "camera shop",
      connectionId,
      intervalSeconds: 300,
      config: { sellerUsername: "vintage-camera-shop", maxItems: 10 },
      nextPollAt: new Date(Date.now() - 1000),
    });

    const after = await pollOnce(target.id);
    expect(after.consecutiveErrors).toBe(0);
    expect(state.calls.at(-1)).toBe("seller:vintage-camera-shop");

    const links = await linksFor(target.id);
    expect(links).toHaveLength(2);
    for (const id of sellerIds) {
      const item = await itemByExternalId(id);
      expect(item!.sellerExternalId).toBe("vintage-camera-shop");
      const observations = await observationsFor(item!.id);
      expect(observations).toHaveLength(1);
      expect(observations[0]!.source).toBe("ebay:seller");
      expect(await newListingEvents(item!.id)).toHaveLength(1);
    }
  });

  it("fails the poll when eBay refuses the seller filter (12003), ingesting nothing", async () => {
    const state = stateFor(connectionId);
    const refusedId = "v1|229999999999|0";
    state.sellerSummaries.set("who-is-this", [
      browseSummaryPayload({ itemId: refusedId }),
    ]);
    state.sellerWarnings = [
      {
        errorId: 12003,
        message: "A seller 'who-is-this' provided in the request filters is invalid.",
      },
    ];

    const target = await monitors.createTarget({
      targetType: "ebay_seller",
      name: "unknown seller",
      connectionId,
      intervalSeconds: 300,
      config: { sellerUsername: "who-is-this", maxItems: 10 },
      nextPollAt: new Date(Date.now() - 1000),
    });

    try {
      const failed = await pollOnceExpectingFailure(target.id);
      expect(failed.consecutiveErrors).toBe(1);
      expect(failed.backoffUntil!.getTime()).toBeGreaterThan(Date.now());
      expect(failed.lastSuccessAt).toBeNull();

      // NEVER partial ingestion: the anchor's result set is not this seller's.
      expect(await itemByExternalId(refusedId)).toBeUndefined();
      expect(await linksFor(target.id)).toHaveLength(0);

      // A mistyped seller username is a monitor-config fault, so the shared
      // connection stays healthy for every other target on it.
      const connection = await services.connections.getConnection(connectionId);
      expect(connection.status).toBe("active");

      // The failure is DOMAIN state, not a failed job.
      await waitFor(
        async () => {
          const stats = await runtime.getStats();
          return stats.running === 0 && stats.failed === 0 ? true : undefined;
        },
        { label: "no failed jobs" },
      );
    } finally {
      state.sellerWarnings = [];
    }
  });
});

describe("monitor defaults settings", () => {
  it("exposes the registered defaults and lists them on the settings surface", async () => {
    const resolved = await services.monitorSettings.read();
    expect(resolved.defaultIntervalSeconds).toBe(60);
    expect(resolved.watchlistItemsPerPoll).toBe(20);
    expect(resolved.searchItemsPerPoll).toBe(50);
    expect(resolved.ebayRateBudget).toEqual({
      capacity: 10,
      refillPerSecond: 1.5,
    });

    const listed = await services.settings.list();
    const keys = listed.map((entry) => entry.key);
    expect(keys).toContain("monitors.defaults");
    expect(keys).toContain("monitors.observation_caps");
    expect(keys).toContain("integration.ebay.rate_budget");

    await services.settings.set(
      monitorDefaultsSetting,
      { intervalSeconds: 120 },
      { actorUserId: "test-user" },
    );
    expect((await services.monitorSettings.read()).defaultIntervalSeconds).toBe(
      120,
    );
    await services.settings.set(
      monitorDefaultsSetting,
      { intervalSeconds: 60 },
      { actorUserId: "test-user" },
    );
  });

  it("lets the observation cap setting bound what a discovery poll observes", async () => {
    const state = stateFor(connectionId);
    const cappedIds = [
      "v1|230000000001|0",
      "v1|230000000002|0",
      "v1|230000000003|0",
    ];
    state.searchSummaries = cappedIds.map((itemId) =>
      browseSummaryPayload({ itemId, price: "9.99" }),
    );

    await services.settings.set(
      monitorObservationCapsSetting,
      { watchlistItemsPerPoll: 20, searchItemsPerPoll: 1 },
      { actorUserId: "test-user" },
    );

    const target = await monitors.createTarget({
      targetType: "ebay_search",
      name: "capped search",
      connectionId,
      intervalSeconds: 300,
      config: { query: "capped", maxItems: 10 },
      nextPollAt: new Date(Date.now() - 1000),
    });

    try {
      await pollOnce(target.id);

      // All three are linked and discovered…
      expect(await linksFor(target.id)).toHaveLength(3);
      const observed: number[] = [];
      for (const id of cappedIds) {
        const item = await itemByExternalId(id);
        expect(await newListingEvents(item!.id)).toHaveLength(1);
        observed.push((await observationsFor(item!.id)).length);
      }
      // …but the cap allowed exactly ONE observation this poll.
      expect(observed.filter((count) => count === 1)).toHaveLength(1);
      expect(observed.filter((count) => count === 0)).toHaveLength(2);

      // The next poll picks up a different, staler member (round-robin).
      await pollOnce(target.id);
      const after: number[] = [];
      for (const id of cappedIds) {
        const item = await itemByExternalId(id);
        after.push((await observationsFor(item!.id)).length);
      }
      expect(after.reduce((sum, count) => sum + count, 0)).toBe(2);
    } finally {
      await services.settings.set(
        monitorObservationCapsSetting,
        { watchlistItemsPerPoll: 20, searchItemsPerPoll: 50 },
        { actorUserId: "test-user" },
      );
      state.searchSummaries = [];
    }
  });

  it("derives the adaptive interval floor from the rate-budget setting", async () => {
    // The REAL adapter factory (only the provider client is stubbed), so the
    // settings → budget → interval-floor chain is exercised end to end.
    await services.secrets.setSecret({
      secretKey: EBAY_KEYSET_SECRET_KEY,
      purpose: "ebay_keyset",
      payload: {
        appId: "fake-app-id",
        certId: "fake-cert-id",
        devId: "fake-dev-id",
        environment: "sandbox",
      },
    });
    const factory = createEbayAdapterFactory({
      db: services.db,
      secrets: services.secrets,
      connections: services.connections,
      connectionCredentials: services.connectionCredentials,
      logger: silentJobsLogger,
      createAdapter: () =>
        ({ marketplaceId: "EBAY_US", environment: "sandbox" }) as EbayAdapter,
      resolveRateBudget: async () =>
        (await services.monitorSettings.read()).ebayRateBudget,
    });

    const withDefaults = await factory.getAdapterForConnection(connectionId);
    // ceil(20 / 1.5) = 14 s, so the 30 s politeness floor wins.
    expect(withDefaults.minIntervalSeconds).toBe(
      EBAY_ABSOLUTE_MIN_INTERVAL_SECONDS,
    );

    try {
      await services.settings.set(
        ebayRateBudgetSetting,
        { capacity: 2, refillPerSecond: 0.1 },
        { actorUserId: "test-user" },
      );
      // A genuinely tight budget makes the budget term win: 20 / 0.1 = 200 s.
      const tightened = await factory.getAdapterForConnection(connectionId);
      expect(tightened.minIntervalSeconds).toBe(200);
    } finally {
      await services.settings.set(
        ebayRateBudgetSetting,
        { capacity: 10, refillPerSecond: 1.5 },
        { actorUserId: "test-user" },
      );
    }
  });
});

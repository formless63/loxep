/**
 * Live-pipeline integration tests (loxep-62y.2) through the REAL Graphile
 * Worker runtime and the REAL composed registry:
 *
 *   due target → market.dispatch-due-monitors → market.poll-target
 *     → eBay poll executor → observation batch → market event
 *     → opportunity rule attribution → notifications.deliver → transport
 *
 * The ONLY mock is the provider: `services.getEbayAdapterForConnection` is
 * replaced with a fake adapter serving canned Browse/Trading payloads, so no
 * test in this file performs network I/O. Everything else — PostgreSQL,
 * the observation hypertable, the worker, the market/notifications/domain
 * packages, the enriched message renderer — is the real thing.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeDb, createDb, runMigrations } from "@loxep/db";
import type { DbHandle } from "@loxep/db";
import { user } from "@loxep/db/schema";
import { startWorkerRuntime } from "@loxep/jobs";
import type { WorkerRuntime } from "@loxep/jobs";
import {
  createMarketTasks,
  createMonitorService,
  createOpportunityRulesService,
} from "@loxep/market";
import type { MonitorService, MonitorTargetRow } from "@loxep/market";
import { createNotificationService } from "@loxep/notifications";
import type {
  NotificationTransport,
  TransportSendInput,
} from "@loxep/notifications";
import { EbayAdapterError } from "@loxep/integration-ebay";
import { buildAppServices, buildWorkerRegistry } from "../src/index.ts";
import type { AppServices, WorkerComposition } from "../src/index.ts";
import {
  browseItemPayload,
  createScratchDb,
  dropScratchDb,
  fakeConnectionAdapter,
  fakeEbayState,
  scratchDbName,
  silentJobsLogger,
  silentLogger,
  testConfig,
  waitFor,
  watchlistItemPayload,
} from "./helpers.ts";
import type { FakeEbayState } from "./helpers.ts";

const dbName = scratchDbName("loxep_test_app_pipeline");
let databaseUrl = "";
let handle: DbHandle;
let services: AppServices;
let composition: WorkerComposition;
let runtime: WorkerRuntime;
let monitors: MonitorService;
let connectionId = "";
let failingConnectionId = "";

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

/** Trigger one dispatcher run (the every-minute cron is not needed here). */
async function dispatch(): Promise<void> {
  const market = createMarketTasks({ db: handle.db });
  await runtime.addJob(market.dispatchDueMonitorsTask, {});
}

/**
 * Run exactly one poll of a target and wait for it to be fully RECORDED.
 *
 * Waiting on `last_success_at` (not on the observation row) matters: the
 * observation is written mid-poll, while `recordPollSuccess` — which rewrites
 * `next_poll_at` from the adaptive policy — runs after the executor returns.
 * Making a target due before that lands would be overwritten.
 */
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

/** Run one poll of a target expected to FAIL, and wait for the backoff. */
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

async function observationsFor(marketplaceItemId: string) {
  return handle.db.query.marketplaceItemObservations.findMany({
    where: (table, { eq }) => eq(table.marketplaceItemId, marketplaceItemId),
    orderBy: (table, { asc }) => [asc(table.observedAt)],
  });
}

async function itemByExternalId(externalItemId: string) {
  return handle.db.query.marketplaceItems.findFirst({
    where: (table, { eq }) => eq(table.externalItemId, externalItemId),
  });
}

async function eventsForItem(marketplaceItemId: string) {
  return handle.db.query.marketEvents.findMany({
    where: (table, { eq }) => eq(table.marketplaceItemId, marketplaceItemId),
    orderBy: (table, { asc }) => [asc(table.detectedAt)],
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

  const real = buildAppServices({ config, logger: silentJobsLogger });
  // The one mock: the provider boundary.
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
  });

  runtime = await startWorkerRuntime({
    databaseUrl,
    logger: silentJobsLogger,
    concurrency: 2,
    pollInterval: 200,
    registry: composition.registry,
    // Dispatch is triggered explicitly so the tests stay fast.
    cronItems: [],
  });

  // --- fixtures -------------------------------------------------------
  await handle.db.insert(user).values({
    id: "test-user",
    name: "Test User",
    email: "pipeline@example.invalid",
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
  const failing = await services.connections.createConnection({
    provider: "ebay",
    kind: "marketplace",
    name: "broken buyer",
    createdByUserId: "test-user",
  });
  failingConnectionId = failing.id;

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
    name: "every price drop",
    endpointId: endpoint.id,
    marketEventType: "price_dropped",
  });

  // An opportunity rule so `market_events.rule_id` attribution is exercised.
  const opportunities = createOpportunityRulesService({ db: handle.db });
  await opportunities.createRule({
    name: "any drop is interesting",
    conditions: { eventTypes: ["price_dropped"] },
    scoreWeight: "1.0000",
  });
}, 120_000);

afterAll(async () => {
  await runtime?.stop();
  await composition?.close();
  await services?.close();
  await closeDb(handle);
  await dropScratchDb(dbName);
});

describe("ebay_item poll executor", () => {
  const externalItemId = "v1|110000000001|0";

  it("observes an item, derives a price drop, attributes a rule, and delivers", async () => {
    const state = stateFor(connectionId);
    state.items.set(
      externalItemId,
      browseItemPayload({
        itemId: externalItemId,
        price: "100.00",
        title: "Fake Widget",
        itemWebUrl: "https://www.ebay.com/itm/110000000001",
      }),
    );

    const target = await monitors.createTarget({
      targetType: "ebay_item",
      name: "widget",
      connectionId,
      intervalSeconds: 300,
      config: { externalItemId },
      nextPollAt: new Date(Date.now() - 1000),
    });

    await pollOnce(target.id);
    const item = await waitFor(
      async () => itemByExternalId(externalItemId),
      { label: "marketplace item upserted" },
    );
    expect(await observationsFor(item.id)).toHaveLength(1);

    // A first observation derives nothing: events interpret CHANGE.
    expect(await eventsForItem(item.id)).toHaveLength(0);

    // --- second poll, cheaper -----------------------------------------
    state.items.set(
      externalItemId,
      browseItemPayload({
        itemId: externalItemId,
        price: "80.00",
        title: "Fake Widget",
        itemWebUrl: "https://www.ebay.com/itm/110000000001",
      }),
    );
    await pollOnce(target.id);

    const events = await eventsForItem(item.id);
    const types = events.map((event) => event.eventType).sort();
    expect(types).toEqual(["price_changed", "price_dropped"]);

    const dropped = events.find(
      (event) => event.eventType === "price_dropped",
    );
    expect(dropped?.monitorTargetId).toBe(target.id);
    // Opportunity attribution ran inside the poll.
    expect(dropped?.ruleId).not.toBeNull();

    // --- delivery ------------------------------------------------------
    const delivery = await waitFor(
      async () => {
        const row = await handle.db.query.notificationDeliveries.findFirst({
          where: (table, { eq }) => eq(table.marketEventId, dropped!.id),
        });
        return row !== undefined && row.deliveredAt !== null ? row : undefined;
      },
      { label: "notification delivered" },
    );
    expect(delivery.status).toBe("delivered");
    expect(delivery.providerMessageId).toBe("fake-message-id");

    // The ENRICHED renderer ran (per-event-type title, price delta, and the
    // canonical listing URL from the listing-context bridge).
    const message = sent.at(-1)?.message;
    expect(message?.title).toBe("Price drop: Fake Widget");
    // Amounts render through the notifications formatter (Intl fed from the
    // decimal string, display-only) — no raw numeric(20,6) leaks into pushes.
    expect(message?.body).toContain("$100.00 → $80.00");
    expect(message?.body).toContain("https://www.ebay.com/itm/110000000001");
    expect(message?.priority).toBe("high");

    // --- adaptive facts -------------------------------------------------
    const after = await monitors.getTarget(target.id);
    const adaptive = adaptiveState(after);
    expect(adaptive["lastTier"]).toBeTypeOf("string");
    // The poll reported `changed`, so the streak reset rather than growing.
    expect(adaptive["unchangedStreak"]).toBe(0);
    // Never below the connection's rate-budget floor (30s in the fake).
    expect(Number(adaptive["lastComputedInterval"])).toBeGreaterThanOrEqual(30);
    expect(after.nextPollAt!.getTime()).toBeGreaterThan(Date.now());
    expect(after.consecutiveErrors).toBe(0);

    // The connection was marked healthy by the successful poll.
    const connection = await services.connections.getConnection(connectionId);
    expect(connection.status).toBe("active");
    expect(connection.lastSuccessAt).not.toBeNull();
  });

  it("records relaxation inputs and derives no event when nothing changed", async () => {
    const state = stateFor(connectionId);
    const unchangedId = "v1|110000000009|0";
    state.items.set(
      unchangedId,
      browseItemPayload({ itemId: unchangedId, price: "42.00" }),
    );

    const target = await monitors.createTarget({
      targetType: "ebay_item",
      name: "stable widget",
      connectionId,
      intervalSeconds: 300,
      config: { externalItemId: unchangedId },
      nextPollAt: new Date(Date.now() - 1000),
    });

    await pollOnce(target.id);
    const item = await waitFor(async () => itemByExternalId(unchangedId), {
      label: "stable item upserted",
    });
    expect(await observationsFor(item.id)).toHaveLength(1);

    const after = await pollOnce(target.id);
    expect(await observationsFor(item.id)).toHaveLength(2);

    // Identical state → no derived events at all.
    expect(await eventsForItem(item.id)).toHaveLength(0);

    const adaptive = adaptiveState(after);
    // One unchanged poll after the initial (changed) discovery poll.
    expect(adaptive["unchangedStreak"]).toBe(1);
    expect(adaptive["lastTier"]).toBe("steady");
  });

  it("fails the poll with a clear domain error when the target has no connection", async () => {
    const target = await monitors.createTarget({
      targetType: "ebay_item",
      name: "unbound widget",
      intervalSeconds: 300,
      config: { externalItemId: "v1|110000000099|0" },
      nextPollAt: new Date(Date.now() - 1000),
    });

    const failed = await pollOnceExpectingFailure(target.id);
    expect(failed.backoffUntil!.getTime()).toBeGreaterThan(Date.now());
    expect(failed.lastSuccessAt).toBeNull();
  });
});

describe("ebay_watchlist poll executor", () => {
  it("syncs membership, observes members, and deactivates absent links", async () => {
    const state = stateFor(connectionId);
    const watched = ["120000000001", "120000000002"];
    for (const id of watched) {
      state.items.set(
        id,
        browseItemPayload({ itemId: id, price: "25.00", title: `Watched ${id}` }),
      );
    }
    state.watchlist = watched.map((itemId) => watchlistItemPayload({ itemId }));

    const target = await monitors.createTarget({
      targetType: "ebay_watchlist",
      name: "my watchlist",
      connectionId,
      intervalSeconds: 300,
      nextPollAt: new Date(Date.now() - 1000),
    });

    await pollOnce(target.id);
    const links = await handle.db.query.monitorItems.findMany({
      where: (table, { eq }) => eq(table.monitorTargetId, target.id),
    });
    expect(links).toHaveLength(2);
    expect(links.every((link) => link.active)).toBe(true);

    // Every member was observed inside the SAME batch.
    const first = await itemByExternalId(watched[0] as string);
    const second = await itemByExternalId(watched[1] as string);
    const firstObs = await observationsFor(first!.id);
    const secondObs = await observationsFor(second!.id);
    expect(firstObs).toHaveLength(1);
    expect(secondObs).toHaveLength(1);
    expect(firstObs[0]!.observationBatchId).toBe(
      secondObs[0]!.observationBatchId,
    );
    expect(firstObs[0]!.source).toBe("ebay:watchlist");
    // The discovery link carries the item's canonical identity.
    expect(first!.canonicalUrl).toContain(watched[0] as string);

    // --- member removed from the watch list ---------------------------
    state.watchlist = [watchlistItemPayload({ itemId: watched[0] as string })];
    const after = await pollOnce(target.id);

    const deactivated = await handle.db.query.monitorItems.findFirst({
      where: (table, { and, eq }) =>
        and(
          eq(table.monitorTargetId, target.id),
          eq(table.marketplaceItemId, second!.id),
        ),
    });
    expect(deactivated?.active).toBe(false);

    const stillActive = await handle.db.query.monitorItems.findFirst({
      where: (table, { and, eq }) =>
        and(
          eq(table.monitorTargetId, target.id),
          eq(table.marketplaceItemId, first!.id),
        ),
    });
    expect(stillActive?.active).toBe(true);
    expect(after.consecutiveErrors).toBe(0);
    expect(after.lastSuccessAt).not.toBeNull();
  });

  it("fails a watchlist poll when the connection has no user consent", async () => {
    const unconsentedState = stateFor(failingConnectionId);
    unconsentedState.consented = false;

    const target = await monitors.createTarget({
      targetType: "ebay_watchlist",
      name: "unconsented watchlist",
      connectionId: failingConnectionId,
      intervalSeconds: 300,
      nextPollAt: new Date(Date.now() - 1000),
    });

    const failed = await pollOnceExpectingFailure(target.id);
    expect(failed.backoffUntil).not.toBeNull();

    const connection =
      await services.connections.getConnection(failingConnectionId);
    expect(connection.status).toBe("error");
    expect(connection.lastErrorCode).toBe("ebay_auth");
    unconsentedState.consented = true;
  });
});

describe("provider failure path", () => {
  it("records poll backoff and connection error state on a taxonomy error", async () => {
    const state = stateFor(failingConnectionId);
    state.items.set(
      "v1|130000000001|0",
      browseItemPayload({ itemId: "v1|130000000001|0", price: "5.00" }),
    );
    state.failWith = new EbayAdapterError(
      "provider_unavailable",
      "fake provider outage",
    );

    const target = await monitors.createTarget({
      targetType: "ebay_item",
      name: "outage widget",
      connectionId: failingConnectionId,
      intervalSeconds: 300,
      config: { externalItemId: "v1|130000000001|0" },
      nextPollAt: new Date(Date.now() - 1000),
    });

    try {
      const failed = await pollOnceExpectingFailure(target.id);
      expect(failed.consecutiveErrors).toBe(1);
      expect(failed.backoffUntil!.getTime()).toBeGreaterThan(Date.now());

      const connection =
        await services.connections.getConnection(failingConnectionId);
      expect(connection.status).toBe("error");
      expect(connection.lastErrorCode).toBe("ebay_provider_unavailable");

      // A poll failure is DOMAIN state, not a job failure.
      await waitFor(
        async () => {
          const stats = await runtime.getStats();
          return stats.running === 0 && stats.failed === 0 ? true : undefined;
        },
        { label: "no failed jobs" },
      );
    } finally {
      state.failWith = null;
    }
  });
});

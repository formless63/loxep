/**
 * Reverb poll-executor integration tests (loxep-g4t.3) through the REAL
 * Graphile Worker runtime and the REAL composed registry:
 *
 *   due `reverb_listing`/`reverb_shop` target
 *     -> market.dispatch-due-monitors -> market.poll-target
 *     -> Reverb poll executor -> marketplace_items + observations -> market events
 *     -> notifications.deliver -> transport
 *
 * The ONLY mock is the provider: `services.getReverbAdapterForConnection` is
 * replaced with a fake adapter serving canned Reverb listing payloads
 * (`fakeReverbConnectionAdapter`), so no test here performs network I/O.
 * Everything else — PostgreSQL, the observation hypertable, the worker, the
 * market/notifications/domain packages — is the real thing, mirroring
 * `etsy-poll-executor.test.ts`'s discipline exactly.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeDb, createDb, runMigrations } from "@loxep/db";
import type { DbHandle } from "@loxep/db";
import { user } from "@loxep/db/schema";
import { startWorkerRuntime } from "@loxep/jobs";
import type { WorkerRuntime } from "@loxep/jobs";
import { createMarketTasks, createMonitorService } from "@loxep/market";
import type { MonitorService, MonitorTargetRow } from "@loxep/market";
import type { NotificationTransport, TransportSendInput } from "@loxep/notifications";
import { buildAppServices, buildWorkerRegistry } from "../src/index.ts";
import type { AppServices, WorkerComposition } from "../src/index.ts";
import { ReverbAdapterError } from "../../integrations/reverb/src/index.ts";
import {
  createScratchDb,
  dropScratchDb,
  fakeReverbConnectionAdapter,
  fakeReverbState,
  scratchDbName,
  silentJobsLogger,
  silentLogger,
  testConfig,
  waitFor,
} from "./helpers.ts";
import type { FakeReverbState } from "./helpers.ts";

const dbName = scratchDbName("loxep_test_app_reverb_poll");
let databaseUrl = "";
let handle: DbHandle;
let services: AppServices;
let composition: WorkerComposition;
let runtime: WorkerRuntime;
let monitors: MonitorService;
let connectionId = "";
let failingConnectionId = "";

const states = new Map<string, FakeReverbState>();
const sent: TransportSendInput[] = [];

const captureTransport: NotificationTransport = {
  provider: "ntfy",
  send: async (input) => {
    sent.push(input);
    return { providerMessageId: "fake-message-id" };
  },
};

function stateFor(id: string): FakeReverbState {
  let state = states.get(id);
  if (state === undefined) {
    state = fakeReverbState();
    states.set(id, state);
  }
  return state;
}

function reverbListingPayload(input: {
  id: string;
  title?: string;
  amount?: string;
  currency?: string;
  state?: string;
  shopId?: string;
}): Record<string, unknown> {
  return {
    id: Number(input.id),
    title: input.title ?? `Listing ${input.id}`,
    state: input.state ?? "live",
    price: { amount: input.amount ?? "299.99", currency: input.currency ?? "USD" },
    shop: { id: input.shopId ?? "55555", name: "Test Shop" },
    _links: { web: { href: `https://reverb.com/item/${input.id}` } },
  };
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

async function pollOnceExpectingFailure(targetId: string): Promise<MonitorTargetRow> {
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

async function eventsForItem(marketplaceItemId: string) {
  return handle.db.query.marketEvents.findMany({
    where: (table, { eq }) => eq(table.marketplaceItemId, marketplaceItemId),
    orderBy: (table, { asc }) => [asc(table.detectedAt)],
  });
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
    getReverbAdapterForConnection: async (id) =>
      fakeReverbConnectionAdapter(id, stateFor(id)),
    invalidateReverbAdapter: () => {},
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
    cronItems: [],
  });

  await handle.db.insert(user).values({
    id: "test-user",
    name: "Test User",
    email: "reverb-pipeline@example.invalid",
    emailVerified: true,
    createdAt: new Date(),
    updatedAt: new Date(),
  });

  const connection = await services.connections.createConnection({
    provider: "reverb",
    kind: "marketplace_account",
    name: "test Reverb account",
    createdByUserId: "test-user",
  });
  connectionId = connection.id;
  const failing = await services.connections.createConnection({
    provider: "reverb",
    kind: "marketplace_account",
    name: "broken Reverb account",
    createdByUserId: "test-user",
  });
  failingConnectionId = failing.id;

  monitors = createMonitorService({ db: handle.db });
}, 60_000);

afterAll(async () => {
  await runtime?.stop();
  await composition?.close();
  await services?.close();
  await closeDb(handle);
  await dropScratchDb(dbName);
});

describe("reverb_listing", () => {
  it("observes a listing and records success", async () => {
    const state = stateFor(connectionId);
    state.listings.set(
      "111111",
      reverbListingPayload({ id: "111111", title: "1965 Stratocaster" }),
    );
    const target = await monitors.createTarget({
      targetType: "reverb_listing",
      name: "watch listing 111111",
      intervalSeconds: 300,
      connectionId,
      config: { externalItemId: "111111" },
    });

    const polled = await pollOnce(target.id);
    expect(polled.consecutiveErrors).toBe(0);

    const item = await itemByExternalId("111111");
    expect(item).toBeDefined();
    expect(item?.provider).toBe("reverb");
    expect(item?.title).toBe("1965 Stratocaster");

    const observations = await observationsFor(item!.id);
    expect(observations).toHaveLength(1);
    expect(observations[0]?.price).toBe("299.990000");
    expect(observations[0]?.currency).toBe("USD");
  });

  it("derives a price-change market event on a second, different poll", async () => {
    const state = stateFor(connectionId);
    state.listings.set("222222", reverbListingPayload({ id: "222222", amount: "150.00" }));
    const target = await monitors.createTarget({
      targetType: "reverb_listing",
      name: "watch listing 222222",
      intervalSeconds: 300,
      connectionId,
      config: { externalItemId: "222222" },
    });
    await pollOnce(target.id);
    const item = await itemByExternalId("222222");

    state.listings.set("222222", reverbListingPayload({ id: "222222", amount: "120.00" }));
    await pollOnce(target.id);

    const observations = await observationsFor(item!.id);
    expect(observations).toHaveLength(2);
    expect(observations[0]?.price).toBe("150.000000");
    expect(observations[1]?.price).toBe("120.000000");

    const events = await eventsForItem(item!.id);
    expect(events.some((event) => event.eventType === "price_dropped")).toBe(true);
  });

  it("maps sold -> ended, firing a listing_ended event", async () => {
    const state = stateFor(connectionId);
    state.listings.set("333333", reverbListingPayload({ id: "333333" }));
    const target = await monitors.createTarget({
      targetType: "reverb_listing",
      name: "watch listing 333333",
      intervalSeconds: 300,
      connectionId,
      config: { externalItemId: "333333" },
    });
    await pollOnce(target.id);
    const item = await itemByExternalId("333333");

    state.listings.set("333333", reverbListingPayload({ id: "333333", state: "sold" }));
    await pollOnce(target.id);

    const events = await eventsForItem(item!.id);
    expect(events.some((event) => event.eventType === "listing_ended")).toBe(true);
    const observations = await observationsFor(item!.id);
    expect(observations[1]?.listingState).toBe("ended");
  });

  it("records a poll failure and backoff on a provider error, without touching the connection type", async () => {
    const state = stateFor(failingConnectionId);
    state.failWith = new ReverbAdapterError("not_found", "fake listing not found");
    const target = await monitors.createTarget({
      targetType: "reverb_listing",
      name: "always fails",
      intervalSeconds: 300,
      connectionId: failingConnectionId,
      config: { externalItemId: "does-not-exist" },
    });
    const polled = await pollOnceExpectingFailure(target.id);
    expect(polled.consecutiveErrors).toBeGreaterThan(0);
    expect(polled.backoffUntil).not.toBeNull();
  });
});

describe("reverb_shop", () => {
  it("observes every listing on the connected account's page in one poll", async () => {
    const state = stateFor(connectionId);
    state.myListingsPages = [
      [
        reverbListingPayload({ id: "444444", title: "Gear A" }),
        reverbListingPayload({ id: "555555", title: "Gear B" }),
      ],
    ];
    const target = await monitors.createTarget({
      targetType: "reverb_shop",
      name: "watch the connected account",
      intervalSeconds: 900,
      connectionId,
      config: { maxItems: 10 },
    });

    const polled = await pollOnce(target.id);
    expect(polled.consecutiveErrors).toBe(0);

    const itemA = await itemByExternalId("444444");
    const itemB = await itemByExternalId("555555");
    expect(itemA?.title).toBe("Gear A");
    expect(itemB?.title).toBe("Gear B");
    expect(await observationsFor(itemA!.id)).toHaveLength(1);
    expect(await observationsFor(itemB!.id)).toHaveLength(1);
  });

  it("follows nextHref across multiple pages when the account has more listings", async () => {
    const state = stateFor(connectionId);
    state.myListingsPages = [
      [reverbListingPayload({ id: "666601" })],
      [reverbListingPayload({ id: "666602" })],
      [reverbListingPayload({ id: "666603" })],
    ];
    const target = await monitors.createTarget({
      targetType: "reverb_shop",
      name: "watch the connected account (paged)",
      intervalSeconds: 900,
      connectionId,
      config: { maxItems: 10 },
    });

    await pollOnce(target.id);
    for (const id of ["666601", "666602", "666603"]) {
      const item = await itemByExternalId(id);
      expect(item).toBeDefined();
    }
  });
});

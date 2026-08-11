/**
 * Commerce sync wiring (loxep-xh9.7.1 / .7.2) through the REAL Graphile
 * Worker runtime and the REAL composed registry:
 *
 * ```text
 * woo_orders target (created through @loxep/market's monitor service)
 *   → market.dispatch-due-monitors  → market.poll-target
 *   → the ROUTED poll executor      → @loxep/app's woo_orders branch
 *   → @loxep/commerce syncConnection → orders/lines/provenance rows
 *   → config.commerceSync watermark  → recordPollSuccess (next_poll_at)
 * ```
 *
 * The ONLY mock is the network: `services.getWooAdapterForConnection` returns
 * an adapter built by the REAL `createWooAdapter` over a stubbed `fetchImpl`
 * that honours `modified_after`, `page`, and `per_page` and answers with the
 * WordPress pagination headers. Everything else — PostgreSQL, the worker, the
 * market scheduler, the commerce ingestion service, the cursor SQL — is real.
 *
 * The three things this file is actually here to prove:
 *
 * 1. a `woo_orders` row can be created THROUGH the monitor service (it could
 *    not before the registration; @loxep/commerce had to insert it directly);
 * 2. the dispatcher claims it and the app executor runs the commerce sync,
 *    advancing the cursor so a second poll fetches only what is newer;
 * 3. a provider failure records a poll failure with backoff AND puts the
 *    connection into its error state — the same contract the eBay branch has.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeDb, createDb, runMigrations } from "@loxep/db";
import type { DbHandle } from "@loxep/db";
import { user } from "@loxep/db/schema";
import { startWorkerRuntime } from "@loxep/jobs";
import type { WorkerRuntime } from "@loxep/jobs";
import {
  COMMERCE_SYNC_CONFIG_KEY,
  MONITOR_TARGET_TYPES,
  createMarketTasks,
  createMonitorService,
  monitorTargetConfigSchemas,
} from "@loxep/market";
import type { MonitorService, MonitorTargetRow } from "@loxep/market";
import {
  WOO_ORDERS_TARGET_TYPE,
  wooOrdersTargetConfigSchema,
} from "@loxep/commerce";
import { buildAppServices, buildWorkerRegistry } from "../src/index.ts";
import type { AppServices, WorkerComposition } from "../src/index.ts";
import {
  createScratchDb,
  dropScratchDb,
  fakeWooConnectionAdapter,
  fakeWooState,
  scratchDbName,
  silentJobsLogger,
  silentLogger,
  testConfig,
  waitFor,
  wooOrderPayload,
} from "./helpers.ts";
import type { FakeWooState } from "./helpers.ts";

const dbName = scratchDbName("loxep_test_app_commerce");
let databaseUrl = "";
let handle: DbHandle;
let services: AppServices;
let composition: WorkerComposition;
let runtime: WorkerRuntime;
let monitors: MonitorService;
let connectionId = "";
let failingConnectionId = "";

const states = new Map<string, FakeWooState>();
let invalidated: string[] = [];

function stateFor(id: string): FakeWooState {
  let state = states.get(id);
  if (state === undefined) {
    state = fakeWooState();
    states.set(id, state);
  }
  return state;
}

async function dispatch(): Promise<void> {
  const market = createMarketTasks({ db: handle.db });
  await runtime.addJob(market.dispatchDueMonitorsTask, {});
}

/** Run one poll of a target and wait for `last_success_at` to advance. */
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

/** Run one poll expected to FAIL, and wait for the recorded backoff. */
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

function commerceSyncState(target: MonitorTargetRow): Record<string, unknown> {
  const config = target.config as Record<string, unknown> | null;
  const state = config?.[COMMERCE_SYNC_CONFIG_KEY];
  return typeof state === "object" && state !== null
    ? (state as Record<string, unknown>)
    : {};
}

async function orderCount(connection: string): Promise<number> {
  const rows = await handle.pool.query<{ n: string }>(
    `select count(*)::text as n from orders where connection_id = $1`,
    [connection],
  );
  return Number(rows.rows[0]?.n ?? "0");
}

beforeAll(async () => {
  databaseUrl = await createScratchDb(dbName);
  await runMigrations({ databaseUrl, logger: silentLogger });
  handle = createDb(databaseUrl);
  const config = testConfig(databaseUrl);

  const real = buildAppServices({ config, logger: silentJobsLogger });
  // The one mock: the provider boundary. `invalidateWooAdapter` is captured
  // rather than stubbed away, because the auth-failure contract asserts it.
  services = {
    ...real,
    getWooAdapterForConnection: async (id) =>
      fakeWooConnectionAdapter(id, stateFor(id)),
    invalidateWooAdapter: (id) => {
      invalidated.push(id);
    },
  };

  composition = buildWorkerRegistry({
    config,
    services,
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

  await handle.db.insert(user).values({
    id: "test-user",
    name: "Test User",
    email: "commerce@example.invalid",
    emailVerified: true,
    createdAt: new Date(),
    updatedAt: new Date(),
  });

  const connection = await services.connections.createConnection({
    provider: "woocommerce",
    kind: "store",
    name: "fake shop",
    config: { woo: { baseUrl: "https://shop.example.test" } },
    createdByUserId: "test-user",
  });
  connectionId = connection.id;

  const failing = await services.connections.createConnection({
    provider: "woocommerce",
    kind: "store",
    name: "broken shop",
    config: { woo: { baseUrl: "https://broken.example.test" } },
    createdByUserId: "test-user",
  });
  failingConnectionId = failing.id;

  monitors = createMonitorService({ db: handle.db });
}, 120_000);

afterAll(async () => {
  await runtime?.stop();
  await composition?.close();
  await services?.close();
  await closeDb(handle);
  await dropScratchDb(dbName);
});

describe("'woo_orders' target-type registration", () => {
  it("is part of the closed target-type union and has a config schema", () => {
    expect(MONITOR_TARGET_TYPES).toContain(WOO_ORDERS_TARGET_TYPE);
    expect(monitorTargetConfigSchemas.woo_orders).toBeDefined();
  });

  /**
   * THE DRIFT GUARD for the deliberate schema duplication: @loxep/market
   * re-declares Commerce's `commerceSync` shape structurally (it must not
   * depend on a domain that registers against it), so the two must be kept in
   * step by a test rather than by the type system. Both directions are
   * checked — a field added on either side, or a bound tightened on either
   * side, fails here rather than in production.
   */
  it("accepts, on BOTH sides, every config @loxep/commerce writes", () => {
    const configs: Array<Record<string, unknown>> = [
      {},
      { [COMMERCE_SYNC_CONFIG_KEY]: {} },
      {
        [COMMERCE_SYNC_CONFIG_KEY]: {
          modifiedAfter: "2026-08-01T00:00:00.000Z",
          lastSyncedAt: "2026-08-01T00:05:00.000Z",
          lastOrderCount: 12,
          perPage: 20,
          maxPages: 10,
        },
      },
      // The scheduler's own namespace travels alongside on every real row.
      {
        [COMMERCE_SYNC_CONFIG_KEY]: { lastOrderCount: 0 },
        adaptive: { enabled: false, unchangedStreak: 3 },
      },
    ];
    for (const config of configs) {
      expect(
        monitorTargetConfigSchemas.woo_orders.safeParse(config).success,
      ).toBe(true);
      expect(wooOrdersTargetConfigSchema.safeParse(config).success).toBe(true);
    }
  });

  it("rejects, on BOTH sides, a typo inside the commerceSync namespace", () => {
    const config = {
      [COMMERCE_SYNC_CONFIG_KEY]: { modifedAfter: "2026-08-01T00:00:00.000Z" },
    };
    expect(
      monitorTargetConfigSchemas.woo_orders.safeParse(config).success,
    ).toBe(false);
    expect(wooOrdersTargetConfigSchema.safeParse(config).success).toBe(false);
  });

  it("registers the commerce task in the composed registry", () => {
    expect(composition.registry.has("commerce.sync-woo-orders")).toBe(true);
    // The poll route and the on-demand task share ONE sync service.
    expect(composition.commerce.sync).toBeDefined();
  });
});

describe("woo_orders poll executor", () => {
  let targetId = "";

  it("creates the sync target THROUGH the monitor service", async () => {
    const target = await monitors.createTarget({
      targetType: WOO_ORDERS_TARGET_TYPE,
      name: "fake shop orders",
      connectionId,
      intervalSeconds: 900,
      config: { [COMMERCE_SYNC_CONFIG_KEY]: { perPage: 2, maxPages: 5 } },
      nextPollAt: new Date(Date.now() - 1000),
    });
    targetId = target.id;
    expect(target.targetType).toBe(WOO_ORDERS_TARGET_TYPE);
    // Config survived validation with the namespace intact.
    expect(commerceSyncState(target)["perPage"]).toBe(2);
  });

  it("ingests every page and advances the cursor", async () => {
    const state = stateFor(connectionId);
    state.orders = [
      wooOrderPayload({ id: 9001, dateModifiedGmt: "2026-08-01T10:00:00" }),
      wooOrderPayload({ id: 9002, dateModifiedGmt: "2026-08-01T11:00:00" }),
      wooOrderPayload({ id: 9003, dateModifiedGmt: "2026-08-01T12:00:00" }),
    ];

    const polled = await pollOnce(targetId);
    expect(await orderCount(connectionId)).toBe(3);

    // Three orders over a per_page of 2 is two pages.
    expect(state.requests).toBe(2);
    // The first poll had no watermark.
    expect(state.modifiedAfter[0]).toBeNull();

    const cursor = commerceSyncState(polled);
    expect(cursor["lastOrderCount"]).toBe(3);
    expect(typeof cursor["modifiedAfter"]).toBe("string");
    // The watermark is the newest modification seen, rewound by the
    // one-second overlap @loxep/commerce applies.
    expect(Date.parse(String(cursor["modifiedAfter"]))).toBe(
      Date.parse("2026-08-01T12:00:00Z") - 1000,
    );

    // The poll recorded success on the connection, not just on the target.
    const connection = await services.connections.getConnection(connectionId);
    expect(connection.status).toBe("active");
    expect(connection.lastSuccessAt).not.toBeNull();
  });

  it("re-polls incrementally: only the cursor's slice, and idempotently", async () => {
    const state = stateFor(connectionId);
    state.requests = 0;
    state.modifiedAfter = [];
    state.orders.push(
      wooOrderPayload({ id: 9004, dateModifiedGmt: "2026-08-01T13:00:00" }),
    );

    const polled = await pollOnce(targetId);

    // The stored watermark was replayed to the provider…
    expect(state.modifiedAfter[0]).not.toBeNull();
    // …and the store's EXCLUSIVE filter answered with the new order plus
    // exactly one old one: the cursor is deliberately rewound by
    // CURSOR_OVERLAP_SECONDS, so the order that sat on the previous page
    // boundary is re-read rather than risked. Two of the four orders were
    // never fetched again at all.
    expect(commerceSyncState(polled)["lastOrderCount"]).toBe(2);
    // The re-read one was ingested idempotently: still four orders.
    expect(await orderCount(connectionId)).toBe(4);
    expect(Date.parse(String(commerceSyncState(polled)["modifiedAfter"]))).toBe(
      Date.parse("2026-08-01T13:00:00Z") - 1000,
    );
  });

  it("advances next_poll_at no faster than the rate-budget floor", async () => {
    const target = await monitors.getTarget(targetId);
    expect(target.nextPollAt).not.toBeNull();
    const seconds =
      ((target.nextPollAt as Date).getTime() -
        (target.lastSuccessAt as Date).getTime()) /
      1000;
    // The fake adapter reports the documented 300 s Woo politeness floor; a
    // poll that saw one order lands in a tightening tier, so the floor is what
    // actually binds here.
    expect(seconds).toBeGreaterThanOrEqual(300);
  });

  it("treats a store with nothing new as idle (changed = ordersSeen > 0)", async () => {
    // A store that has never sold anything: the poll fetches zero orders, so
    // `changed` is false and the adaptive policy starts relaxing cadence.
    const quiet = await services.connections.createConnection({
      provider: "woocommerce",
      kind: "store",
      name: "quiet shop",
      config: { woo: { baseUrl: "https://quiet.example.test" } },
      createdByUserId: "test-user",
    });
    stateFor(quiet.id).orders = [];

    const target = await monitors.createTarget({
      targetType: WOO_ORDERS_TARGET_TYPE,
      name: "quiet shop orders",
      connectionId: quiet.id,
      intervalSeconds: 900,
      nextPollAt: new Date(Date.now() - 1000),
    });

    const polled = await pollOnce(target.id);
    expect(commerceSyncState(polled)["lastOrderCount"]).toBe(0);
    // An empty page must never invent a watermark.
    expect(commerceSyncState(polled)["modifiedAfter"]).toBeNull();
    expect(await orderCount(quiet.id)).toBe(0);

    const adaptive = (polled.config as Record<string, unknown>)[
      "adaptive"
    ] as Record<string, unknown>;
    expect(adaptive["unchangedStreak"]).toBe(1);
  });
});

describe("woo_orders failure path", () => {
  it("records a poll failure and the connection's error state on auth failure", async () => {
    const state = stateFor(failingConnectionId);
    state.status = 401;
    invalidated = [];

    const target = await monitors.createTarget({
      targetType: WOO_ORDERS_TARGET_TYPE,
      name: "broken shop orders",
      connectionId: failingConnectionId,
      intervalSeconds: 900,
      nextPollAt: new Date(Date.now() - 1000),
    });

    const failed = await pollOnceExpectingFailure(target.id);
    expect(failed.consecutiveErrors).toBe(1);
    expect(failed.backoffUntil).not.toBeNull();
    expect((failed.backoffUntil as Date).getTime()).toBeGreaterThan(Date.now());
    // Nothing was written for a poll that never got a page.
    expect(await orderCount(failingConnectionId)).toBe(0);

    const connection = await services.connections.getConnection(
      failingConnectionId,
    );
    expect(connection.status).toBe("error");
    expect(connection.lastErrorCode).toBe("woo_auth");
    // An auth-class failure drops the cached adapter so a re-keyed
    // connection recovers on the next poll, not after the cache TTL.
    expect(invalidated).toContain(failingConnectionId);

    // The healthy connection is untouched by its neighbour's failure.
    const healthy = await services.connections.getConnection(connectionId);
    expect(healthy.status).toBe("active");
  });
});

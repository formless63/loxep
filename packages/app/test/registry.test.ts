/**
 * Composition smoke tests: the worker registry builds, carries every task the
 * Phase 1 pipeline needs, and boots the REAL Graphile Worker runtime.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeDb, createDb, runMigrations } from "@loxep/db";
import type { DbHandle } from "@loxep/db";
import { user } from "@loxep/db/schema";
import {
  MEDUSA_ORDERS_TARGET_TYPE,
  REDACT_ORDER_PAYLOADS_TASK_NAME,
  SYNC_EBAY_ORDERS_TASK_NAME,
  SYNC_MEDUSA_ORDERS_TASK_NAME,
  SYNC_WOO_ORDERS_TASK_NAME,
  ensureMedusaOrderSyncTarget,
} from "@loxep/commerce";
import {
  DISPATCH_TASK_NAME,
  MONITOR_TARGET_TYPES,
  POLL_TARGET_TASK_NAME,
  createMarketTasks,
} from "@loxep/market";
import type { MedusaAdapter } from "@loxep/integration-medusa";
import {
  ENSURE_MAIL_DOMAIN_TASK,
  POLL_MAIL_OWNERSHIP_TASK,
  RECONCILE_CONTAINER_HOST_TASK,
  SYNC_MAILBOXES_TASK,
  SYNC_TOKEN_POLICY_TASK,
} from "@loxep/infrastructure";
import { DELIVER_TASK_NAME } from "@loxep/notifications";
import { startWorkerRuntime } from "@loxep/jobs";
import type { WorkerRuntime } from "@loxep/jobs";
import {
  ACCOUNTING_POST_FACTS_TASK_NAME,
  EBAY_ABSOLUTE_MIN_INTERVAL_SECONDS,
  FLEET_EVIDENCE_INGEST_TASK,
  GATUS_PUSH_TASK_NAME,
  HEALTH_SWEEP_TASK_NAME,
  REFRESH_TOKENS_TASK_NAME,
  SYNC_EBAY_PURCHASES_TASK_NAME,
  WOO_ABSOLUTE_MIN_INTERVAL_SECONDS,
  WOO_PAGES_PER_SYNC,
  buildAppServices,
  buildWorkerRegistry,
  rateBudgetIntervalFloorSeconds,
  wooRateBudgetIntervalFloorSeconds,
} from "../src/index.ts";
import type {
  AppServices,
  MedusaConnectionAdapter,
  WorkerComposition,
} from "../src/index.ts";
import {
  createScratchDb,
  dropScratchDb,
  scratchDbName,
  silentJobsLogger,
  silentLogger,
  testConfig,
  waitFor,
} from "./helpers.ts";

const dbName = scratchDbName("loxep_test_app_registry");
let databaseUrl = "";
let composition: WorkerComposition;
let runtime: WorkerRuntime | undefined;

beforeAll(async () => {
  databaseUrl = await createScratchDb(dbName);
  await runMigrations({ databaseUrl, logger: silentLogger });
}, 120_000);

afterAll(async () => {
  await runtime?.stop();
  await composition?.close();
  await dropScratchDb(dbName);
});

describe("buildWorkerRegistry", () => {
  it("registers every pipeline task and its cron schedules", () => {
    composition = buildWorkerRegistry({
      config: testConfig(databaseUrl),
      logger: silentJobsLogger,
    });

    expect([...composition.registry.keys()].sort()).toEqual(
      [
        DISPATCH_TASK_NAME,
        POLL_TARGET_TASK_NAME,
        DELIVER_TASK_NAME,
        REFRESH_TOKENS_TASK_NAME,
        SYNC_WOO_ORDERS_TASK_NAME,
        SYNC_EBAY_ORDERS_TASK_NAME,
        SYNC_MEDUSA_ORDERS_TASK_NAME,
        REDACT_ORDER_PAYLOADS_TASK_NAME,
        // Flipping M5 (loxep-dgf.5): the on-demand eBay purchase-history sync
        // task, sharing the `ebay_orders`-style split — SCHEDULED polling is
        // the `ebay_purchases` monitor-target route, not this task.
        SYNC_EBAY_PURCHASES_TASK_NAME,
        // Phase 7 milestone 2 (loxep-lmy.2). Three tasks and no fourth poll
        // route: ownership verification is a bounded, self-terminating poll,
        // which the infrastructure design classifies as NOT scheduling, so it
        // registers no `monitor_targets` target type.
        ENSURE_MAIL_DOMAIN_TASK,
        POLL_MAIL_OWNERSHIP_TASK,
        SYNC_MAILBOXES_TASK,
        // Phase 7 milestone 3 (loxep-lmy.3): the on-demand DNS-token
        // zone-scope policy sync — enqueued by `tokens.ts`'s `setZones`/
        // `mint`, never claimed by the dispatcher. `sync-proxy-resource` is
        // deliberately NOT registered; see `registry.ts`'s module doc.
        SYNC_TOKEN_POLICY_TASK,
        // loxep-hb7 Milestone C: the container-host reconciler — enqueued by
        // `declareIntent` (an intent change) and by the fleet-detail
        // registration panel's Reconcile/Check-now buttons. Milestone D's
        // drift cadence calls the same underlying service directly from
        // `fleet-health.ts`'s Dockhand connection probe instead of through
        // this task, so it registers no cron item of its own.
        RECONCILE_CONTAINER_HOST_TASK,
        "maintenance.heartbeat",
        // Phase 8 milestone 1 (loxep-ovj.1): the one recurring integration
        // health sweep, no monitor_targets row.
        HEALTH_SWEEP_TASK_NAME,
        // Phase 8 milestone 2 (loxep-ovj.2): the outward Gatus health push,
        // piggybacking on the same 5-minute cadence.
        GATUS_PUSH_TASK_NAME,
        // loxep-6fm: the posting-engine sweep — WEAVE AUDIT finding 1's
        // "the ledger has no pump", wired into the worker for the first time.
        ACCOUNTING_POST_FACTS_TASK_NAME,
        // Phase 8 milestone 7 (loxep-ovj.7): the on-demand fleet-evidence
        // projection — enqueued transactionally by `receiveFleetEvidence`
        // from the inbound webhook, never claimed by the dispatcher.
        FLEET_EVIDENCE_INGEST_TASK,
      ].sort(),
    );

    const cronTasks = composition.cronItems.map((item) => item.task);
    expect(cronTasks).toContain("maintenance.heartbeat");
    expect(cronTasks).toContain(DISPATCH_TASK_NAME);
    expect(cronTasks).toContain(REFRESH_TOKENS_TASK_NAME);
    expect(cronTasks).toContain(HEALTH_SWEEP_TASK_NAME);
    expect(cronTasks).toContain(GATUS_PUSH_TASK_NAME);
    expect(cronTasks).toContain(ACCOUNTING_POST_FACTS_TASK_NAME);
    // @loxep/commerce's ORDER SYNC defines no cron item on purpose: its
    // scheduled work is a `woo_orders` / `ebay_orders` / `medusa_orders`
    // monitor target the market dispatcher claims, which is the whole point
    // of registering a target type rather than adding a second scheduler.
    expect(cronTasks).not.toContain(SYNC_WOO_ORDERS_TASK_NAME);
    expect(cronTasks).not.toContain(SYNC_EBAY_ORDERS_TASK_NAME);
    expect(cronTasks).not.toContain(SYNC_MEDUSA_ORDERS_TASK_NAME);
    // Same rule for `ebay_purchases`: it is an `ebay_purchases` monitor
    // target the market dispatcher claims, not a cron item.
    expect(cronTasks).not.toContain(SYNC_EBAY_PURCHASES_TASK_NAME);
    // The ADR-0021 retention sweep IS cron-driven, and is the one commerce
    // job that is: a retention window is a wall-clock fact about stored rows,
    // not something any connection polls.
    expect(cronTasks).toContain(REDACT_ORDER_PAYLOADS_TASK_NAME);
    // Every cron item points at a registered task, or the runtime drops it.
    for (const task of cronTasks) {
      expect(composition.registry.has(task)).toBe(true);
    }
  });

  it("boots the embedded worker runtime with the composed registry", async () => {
    runtime = await startWorkerRuntime({
      databaseUrl,
      logger: silentJobsLogger,
      concurrency: 1,
      pollInterval: 200,
      registry: composition.registry,
      cronItems: composition.cronItems,
    });

    const stats = await runtime.getStats();
    expect(stats.failed).toBe(0);

    // The maintenance task from @loxep/jobs' defaults still works through the
    // composed registry (the job → database write path).
    await runtime.addJob(
      composition.registry.get("maintenance.heartbeat")!,
      {},
    );
    await waitFor(
      async () => {
        const result = await runtime!.pool.query(
          "select 1 from application_settings where key = 'runtime.heartbeat'",
        );
        return result.rowCount === 1;
      },
      { label: "heartbeat wrote runtime.heartbeat" },
    );
  });
});

describe("rate-budget interval floor", () => {
  it("never falls below the politeness floor with the documented defaults", () => {
    expect(rateBudgetIntervalFloorSeconds({ refillPerSecond: 1.5 })).toBe(
      EBAY_ABSOLUTE_MIN_INTERVAL_SECONDS,
    );
  });

  it("tightens when the budget genuinely constrains cadence", () => {
    // 20 targets / 0.1 calls-per-second = 200 s between polls.
    expect(rateBudgetIntervalFloorSeconds({ refillPerSecond: 0.1 })).toBe(200);
  });
});

describe("WooCommerce rate-budget interval floor", () => {
  it("is the 5-minute politeness floor with the documented defaults", () => {
    // ceil(10 pages / 1 per second) = 10 s, far below the politeness floor —
    // the thing on the other end is somebody's self-hosted WordPress.
    expect(wooRateBudgetIntervalFloorSeconds({ refillPerSecond: 1 })).toBe(
      WOO_ABSOLUTE_MIN_INTERVAL_SECONDS,
    );
  });

  it("tightens when a deliberately gentle budget constrains a whole walk", () => {
    // One full sync walk of WOO_PAGES_PER_SYNC requests at 1 per 100 s.
    expect(wooRateBudgetIntervalFloorSeconds({ refillPerSecond: 0.01 })).toBe(
      WOO_PAGES_PER_SYNC * 100,
    );
  });
});

/**
 * The route table's silent failure mode: a `medusa_orders` target that falls
 * through to the eBay fallback executor instead of `medusaOrderPollExecutor`
 * (`registry.ts`'s route map). `getEbayAdapterForConnection` is stubbed to
 * THROW unconditionally and count its own calls, so a broken route fails this
 * test loudly (the poll would error, and `ebayAdapterCalls` would be nonzero)
 * instead of silently misrouting.
 */
describe("medusa_orders routing", () => {
  const routingDbName = scratchDbName("loxep_test_app_registry_medusa_routing");
  let routingDatabaseUrl = "";
  let routingHandle: DbHandle;
  let routingServices: AppServices;
  let routingComposition: WorkerComposition;
  let routingRuntime: WorkerRuntime;
  let ebayAdapterCalls = 0;
  let connectionId = "";
  let targetId = "";

  beforeAll(async () => {
    routingDatabaseUrl = await createScratchDb(routingDbName);
    await runMigrations({ databaseUrl: routingDatabaseUrl, logger: silentLogger });
    routingHandle = createDb(routingDatabaseUrl);
    const config = testConfig(routingDatabaseUrl);

    const real = buildAppServices({ config, logger: silentJobsLogger });
    const fakeMedusaAdapter: MedusaConnectionAdapter = {
      connectionId: "",
      baseUrl: "https://medusa-routing-check.example.invalid",
      sourceAccountKey: "medusa:https://medusa-routing-check.example.invalid",
      // Unused: paging comes from the injected `medusaOrders` iterator below,
      // never from this adapter object directly.
      adapter: {} as unknown as MedusaAdapter,
      minIntervalSeconds: 60,
    };
    routingServices = {
      ...real,
      getEbayAdapterForConnection: async () => {
        ebayAdapterCalls += 1;
        throw new Error(
          "medusa_orders must not reach the eBay fallback executor",
        );
      },
      getMedusaAdapterForConnection: async (id) => ({
        ...fakeMedusaAdapter,
        connectionId: id,
      }),
    };

    routingComposition = buildWorkerRegistry({
      config,
      services: routingServices,
      logger: silentJobsLogger,
      // Zero pages: this test proves ROUTING, not ingestion — a successful,
      // empty sync is enough to show the poll reached the Medusa branch.
      medusaOrders: () => (async function* () {})(),
    });

    routingRuntime = await startWorkerRuntime({
      databaseUrl: routingDatabaseUrl,
      logger: silentJobsLogger,
      concurrency: 1,
      pollInterval: 200,
      registry: routingComposition.registry,
      cronItems: [],
    });

    await routingHandle.db.insert(user).values({
      id: "registry-medusa-routing-user",
      name: "Registry Medusa Routing",
      email: "registry-medusa-routing@example.invalid",
      emailVerified: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const connection = await routingServices.connections.createConnection({
      provider: "medusa",
      kind: "store",
      name: "routing-check backend",
      createdByUserId: "registry-medusa-routing-user",
    });
    connectionId = connection.id;

    const cursor = await ensureMedusaOrderSyncTarget(routingHandle.db, {
      connectionId,
    });
    targetId = cursor.monitorTargetId;
  }, 120_000);

  afterAll(async () => {
    await routingRuntime?.stop();
    await routingComposition?.close();
    // `composition.close()` is a no-op here (services were INJECTED, not
    // owned), so the underlying pool `buildAppServices` opened must be
    // closed explicitly — the same two-handle discipline
    // `commerce-ebay-sync.test.ts` follows.
    await routingServices?.close();
    await closeDb(routingHandle);
    await dropScratchDb(routingDbName);
  });

  it("IS registered in @loxep/market's target-type union", () => {
    expect(MONITOR_TARGET_TYPES).toContain(MEDUSA_ORDERS_TARGET_TYPE);
  });

  it("routes medusa_orders to the Medusa executor, never the eBay fallback", async () => {
    await routingHandle.pool.query(
      `update monitor_targets
          set next_poll_at = now() - interval '1 second', backoff_until = null
        where id = $1`,
      [targetId],
    );

    const market = createMarketTasks({ db: routingHandle.db });
    await routingRuntime.addJob(market.dispatchDueMonitorsTask, {});

    await waitFor(
      async () => {
        const rows = await routingHandle.pool.query<{
          last_success_at: Date | null;
        }>(`select last_success_at from monitor_targets where id = $1`, [
          targetId,
        ]);
        return rows.rows[0]?.last_success_at !== null ? true : undefined;
      },
      { timeoutMs: 30_000, label: "medusa_orders routing poll succeeded" },
    );

    // The strongest possible evidence of correct routing: the eBay fallback
    // executor — which would throw for ANY connection on a "medusa_orders"
    // target type, per `poll-executor.ts`'s own unsupported-target-type
    // guard — was never even asked to resolve an adapter.
    expect(ebayAdapterCalls).toBe(0);
  });
});

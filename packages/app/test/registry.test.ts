/**
 * Composition smoke tests: the worker registry builds, carries every task the
 * Phase 1 pipeline needs, and boots the REAL Graphile Worker runtime.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runMigrations } from "@loxep/db";
import {
  REDACT_ORDER_PAYLOADS_TASK_NAME,
  SYNC_EBAY_ORDERS_TASK_NAME,
  SYNC_WOO_ORDERS_TASK_NAME,
} from "@loxep/commerce";
import { DISPATCH_TASK_NAME, POLL_TARGET_TASK_NAME } from "@loxep/market";
import {
  ENSURE_MAIL_DOMAIN_TASK,
  POLL_MAIL_OWNERSHIP_TASK,
  SYNC_MAILBOXES_TASK,
  SYNC_TOKEN_POLICY_TASK,
} from "@loxep/infrastructure";
import { DELIVER_TASK_NAME } from "@loxep/notifications";
import { startWorkerRuntime } from "@loxep/jobs";
import type { WorkerRuntime } from "@loxep/jobs";
import {
  EBAY_ABSOLUTE_MIN_INTERVAL_SECONDS,
  GATUS_PUSH_TASK_NAME,
  HEALTH_SWEEP_TASK_NAME,
  REFRESH_TOKENS_TASK_NAME,
  SYNC_EBAY_PURCHASES_TASK_NAME,
  WOO_ABSOLUTE_MIN_INTERVAL_SECONDS,
  WOO_PAGES_PER_SYNC,
  buildWorkerRegistry,
  rateBudgetIntervalFloorSeconds,
  wooRateBudgetIntervalFloorSeconds,
} from "../src/index.ts";
import type { WorkerComposition } from "../src/index.ts";
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
        "maintenance.heartbeat",
        // Phase 8 milestone 1 (loxep-ovj.1): the one recurring integration
        // health sweep, no monitor_targets row.
        HEALTH_SWEEP_TASK_NAME,
        // Phase 8 milestone 2 (loxep-ovj.2): the outward Gatus health push,
        // piggybacking on the same 5-minute cadence.
        GATUS_PUSH_TASK_NAME,
      ].sort(),
    );

    const cronTasks = composition.cronItems.map((item) => item.task);
    expect(cronTasks).toContain("maintenance.heartbeat");
    expect(cronTasks).toContain(DISPATCH_TASK_NAME);
    expect(cronTasks).toContain(REFRESH_TOKENS_TASK_NAME);
    expect(cronTasks).toContain(HEALTH_SWEEP_TASK_NAME);
    expect(cronTasks).toContain(GATUS_PUSH_TASK_NAME);
    // @loxep/commerce's ORDER SYNC defines no cron item on purpose: its
    // scheduled work is a `woo_orders` / `ebay_orders` monitor target the
    // market dispatcher claims, which is the whole point of registering a
    // target type rather than adding a second scheduler.
    expect(cronTasks).not.toContain(SYNC_WOO_ORDERS_TASK_NAME);
    expect(cronTasks).not.toContain(SYNC_EBAY_ORDERS_TASK_NAME);
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

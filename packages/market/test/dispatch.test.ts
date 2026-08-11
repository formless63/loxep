/**
 * Dispatcher/poll-stub integration tests (loxep-ubx.1) through the REAL
 * Graphile Worker runtime: due target → dispatcher claim → enqueued
 * `market.poll-target` → stub executor → poll success recorded.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeDb, createDb, runMigrations } from "@loxep/db";
import type { DbHandle } from "@loxep/db";
import { createTaskRegistry, jobKeyFor, startWorkerRuntime } from "@loxep/jobs";
import type { WorkerRuntime } from "@loxep/jobs";
import {
  DISPATCH_TASK_NAME,
  POLL_TARGET_TASK_NAME,
  createMarketTasks,
  createMonitorService,
} from "../src/index.ts";
import type { MonitorService, MonitorTargetRow } from "../src/index.ts";
import {
  createScratchDb,
  dropScratchDb,
  scratchDbName,
  silentJobsLogger,
  silentLogger,
  waitFor,
} from "./helpers.ts";

const dbName = scratchDbName("loxep_test_dispatch");
let databaseUrl = "";
let handle: DbHandle;
let service: MonitorService;
let runtime: WorkerRuntime;

const polled: MonitorTargetRow[] = [];
let failNext = 0;

beforeAll(async () => {
  databaseUrl = await createScratchDb(dbName);
  await runMigrations({ databaseUrl, logger: silentLogger });
  handle = createDb(databaseUrl);
  service = createMonitorService({ db: handle.db });

  const market = createMarketTasks({
    db: handle.db,
    // Stub executor: records targets it saw; fails on demand. No provider
    // I/O anywhere (Phase 0).
    pollExecutor: (target) => {
      if (failNext > 0) {
        failNext -= 1;
        throw new Error("simulated provider failure");
      }
      polled.push(target);
      return { observations: 0 };
    },
  });
  runtime = await startWorkerRuntime({
    databaseUrl,
    logger: silentJobsLogger,
    concurrency: 2,
    pollInterval: 200,
    registry: createTaskRegistry(market.tasks),
    // The every-minute cron item is exercised structurally below; tests
    // trigger dispatch runs directly to stay fast.
    cronItems: [market.dispatchDueMonitorsCronItem],
  });
});

afterAll(async () => {
  await runtime.stop();
  await closeDb(handle);
  await dropScratchDb(dbName);
});

describe("createMarketTasks", () => {
  it("exposes a jobKey-replace every-minute cron item for the dispatcher", () => {
    const market = createMarketTasks({ db: handle.db });
    expect(market.dispatchDueMonitorsCronItem).toEqual({
      task: DISPATCH_TASK_NAME,
      match: "* * * * *",
      identifier: "market_dispatch_due_monitors",
      options: {
        maxAttempts: 3,
        backfillPeriod: 0,
        jobKey: jobKeyFor(DISPATCH_TASK_NAME, "cron"),
        jobKeyMode: "replace",
      },
    });
    expect(market.tasks.map((t) => t.name)).toEqual([
      DISPATCH_TASK_NAME,
      POLL_TARGET_TASK_NAME,
    ]);
  });
});

describe("dispatch → poll end to end", () => {
  it("claims a due target, enqueues a poll job, and records a stub success", async () => {
    const target = await service.createTarget({
      targetType: "ebay_watchlist",
      name: "e2e watchlist",
      intervalSeconds: 300,
      nextPollAt: new Date(Date.now() - 1000),
    });
    const before = await service.getTarget(target.id);
    expect(before.lastSuccessAt).toBeNull();

    const market = createMarketTasks({ db: handle.db });
    await runtime.addJob(market.dispatchDueMonitorsTask, {});

    await waitFor(
      async () => {
        const row = await service.getTarget(target.id);
        return row.lastSuccessAt !== null ? row : undefined;
      },
      { label: "poll success recorded" },
    );
    const after = await service.getTarget(target.id);
    expect(after.consecutiveErrors).toBe(0);
    expect(after.backoffUntil).toBeNull();
    // The claim advanced next_poll_at one interval into the future.
    expect(after.nextPollAt!.getTime()).toBeGreaterThan(Date.now());
    // The stub executor received the claimed target.
    expect(polled.some((t) => t.id === target.id)).toBe(true);
  });

  it("records failure with backoff when the executor throws, and the job itself completes", async () => {
    const target = await service.createTarget({
      targetType: "ebay_watchlist",
      name: "failing watchlist",
      intervalSeconds: 300,
      nextPollAt: new Date(Date.now() - 1000),
    });
    failNext = 1;

    const market = createMarketTasks({ db: handle.db });
    await runtime.addJob(market.dispatchDueMonitorsTask, {});

    const failed = await waitFor(
      async () => {
        const row = await service.getTarget(target.id);
        return row.consecutiveErrors > 0 ? row : undefined;
      },
      { label: "poll failure recorded" },
    );
    expect(failed.consecutiveErrors).toBe(1);
    expect(failed.backoffUntil).not.toBeNull();
    expect(failed.backoffUntil!.getTime()).toBeGreaterThan(Date.now());
    expect(failed.lastSuccessAt).toBeNull();

    // Poll failures are domain state, not job failures: no failed jobs
    // remain (the poll job completed after recording backoff).
    await waitFor(
      async () => {
        const stats = await runtime.getStats();
        return stats.running === 0 && stats.failed === 0 ? true : undefined;
      },
      { label: "no failed jobs" },
    );

    // The dispatcher will not re-claim while backoff_until is in the future.
    polled.length = 0;
    await runtime.addJob(market.dispatchDueMonitorsTask, {});
    await new Promise((resolve) => setTimeout(resolve, 800));
    expect(polled.some((t) => t.id === target.id)).toBe(false);
  });

  it("skips targets that were disabled between dispatch and poll", async () => {
    const target = await service.createTarget({
      targetType: "ebay_watchlist",
      name: "disabled before poll",
      intervalSeconds: 300,
      nextPollAt: new Date(Date.now() - 1000),
      enabled: true,
    });
    // Disable immediately; the dispatcher may have claimed it already, so
    // the poll task must no-op rather than record activity.
    await service.updateTarget(target.id, { enabled: false });
    polled.length = 0;

    const market = createMarketTasks({ db: handle.db });
    await runtime.addJob(market.dispatchDueMonitorsTask, {});
    await new Promise((resolve) => setTimeout(resolve, 800));

    const row = await service.getTarget(target.id);
    expect(row.lastSuccessAt).toBeNull();
    expect(polled.some((t) => t.id === target.id)).toBe(false);
  });
});

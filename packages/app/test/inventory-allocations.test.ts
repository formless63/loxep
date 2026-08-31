/**
 * `inventory.expire-stale-holds` wiring tests (loxep-souz): the task/cron
 * shape, a stale `manual_hold` actually expiring through the sweep (proving
 * `available_to_sell` unsuppresses), a fresh hold staying untouched, and
 * re-running the sweep being a no-op — the idempotency contract this
 * module's doc claims from `AllocationsService.expireStaleHolds`'s own
 * `UPDATE ... WHERE status = 'reserved'` predicate.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeDb, createDb, runMigrations } from "@loxep/db";
import type { DbHandle } from "@loxep/db";
import { createAllocationsService, createItemsService } from "@loxep/inventory";
import { jobKeyFor } from "@loxep/jobs";
import type { TaskContext } from "@loxep/jobs";
import {
  EXPIRE_STALE_HOLDS_CRON_MATCH,
  EXPIRE_STALE_HOLDS_TASK_NAME,
  buildAppServices,
  createExpireStaleHoldsTasks,
  runExpireStaleHoldsSweep,
} from "../src/index.ts";
import type { AppServices } from "../src/index.ts";
import {
  createScratchDb,
  dropScratchDb,
  scratchDbName,
  silentJobsLogger,
  silentLogger,
  testConfig,
} from "./helpers.ts";

function noopHelpers(): TaskContext["helpers"] {
  return { addJob: async () => ({}) as never } as unknown as TaskContext["helpers"];
}

describe("inventory.expire-stale-holds", () => {
  const dbName = scratchDbName("loxep_test_app_inventory_allocations");
  let databaseUrl = "";
  let handle: DbHandle;
  let services: AppServices;
  let items: ReturnType<typeof createItemsService>;
  let allocations: ReturnType<typeof createAllocationsService>;

  beforeAll(async () => {
    databaseUrl = await createScratchDb(dbName);
    await runMigrations({ databaseUrl, logger: silentLogger });
    handle = createDb(databaseUrl);
    services = buildAppServices({
      config: testConfig(databaseUrl),
      logger: silentJobsLogger,
    });
    items = createItemsService({ db: handle.db });
    allocations = createAllocationsService({ db: handle.db });
  }, 120_000);

  afterAll(async () => {
    await services?.close();
    await closeDb(handle);
    await dropScratchDb(dbName);
  });

  it("has the expected task name and an hourly cron match", () => {
    const tasks = createExpireStaleHoldsTasks({ services });
    expect(tasks.expireStaleHoldsTask.name).toBe(EXPIRE_STALE_HOLDS_TASK_NAME);
    expect(tasks.expireStaleHoldsCronItem.match).toBe(
      EXPIRE_STALE_HOLDS_CRON_MATCH,
    );
    expect(tasks.expireStaleHoldsCronItem.options.jobKey).toBe(
      jobKeyFor(EXPIRE_STALE_HOLDS_TASK_NAME, "cron"),
    );
    expect(tasks.expireStaleHoldsCronItem.options.jobKeyMode).toBe("replace");
  });

  it("expires a stale manual hold and unsuppresses available-to-sell", async () => {
    const item = await items.create({ label: "held past its date", currency: "USD" });
    await allocations.reserve({
      inventoryItemId: item.id,
      allocationKind: "manual_hold",
      expiresAt: new Date("2026-01-01T00:00:00Z"),
    });
    expect(await items.availableToSell(item.id)).toBe("0.000000");

    const result = await runExpireStaleHoldsSweep({
      services,
      asOf: new Date("2026-06-01T00:00:00Z"),
    });
    expect(result.expired).toBeGreaterThanOrEqual(1);
    expect(await items.availableToSell(item.id)).toBe("1.000000");
  });

  it("never touches a hold that has not expired yet", async () => {
    const item = await items.create({ label: "held, not due yet", currency: "USD" });
    await allocations.reserve({
      inventoryItemId: item.id,
      allocationKind: "manual_hold",
      expiresAt: new Date("2099-01-01T00:00:00Z"),
    });

    await runExpireStaleHoldsSweep({
      services,
      asOf: new Date("2026-06-01T00:00:00Z"),
    });
    expect(await items.availableToSell(item.id)).toBe("0.000000");
  });

  it("is idempotent: the task handler run twice back-to-back re-expires nothing the second time", async () => {
    const item = await items.create({ label: "double-swept", currency: "USD" });
    await allocations.reserve({
      inventoryItemId: item.id,
      allocationKind: "manual_hold",
      expiresAt: new Date("2026-01-01T00:00:00Z"),
    });

    const tasks = createExpireStaleHoldsTasks({ services });
    const asOf = "2026-06-01T00:00:00.000Z";
    const first = (await tasks.expireStaleHoldsTask.handler(
      { asOf },
      { logger: silentJobsLogger, helpers: noopHelpers() },
    )) as { expired: number };
    expect(first.expired).toBeGreaterThanOrEqual(1);

    const second = (await tasks.expireStaleHoldsTask.handler(
      { asOf },
      { logger: silentJobsLogger, helpers: noopHelpers() },
    )) as { expired: number };
    expect(second.expired).toBe(0);

    expect(await items.availableToSell(item.id)).toBe("1.000000");
  });
});

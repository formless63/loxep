/**
 * `health.sweep` wiring tests (loxep-ovj.1): the task/cron shape and one
 * end-to-end pass against a real scratch database and the real default
 * subject registry (a fixture connection is the only subject present, so no
 * network probe ever fires — `notification_endpoints`/`storage_backends`
 * start empty).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeDb, createDb, runMigrations } from "@loxep/db";
import { user } from "@loxep/db/schema";
import type { DbHandle } from "@loxep/db";
import { createHealthService } from "@loxep/domain";
import { jobKeyFor } from "@loxep/jobs";
import type { TaskContext } from "@loxep/jobs";
import {
  HEALTH_SWEEP_TASK_NAME,
  buildAppServices,
  createHealthSweepTasks,
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

describe("health.sweep", () => {
  const dbName = scratchDbName("loxep_test_app_health_sweep");
  let databaseUrl = "";
  let handle: DbHandle;
  let services: AppServices;

  beforeAll(async () => {
    databaseUrl = await createScratchDb(dbName);
    await runMigrations({ databaseUrl, logger: silentLogger });
    handle = createDb(databaseUrl);
    services = buildAppServices({
      config: testConfig(databaseUrl),
      logger: silentJobsLogger,
    });
    await handle.db.insert(user).values({
      id: "health-sweep-test-fixture",
      name: "Health Sweep Fixture",
      email: "health-sweep@example.invalid",
      emailVerified: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
  }, 120_000);

  afterAll(async () => {
    await services?.close();
    await closeDb(handle);
    await dropScratchDb(dbName);
  });

  it("has the expected task name and a 5-minute cron match", () => {
    const tasks = createHealthSweepTasks({ services });
    expect(tasks.healthSweepTask.name).toBe(HEALTH_SWEEP_TASK_NAME);
    expect(tasks.healthSweepCronItem.match).toBe("*/5 * * * *");
    expect(tasks.healthSweepCronItem.options.jobKey).toBe(
      jobKeyFor(HEALTH_SWEEP_TASK_NAME, "cron"),
    );
    expect(tasks.healthSweepCronItem.options.jobKeyMode).toBe("replace");
  });

  it("probes a real connection through the default registry and upserts one row", async () => {
    const connection = await services.connections.createConnection({
      provider: "ebay",
      kind: "seller",
      name: "health sweep fixture",
      createdByUserId: "health-sweep-test-fixture",
    });
    await services.connections.recordConnectionSuccess(connection.id);

    const tasks = createHealthSweepTasks({ services });
    await tasks.healthSweepTask.handler(
      {},
      { logger: silentJobsLogger, helpers: noopHelpers() },
    );

    const health = createHealthService({ db: services.db });
    const row = await health.getHealth("connection", connection.id);
    expect(row?.status).toBe("ok");
    expect(row?.source).toBe("probe");
  });

  it("is idempotent by the primary key across two consecutive runs", async () => {
    const tasks = createHealthSweepTasks({ services });
    // Immediately due again is unlikely (5-minute base backoff), but a second
    // run must never throw or duplicate a row even when nothing was due.
    await expect(
      tasks.healthSweepTask.handler(
        {},
        { logger: silentJobsLogger, helpers: noopHelpers() },
      ),
    ).resolves.toBeDefined();

    const rows = await handle.pool.query<{ n: string }>(
      "select count(*)::text as n from integration_health",
    );
    // One row per subject — never more than one per (subject_type, subject_id).
    const dedup = await handle.pool.query<{ n: string }>(
      `select count(*)::text as n from (
         select subject_type, subject_id, count(*) as c
           from integration_health
          group by subject_type, subject_id
         having count(*) > 1
       ) dupes`,
    );
    expect(Number(dedup.rows[0]?.n ?? "0")).toBe(0);
    expect(Number(rows.rows[0]?.n ?? "0")).toBeGreaterThanOrEqual(1);
  });
});

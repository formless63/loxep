/**
 * Worker runtime integration tests (loxep-680.4) against real PostgreSQL
 * (docker/compose.dev.yml). One scratch database for the whole file; tests
 * run sequentially and build on each other's queue state carefully.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { hostname } from "node:os";
import { z } from "zod";
import { createDb, closeDb, runMigrations } from "@loxep/db";
import type { DbHandle } from "@loxep/db";
import { createLogger } from "@loxep/observability";
import {
  DEFAULT_MAX_ATTEMPTS,
  HEARTBEAT_SETTINGS_KEY,
  addJob,
  createTaskRegistry,
  defineTask,
  getJobStats,
  heartbeatTask,
  jobKeyFor,
  startWorkerRuntime,
} from "../src/index.ts";
import type { WorkerRuntime } from "../src/index.ts";
import {
  createScratchDb,
  dropScratchDb,
  scratchDbName,
  silentLogger,
  waitFor,
} from "./helpers.ts";

// ---------- unit-level conventions ----------

describe("task conventions", () => {
  it("jobKeyFor builds taskName:stableId", () => {
    expect(jobKeyFor("poll.monitor", "42")).toBe("poll.monitor:42");
  });

  it("defineTask applies the default retry budget", () => {
    const task = defineTask({
      name: "t.default",
      payloadSchema: z.object({}),
      handler: () => undefined,
    });
    expect(task.maxAttempts).toBe(DEFAULT_MAX_ATTEMPTS);
    expect(DEFAULT_MAX_ATTEMPTS).toBe(8);
  });

  it("defineTask honors a per-task maxAttempts override", () => {
    expect(heartbeatTask.maxAttempts).toBe(3);
  });

  it("createTaskRegistry rejects duplicate names", () => {
    const task = defineTask({
      name: "t.dup",
      payloadSchema: z.object({}),
      handler: () => undefined,
    });
    expect(() => createTaskRegistry([task, task])).toThrow(/duplicate/);
  });
});

// ---------- integration ----------

interface LogLine {
  msg?: string;
  [key: string]: unknown;
}

const logLines: LogLine[] = [];
const destination = {
  write(chunk: string) {
    for (const line of chunk.split("\n")) {
      const trimmed = line.trim();
      if (trimmed) logLines.push(JSON.parse(trimmed) as LogLine);
    }
  },
};

const executed: Array<{ value: string }> = [];
const echoTask = defineTask({
  name: "test.echo",
  payloadSchema: z.object({
    value: z.string(),
    correlationId: z.string().optional(),
  }),
  handler: (payload, { logger }) => {
    executed.push({ value: payload.value });
    logger.info({ value: payload.value }, "echo executed");
  },
});

describe("startWorkerRuntime", () => {
  const dbName = scratchDbName("loxep_test_jobs");
  let databaseUrl = "";
  let runtime: WorkerRuntime;
  const logger = createLogger({ level: "debug" }, destination);

  beforeAll(async () => {
    databaseUrl = await createScratchDb(dbName);
    await runMigrations({ databaseUrl, logger: silentLogger });
    runtime = await startWorkerRuntime({
      databaseUrl,
      logger,
      concurrency: 2,
      pollInterval: 200,
      registry: createTaskRegistry([echoTask, heartbeatTask]),
    });
  });

  afterAll(async () => {
    await runtime.stop();
    await dropScratchDb(dbName);
  });

  it("executes a typed task with validated payload and log context", async () => {
    await runtime.addJob(echoTask, {
      value: "hello",
      correlationId: "corr-123",
    });
    await waitFor(
      () => Promise.resolve(executed.some((e) => e.value === "hello")),
      { label: "echo job execution" },
    );
    const line = logLines.find((l) => l.msg === "echo executed");
    expect(line).toBeDefined();
    expect(line?.["task"]).toBe("test.echo");
    expect(typeof line?.["jobId"]).toBe("string");
    expect(line?.["correlationId"]).toBe("corr-123");
    expect(line?.["value"]).toBe("hello");
  });

  it("rejects an invalid payload at the enqueue site", async () => {
    await expect(
      // @ts-expect-error — intentionally wrong payload type
      runtime.addJob(echoTask, { value: 42 }),
    ).rejects.toThrow();
  });

  it("fails an invalid raw payload in the handler and retries per policy", async () => {
    // Bypass typed enqueue validation via the raw Graphile addJob, keeping
    // the task's retry budget as the typed helper would set it.
    const job = await runtime.runner.addJob(
      "test.echo",
      { value: 42 },
      { maxAttempts: echoTask.maxAttempts },
    );
    const failedRow = await waitFor(
      async () => {
        const result = await runtime.pool.query(
          `select attempts, max_attempts, last_error, run_at
             from graphile_worker.jobs where id = $1 and attempts >= 1 and locked_at is null`,
          [job.id],
        );
        return result.rows[0];
      },
      { label: "first failed attempt" },
    );
    expect(Number(failedRow.attempts)).toBeGreaterThanOrEqual(1);
    expect(Number(failedRow.max_attempts)).toBe(8);
    expect(String(failedRow.last_error)).toContain("payload failed validation");
    // Exponential backoff scheduled the retry in the future.
    expect(new Date(failedRow.run_at as string).getTime()).toBeGreaterThan(
      Date.now(),
    );
    const line = logLines.find(
      (l) => l.msg === `task "test.echo" payload failed validation`,
    );
    expect(line).toBeDefined();
    expect(typeof line?.["jobId"]).toBe("string");
    // Clean up so later stats assertions are deterministic.
    await runtime.pool.query(
      "select graphile_worker.complete_jobs(array[$1::bigint])",
      [job.id],
    );
  });

  it("dedupes jobKey enqueues with replace semantics", async () => {
    const runAt = new Date(Date.now() + 3_600_000);
    const jobKey = jobKeyFor("test.echo", "dedupe");
    await runtime.addJob(echoTask, { value: "first" }, { jobKey, runAt });
    await runtime.addJob(echoTask, { value: "second" }, { jobKey, runAt });
    // The public `jobs` view intentionally omits payload; read the row
    // count from the view and the payload from the private table.
    const viewResult = await runtime.pool.query(
      "select id from graphile_worker.jobs where key = $1",
      [jobKey],
    );
    expect(viewResult.rows).toHaveLength(1);
    const result = await runtime.pool.query(
      "select payload from graphile_worker._private_jobs where key = $1",
      [jobKey],
    );
    expect(result.rows).toHaveLength(1);
    expect((result.rows[0]?.payload as { value: string }).value).toBe("second");
    await runtime.pool.query("select graphile_worker.remove_job($1)", [jobKey]);
  });

  it("heartbeat task upserts the runtime.heartbeat settings row", async () => {
    await runtime.addJob(heartbeatTask, {});
    const row = await waitFor(
      async () => {
        const result = await runtime.pool.query(
          "select value from application_settings where key = $1",
          [HEARTBEAT_SETTINGS_KEY],
        );
        return result.rows[0];
      },
      { label: "heartbeat settings row" },
    );
    const value = row.value as { lastRunAt: string; hostname: string };
    expect(value.hostname).toBe(hostname());
    expect(Number.isNaN(Date.parse(value.lastRunAt))).toBe(false);
  });

  it("registers the heartbeat cron schedule", async () => {
    const row = await waitFor(
      async () => {
        const result = await runtime.pool.query(
          "select identifier from graphile_worker._private_known_crontabs where identifier = $1",
          ["maintenance_heartbeat"],
        );
        return result.rows[0];
      },
      { label: "known crontab row" },
    );
    expect(row.identifier).toBe("maintenance_heartbeat");
  });

  it("getStats reflects pending and permanently failed jobs", async () => {
    // Pending: scheduled in the future so the runner leaves it alone.
    await runtime.addJob(
      echoTask,
      { value: "stats-pending" },
      {
        jobKey: jobKeyFor("test.echo", "stats-pending"),
        runAt: new Date(Date.now() + 3_600_000),
      },
    );
    // Permanently failed: invalid payload with a single attempt allowed.
    const failed = await runtime.runner.addJob(
      "test.echo",
      { value: 99 },
      { maxAttempts: 1 },
    );
    await waitFor(
      async () => {
        const result = await runtime.pool.query(
          // attempts increments at checkout, so also require the lock to be
          // released — otherwise stats still counts the job as running.
          "select 1 from graphile_worker.jobs where id = $1 and attempts >= max_attempts and locked_at is null",
          [failed.id],
        );
        return result.rows[0];
      },
      { label: "permanently failed job" },
    );
    const stats = await runtime.getStats();
    expect(stats.pending).toBeGreaterThanOrEqual(1);
    expect(stats.failed).toBeGreaterThanOrEqual(1);
    expect(stats.running).toBeGreaterThanOrEqual(0);
    expect(
      stats.oldestPendingSeconds === null ||
        stats.oldestPendingSeconds >= 0,
    ).toBe(true);
  });

  it("stops gracefully and supports standalone addJob + getJobStats", async () => {
    await runtime.stop();
    await expect(runtime.runner.promise).resolves.toBeUndefined();
    // Stop is idempotent.
    await runtime.stop();

    // With no runner, a due job stays pending — enqueue via the standalone
    // helper over a plain pool, then read stats the same way.
    const handle: DbHandle = createDb(databaseUrl);
    try {
      await addJob(handle.pool, echoTask, { value: "after-stop" });
      const stats = await getJobStats(handle.pool);
      expect(stats.pending).toBeGreaterThanOrEqual(2);
      expect(stats.oldestPendingSeconds).not.toBeNull();
      expect(stats.oldestPendingSeconds).toBeGreaterThanOrEqual(0);
    } finally {
      await closeDb(handle);
    }
  });
});

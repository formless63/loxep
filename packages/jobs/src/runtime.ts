/**
 * Embedded Graphile Worker runner (ADR-0003, ADR-0013, ADR-0018).
 *
 * `startWorkerRuntime` runs graphile-worker's library-mode `run()` inside the
 * current Node process, sharing a pg Pool created from the database URL. The
 * runner creates/updates its own `graphile_worker` schema at startup — that
 * schema is Graphile-owned and is NOT part of Loxep's Drizzle migrations.
 *
 * APIs verified against graphile-worker 0.17.3 (worker.graphile.org/docs +
 * packaged type declarations): `run({ pgPool, taskList, concurrency,
 * parsedCronItems, noHandleSignals, logger })` → `Runner { stop, addJob,
 * promise, events }`; `makeWorkerUtils({ pgPool })` for enqueue-only clients;
 * `parseCronItems` for programmatic cron.
 */
import {
  Logger as GraphileLogger,
  makeWorkerUtils,
  parseCronItems,
  run,
} from "graphile-worker";
import type {
  AddJobFunction,
  CronItem,
  Job,
  Runner,
  Task,
  TaskList,
} from "graphile-worker";
import { z } from "zod";
import { createDb, closeDb } from "@loxep/db";
import type { DbHandle } from "@loxep/db";
import { runWithLogContext } from "@loxep/observability";
import type { LogContext } from "@loxep/observability";
import type {
  AnyLoxepTask,
  EnqueueOptions,
  JobsLogger,
  LoxepTask,
  TaskRegistry,
} from "./conventions.ts";
import { createTaskRegistry } from "./conventions.ts";
import { heartbeatCronItem, heartbeatTask } from "./tasks/heartbeat.ts";
import { getJobStats } from "./stats.ts";
import type { JobStats } from "./stats.ts";

/** Tasks every Loxep worker runs unless a custom registry is supplied. */
export const defaultTaskRegistry: TaskRegistry = createTaskRegistry([
  heartbeatTask,
]);

/** Recurring schedules paired with {@link defaultTaskRegistry}. */
export const defaultCronItems: readonly CronItem[] = [heartbeatCronItem];

/** Typed enqueue: validates the payload, applies the task's retry budget. */
export type AddJob = <TSchema extends z.ZodType>(
  task: LoxepTask<TSchema>,
  payload: z.input<TSchema>,
  options?: EnqueueOptions,
) => Promise<Job>;

export interface StartWorkerRuntimeOptions {
  databaseUrl: string;
  logger: JobsLogger;
  /** Parallel job slots in this process (default 4). */
  concurrency?: number;
  /** Tasks to run (default {@link defaultTaskRegistry}). */
  registry?: TaskRegistry;
  /** Cron items to schedule; entries whose task is not registered are skipped. */
  cronItems?: readonly CronItem[];
  /** Fallback poll interval in ms (default graphile-worker's 2000). */
  pollInterval?: number;
}

export interface WorkerRuntime {
  /** The underlying graphile-worker Runner (stop, promise, events). */
  runner: Runner;
  /** The shared pg Pool (also usable with {@link getJobStats}). */
  pool: DbHandle["pool"];
  addJob: AddJob;
  /** Queue statistics from the graphile_worker schema. */
  getStats: () => Promise<JobStats>;
  /** Graceful shutdown: finish in-flight jobs, then release the pool. */
  stop: () => Promise<void>;
}

function extractCorrelationId(rawPayload: unknown): string | undefined {
  if (
    typeof rawPayload === "object" &&
    rawPayload !== null &&
    "correlationId" in rawPayload &&
    typeof (rawPayload as { correlationId: unknown }).correlationId === "string"
  ) {
    return (rawPayload as { correlationId: string }).correlationId;
  }
  return undefined;
}

/**
 * Wrap a Loxep task as a Graphile task: log-context scoping, payload
 * validation, child logger. Validation failures throw, so the job fails and
 * retries per the retry policy — enqueue-side validation in {@link AddJob}
 * makes that path rare (raw SQL/cron enqueues are the remaining source).
 */
function wrapTask(task: AnyLoxepTask, baseLogger: JobsLogger): Task {
  return (rawPayload, helpers) => {
    const job = helpers.job;
    const context: LogContext = { jobId: job.id };
    const correlationId = extractCorrelationId(rawPayload);
    if (correlationId !== undefined) {
      context.correlationId = correlationId;
    }
    return runWithLogContext(context, async () => {
      const logger = baseLogger.child({
        task: task.name,
        attempt: job.attempts,
      });
      const parsed = task.payloadSchema.safeParse(rawPayload);
      if (!parsed.success) {
        const message = `task "${task.name}" payload failed validation`;
        logger.error({ issues: parsed.error.issues }, message);
        const issues: Array<{ path: PropertyKey[]; message: string }> =
          parsed.error.issues;
        throw new Error(
          `${message}: ${issues
            .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
            .join("; ")}`,
        );
      }
      await task.handler(parsed.data, { logger, helpers });
    });
  };
}

function buildTaskList(
  registry: TaskRegistry,
  baseLogger: JobsLogger,
): TaskList {
  const taskList: TaskList = {};
  for (const [name, task] of registry) {
    taskList[name] = wrapTask(task, baseLogger);
  }
  return taskList;
}

/** Bridge graphile-worker's logger onto the Loxep structured logger. */
function graphileLoggerFor(logger: JobsLogger): GraphileLogger {
  const child = logger.child({ component: "graphile-worker" });
  return new GraphileLogger((scope) => (level, message, meta) => {
    const fields = { ...scope, ...(meta !== undefined ? { meta } : {}) };
    // LogLevel is an ambient const enum (string-valued: "error" | "warning" |
    // "info" | "debug"), inaccessible under verbatimModuleSyntax.
    switch (level as string) {
      case "error":
        child.error(fields, message);
        break;
      case "warning":
        child.warn(fields, message);
        break;
      case "debug":
        child.debug(fields, message);
        break;
      default:
        child.info(fields, message);
    }
  });
}

function makeTypedAddJob(rawAddJob: AddJobFunction): AddJob {
  return async (task, payload, options = {}) => {
    // Fail fast at the enqueue site instead of burning retry attempts.
    const parsed = task.payloadSchema.parse(payload);
    return rawAddJob(task.name, parsed, {
      maxAttempts: options.maxAttempts ?? task.maxAttempts,
      jobKey: options.jobKey,
      jobKeyMode: options.jobKeyMode,
      runAt: options.runAt,
      priority: options.priority,
      queueName: options.queueName,
    });
  };
}

/**
 * Start the embedded worker runtime. Resolves once the runner is live (its
 * schema installed/migrated, tasks registered, cron started).
 */
export async function startWorkerRuntime(
  options: StartWorkerRuntimeOptions,
): Promise<WorkerRuntime> {
  const {
    databaseUrl,
    logger,
    concurrency = 4,
    registry = defaultTaskRegistry,
    cronItems = defaultCronItems,
    pollInterval,
  } = options;

  const handle = createDb(databaseUrl);
  // graphile-worker requires the shared pool to have an error handler so an
  // idle-client failure cannot crash the process (err.red/wpeh).
  handle.pool.on("error", (error) => {
    logger.error(
      { err: error instanceof Error ? error.message : String(error) },
      "pg pool error in worker runtime",
    );
  });
  const activeCronItems = cronItems.filter((item) => registry.has(item.task));
  try {
    const runner = await run({
      pgPool: handle.pool,
      taskList: buildTaskList(registry, logger),
      concurrency,
      parsedCronItems: parseCronItems([...activeCronItems]),
      // The Loxep entrypoint owns process signals (ADR-0018).
      noHandleSignals: true,
      logger: graphileLoggerFor(logger),
      ...(pollInterval !== undefined ? { pollInterval } : {}),
    });

    let stopped = false;
    return {
      runner,
      pool: handle.pool,
      addJob: makeTypedAddJob(runner.addJob),
      getStats: () => getJobStats(handle.pool),
      stop: async () => {
        if (stopped) return;
        stopped = true;
        try {
          await runner.stop();
        } finally {
          await closeDb(handle);
        }
      },
    };
  } catch (error) {
    await closeDb(handle).catch(() => undefined);
    throw error;
  }
}

const silentGraphileLogger = new GraphileLogger(() => () => undefined);

/**
 * Standalone typed enqueue for web/server code that has a pg Pool but no
 * runner (e.g. request handlers enqueueing work for the worker replicas).
 * Requires the `graphile_worker` schema to exist (a runner must have started
 * against this database at least once).
 */
export async function addJob<TSchema extends z.ZodType>(
  pool: DbHandle["pool"],
  task: LoxepTask<TSchema>,
  payload: z.input<TSchema>,
  options?: EnqueueOptions,
): Promise<Job> {
  const utils = await makeWorkerUtils({
    pgPool: pool,
    logger: silentGraphileLogger,
  });
  try {
    return await makeTypedAddJob(utils.addJob)(task, payload, options);
  } finally {
    await utils.release();
  }
}

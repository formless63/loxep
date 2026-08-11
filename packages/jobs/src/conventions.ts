/**
 * Typed task conventions for Loxep's Graphile Worker runtime (ADR-0003,
 * ADR-0018).
 *
 * ## Delivery and idempotency
 *
 * Jobs are **at-least-once**: a handler can run more than once for the same
 * logical event (crash after work, retry after transient failure). Handlers
 * must be idempotent or otherwise safe to retry — upserts, `on conflict`
 * clauses, and source-event identities, never blind inserts of consequential
 * state.
 *
 * ## Job keys (dedupe)
 *
 * Dedupe-able work uses a `jobKey` built by {@link jobKeyFor} with
 * `jobKeyMode: "replace"` (the Graphile default): re-enqueueing the same key
 * replaces the queued job's payload/run_at instead of queueing a duplicate.
 * Use a stable domain identity (`monitor:{id}`, `sync:{connectionId}`) —
 * never timestamps or random values.
 *
 * ## Retry/backoff policy
 *
 * Graphile Worker retries failed jobs with exponential backoff:
 * `run_at = greatest(now(), run_at) + exp(least(attempts, 10)) seconds`
 * (verified against graphile-worker 0.17.3 SQL). Loxep's default retry
 * budget is {@link DEFAULT_MAX_ATTEMPTS} = 8 attempts (~30 minutes of total
 * backoff), not Graphile's upstream default of 25 (~6h+ per retry at the
 * cap), so persistent failures surface in health detail within minutes, not
 * days. Override per task via `defineTask({ maxAttempts })` or per enqueue
 * via `EnqueueOptions.maxAttempts`.
 */
import type { JobHelpers } from "graphile-worker";
import { z } from "zod";

/**
 * Default retry budget for Loxep tasks (see the module doc for rationale).
 * Applied by the typed `addJob` helpers and cron items; raw Graphile enqueues
 * that bypass the typed helpers get Graphile's own default (25).
 */
export const DEFAULT_MAX_ATTEMPTS = 8;

/**
 * Minimal structural logger contract (satisfied by the Pino logger from
 * `@loxep/observability` `createLogger`, which also stamps the active
 * correlation context onto every line).
 */
export interface JobsLogger {
  debug: (obj: object | string, msg?: string) => void;
  info: (obj: object | string, msg?: string) => void;
  warn: (obj: object | string, msg?: string) => void;
  error: (obj: object | string, msg?: string) => void;
  child: (bindings: Record<string, unknown>) => JobsLogger;
}

/** Context handed to every task handler. */
export interface TaskContext {
  /** Child logger bound to the task name; lines carry jobId/correlationId. */
  logger: JobsLogger;
  /** Graphile Worker job helpers (query, addJob, the raw job row, ...). */
  helpers: JobHelpers;
}

export type TaskHandler<TSchema extends z.ZodType> = (
  payload: z.output<TSchema>,
  context: TaskContext,
) => Promise<unknown> | unknown;

export interface DefineTaskOptions<TSchema extends z.ZodType> {
  /** Task identifier, `area.verb` style (e.g. `maintenance.heartbeat`). */
  name: string;
  /** Zod schema validated against the raw payload before the handler runs. */
  payloadSchema: TSchema;
  /** Per-task override of {@link DEFAULT_MAX_ATTEMPTS}. */
  maxAttempts?: number;
  handler: TaskHandler<TSchema>;
}

export interface LoxepTask<TSchema extends z.ZodType = z.ZodType> {
  name: string;
  payloadSchema: TSchema;
  maxAttempts: number;
  handler: TaskHandler<TSchema>;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyLoxepTask = LoxepTask<any>;

/**
 * Define a typed task. The worker runtime wraps the handler so that:
 *  - the raw payload is validated against `payloadSchema` before the handler
 *    runs (invalid payloads fail the job and retry per policy);
 *  - execution runs inside `runWithLogContext({ jobId, correlationId })`
 *    with a child logger, so every log line carries the job identity.
 *
 * Convention: if the payload schema includes an optional `correlationId`
 * string field, its value becomes the log correlation ID for the execution,
 * linking the job back to the request that enqueued it.
 */
export function defineTask<TSchema extends z.ZodType>(
  options: DefineTaskOptions<TSchema>,
): LoxepTask<TSchema> {
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
    throw new Error(
      `task "${options.name}": maxAttempts must be a positive integer`,
    );
  }
  return {
    name: options.name,
    payloadSchema: options.payloadSchema,
    maxAttempts,
    handler: options.handler,
  };
}

/** Immutable name → task collection consumed by the worker runtime. */
export type TaskRegistry = ReadonlyMap<string, AnyLoxepTask>;

/** Build a {@link TaskRegistry}, rejecting duplicate task names. */
export function createTaskRegistry(
  tasks: readonly AnyLoxepTask[],
): TaskRegistry {
  const registry = new Map<string, AnyLoxepTask>();
  for (const task of tasks) {
    if (registry.has(task.name)) {
      throw new Error(`duplicate task name "${task.name}" in task registry`);
    }
    registry.set(task.name, task);
  }
  return registry;
}

/**
 * Canonical job key for dedupe-able work: `taskName:stableId`. Use with
 * `jobKeyMode: "replace"` (the default) so re-enqueues update the queued job
 * in place instead of duplicating it.
 */
export function jobKeyFor(taskName: string, stableId: string): string {
  return `${taskName}:${stableId}`;
}

/** Options accepted by the typed enqueue helpers (subset of Graphile TaskSpec). */
export interface EnqueueOptions {
  /** Dedupe/update identity — build with {@link jobKeyFor}. */
  jobKey?: string;
  /** Default "replace"; see Graphile TaskSpec docs before using others. */
  jobKeyMode?: "replace" | "preserve_run_at" | "unsafe_dedupe";
  /** Schedule in the future (default: now). */
  runAt?: Date;
  /** Numerically smaller runs first (default 0). */
  priority?: number;
  /** Serial-execution queue; avoid high-cardinality values. */
  queueName?: string;
  /** Per-enqueue override of the task's retry budget. */
  maxAttempts?: number;
}

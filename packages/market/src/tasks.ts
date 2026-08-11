/**
 * Market polling jobs (ADR-0003): a single recurring dispatcher claims due
 * monitor targets and enqueues one `market.poll-target` job per claimed
 * target — never one cron entry per monitored item.
 *
 * `market.poll-target` is a Phase 0 STUB: it delegates to an injectable
 * {@link PollExecutor}; provider adapters (eBay via `ebay-api` behind
 * Loxep-owned adapters, ADR-0009) arrive in Phase 1 and slot in as real
 * executors. The default executor performs no provider I/O and reports zero
 * observations — the task then records a poll success. There is NO provider
 * API code in this package.
 *
 * ## Failure semantics
 *
 * A poll failure is DOMAIN state, not a job failure: the task records it
 * (`consecutive_errors`/`backoff_until`) and completes, because the
 * dispatcher owns retry cadence through `backoff_until`. Letting Graphile
 * also retry the job would poll again before the recorded backoff elapses.
 */
import type { LoxepDb } from "@loxep/db";
import { defineTask, jobKeyFor } from "@loxep/jobs";
import type { JobsLogger, LoxepTask } from "@loxep/jobs";
import { z } from "zod";
import {
  claimDueTargets,
  recordPollFailure,
  recordPollSuccess,
} from "./monitors.ts";
import type {
  ClaimedTarget,
  MonitorTargetRow,
  RecordPollSuccessOptions,
} from "./monitors.ts";

export const DISPATCH_TASK_NAME = "market.dispatch-due-monitors";
export const POLL_TARGET_TASK_NAME = "market.poll-target";

/** Result reported by a poll executor on success. */
export interface PollOutcome {
  /** How many observations the executor recorded (informational). */
  observations: number;
  /**
   * Optional adaptive-cadence facts. Supplying it (specifically `changed`)
   * opts this poll into activity-adaptive `next_poll_at` advancement; omitting
   * it keeps the flat `interval_seconds` cadence the claim already applied.
   * A provider executor passes its per-connection rate-budget floor as
   * `bounds.minSeconds`.
   */
  adaptive?: AdaptivePollFacts;
}

/** The adaptive inputs a poll executor may report (see `adaptive.ts`). */
export type AdaptivePollFacts = Omit<RecordPollSuccessOptions, "at"> & {
  changed: boolean;
};

/**
 * Injectable provider-poll boundary. Phase 1 provider adapters implement
 * this; a thrown error marks the poll failed (with backoff).
 */
export type PollExecutor = (
  target: MonitorTargetRow,
  context: { logger: JobsLogger },
) => Promise<PollOutcome> | PollOutcome;

/** Default Phase 0 executor: no provider I/O, zero observations. */
export const defaultPollExecutor: PollExecutor = () => ({ observations: 0 });

const dispatchPayloadSchema = z.looseObject({});
const pollTargetPayloadSchema = z.object({
  monitorTargetId: z.uuid(),
  correlationId: z.string().optional(),
});

export type DispatchTask = LoxepTask<typeof dispatchPayloadSchema>;
export type PollTargetTask = LoxepTask<typeof pollTargetPayloadSchema>;

/**
 * Structural equivalent of graphile-worker's `CronItem` (this package takes
 * no graphile-worker dependency; the object is assignable where the runtime
 * expects a `CronItem`).
 */
export interface MarketCronItem {
  task: string;
  match: string;
  identifier: string;
  options: {
    maxAttempts: number;
    backfillPeriod: number;
    jobKey: string;
    jobKeyMode: "replace";
  };
}

export interface MarketTasks {
  dispatchDueMonitorsTask: DispatchTask;
  pollTargetTask: PollTargetTask;
  /** Cron: dispatch every minute; jobKey-replace collapses overlapping ticks. */
  dispatchDueMonitorsCronItem: MarketCronItem;
  /** Both tasks, ready for `createTaskRegistry([...])`. */
  tasks: readonly [DispatchTask, PollTargetTask];
}

/**
 * Build the market task set bound to a database handle and an injectable
 * poll executor. Compose into a worker runtime via
 * `createTaskRegistry([...market.tasks, ...])` and pass the cron item along.
 */
export function createMarketTasks(options: {
  db: LoxepDb;
  pollExecutor?: PollExecutor;
  /** Max targets claimed per dispatcher run (default 100). */
  dispatchBatchLimit?: number;
}): MarketTasks {
  const { db } = options;
  const pollExecutor = options.pollExecutor ?? defaultPollExecutor;
  const dispatchBatchLimit = options.dispatchBatchLimit ?? 100;

  const pollTargetTask = defineTask({
    name: POLL_TARGET_TASK_NAME,
    payloadSchema: pollTargetPayloadSchema,
    // Poll retry cadence is owned by backoff_until, not Graphile retries.
    maxAttempts: 1,
    handler: async (payload, { logger }) => {
      const target = await db.query.monitorTargets.findFirst({
        where: (table, { eq }) => eq(table.id, payload.monitorTargetId),
      });
      if (target === undefined) {
        logger.warn(
          { monitorTargetId: payload.monitorTargetId },
          "poll skipped: monitor target no longer exists",
        );
        return;
      }
      if (!target.enabled) {
        logger.info(
          { monitorTargetId: target.id },
          "poll skipped: monitor target disabled",
        );
        return;
      }
      try {
        const outcome = await pollExecutor(target, { logger });
        const recorded = await recordPollSuccess(
          db,
          target.id,
          outcome.adaptive ?? {},
        );
        logger.info(
          {
            monitorTargetId: target.id,
            observations: outcome.observations,
            ...(recorded.adaptive === null
              ? {}
              : {
                  adaptiveTier: recorded.adaptive.tier,
                  adaptiveIntervalSeconds: recorded.adaptive.intervalSeconds,
                  nextPollAt: recorded.nextPollAt?.toISOString(),
                }),
          },
          "poll succeeded",
        );
      } catch (error) {
        const failure = await recordPollFailure(db, target.id);
        logger.error(
          {
            monitorTargetId: target.id,
            consecutiveErrors: failure.consecutiveErrors,
            backoffUntil: failure.backoffUntil.toISOString(),
            err: error instanceof Error ? error.message : String(error),
          },
          "poll failed; backoff recorded",
        );
        // Deliberately NOT rethrown — see module doc (backoff owns cadence).
      }
    },
  });

  const dispatchDueMonitorsTask = defineTask({
    name: DISPATCH_TASK_NAME,
    // Loose: cron-scheduled runs carry Graphile's `_cron` envelope field.
    payloadSchema: dispatchPayloadSchema,
    // The next cron tick supersedes a failed dispatch.
    maxAttempts: 3,
    handler: async (_payload, { logger, helpers }) => {
      const claimed = await claimDueTargets(db, {
        now: new Date(),
        limit: dispatchBatchLimit,
      });
      for (const target of claimed) {
        await enqueuePollJob(helpers.addJob, target);
      }
      if (claimed.length > 0) {
        logger.info(
          { claimed: claimed.length },
          "dispatched due monitor targets",
        );
      }
    },
  });

  /** Raw Graphile addJob signature, structurally (no graphile-worker dep). */
  type RawAddJob = (
    identifier: string,
    payload?: unknown,
    spec?: {
      jobKey?: string;
      jobKeyMode?: "replace" | "preserve_run_at" | "unsafe_dedupe";
      maxAttempts?: number;
      priority?: number;
    },
  ) => Promise<unknown>;

  async function enqueuePollJob(
    addJob: RawAddJob,
    target: ClaimedTarget,
  ): Promise<void> {
    await addJob(
      POLL_TARGET_TASK_NAME,
      { monitorTargetId: target.id },
      {
        // One queued poll per target; re-dispatch replaces, never duplicates.
        jobKey: jobKeyFor(POLL_TARGET_TASK_NAME, target.id),
        jobKeyMode: "replace",
        maxAttempts: pollTargetTask.maxAttempts,
        priority: target.priority,
      },
    );
  }

  const dispatchDueMonitorsCronItem: MarketCronItem = {
    task: DISPATCH_TASK_NAME,
    match: "* * * * *",
    identifier: "market_dispatch_due_monitors",
    options: {
      maxAttempts: dispatchDueMonitorsTask.maxAttempts,
      // Missed ticks while the worker was down are uninteresting; the next
      // dispatch claims everything due anyway.
      backfillPeriod: 0,
      jobKey: jobKeyFor(DISPATCH_TASK_NAME, "cron"),
      jobKeyMode: "replace",
    },
  };

  return {
    dispatchDueMonitorsTask,
    pollTargetTask,
    dispatchDueMonitorsCronItem,
    tasks: [dispatchDueMonitorsTask, pollTargetTask],
  };
}

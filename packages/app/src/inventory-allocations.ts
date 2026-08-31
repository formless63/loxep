/**
 * `inventory.expire-stale-holds` — the release valve for a `manual_hold`
 * reservation nobody ever came back to release (loxep-souz, surfaced by
 * loxep-rh0).
 *
 * `AllocationsService.expireStaleHolds` (`@loxep/inventory`'s
 * `allocations.ts`) has existed since the allocation lifecycle shipped —
 * `quantity_reserved`/`available_to_sell` (`items.ts`'s own doc) subtract
 * every OPEN `reserved` allocation, `manual_hold` included, and a hold whose
 * `expires_at` has passed with nobody clicking "release" suppresses
 * `available_to_sell` FOREVER: the item looks permanently unsellable even
 * though the operator's own stated cutoff has come and gone. The verb had no
 * caller anywhere — not the worker, not a web action — until this module.
 *
 * ## Why this is a cadence sweep, not an on-write enqueue
 *
 * There is no "write" that makes a hold stale — staleness is a wall-clock
 * fact (`expires_at < now()`), the same shape `commerce.redact-order-
 * payloads`' retention window and `health.sweep`'s probe cadence are, not an
 * event a `reserve()` call could enqueue ahead of time (the hold is fresh at
 * creation; it becomes stale only by the clock moving past a timestamp set
 * once, up front). A recurring sweep is the only mechanism that can notice
 * that on its own, mirroring `accounting-posting.ts`'s own reasoning for
 * picking a sweep over a per-write trigger.
 *
 * ## Idempotency
 *
 * `expireStaleHolds`'s own `UPDATE` (`allocations.ts`) is scoped to
 * `status = 'reserved' and allocation_kind = 'manual_hold' and expires_at <
 * asOf` — once a row's `status` flips to `'expired'` it no longer matches
 * that predicate, so a redelivered job, an overlapping run, or this sweep's
 * own next tick all see zero matching rows for that allocation and update
 * nothing. At-least-once is safe by construction: re-expiring an
 * already-expired hold is a no-op, never an error, and the `expired` count a
 * retry reports can legitimately be zero. See `inventory-allocations.test.ts`
 * for two consecutive runs proving exactly this.
 *
 * ## No staleness-threshold parameter to invent
 *
 * `expireStaleHolds` takes one optional argument, `asOf?: Date` — a cutoff to
 * compare `expires_at` against, defaulting to `new Date()` when omitted
 * (`allocations.ts`). There is no separate "how stale is stale" duration
 * setting to thread: staleness is entirely `expires_at`, a value the caller
 * who created the hold already chose. This sweep's own payload exposes the
 * SAME optional cutoff (as an ISO string, `_cron`-safe) rather than inventing
 * a duration knob `expireStaleHolds` does not accept — a test overrides it to
 * assert deterministically against a fixed instant; a live cron/manual run
 * omits it and gets "now".
 *
 * ## Cadence, PROVISIONAL
 *
 * Neither `inventory-schema-design.md` nor `flipping-lifecycle-design.md`
 * names a cadence for this sweep (both describe `expires_at` and
 * `available_to_sell` but are silent on when a stale hold gets swept) — the
 * same silence `accounting-posting.ts` found for posting cadence, so the
 * same PROVISIONAL discipline applies: pick a defensible interval and say
 * why. A `manual_hold` is an operator choosing to set stock aside past a
 * self-picked deadline, not a provider event or a financial fact — nothing
 * about it needs sub-minute (or even sub-hour) freshness the way
 * `accounting.post-facts`/`health.sweep`'s 5-minute cadence serves a pump
 * or a probe. HOURLY (`42 * * * *` — an off-the-hour minute, avoiding a
 * thundering herd with the every-5-minute and every-15-minute crons at
 * `:00`, the same reasoning `commerce.redact-order-payloads` applies to its
 * own daily off-peak tick)
 * bounds the worst case — an expired hold still suppressing
 * `available_to_sell` — to under an hour without adding a job that fires
 * every few minutes for a backlog that, in the steady state, is usually
 * empty.
 *
 * ## Bounding
 *
 * `expireStaleHolds` is a single `UPDATE ... WHERE ... RETURNING id`, not a
 * per-row loop — unlike `unpostedFacts`' SELECT-then-process shape, there is
 * no candidate list to cap client-side; PostgreSQL does the whole batch in
 * one statement. A backlog of thousands of stale holds is still one round
 * trip, so no `limit` parameter is threaded here the way
 * `accounting-posting.ts`'s `limit` bounds its own candidate read.
 */
import { createAllocationsService } from "@loxep/inventory";
import type { AllocationsService } from "@loxep/inventory";
import { defineTask, jobKeyFor } from "@loxep/jobs";
import type { LoxepTask } from "@loxep/jobs";
import { z } from "zod";
import type { AppCronItem } from "./refresh-tokens.ts";
import type { AppServices } from "./services.ts";

export const EXPIRE_STALE_HOLDS_TASK_NAME = "inventory.expire-stale-holds";

/**
 * PROVISIONAL — see this module's doc for why neither design doc names a
 * cadence and why hourly, off the top of the hour, was chosen over the
 * 5-minute precedent `accounting.post-facts`/`health.sweep` set.
 */
export const EXPIRE_STALE_HOLDS_CRON_MATCH = "42 * * * *";

/** Loose: cron-scheduled runs carry Graphile's `_cron` envelope field. */
const expireStaleHoldsPayloadSchema = z.looseObject({
  /**
   * Overrides `expireStaleHolds`'s own `asOf` cutoff — see this module's
   * doc for why this is the only knob threaded through (no invented
   * duration parameter). Omitted on a live cron/manual run, so the service
   * default (`new Date()`) applies; a test supplies a fixed instant.
   */
  asOf: z.iso.datetime().optional(),
  correlationId: z.string().optional(),
});

export type ExpireStaleHoldsTask = LoxepTask<
  typeof expireStaleHoldsPayloadSchema
>;

export interface ExpireStaleHoldsResult {
  /** Holds flipped from `reserved`/`manual_hold` to `expired` this run. */
  expired: number;
}

export interface ExpireStaleHoldsTasks {
  expireStaleHoldsTask: ExpireStaleHoldsTask;
  expireStaleHoldsCronItem: AppCronItem;
}

/**
 * Sweep expired manual holds once. Exported separately from the task
 * wrapper — mirrors `runAccountingPostFactsSweep` — so a test (or a future
 * "release now" caller) can call it without a Graphile `TaskContext`.
 */
export async function runExpireStaleHoldsSweep(options: {
  services: AppServices;
  asOf?: Date;
}): Promise<ExpireStaleHoldsResult> {
  const allocations: AllocationsService = createAllocationsService({
    db: options.services.db,
  });
  return allocations.expireStaleHolds(options.asOf);
}

/**
 * `inventory.expire-stale-holds` — the Graphile Worker wrapper around
 * {@link runExpireStaleHoldsSweep}, the same thin-wrapper shape
 * `accounting-posting.ts`/`health-sweep.ts` use: `@loxep/app` owns the
 * task/cron definition; `@loxep/inventory` takes no `@loxep/jobs`
 * dependency (mirrors `inventory-ebay.ts`'s own reasoning for its on-demand
 * task living here rather than there).
 */
export function createExpireStaleHoldsTasks(options: {
  services: AppServices;
}): ExpireStaleHoldsTasks {
  const { services } = options;

  const expireStaleHoldsTask = defineTask({
    name: EXPIRE_STALE_HOLDS_TASK_NAME,
    payloadSchema: expireStaleHoldsPayloadSchema,
    // The update is a single idempotent statement (see this module's doc);
    // a retry only ever covers a transient database blip.
    maxAttempts: 3,
    handler: async (payload, { logger }) => {
      const result = await runExpireStaleHoldsSweep({
        services,
        ...(payload.asOf === undefined ? {} : { asOf: new Date(payload.asOf) }),
      });
      logger.info({ expired: result.expired }, "stale hold sweep completed");
      return result;
    },
  });

  const expireStaleHoldsCronItem: AppCronItem = {
    task: EXPIRE_STALE_HOLDS_TASK_NAME,
    match: EXPIRE_STALE_HOLDS_CRON_MATCH,
    identifier: "inventory_expire_stale_holds",
    options: {
      maxAttempts: expireStaleHoldsTask.maxAttempts,
      // A missed tick while the worker was down is not lost: the next run's
      // UPDATE reads live rows, not a queue, so every hold still stale picks
      // straight back up — mirrors `accounting.post-facts`/`health.sweep`.
      backfillPeriod: 0,
      jobKey: jobKeyFor(EXPIRE_STALE_HOLDS_TASK_NAME, "cron"),
      jobKeyMode: "replace",
    },
  };

  return { expireStaleHoldsTask, expireStaleHoldsCronItem };
}

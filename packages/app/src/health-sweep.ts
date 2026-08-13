/**
 * `health.sweep` — the Phase 8 milestone 1 recurring probe (loxep-ovj.1).
 * Design: apps/docs/src/content/docs/architecture/
 * fleet-observability-design.md ("Probing, jobs, and where cadence lives").
 *
 * `@loxep/domain` owns the `integration_health` service, the subject
 * registry, and the sweep MECHANICS (`runHealthSweep`,
 * `createDefaultHealthSubjectRegistry`) as plain async functions over a
 * database handle — it deliberately takes no `@loxep/jobs` dependency (see
 * `health-probes.ts`'s module doc). This module is the thin Graphile Worker
 * wrapper, exactly the shape `ebay.refresh-tokens` already uses for a task
 * `@loxep/app` owns outright: `defineTask` + a structural `AppCronItem`, no
 * dispatch/per-subject job fan-out.
 *
 * ONE recurring cron job, not one job per subject and no `monitor_targets`
 * row — the design's explicit rejection of registering a scheduling target
 * type for health probing ("cadence is uniform, there is no per-subject
 * intent worth an operator setting"). `runHealthSweep` computes due-ness from
 * `integration_health.checked_at` and `.consecutive_failures` alone and
 * bounds work per run (`DEFAULT_MAX_SUBJECTS_PER_TYPE` per subject type),
 * mirroring `commerce.redact-order-payloads`' bounded-batch shape.
 *
 * Idempotent by the primary key `(subject_type, subject_id)`: a redelivered
 * job, an overlapping run, or a retry only re-probes and re-upserts, never
 * duplicates.
 *
 * ## The `connection` subject is fleet-aware (loxep-rf4)
 *
 * `@loxep/domain`'s own registry (`createDefaultHealthSubjectRegistry`)
 * cannot host a Beszel/Dockhand/Gatus/Tailscale/Termix probe — it takes no
 * integration-package dependency. This module is the composition root that
 * CAN: `createFleetHealthSubjectRegistry` (`fleet-health.ts`) wraps the
 * default registry's `connection` entry so a fleet-provider connection gets
 * its own adapter read while every other provider keeps the original derived
 * `probeConnection`. Built once, here, and passed through to
 * `runHealthSweep({ registry })` on every run — the mechanics and the
 * provider-specific probes live in `fleet-health.ts`, not in this file.
 */
import { defineTask, jobKeyFor } from "@loxep/jobs";
import type { LoxepTask } from "@loxep/jobs";
import { runHealthSweep } from "@loxep/domain";
import type { HealthSweepResult } from "@loxep/domain";
import { z } from "zod";
import { createFleetHealthSubjectRegistry } from "./fleet-health.ts";
import type { AppCronItem } from "./refresh-tokens.ts";
import type { AppServices } from "./services.ts";

export const HEALTH_SWEEP_TASK_NAME = "health.sweep";

/** Loose: cron-scheduled runs carry Graphile's `_cron` envelope field. */
const healthSweepPayloadSchema = z.looseObject({
  /** Subjects probed per subject type, this run; defaults to the sweep's own bound. */
  maxSubjectsPerType: z.number().int().min(1).max(1000).optional(),
  correlationId: z.string().optional(),
});

export type HealthSweepTask = LoxepTask<typeof healthSweepPayloadSchema>;

/** Every 5 minutes — matches the sweep's own base probe interval. */
export const HEALTH_SWEEP_CRON_MATCH = "*/5 * * * *";

export interface HealthSweepTasks {
  healthSweepTask: HealthSweepTask;
  healthSweepCronItem: AppCronItem;
}

export function createHealthSweepTasks(options: {
  services: AppServices;
}): HealthSweepTasks {
  const { services } = options;
  // Built once and reused across every cron tick — see this module's doc.
  const registry = createFleetHealthSubjectRegistry(services);

  const healthSweepTask = defineTask({
    name: HEALTH_SWEEP_TASK_NAME,
    payloadSchema: healthSweepPayloadSchema,
    // The sweep touches no provider and every probe is bounded by its own
    // timeout, so a retry is cheap; three attempts covers a transient
    // database blip without grinding on a genuinely broken registry entry.
    maxAttempts: 3,
    handler: async (payload, { logger }) => {
      const result: HealthSweepResult = await runHealthSweep({
        db: services.db,
        registry,
        ...(payload.maxSubjectsPerType === undefined
          ? {}
          : { maxSubjectsPerType: payload.maxSubjectsPerType }),
        logger,
      });
      logger.info(
        {
          checkedTypes: result.checkedTypes,
          scanned: result.scanned,
          due: result.due,
          probed: result.probed,
          cleared: result.cleared,
          failed: result.failed,
          more: result.more,
          batches: result.batches,
        },
        "integration health sweep completed",
      );
      return result;
    },
  });

  const healthSweepCronItem: AppCronItem = {
    task: HEALTH_SWEEP_TASK_NAME,
    match: HEALTH_SWEEP_CRON_MATCH,
    identifier: "health_sweep",
    options: {
      maxAttempts: healthSweepTask.maxAttempts,
      // A missed tick while the worker was down is uninteresting: the next
      // run picks up whatever has since gone due, backoff and all.
      backfillPeriod: 0,
      jobKey: jobKeyFor(HEALTH_SWEEP_TASK_NAME, "cron"),
      jobKeyMode: "replace",
    },
  };

  return { healthSweepTask, healthSweepCronItem };
}

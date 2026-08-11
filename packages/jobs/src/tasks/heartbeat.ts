/**
 * `maintenance.heartbeat` — the first real task proving the job → database
 * write path (loxep-680.3).
 *
 * Upserts `application_settings` key `runtime.heartbeat` with
 * `{ lastRunAt, hostname }` so operators (and integration tests) can see that
 * the worker runtime is alive and writing. Scheduled every 5 minutes via the
 * runtime's cron items; safe to re-run at any time (pure upsert).
 */
import { hostname } from "node:os";
import type { CronItem } from "graphile-worker";
import { z } from "zod";
import { defineTask } from "../conventions.ts";

/** `application_settings.key` written by the heartbeat task. */
export const HEARTBEAT_SETTINGS_KEY = "runtime.heartbeat";

export const heartbeatTask = defineTask({
  name: "maintenance.heartbeat",
  // Loose: cron-scheduled runs carry Graphile's `_cron` envelope field.
  payloadSchema: z.looseObject({}),
  // Per-task override demo: the next cron tick supersedes a failed heartbeat,
  // so a long retry tail is pointless.
  maxAttempts: 3,
  handler: async (_payload, { logger, helpers }) => {
    const value = {
      lastRunAt: new Date().toISOString(),
      hostname: hostname(),
    };
    await helpers.query(
      `insert into application_settings (key, value, schema_version, updated_at)
       values ($1, $2::jsonb, 1, now())
       on conflict (key) do update
         set value = excluded.value, updated_at = now()`,
      [HEARTBEAT_SETTINGS_KEY, JSON.stringify(value)],
    );
    logger.info({ heartbeat: value }, "runtime heartbeat recorded");
  },
});

/**
 * Cron entry: heartbeat every 5 minutes. `backfillPeriod: 0` — missed ticks
 * while the worker was down are not interesting, only the current liveness.
 */
export const heartbeatCronItem: CronItem = {
  task: heartbeatTask.name,
  match: "*/5 * * * *",
  identifier: "maintenance_heartbeat",
  options: {
    maxAttempts: heartbeatTask.maxAttempts,
    backfillPeriod: 0,
  },
};

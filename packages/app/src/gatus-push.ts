/**
 * The Gatus outward health push (Phase 8 milestone 2, loxep-ovj.2). Design:
 * apps/docs/src/content/docs/architecture/fleet-observability-design.md,
 * "Publish Loxep's own health outward".
 *
 * Gatus exposes exactly one write path in its whole route table:
 *
 * ```text
 * POST /api/v1/endpoints/:key/external?success=<bool>&error=<msg>&duration=<ns>
 *      Authorization: Bearer <token declared in the operator's gatus YAML>
 *      key format:  <GROUP_NAME>_<ENDPOINT_NAME>
 * ```
 *
 * The endpoint must already be declared under `external-endpoints` in the
 * OPERATOR's own gatus config, optionally with `heartbeat.interval` — Gatus
 * cannot be configured remotely, and Loxep never writes to it (the design's
 * "Loxep does not push Gatus configuration" rule). If Loxep stops pushing,
 * the declared heartbeat interval expires and Gatus raises the alert Loxep
 * could never raise about its own outage — the self-monitoring trap this
 * whole milestone exists to solve.
 *
 * ## What gets synthesized
 *
 * ONE push per interval, carrying ONE success/error/duration triple derived
 * from Loxep's own OVERALL integration health (`integration_health`, via
 * `@loxep/domain`'s `listHealth`): the worst status among every subject row
 * wins — `failing` beats `degraded` beats `unknown` beats `ok`. `success` is
 * `false` only when the worst status is `failing`. `degraded`/`unknown`
 * still report `success: true` — Gatus's success/error pair is binary and has
 * no room for a third state, and a merely `degraded` or not-yet-determined
 * subject is not itself an outage worth paging on. `error` is a short,
 * credential-free summary naming the failing subjects' count — never a
 * subject's own `detail` payload, which is Loxep-internal and not meant to
 * leave the installation even redacted.
 *
 * The push's OWN reachability of Gatus is a second, independent fact from
 * what it reports: the mere act of a run completing at all IS the liveness
 * signal Gatus's heartbeat depends on — if the Loxep process is down, no push
 * happens, and that silence is exactly what the design wants Gatus to catch.
 * `duration` therefore reports the wall-clock time this task spent computing
 * the health summary (not a round-trip time to some OTHER service Loxep is
 * checking) — a diagnostic Gatus displays, not something Loxep is asking
 * Gatus to gate alerting on.
 *
 * ## Five-kind outcome, and this NEVER throws
 *
 * {@link pushGatusHealth} returns a {@link GatusPushOutcome} rather than
 * throwing for any reachable failure — a failed push is Loxep's OWN
 * reporting problem, not a reason to fail a cron run loudly (nothing is
 * waiting on a job-level retry to fix a misconfigured Gatus base URL, and a
 * push that throws would just get silently retried into the same failure by
 * Graphile's own retry budget). The five kinds:
 *
 * ```text
 * disabled       infrastructure.gatus_push.enabled is false (the default)
 * unconfigured   enabled, but baseUrl/endpointKey/token is missing
 * network_error  the POST itself threw (DNS, connection refused, timeout)
 * http_error     Gatus answered with a non-2xx status
 * ok             Gatus accepted the push
 * ```
 *
 * `createGatusPushTasks`' task wrapper logs anything other than `ok`/
 * `disabled` as a warning and always returns normally — the same "one
 * subject's failure never takes the run down" discipline `health-sweep.ts`
 * uses for its own probes. There is deliberately no `integration_health` row
 * for this outcome: every row in that table describes a subject TYPE the
 * schema's own `CHECK` enumerates, and "Loxep's push to Gatus" is not one of
 * them (it is the reverse direction from every other row in the table, and
 * misusing an existing subject type for it would be exactly the "no
 * per-tool foreign keys on any domain table" discipline the design warns
 * against, applied to a subject instead of a column). A structured log line
 * is the honest record.
 */
import type { LoxepDb } from "@loxep/db";
import {
  createHealthService,
  GATUS_PUSH_SECRET_KEY,
  gatusPushSetting,
} from "@loxep/domain";
import type {
  HealthStatus,
  SecretsService,
  SettingsService,
} from "@loxep/domain";
import { defineTask, jobKeyFor } from "@loxep/jobs";
import type { LoxepTask } from "@loxep/jobs";
import { z } from "zod";
import type { AppCronItem } from "./refresh-tokens.ts";
import type { AppServices } from "./services.ts";

/**
 * Re-exported from `@loxep/domain`, which owns it (see its own doc comment)
 * so `apps/web`'s settings form and this push job can never drift apart on
 * the literal string. Kept as a re-export here rather than an import-only
 * reference so nothing importing `@loxep/app` needs a second import from
 * `@loxep/domain` just to name this key.
 */
export { GATUS_PUSH_SECRET_KEY };

export const GATUS_PUSH_TASK_NAME = "infrastructure.gatus-push";

/** Every 5 minutes — matches `health.sweep`'s own base interval. */
export const GATUS_PUSH_CRON_MATCH = "*/5 * * * *";

export type GatusPushKind =
  | "disabled"
  | "unconfigured"
  | "network_error"
  | "http_error"
  | "ok";

export interface GatusPushOutcome {
  kind: GatusPushKind;
  /** Present for network_error/http_error/unconfigured. */
  message?: string;
  /** Present only for http_error. */
  statusCode?: number;
  /** What was actually reported to Gatus — present only when kind is 'ok'. */
  reported?: { success: boolean; error: string; durationNs: number };
}

/** Minimal structural fetch, injectable so tests never perform network I/O. */
export type GatusPushFetch = (
  url: string,
  init: { method: string; headers: Record<string, string> },
) => Promise<{ ok: boolean; status: number; text: () => Promise<string> }>;

/** `failing` > `degraded` > `unknown` > `ok` — see the module doc. */
const STATUS_SEVERITY: Record<HealthStatus, number> = {
  ok: 0,
  unknown: 1,
  degraded: 2,
  failing: 3,
};

/** The worst status across every subject, `'ok'` when there are none yet. */
export function worstHealthStatus(
  rows: readonly { status: HealthStatus }[],
): HealthStatus {
  let worst: HealthStatus = "ok";
  for (const row of rows) {
    if (STATUS_SEVERITY[row.status] > STATUS_SEVERITY[worst]) worst = row.status;
  }
  return worst;
}

export interface PushGatusHealthOptions {
  db: LoxepDb;
  settings: SettingsService;
  secrets: SecretsService;
  /** Injectable HTTP client; defaults to the global `fetch`. */
  fetchImpl?: GatusPushFetch;
}

/**
 * Synthesize Loxep's overall health from `integration_health` and push it to
 * the operator's Gatus `external-endpoints` entry. Never throws — every
 * reachable failure is a {@link GatusPushOutcome}, not an exception.
 */
export async function pushGatusHealth(
  options: PushGatusHealthOptions,
): Promise<GatusPushOutcome> {
  const { db, settings, secrets } = options;
  const fetchImpl: GatusPushFetch =
    options.fetchImpl ?? ((url, init) => globalThis.fetch(url, init));

  const config = await settings.get(gatusPushSetting);
  if (!config.enabled) return { kind: "disabled" };
  if (config.baseUrl === null || config.endpointKey === null) {
    return {
      kind: "unconfigured",
      message: "gatus base URL and/or endpoint key is not set",
    };
  }

  let token: string;
  try {
    const secret = await secrets.getSecretPayload(GATUS_PUSH_SECRET_KEY, "token");
    token = secret.payload.token;
  } catch {
    return {
      kind: "unconfigured",
      message: "no push token is stored",
    };
  }

  const startedAt = performance.now();
  const health = createHealthService({ db });
  const rows = await health.listHealth();
  const worst = worstHealthStatus(rows);
  const success = worst !== "failing";
  const failingCount = rows.filter((row) => row.status === "failing").length;
  const error = success ? "" : `${failingCount} subject(s) failing`;
  const durationNs = Math.max(
    0,
    Math.round((performance.now() - startedAt) * 1_000_000),
  );

  const url = new URL(
    `${config.baseUrl.replace(/\/+$/u, "")}/api/v1/endpoints/${encodeURIComponent(config.endpointKey)}/external`,
  );
  url.searchParams.set("success", String(success));
  url.searchParams.set("error", error);
  url.searchParams.set("duration", String(durationNs));

  let response: Awaited<ReturnType<GatusPushFetch>>;
  try {
    response = await fetchImpl(url.toString(), {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
    });
  } catch (err) {
    return {
      kind: "network_error",
      message: err instanceof Error ? err.message : String(err),
    };
  }
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    return {
      kind: "http_error",
      statusCode: response.status,
      message: text.slice(0, 200),
    };
  }
  return { kind: "ok", reported: { success, error, durationNs } };
}

/** Loose: cron-scheduled runs carry Graphile's `_cron` envelope field. */
const gatusPushPayloadSchema = z.looseObject({
  correlationId: z.string().optional(),
});

export type GatusPushTask = LoxepTask<typeof gatusPushPayloadSchema>;

export interface GatusPushTasks {
  gatusPushTask: GatusPushTask;
  gatusPushCronItem: AppCronItem;
}

/**
 * `infrastructure.gatus-push` — the Graphile Worker wrapper around
 * {@link pushGatusHealth}, the same thin-wrapper shape `health-sweep.ts` uses
 * around `runHealthSweep`: `@loxep/app` owns the task/cron definition, the
 * push MECHANICS above take no `@loxep/jobs` dependency.
 *
 * Piggybacks on the same 5-minute cadence `health.sweep` already runs on —
 * there is no separate operator-tunable interval here for the same reason
 * the design gives `health.sweep` one recurring cron rather than a
 * `monitor_targets` row: cadence is uniform and not a per-subject intent
 * worth an operator setting.
 */
export function createGatusPushTasks(options: {
  services: AppServices;
  /** Injectable HTTP client (tests); defaults to the global `fetch`. */
  fetchImpl?: GatusPushFetch;
}): GatusPushTasks {
  const { services } = options;

  const gatusPushTask = defineTask({
    name: GATUS_PUSH_TASK_NAME,
    payloadSchema: gatusPushPayloadSchema,
    // A failed push is recorded and swallowed inside the handler itself
    // (see the module doc) — retries exist only to cover a transient
    // database blip while reading the setting/secret/health rows.
    maxAttempts: 3,
    handler: async (_payload, { logger }) => {
      const outcome = await pushGatusHealth({
        db: services.db,
        settings: services.settings,
        secrets: services.secrets,
        ...(options.fetchImpl !== undefined
          ? { fetchImpl: options.fetchImpl }
          : {}),
      });
      if (outcome.kind === "http_error" || outcome.kind === "network_error") {
        logger.warn(
          {
            kind: outcome.kind,
            statusCode: outcome.statusCode,
            message: outcome.message,
          },
          "gatus health push failed; will retry next cycle",
        );
      } else if (outcome.kind === "unconfigured") {
        logger.warn(
          { kind: outcome.kind, message: outcome.message },
          "gatus health push is enabled but not fully configured",
        );
      } else if (outcome.kind === "ok") {
        logger.info(
          { reported: outcome.reported },
          "gatus health push completed",
        );
      }
      // 'disabled' is the shipped default and not worth a log line every 5
      // minutes on every installation that has not opted in.
      return outcome;
    },
  });

  const gatusPushCronItem: AppCronItem = {
    task: GATUS_PUSH_TASK_NAME,
    match: GATUS_PUSH_CRON_MATCH,
    identifier: "gatus_push",
    options: {
      maxAttempts: gatusPushTask.maxAttempts,
      // A missed tick while the worker was down is uninteresting — Gatus's
      // own heartbeat is exactly what is supposed to notice that gap.
      backfillPeriod: 0,
      jobKey: jobKeyFor(GATUS_PUSH_TASK_NAME, "cron"),
      jobKeyMode: "replace",
    },
  };

  return { gatusPushTask, gatusPushCronItem };
}

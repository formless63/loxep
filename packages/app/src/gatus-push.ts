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
 *
 * ## The OQ9 five-fact expansion (loxep-4ah, owner ruling 6b)
 *
 * `gatusPushSetting.mode` (`@loxep/domain`, additive, PROVISIONAL default
 * `'single'`) selects between this milestone's single worst-status rollup —
 * unchanged, still {@link pushGatusHealth} — and open question 9's five
 * candidate facts, each pushed to its OWN Gatus `external-endpoints` key
 * ({@link pushGatusHealthFacts}): worker backlog, order-sync freshness,
 * notification delivery success, reconciler drift count, and a readiness
 * proxy. `mode: 'facts'` is a strict ADDITION to what ships — every
 * installation that has never touched this field keeps EXACTLY today's
 * one-push behavior; nothing about {@link pushGatusHealth} changes when a
 * sibling installation opts into `'facts'`.
 *
 * Each fact key is DERIVED from the same `endpointKey` the single-key mode
 * already uses (`@loxep/domain`'s `deriveGatusPushFactKey`,
 * `<baseKey>-<slug>`) — the operator declares five `external-endpoints`
 * entries in their own gatus YAML with names that sanitize to those five
 * derived keys (see the `gatus-health-push` guide for the exact block), and
 * Loxep never creates or renames a Gatus endpoint, matching the single-key
 * mode's own "never writes Gatus configuration" rule.
 *
 * A fact whose computation throws (a missing `graphile_worker` schema, a
 * database hiccup on one query) is SKIPPED for that cycle — never reported
 * as `success:false`, which would be inventing a fact Loxep cannot back, and
 * never silently reported `success:true` either. The next cycle tries again.
 */
import type { LoxepDb } from "@loxep/db";
import {
  createHealthService,
  deriveGatusPushFactKey,
  GATUS_PUSH_FACT_SLUGS,
  GATUS_PUSH_SECRET_KEY,
  gatusPushSetting,
} from "@loxep/domain";
import type {
  ConnectionsService,
  GatusPushFactSlug,
  HealthStatus,
  SecretsService,
  SettingsService,
} from "@loxep/domain";
import { defineTask, getJobStats, jobKeyFor } from "@loxep/jobs";
import type { LoxepTask, Queryable } from "@loxep/jobs";
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

  return await postGatusExternalPush({
    fetchImpl,
    baseUrl: config.baseUrl,
    key: config.endpointKey,
    token,
    success,
    error,
    durationNs,
  });
}

/**
 * The one HTTP exchange every push (single-key or per-fact) makes:
 * `POST /api/v1/endpoints/:key/external`, bearer-authenticated, never
 * throwing — every reachable failure is a {@link GatusPushOutcome}. Factored
 * out of {@link pushGatusHealth} so {@link pushGatusHealthFacts} makes the
 * exact same request shape per fact key, never a second implementation to
 * drift from the first.
 */
async function postGatusExternalPush(input: {
  fetchImpl: GatusPushFetch;
  baseUrl: string;
  key: string;
  token: string;
  success: boolean;
  error: string;
  durationNs: number;
}): Promise<GatusPushOutcome> {
  const url = new URL(
    `${input.baseUrl.replace(/\/+$/u, "")}/api/v1/endpoints/${encodeURIComponent(input.key)}/external`,
  );
  url.searchParams.set("success", String(input.success));
  url.searchParams.set("error", input.error);
  url.searchParams.set("duration", String(input.durationNs));

  let response: Awaited<ReturnType<GatusPushFetch>>;
  try {
    response = await input.fetchImpl(url.toString(), {
      method: "POST",
      headers: { Authorization: `Bearer ${input.token}` },
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
  return {
    kind: "ok",
    reported: { success: input.success, error: input.error, durationNs: input.durationNs },
  };
}

// =============================================================================
// The OQ9 five-fact expansion (loxep-4ah, owner ruling 6b) — see the module
// doc's "The OQ9 five-fact expansion" section for the shape. Everything below
// is reached ONLY when `gatusPushSetting.mode === 'facts'`; `pushGatusHealth`
// above is untouched by any of it.
// =============================================================================

/**
 * Order-sync-capable providers — narrower than `fleet-health.ts`'s "has a
 * poll executor" list, which also names Cloudflare (a DNS provider, not an
 * order-sync one) for a different rule (who may write
 * `connections.last_success_at`). This is OQ9's "order-sync freshness per
 * connection" fact specifically, so it is scoped to the providers that
 * actually sync orders/listings: ebay, woocommerce, etsy, reverb, medusa.
 */
const ORDER_SYNC_PROVIDERS: readonly string[] = [
  "ebay",
  "woocommerce",
  "etsy",
  "reverb",
  "medusa",
];

/**
 * How long a job may sit due-but-unstarted before the worker-backlog fact
 * reports failure — a documented politeness/attention threshold (health.sweep
 * itself runs every 5 minutes; three missed cycles is a genuine backlog, not
 * noise), not a Graphile Worker constant.
 */
const WORKER_BACKLOG_STALE_SECONDS = 15 * 60;

/** The rolling window the notification-delivery-success fact counts failures over. */
const NOTIFICATION_WINDOW_HOURS = 24;

interface GatusPushFactComputation {
  success: boolean;
  /** Empty when `success`. Never a stack trace, a query, or credential material. */
  error: string;
}

/**
 * Times a fact's own computation, matching {@link pushGatusHealth}'s
 * `duration` semantics (wall-clock time Loxep spent computing the summary,
 * not a network round-trip). A computation that THROWS (a missing
 * `graphile_worker` schema, a transient database hiccup on one query) comes
 * back `null` — SKIPPED for this cycle, never reported as `success:false`
 * (which would invent a fact Loxep cannot back) and never silently
 * `success:true` either. See the module doc.
 */
async function timedGatusPushFact(
  compute: () => Promise<GatusPushFactComputation>,
): Promise<(GatusPushFactComputation & { durationNs: number }) | null> {
  const startedAt = performance.now();
  let result: GatusPushFactComputation;
  try {
    result = await compute();
  } catch {
    return null;
  }
  const durationNs = Math.max(0, Math.round((performance.now() - startedAt) * 1_000_000));
  return { ...result, durationNs };
}

/**
 * Worker backlog: `@loxep/jobs`' `getJobStats`, reading `graphile_worker.jobs`
 * directly. `failed` (permanently exhausted jobs) or an oldest-pending job
 * older than {@link WORKER_BACKLOG_STALE_SECONDS} both fail this fact —
 * ADR-0018's own rule that backlog/failure numbers are health DETAIL, applied
 * here as the detail this particular external observer gets to see.
 */
async function computeWorkerBacklogFact(db: LoxepDb): Promise<GatusPushFactComputation> {
  // `getJobStats` wants a structural `{ query(text, values?) }` — `LoxepDb.execute`
  // already returns `{ rows }` for a plain string statement (see this
  // package's `sql.ts`), so the adapter is a one-line forward, no `pg` import.
  const queryable: Queryable = { query: (text) => db.execute(text) };
  const stats = await getJobStats(queryable);
  const stale =
    stats.oldestPendingSeconds !== null && stats.oldestPendingSeconds > WORKER_BACKLOG_STALE_SECONDS;
  const success = stats.failed === 0 && !stale;
  const error = success
    ? ""
    : `${stats.failed} failed job(s), ${stats.pending} pending` +
      (stale ? `, oldest due ${Math.round(stats.oldestPendingSeconds ?? 0)}s ago` : "");
  return { success, error };
}

/**
 * Order-sync freshness: the worst `integration_health` connection status
 * among {@link ORDER_SYNC_PROVIDERS} — the SAME rollup `/settings/overview`'s
 * Integration health table already shows, never a second staleness
 * computation invented for this one fact.
 */
async function computeSyncFreshnessFact(
  db: LoxepDb,
  connections: ConnectionsService,
): Promise<GatusPushFactComputation> {
  const health = createHealthService({ db });
  const [allConnections, rows] = await Promise.all([
    connections.listConnections(),
    health.listHealth({ subjectType: "connection" }),
  ]);
  const providerById = new Map(allConnections.map((c) => [c.id, c.provider]));
  const orderSyncRows = rows.filter((row) =>
    ORDER_SYNC_PROVIDERS.includes(providerById.get(row.subjectId) ?? ""),
  );
  if (orderSyncRows.length === 0) return { success: true, error: "" };
  const worst = worstHealthStatus(orderSyncRows);
  const failingCount = orderSyncRows.filter((row) => row.status === "failing").length;
  const success = worst !== "failing";
  return {
    success,
    error: success ? "" : `${failingCount} order-sync connection(s) failing`,
  };
}

/**
 * Notification delivery success: `notification_deliveries` rows created in
 * the last {@link NOTIFICATION_WINDOW_HOURS}, counting `status = 'failed'`
 * (the terminal failure state — `deliver.ts`'s own "pending → delivered |
 * failed" vocabulary). A window with zero deliveries at all is `success`,
 * matching every other fact's "nothing to report is not a failure" posture.
 */
async function computeNotificationDeliveryFact(db: LoxepDb): Promise<GatusPushFactComputation> {
  const result = await db.execute(
    `select
       count(*) filter (where status = 'failed')::int as failed,
       count(*)::int as total
     from notification_deliveries
     where created_at > now() - interval '${NOTIFICATION_WINDOW_HOURS} hours'`,
  );
  const row = result.rows[0] ?? {};
  const failed = Number(row["failed"] ?? 0);
  const total = Number(row["total"] ?? 0);
  const success = failed === 0;
  return {
    success,
    error: success
      ? ""
      : `${failed} of ${total} notification(s) failed in the last ${NOTIFICATION_WINDOW_HOURS}h`,
  };
}

/**
 * Reconciler drift count: DNS drift (`managed_domains.drift_detected_at IS
 * NOT NULL` — the same column `@loxep/infrastructure`'s `DriftService`
 * already maintains as its own "unresolved" signal) plus container-host
 * drift, read from `detail.driftingTargetCount` on every `connection`
 * `integration_health` row — the exact number `fleet-health.ts`'s
 * `reconcileDeclaredContainerHosts` already computed and persisted per
 * Dockhand connection during its own sweep. Deliberately reuses BOTH
 * already-persisted signals rather than re-running either reconciler a
 * second time for this one push.
 */
async function computeDriftFact(db: LoxepDb): Promise<GatusPushFactComputation> {
  const health = createHealthService({ db });
  const [rows, domainDriftResult] = await Promise.all([
    health.listHealth({ subjectType: "connection" }),
    db.execute(
      `select count(*)::int as n from managed_domains where drift_detected_at is not null`,
    ),
  ]);
  let containerHostDrift = 0;
  for (const row of rows) {
    const value = row.detail?.["driftingTargetCount"];
    if (typeof value === "number") containerHostDrift += value;
  }
  const dnsDrift = Number(domainDriftResult.rows[0]?.["n"] ?? 0);
  const total = containerHostDrift + dnsDrift;
  return {
    success: total === 0,
    error:
      total === 0
        ? ""
        : `${total} drifting target(s) (${dnsDrift} DNS, ${containerHostDrift} container-host)`,
  };
}

/**
 * Readiness: narrowed to database reachability (`select 1`), a DELIBERATE
 * scoping call recorded rather than silently substituted — matching
 * milestone 2's own precedent (OQ9's "which facts" answered narrower than
 * asked). The full runtime readiness report (`@loxep/runtime`'s
 * `readiness()`: component + dependency checks, not just the database) is
 * out of reach WITHOUT adding `@loxep/app` -> `@loxep/runtime` as a new
 * package dependency, which this bead's own constraints forbid touching
 * (`package.json`/`bun.lock` are off-limits). In practice this fact rarely
 * reports `false`: the push task cannot read `gatusPushSetting` at all
 * without a working database connection, so a `false` here is closer to "the
 * database degraded mid-task" than "Loxep is unready" in the fuller sense.
 * Recorded here so a future session that DOES touch the dependency graph can
 * widen this to the real readiness report without re-deriving the reasoning.
 */
async function computeReadinessFact(db: LoxepDb): Promise<GatusPushFactComputation> {
  try {
    await db.execute("select 1");
    return { success: true, error: "" };
  } catch (err) {
    return {
      success: false,
      error: `database unreachable: ${err instanceof Error ? err.message : String(err)}`.slice(
        0,
        200,
      ),
    };
  }
}

export interface ComputeGatusPushFactsOptions {
  db: LoxepDb;
  connections: ConnectionsService;
}

/**
 * Compute every OQ9 fact this cycle can back, keyed by slug. A slug absent
 * from the result was SKIPPED (its computation threw) — see
 * {@link timedGatusPushFact}'s doc.
 */
async function computeGatusPushFacts(
  options: ComputeGatusPushFactsOptions,
): Promise<Partial<Record<GatusPushFactSlug, GatusPushFactComputation & { durationNs: number }>>> {
  const { db, connections } = options;
  const [workerBacklog, syncFreshness, notifications, drift, readiness] = await Promise.all([
    timedGatusPushFact(() => computeWorkerBacklogFact(db)),
    timedGatusPushFact(() => computeSyncFreshnessFact(db, connections)),
    timedGatusPushFact(() => computeNotificationDeliveryFact(db)),
    timedGatusPushFact(() => computeDriftFact(db)),
    timedGatusPushFact(() => computeReadinessFact(db)),
  ]);
  const results: Partial<
    Record<GatusPushFactSlug, GatusPushFactComputation & { durationNs: number }>
  > = {};
  if (workerBacklog !== null) results["worker-backlog"] = workerBacklog;
  if (syncFreshness !== null) results["sync-freshness"] = syncFreshness;
  if (notifications !== null) results["notifications"] = notifications;
  if (drift !== null) results["drift"] = drift;
  if (readiness !== null) results["readiness"] = readiness;
  return results;
}

/** One fact's own push outcome, tagged with which fact it was. */
export interface GatusPushFactOutcome extends GatusPushOutcome {
  slug: GatusPushFactSlug;
}

export interface PushGatusHealthFactsOptions extends PushGatusHealthOptions {
  connections: ConnectionsService;
}

/**
 * The `mode: 'facts'` push: one {@link postGatusExternalPush} per OQ9 fact
 * this cycle could compute, to that fact's own derived key
 * (`deriveGatusPushFactKey(config.endpointKey, slug)`). Never throws, exactly
 * like {@link pushGatusHealth} — every reachable failure is a
 * {@link GatusPushFactOutcome} in the returned array, one per slug that was
 * attempted (a slug SKIPPED by {@link computeGatusPushFacts} is simply absent
 * from the result, not reported as any kind of failure).
 *
 * `disabled`/`unconfigured` fan out to all five slugs uniformly — there is
 * nothing fact-specific to report when the whole push has nowhere to go.
 */
export async function pushGatusHealthFacts(
  options: PushGatusHealthFactsOptions,
): Promise<GatusPushFactOutcome[]> {
  const { db, settings, secrets, connections } = options;
  const fetchImpl: GatusPushFetch =
    options.fetchImpl ?? ((url, init) => globalThis.fetch(url, init));

  const config = await settings.get(gatusPushSetting);
  if (!config.enabled) {
    return GATUS_PUSH_FACT_SLUGS.map((slug) => ({ slug, kind: "disabled" }));
  }
  if (config.baseUrl === null || config.endpointKey === null) {
    return GATUS_PUSH_FACT_SLUGS.map((slug) => ({
      slug,
      kind: "unconfigured",
      message: "gatus base URL and/or endpoint key is not set",
    }));
  }

  let token: string;
  try {
    const secret = await secrets.getSecretPayload(GATUS_PUSH_SECRET_KEY, "token");
    token = secret.payload.token;
  } catch {
    return GATUS_PUSH_FACT_SLUGS.map((slug) => ({
      slug,
      kind: "unconfigured",
      message: "no push token is stored",
    }));
  }

  const facts = await computeGatusPushFacts({ db, connections });
  const baseUrl = config.baseUrl;
  const endpointKey = config.endpointKey;

  const outcomes: GatusPushFactOutcome[] = [];
  for (const slug of GATUS_PUSH_FACT_SLUGS) {
    const fact = facts[slug];
    if (fact === undefined) continue; // Skipped this cycle — see the module doc.
    const outcome = await postGatusExternalPush({
      fetchImpl,
      baseUrl,
      key: deriveGatusPushFactKey(endpointKey, slug),
      token,
      success: fact.success,
      error: fact.error,
      durationNs: fact.durationNs,
    });
    outcomes.push({ slug, ...outcome });
  }
  return outcomes;
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
      const fetchOption = options.fetchImpl !== undefined ? { fetchImpl: options.fetchImpl } : {};

      // loxep-4ah: the mode read is cheap (one settings row, already read
      // again inside whichever push function runs) and keeps this handler —
      // the only caller of either push function — as the ONE place the
      // branch is made, rather than threading a pre-fetched config into
      // functions that are also called directly, and independently, by
      // tests.
      const config = await services.settings.get(gatusPushSetting);

      if (config.mode === "facts") {
        const outcomes = await pushGatusHealthFacts({
          db: services.db,
          settings: services.settings,
          secrets: services.secrets,
          connections: services.connections,
          ...fetchOption,
        });
        for (const outcome of outcomes) {
          if (outcome.kind === "http_error" || outcome.kind === "network_error") {
            logger.warn(
              {
                slug: outcome.slug,
                kind: outcome.kind,
                statusCode: outcome.statusCode,
                message: outcome.message,
              },
              "gatus health push (fact) failed; will retry next cycle",
            );
          } else if (outcome.kind === "unconfigured") {
            logger.warn(
              { slug: outcome.slug, kind: outcome.kind, message: outcome.message },
              "gatus health push is enabled but not fully configured",
            );
          } else if (outcome.kind === "ok") {
            logger.info(
              { slug: outcome.slug, reported: outcome.reported },
              "gatus health push (fact) completed",
            );
          }
        }
        return outcomes;
      }

      const outcome = await pushGatusHealth({
        db: services.db,
        settings: services.settings,
        secrets: services.secrets,
        ...fetchOption,
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

/**
 * The Phase 8 milestone 1 subject registry and sweep (loxep-ovj.1). Full
 * design: apps/docs/src/content/docs/architecture/
 * fleet-observability-design.md ("Probing, jobs, and where cadence lives").
 *
 * ## Due-ness needs no extra column
 *
 * "`checked_at` and `consecutive_failures` are already on the row, so the
 * sweep computes the next check as `checked_at + interval(consecutive_
 * failures)` and skips what is not due. A dead host backs off to a long
 * interval on its own." {@link isHealthCheckDue} is that formula, exposed as
 * a pure function so it is tested in isolation from any database or clock.
 *
 * ## One recurring sweep, no `monitor_targets` rows
 *
 * The design rejects registering a `monitor_targets` target type for health
 * probing — cadence is uniform and not operator-tunable, which is exactly
 * the shape `monitor_targets` is NOT for. {@link runHealthSweep} is instead a
 * bounded, self-contained pass: for every registered subject TYPE it lists
 * every currently-probeable subject (design: "volumes are tens of subjects,
 * not thousands", so listing all of them and filtering due-ness in memory is
 * the honest cost, not a premature one), keeps only the due ones, probes at
 * most {@link DEFAULT_MAX_SUBJECTS_PER_TYPE} per type per run, and upserts
 * one row per probed subject through {@link HealthService.upsertHealth}.
 *
 * This module owns the registry and the sweep MECHANICS. It deliberately
 * takes no `@loxep/jobs` dependency — `runHealthSweep` is plain async
 * function over a database handle, exactly like `@loxep/commerce`'s
 * `runOrderPayloadRedactionSweep` — so the Graphile Worker task definition
 * and cron item live in the composition root (`@loxep/app`), which already
 * depends on both `@loxep/jobs` and `@loxep/domain`.
 *
 * ## Cheap, unauthenticated, subject-based probes only
 *
 * Every probe here is read-only, sends no credential, and probes a Loxep
 * RECORD with a documented health path — never an operator-typed URL (the
 * design's review test: "a form whose first field is a URL the operator
 * types" is the line that must never be crossed). The first three subjects
 * (loxep-ovj.1), plus a fourth added by loxep-ovj.3:
 *
 * ```text
 * connection            derived from connections.last_success_at /
 *                       last_error_at — NO network call. Loxep already knows
 *                       this from every other provider operation.
 * notification_endpoint ntfy only (the one registered provider): GET
 *                       <baseUrl>/v1/health, unauthenticated
 *                       (https://docs.ntfy.sh — verified 2026-08).
 * storage_backend       local: fs.stat(rootDir) — same host as Loxep, so a
 *                       failure is Loxep's own misconfiguration ('failing'),
 *                       not a network question.
 *                       s3: an unauthenticated HEAD to the configured
 *                       endpoint — any HTTP response proves reachability;
 *                       no bucket call, no credential.
 * external_resource     (loxep-ovj.3) one row per companion-tool LINK
 *                       (`external_resources`), not per connection: GET
 *                       `<url origin><registry health path>`, unauthenticated,
 *                       for whichever provider `./fleet-tool-registry.ts`
 *                       names as tier-2-probeable. A provider with no
 *                       registered health path (Tailscale, Termix — see that
 *                       module's doc) is never listed as a candidate at all,
 *                       so it never gets a fabricated `unknown` row. Netdata,
 *                       Cockpit, and Uptime Kuma were link-only entries in
 *                       that registry and were REMOVED from it on 2026-08-14
 *                       (owner instruction: "if it doesn't integrate we don't
 *                       mention it" — see that module's doc); this probe
 *                       simply never sees them anymore, same as any other
 *                       provider the registry does not name.
 * ```
 *
 * **"Unreachable from Loxep" vs "failing"**, the design's sharpest UX rule: a
 * network-level failure (DNS, connection refused, timeout) reports
 * `'unknown'` — Loxep could not determine the subject's health, which is a
 * true statement distinct from the subject itself misbehaving. A definite
 * response the subject gave back that signals trouble (non-2xx, an
 * `unhealthy` body, a broken local directory) reports `'failing'`.
 */
import { access, stat } from "node:fs/promises";
import type { LoxepDb } from "@loxep/db";
import { isConnectionArchived } from "./connections.ts";
import {
  FLEET_TOOL_REGISTRY,
  PROBEABLE_FLEET_TOOL_PROVIDERS,
} from "./fleet-tool-registry.ts";
import type { FleetToolProvider } from "./fleet-tool-registry.ts";
import { createHealthService } from "./health.ts";
import {
  HEALTH_EVENT_TYPES,
  NOTIFIABLE_HEALTH_SUBJECT_TYPES,
  publishNotificationEvent,
} from "./notification-events.ts";
import type {
  NotificationEnqueue,
  NotificationSubjectType,
} from "./notification-events.ts";
import type {
  HealthService,
  HealthSource,
  HealthStatus,
  HealthSubjectType,
} from "./health.ts";
import { DomainValidationError } from "./errors.ts";

/** Base backoff step for a subject with zero consecutive failures. */
export const BASE_PROBE_INTERVAL_SECONDS = 300;
/** Backoff ceiling — a persistently dead subject is checked at most hourly. */
export const MAX_PROBE_INTERVAL_SECONDS = 3600;

/**
 * `checked_at + interval(consecutive_failures)`, the design's due-ness
 * formula. Exponential in the failure streak, capped at
 * {@link MAX_PROBE_INTERVAL_SECONDS} — a dead subject backs off on its own
 * using only columns the row already has.
 */
export function nextHealthCheckDueAt(
  checkedAt: Date,
  consecutiveFailures: number,
): Date {
  const exponent = Math.min(Math.max(consecutiveFailures, 0), 10);
  const backoffSeconds = Math.min(
    BASE_PROBE_INTERVAL_SECONDS * 2 ** exponent,
    MAX_PROBE_INTERVAL_SECONDS,
  );
  return new Date(checkedAt.getTime() + backoffSeconds * 1000);
}

/** True when a subject with no health row yet, or one past its backoff, is due. */
export function isHealthCheckDue(
  existing: { checkedAt: Date; consecutiveFailures: number } | null,
  now: Date,
): boolean {
  if (existing === null) return true;
  return (
    nextHealthCheckDueAt(existing.checkedAt, existing.consecutiveFailures).getTime() <=
    now.getTime()
  );
}

export interface HealthProbeOutcome {
  status: HealthStatus;
  detail?: Record<string, unknown>;
  /**
   * Overrides {@link HealthSubjectRegistryEntry.source} for this one outcome.
   *
   * `source` on the registry entry is per subject TYPE, which is correct for
   * every entry in {@link createDefaultHealthSubjectRegistry} — a
   * `notification_endpoint` probe is always `'probe'`, a `connection` probe
   * derived from `connections.last_success_at` is always `'probe'`. But
   * `@loxep/app`'s composed registry (loxep-rf4/loxep-hb7) gives `connection`
   * a SINGLE entry that dispatches per row: a fleet-tool connection (Beszel,
   * Dockhand, Gatus, Tailscale, Termix) reads the provider's own API through
   * an adapter, while every other connection still gets the derived
   * `last_success_at` read. Those two outcomes are not the same kind of fact
   * and must not share one label:
   *
   * - `'probe'` — Loxep CHECKED something itself (an unauthenticated HTTP
   *   GET, or a derived read of a column Loxep already owns).
   * - `'adapter'` — Loxep READ a companion tool's own API through its
   *   integration adapter, using a stored credential.
   *
   * Left `undefined`, {@link runHealthSweep} falls back to the registry
   * entry's own `source` — every existing caller (the default registry, and
   * every test built against it) is unaffected.
   */
  source?: HealthSource;
}

export interface HealthSubjectCandidate {
  subjectId: string;
}

export interface HealthSubjectRegistryEntry {
  source: HealthSource;
  /** Every currently-probeable subject id for this type (tens of rows). */
  listCandidates: (db: LoxepDb) => Promise<HealthSubjectCandidate[]>;
  /**
   * Probe exactly one subject. `null` means the subject no longer exists
   * (deleted between listing and probing); the sweep clears its health row
   * instead of writing a stale one.
   */
  probe: (db: LoxepDb, subjectId: string) => Promise<HealthProbeOutcome | null>;
}

export type HealthSubjectRegistry = Partial<
  Record<HealthSubjectType, HealthSubjectRegistryEntry>
>;

/** Minimal structural fetch, injectable so tests never perform network I/O. */
export type HealthFetch = (
  url: string,
  init: { method: string; signal?: AbortSignal },
) => Promise<{ ok: boolean; status: number; text: () => Promise<string> }>;

const DEFAULT_PROBE_TIMEOUT_MS = 5000;

/** Distinguishes a network-level failure from an HTTP response. */
class HealthProbeNetworkError extends Error {}

async function probeUrl(
  fetchImpl: HealthFetch,
  url: string,
  timeoutMs: number,
): Promise<{ status: number; ok: boolean; text: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, {
      method: "GET",
      signal: controller.signal,
    });
    const text = await response.text().catch(() => "");
    return { status: response.status, ok: response.ok, text };
  } catch (error) {
    throw new HealthProbeNetworkError(
      error instanceof Error ? error.message : String(error),
    );
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// connection
// ---------------------------------------------------------------------------

async function listConnectionCandidates(
  db: LoxepDb,
): Promise<HealthSubjectCandidate[]> {
  const rows = await db.query.connections.findMany({
    columns: { id: true, status: true },
  });
  return rows
    .filter((row) => !isConnectionArchived(row.status))
    .map((row) => ({ subjectId: row.id }));
}

async function probeConnection(
  db: LoxepDb,
  subjectId: string,
): Promise<HealthProbeOutcome | null> {
  const row = await db.query.connections.findFirst({
    where: (table, { eq }) => eq(table.id, subjectId),
    columns: {
      lastSuccessAt: true,
      lastErrorAt: true,
      lastErrorCode: true,
      provider: true,
    },
  });
  if (row === undefined) return null;

  // Mirrors the dashboard's existing "most recent outcome" rule: an error
  // with no later success is failing; a later success clears it.
  const erroring =
    row.lastErrorAt !== null &&
    (row.lastSuccessAt === null || row.lastErrorAt > row.lastSuccessAt);
  if (erroring) {
    return {
      status: "failing",
      detail: {
        kind: "provider_error",
        provider: row.provider,
        ...(row.lastErrorCode === null ? {} : { errorCode: row.lastErrorCode }),
      },
    };
  }
  if (row.lastSuccessAt !== null) {
    return { status: "ok", detail: { provider: row.provider } };
  }
  // Never synced yet — "nothing configured must not render like everything
  // healthy" applies at the row level too.
  return {
    status: "unknown",
    detail: { kind: "never_succeeded", provider: row.provider },
  };
}

// ---------------------------------------------------------------------------
// notification_endpoint (ntfy only — the one registered provider)
// ---------------------------------------------------------------------------

/** Structural pick of the one field this probe needs (see the module doc). */
function readBaseUrl(config: unknown): string | null {
  if (config === null || typeof config !== "object") return null;
  const value = (config as Record<string, unknown>)["baseUrl"];
  return typeof value === "string" && value.length > 0 ? value : null;
}

async function listNotificationEndpointCandidates(
  db: LoxepDb,
): Promise<HealthSubjectCandidate[]> {
  const rows = await db.query.notificationEndpoints.findMany({
    where: (table, { eq }) => eq(table.enabled, true),
    columns: { id: true },
  });
  return rows.map((row) => ({ subjectId: row.id }));
}

function createNotificationEndpointProbe(
  fetchImpl: HealthFetch,
  timeoutMs: number,
): HealthSubjectRegistryEntry["probe"] {
  return async (db, subjectId) => {
    const row = await db.query.notificationEndpoints.findFirst({
      where: (table, { eq }) => eq(table.id, subjectId),
      columns: { provider: true, config: true },
    });
    if (row === undefined) return null;
    if (row.provider !== "ntfy") {
      return {
        status: "unknown",
        detail: { kind: "unsupported_provider", provider: row.provider },
      };
    }
    const baseUrl = readBaseUrl(row.config);
    if (baseUrl === null) {
      return { status: "unknown", detail: { kind: "missing_base_url" } };
    }

    try {
      const result = await probeUrl(
        fetchImpl,
        `${baseUrl.replace(/\/+$/u, "")}/v1/health`,
        timeoutMs,
      );
      if (!result.ok) {
        return {
          status: "failing",
          detail: { kind: "http_error", statusCode: result.status },
        };
      }
      // ntfy's /v1/health body is `{"healthy":true}`; an explicit false is a
      // definite unhealthy signal, not a reachability question.
      try {
        const parsed = JSON.parse(result.text) as { healthy?: unknown };
        if (parsed.healthy === false) {
          return { status: "failing", detail: { kind: "reported_unhealthy" } };
        }
      } catch {
        // Non-JSON 2xx body: still a reachable, responding server.
      }
      return { status: "ok", detail: {} };
    } catch (error) {
      if (error instanceof HealthProbeNetworkError) {
        return { status: "unknown", detail: { kind: "unreachable" } };
      }
      throw error;
    }
  };
}

// ---------------------------------------------------------------------------
// storage_backend
// ---------------------------------------------------------------------------

function readRootDir(config: unknown): string | null {
  if (config === null || typeof config !== "object") return null;
  const value = (config as Record<string, unknown>)["rootDir"];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function readEndpoint(config: unknown): string | null {
  if (config === null || typeof config !== "object") return null;
  const value = (config as Record<string, unknown>)["endpoint"];
  return typeof value === "string" && value.length > 0 ? value : null;
}

async function listStorageBackendCandidates(
  db: LoxepDb,
): Promise<HealthSubjectCandidate[]> {
  const rows = await db.query.storageBackends.findMany({
    where: (table, { eq }) => eq(table.enabled, true),
    columns: { id: true },
  });
  return rows.map((row) => ({ subjectId: row.id }));
}

function createStorageBackendProbe(
  fetchImpl: HealthFetch,
  timeoutMs: number,
): HealthSubjectRegistryEntry["probe"] {
  return async (db, subjectId) => {
    const row = await db.query.storageBackends.findFirst({
      where: (table, { eq }) => eq(table.id, subjectId),
      columns: { driver: true, config: true },
    });
    if (row === undefined) return null;

    if (row.driver === "local") {
      const rootDir = readRootDir(row.config);
      if (rootDir === null) {
        return { status: "unknown", detail: { kind: "missing_root_dir" } };
      }
      try {
        await access(rootDir);
        const info = await stat(rootDir);
        if (!info.isDirectory()) {
          return { status: "failing", detail: { kind: "not_a_directory" } };
        }
        return { status: "ok", detail: {} };
      } catch (error) {
        const code =
          error !== null && typeof error === "object" && "code" in error
            ? String((error as { code: unknown }).code)
            : "unknown_error";
        // Same host as Loxep — a broken local directory is Loxep's own
        // misconfiguration, not a network topology question.
        return { status: "failing", detail: { kind: "fs_error", code } };
      }
    }

    if (row.driver === "s3") {
      const endpoint = readEndpoint(row.config);
      if (endpoint === null) {
        return { status: "unknown", detail: { kind: "missing_endpoint" } };
      }
      try {
        // Unauthenticated HEAD: any HTTP response proves reachability. No
        // bucket call, no credential — deliberately tier-2, not tier-3.
        const result = await probeUrl(fetchImpl, endpoint, timeoutMs);
        void result;
        return { status: "ok", detail: {} };
      } catch (error) {
        if (error instanceof HealthProbeNetworkError) {
          return { status: "unknown", detail: { kind: "unreachable" } };
        }
        return {
          status: "failing",
          detail: { kind: "invalid_endpoint_config" },
        };
      }
    }

    return { status: "unknown", detail: { kind: "unsupported_driver" } };
  };
}

// ---------------------------------------------------------------------------
// external_resource (loxep-ovj.3) — one row per companion-tool LINK
// ---------------------------------------------------------------------------

/**
 * Every `external_resources` row whose `provider` is tier-2-probeable per
 * `./fleet-tool-registry.ts` (`PROBEABLE_FLEET_TOOL_PROVIDERS`). Other
 * providers — a future knowledge/tasks companion link, a fleet tool with no
 * unauthenticated health path (Tailscale, Termix), or a link-only tool
 * removed from the registry entirely (Netdata, Cockpit, Uptime Kuma — see
 * that module's doc) — are never listed, so they never accumulate a
 * fabricated `integration_health` row this probe cannot honestly back.
 */
async function listExternalResourceCandidates(
  db: LoxepDb,
): Promise<HealthSubjectCandidate[]> {
  if (PROBEABLE_FLEET_TOOL_PROVIDERS.length === 0) return [];
  const rows = await db.query.externalResources.findMany({
    where: (table, { inArray }) =>
      inArray(table.provider, [...PROBEABLE_FLEET_TOOL_PROVIDERS]),
    columns: { id: true },
  });
  return rows.map((row) => ({ subjectId: row.id }));
}

function createExternalResourceProbe(
  fetchImpl: HealthFetch,
  timeoutMs: number,
): HealthSubjectRegistryEntry["probe"] {
  return async (db, subjectId) => {
    const row = await db.query.externalResources.findFirst({
      where: (table, { eq }) => eq(table.id, subjectId),
      columns: { provider: true, url: true },
    });
    if (row === undefined) return null;

    const entry = FLEET_TOOL_REGISTRY[row.provider as FleetToolProvider] as
      | (typeof FLEET_TOOL_REGISTRY)[FleetToolProvider]
      | undefined;
    if (entry === undefined || entry.healthPath === null) {
      // Reached only if a row's provider changed under this candidate list's
      // feet between listing and probing, or the registry itself changed —
      // `listExternalResourceCandidates` already filters to probeable
      // providers, so this is defensive, not the common path.
      return {
        status: "unknown",
        detail: { kind: "no_health_path", provider: row.provider },
      };
    }

    // The link's own URL points at ONE specific resource, never a base URL
    // (see fleet-tool-registry.ts's module doc) — the health path is
    // resolved against its ORIGIN, not appended to the stored URL.
    let origin: string;
    try {
      origin = new URL(row.url).origin;
    } catch {
      return { status: "unknown", detail: { kind: "invalid_url" } };
    }

    try {
      const result = await probeUrl(
        fetchImpl,
        `${origin}${entry.healthPath}`,
        timeoutMs,
      );
      if (!result.ok) {
        return {
          status: "failing",
          detail: { kind: "http_error", statusCode: result.status },
        };
      }
      return { status: "ok", detail: {} };
    } catch (error) {
      if (error instanceof HealthProbeNetworkError) {
        // Distinct from 'failing' by design — these hubs commonly sit
        // behind a tunnel or on a private network Loxep is not on.
        return { status: "unknown", detail: { kind: "unreachable" } };
      }
      throw error;
    }
  };
}

export interface CreateDefaultHealthSubjectRegistryOptions {
  /** Injectable HTTP client; defaults to the global `fetch`. */
  fetchImpl?: HealthFetch;
  /** Per-probe network timeout; defaults to {@link DEFAULT_PROBE_TIMEOUT_MS}. */
  timeoutMs?: number;
}

/**
 * The first three subjects (design: "First subjects: connections,
 * notification endpoints, storage backends. No companion tool integration in
 * this milestone."), plus `external_resource` (loxep-ovj.3, tier-2
 * companion-link reachability). `source` is `'probe'` for all four — this
 * registry is only ever consulted by {@link runHealthSweep}.
 *
 * `@loxep/app`'s `createFleetHealthSubjectRegistry` (loxep-rf4/hb7) spreads
 * this registry and overrides only its `connection` entry with a
 * fleet-provider-dispatching one; `external_resource` passes through
 * unchanged, exactly like `notification_endpoint`/`storage_backend` already
 * do — no `@loxep/app` change was needed to compose this in.
 */
export function createDefaultHealthSubjectRegistry(
  options?: CreateDefaultHealthSubjectRegistryOptions,
): HealthSubjectRegistry {
  const fetchImpl: HealthFetch =
    options?.fetchImpl ?? ((url, init) => globalThis.fetch(url, init));
  const timeoutMs = options?.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;

  return {
    connection: {
      source: "probe",
      listCandidates: listConnectionCandidates,
      probe: probeConnection,
    },
    notification_endpoint: {
      source: "probe",
      listCandidates: listNotificationEndpointCandidates,
      probe: createNotificationEndpointProbe(fetchImpl, timeoutMs),
    },
    storage_backend: {
      source: "probe",
      listCandidates: listStorageBackendCandidates,
      probe: createStorageBackendProbe(fetchImpl, timeoutMs),
    },
    external_resource: {
      source: "probe",
      listCandidates: listExternalResourceCandidates,
      probe: createExternalResourceProbe(fetchImpl, timeoutMs),
    },
  };
}

// ---------------------------------------------------------------------------
// The sweep
// ---------------------------------------------------------------------------

/** Subjects probed per subject type, per run — bounded, like the redaction sweep. */
export const DEFAULT_MAX_SUBJECTS_PER_TYPE = 50;

export interface HealthSweepResult {
  checkedTypes: HealthSubjectType[];
  /** Candidates listed across every registered type. */
  scanned: number;
  /** Candidates whose backoff had elapsed. */
  due: number;
  /** Rows upserted by this run. */
  probed: number;
  /** Due candidates left for the next run because a type hit its cap. */
  more: boolean;
  /** Health rows cleared because the subject was gone. */
  cleared: number;
  /** Probes that threw; left unwritten and reported. */
  failed: number;
  /** Probed count per subject type. */
  batches: Readonly<Partial<Record<HealthSubjectType, number>>>;
  /**
   * Status transitions this run recorded as `health`-class notification events
   * (loxep-oii). Aggregate counters cannot express which subject changed, and
   * the transition is exactly the fact a notification is about.
   */
  transitions: readonly HealthTransition[];
}

/** One notifiable status transition observed by {@link runHealthSweep}. */
export interface HealthTransition {
  subjectType: HealthSubjectType;
  subjectId: string;
  previousStatus: HealthStatus;
  status: HealthStatus;
  eventType: (typeof HEALTH_EVENT_TYPES)[number];
  /** Whether a notification event row was written (false on a re-run). */
  recorded: boolean;
  /** Endpoints the transition was routed to, if an enqueue seam was given. */
  endpointIds: readonly string[];
}

/**
 * Which transitions are worth telling a human about.
 *
 * Into `degraded`/`failing` is a degradation; back to `ok` from one of those
 * is a recovery. Transitions into or out of `unknown` are deliberately NOT
 * emitted: "we could not tell" is not an alert, and a flapping unknown would
 * be the loudest thing in the feed. First insert (no previous status) is not a
 * transition at all — the same semantics `previous_status`/`status_changed_at`
 * already have.
 */
export function healthTransitionEventType(
  previousStatus: HealthStatus | null,
  status: HealthStatus,
): (typeof HEALTH_EVENT_TYPES)[number] | null {
  if (previousStatus === null || previousStatus === status) return null;
  if (status === "degraded" || status === "failing") return "health_degraded";
  if (
    status === "ok" &&
    (previousStatus === "degraded" || previousStatus === "failing")
  ) {
    return "health_recovered";
  }
  return null;
}

export interface RunHealthSweepOptions {
  db: LoxepDb;
  /** Defaults to {@link createDefaultHealthSubjectRegistry}. */
  registry?: HealthSubjectRegistry;
  /** Reuse an existing health service instead of creating one. */
  health?: HealthService;
  /** Sweep clock; defaults to now. Tests pin it. */
  now?: Date;
  maxSubjectsPerType?: number;
  logger?: { warn: (obj: Record<string, unknown>, msg: string) => void };
  /**
   * The delivery enqueue seam (ADR-0023). Omit and the sweep still RECORDS
   * every notifiable transition — detection does not depend on delivery — but
   * routes none of them. `@loxep/app` composes the transactional one; tests
   * pass a recorder.
   */
  enqueue?: NotificationEnqueue;
  /**
   * Set false to record no notification events at all (health rows are still
   * written). Defaults to true.
   */
  emitNotifications?: boolean;
}

/**
 * Run one bounded pass of the health sweep across every registered subject
 * type. Idempotent by `(subject_type, subject_id)` — a redelivered job, two
 * overlapping runs, or a retry re-probes and re-upserts the same subjects
 * without duplicating anything (there is nothing to duplicate: one row per
 * subject, overwritten in place).
 */
export async function runHealthSweep(
  options: RunHealthSweepOptions,
): Promise<HealthSweepResult> {
  const { db } = options;
  const registry = options.registry ?? createDefaultHealthSubjectRegistry();
  const health = options.health ?? createHealthService({ db });
  const now = options.now ?? new Date();
  const maxSubjectsPerType =
    options.maxSubjectsPerType ?? DEFAULT_MAX_SUBJECTS_PER_TYPE;
  if (!Number.isInteger(maxSubjectsPerType) || maxSubjectsPerType < 1) {
    throw new DomainValidationError(
      "maxSubjectsPerType must be a positive integer",
    );
  }

  const emitNotifications = options.emitNotifications ?? true;
  const transitions: HealthTransition[] = [];
  const checkedTypes: HealthSubjectType[] = [];
  let scanned = 0;
  let due = 0;
  let probed = 0;
  let more = false;
  let cleared = 0;
  let failed = 0;
  const batches: Partial<Record<HealthSubjectType, number>> = {};

  for (const entry of Object.entries(registry)) {
    const subjectType = entry[0] as HealthSubjectType;
    const registryEntry = entry[1];
    if (registryEntry === undefined) continue;
    checkedTypes.push(subjectType);
    batches[subjectType] = 0;

    const [candidates, existingRows] = await Promise.all([
      registryEntry.listCandidates(db),
      health.listHealth({ subjectType }),
    ]);
    scanned += candidates.length;

    const existingByKey = new Map(existingRows.map((row) => [row.subjectId, row]));
    const dueCandidates = candidates.filter((candidate) =>
      isHealthCheckDue(existingByKey.get(candidate.subjectId) ?? null, now),
    );
    due += dueCandidates.length;
    const toProbe = dueCandidates.slice(0, maxSubjectsPerType);
    if (dueCandidates.length > toProbe.length) more = true;

    for (const candidate of toProbe) {
      let outcome: HealthProbeOutcome | null;
      try {
        outcome = await registryEntry.probe(db, candidate.subjectId);
      } catch (error) {
        failed += 1;
        options.logger?.warn(
          {
            subjectType,
            subjectId: candidate.subjectId,
            error: error instanceof Error ? error.message : String(error),
          },
          "integration health probe failed; subject left unwritten",
        );
        continue;
      }
      if (outcome === null) {
        await health.clearHealthForSubject(subjectType, candidate.subjectId);
        cleared += 1;
        continue;
      }
      const before = existingByKey.get(candidate.subjectId) ?? null;
      await health.upsertHealth({
        subjectType,
        subjectId: candidate.subjectId,
        status: outcome.status,
        // `outcome.source` wins when a per-row dispatcher (a mixed
        // `connection` registry composed in `@loxep/app`) needs to label an
        // adapter read differently from the entry's own default — see
        // `HealthProbeOutcome.source`'s doc.
        source: outcome.source ?? registryEntry.source,
        checkedAt: now,
        detail: outcome.detail ?? {},
      });
      probed += 1;
      batches[subjectType] = (batches[subjectType] ?? 0) + 1;

      if (!emitNotifications) continue;
      const transition = await publishHealthTransition({
        db,
        subjectType,
        subjectId: candidate.subjectId,
        previousStatus: before?.status ?? null,
        status: outcome.status,
        occurredAt: now,
        detail: outcome.detail ?? {},
        enqueue: options.enqueue,
        logger: options.logger,
      });
      if (transition !== null) transitions.push(transition);
    }
  }

  return {
    checkedTypes,
    scanned,
    due,
    probed,
    more,
    cleared,
    failed,
    batches,
    transitions,
  };
}

/**
 * Record (and optionally route) one health transition as a `health`-class
 * notification event.
 *
 * Notifiability is decided in two places, both of them narrow on purpose:
 * {@link NOTIFIABLE_HEALTH_SUBJECT_TYPES} excludes every companion-tool (fleet)
 * subject per the fleet design's open question 1, and
 * {@link healthTransitionEventType} excludes `unknown` in either direction.
 *
 * A notification problem never fails the sweep: the health row is already
 * written and correct, and the sweep's job is health, not delivery. Failures
 * are logged and the pass continues — the same rule the market bridge follows.
 */
async function publishHealthTransition(input: {
  db: LoxepDb;
  subjectType: HealthSubjectType;
  subjectId: string;
  previousStatus: HealthStatus | null;
  status: HealthStatus;
  occurredAt: Date;
  detail: Record<string, unknown>;
  enqueue?: NotificationEnqueue;
  logger?: { warn: (obj: Record<string, unknown>, msg: string) => void };
}): Promise<HealthTransition | null> {
  const notifiable = (
    NOTIFIABLE_HEALTH_SUBJECT_TYPES as readonly string[]
  ).includes(input.subjectType);
  if (!notifiable) return null;
  const eventType = healthTransitionEventType(
    input.previousStatus,
    input.status,
  );
  if (eventType === null || input.previousStatus === null) return null;

  try {
    const published = await publishNotificationEvent({
      executor: input.db,
      enqueue: input.enqueue,
      event: {
        eventClass: "health",
        eventType,
        subjectType: input.subjectType as NotificationSubjectType,
        subjectId: input.subjectId,
        occurredAt: input.occurredAt,
        payload: {
          subjectType: input.subjectType,
          previousStatus: input.previousStatus,
          status: input.status,
          // `detail` is already guaranteed credential-free: `guardHealthDetail`
          // REJECTS (never redacts) body/header/response/payload keys before a
          // health row is written at all.
          detail: input.detail,
        },
        deduplicationKey: `health:${input.subjectType}:${input.subjectId}:${eventType}:${input.occurredAt.toISOString()}`,
      },
    });
    return {
      subjectType: input.subjectType,
      subjectId: input.subjectId,
      previousStatus: input.previousStatus,
      status: input.status,
      eventType,
      recorded: published.created,
      endpointIds: published.endpointIds,
    };
  } catch (error) {
    input.logger?.warn(
      {
        subjectType: input.subjectType,
        subjectId: input.subjectId,
        error: error instanceof Error ? error.message : String(error),
      },
      "health transition notification failed; health row is unaffected",
    );
    return null;
  }
}

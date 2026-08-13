/**
 * `integration_health` service (shared foundation, ADR/Phase 8 milestone 1,
 * loxep-ovj.1). Full design: apps/docs/src/content/docs/architecture/
 * fleet-observability-design.md.
 *
 * This module owns the ROW, not the probing. `upsertHealth` is the single
 * write path every probe (and, in a later phase, every adapter/ingest/report
 * source) goes through, so the transition rule below is enforced exactly
 * once rather than once per caller:
 *
 * ```text
 * status = 'ok'       consecutive_failures := 0
 *                      last_success_at := checked_at
 *                      last_failure_at unchanged
 * status != 'ok'       consecutive_failures := previous + 1 (or 1 if none)
 *                      last_failure_at := checked_at
 *                      last_success_at unchanged
 * ```
 *
 * `(status = 'ok') = (consecutive_failures = 0)` is a database CHECK, so a
 * caller cannot even attempt the two together in a way that would violate it.
 *
 * ## This table NEVER drives retry or backoff (tested)
 *
 * `upsertHealth` writes exactly one row, keyed by `(subject_type,
 * subject_id)`, and touches NOTHING else — no `connections` row, no
 * `monitor_targets` row, no `managed_domains` row. The owning tables' own
 * error/backoff columns (`connections.last_error_at`,
 * `monitor_targets.backoff_until`/`consecutive_errors`, and later
 * `managed_domains`' own columns) stay authoritative for their own subject's
 * retry behavior; this table is a derived rollup for display and attention.
 *
 * ## `detail` is guarded, not just documented
 *
 * The design requires `detail` never carry a provider response body, a
 * header, or credential material. Rather than trust every future probe to
 * remember that, `upsertHealth` enforces it: `detail` is passed through
 * {@link redactJson} (the same sensitive-key scan `@loxep/domain`'s audit
 * pipeline uses) and rejected outright — not silently redacted — if a
 * sensitive key would have been touched, plus a small explicit list of
 * raw-payload-shaped keys (`body`, `headers`, `response`, `html`) that are
 * not secret-shaped but are exactly the "response body"/"header" the design
 * names. A probe that trips this has a bug, and a thrown
 * {@link DomainValidationError} at write time is a better place to find that
 * than a leaked header in a rendered dashboard.
 */
import { integrationHealth } from "@loxep/db/schema";
import type { LoxepDb } from "@loxep/db";
import { DomainValidationError } from "./errors.ts";
import { redactJson } from "./redact.ts";
import { uuidLiteral } from "./sql.ts";

export const HEALTH_SUBJECT_TYPES = [
  "connection",
  "notification_endpoint",
  "storage_backend",
  "external_resource",
  "hosting_target",
  "managed_domain",
] as const;
export type HealthSubjectType = (typeof HEALTH_SUBJECT_TYPES)[number];

export const HEALTH_STATUSES = ["ok", "degraded", "failing", "unknown"] as const;
export type HealthStatus = (typeof HEALTH_STATUSES)[number];

export const HEALTH_SOURCES = ["probe", "adapter", "ingest", "report"] as const;
export type HealthSource = (typeof HEALTH_SOURCES)[number];

/** Raw-payload-shaped keys the redact-key scan does not already catch. */
const FORBIDDEN_DETAIL_KEYS = new Set([
  "body",
  "header",
  "headers",
  "response",
  "rawresponse",
  "html",
  "payload",
]);

function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function containsForbiddenKey(node: unknown): boolean {
  if (Array.isArray(node)) return node.some(containsForbiddenKey);
  if (node !== null && typeof node === "object") {
    for (const [key, value] of Object.entries(node)) {
      if (FORBIDDEN_DETAIL_KEYS.has(normalizeKey(key))) return true;
      if (containsForbiddenKey(value)) return true;
    }
  }
  return false;
}

function deepEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Rejects `detail` outright when it carries a sensitive key (the same scan
 * `redactJson` uses) or a raw-payload-shaped key. Returns the value unchanged
 * otherwise — `detail` is never silently mutated, only refused.
 */
export function guardHealthDetail(
  detail: Record<string, unknown>,
): Record<string, unknown> {
  if (containsForbiddenKey(detail)) {
    throw new DomainValidationError(
      "integration_health.detail must not carry a provider response body, " +
        "a header, or a raw payload — pass a short taxonomy kind and message",
    );
  }
  const redacted = redactJson(detail);
  if (!deepEqual(redacted, detail)) {
    throw new DomainValidationError(
      "integration_health.detail must not carry credential material — a " +
        "sensitive-shaped key was present",
    );
  }
  return detail;
}

export interface HealthRow {
  subjectType: HealthSubjectType;
  subjectId: string;
  status: HealthStatus;
  source: HealthSource;
  checkedAt: Date;
  lastSuccessAt: Date | null;
  lastFailureAt: Date | null;
  consecutiveFailures: number;
  detail: Record<string, unknown>;
  updatedAt: Date;
}

export interface UpsertHealthInput {
  subjectType: HealthSubjectType;
  subjectId: string;
  status: HealthStatus;
  source: HealthSource;
  /** Defaults to now; tests pin it. */
  checkedAt?: Date;
  detail?: Record<string, unknown>;
}

export interface HealthListFilter {
  subjectType?: HealthSubjectType;
  status?: HealthStatus;
}

export interface HealthService {
  /** The one write path every probe/adapter/ingest/report source uses. */
  upsertHealth: (input: UpsertHealthInput) => Promise<HealthRow>;
  getHealth: (
    subjectType: HealthSubjectType,
    subjectId: string,
  ) => Promise<HealthRow | null>;
  listHealth: (filter?: HealthListFilter) => Promise<HealthRow[]>;
  /**
   * Deletes the health row for one subject. The owning service calls this in
   * the SAME transaction as deleting the subject itself — `subject_id` is
   * deliberately not a foreign key (see the schema doc), so nothing else
   * clears an orphaned row.
   */
  clearHealthForSubject: (
    subjectType: HealthSubjectType,
    subjectId: string,
  ) => Promise<void>;
}

type HealthRowShape = typeof integrationHealth.$inferSelect;

function toHealthRow(row: HealthRowShape): HealthRow {
  return {
    subjectType: row.subjectType as HealthSubjectType,
    subjectId: row.subjectId,
    status: row.status as HealthStatus,
    source: row.source as HealthSource,
    checkedAt: row.checkedAt,
    lastSuccessAt: row.lastSuccessAt,
    lastFailureAt: row.lastFailureAt,
    consecutiveFailures: row.consecutiveFailures,
    detail: row.detail as Record<string, unknown>,
    updatedAt: row.updatedAt,
  };
}

export function createHealthService(options: { db: LoxepDb }): HealthService {
  const { db } = options;

  async function findExisting(
    subjectType: HealthSubjectType,
    subjectId: string,
  ): Promise<HealthRowShape | undefined> {
    return db.query.integrationHealth.findFirst({
      where: (table, { and, eq }) =>
        and(eq(table.subjectType, subjectType), eq(table.subjectId, subjectId)),
    });
  }

  async function upsertHealth(input: UpsertHealthInput): Promise<HealthRow> {
    if (!HEALTH_SUBJECT_TYPES.includes(input.subjectType)) {
      throw new DomainValidationError(
        `invalid health subject_type "${input.subjectType}"`,
      );
    }
    if (!HEALTH_STATUSES.includes(input.status)) {
      throw new DomainValidationError(`invalid health status "${input.status}"`);
    }
    if (!HEALTH_SOURCES.includes(input.source)) {
      throw new DomainValidationError(`invalid health source "${input.source}"`);
    }
    const detail = guardHealthDetail(input.detail ?? {});
    const checkedAt = input.checkedAt ?? new Date();
    const existing = await findExisting(input.subjectType, input.subjectId);

    const consecutiveFailures =
      input.status === "ok" ? 0 : (existing?.consecutiveFailures ?? 0) + 1;
    const lastSuccessAt =
      input.status === "ok" ? checkedAt : (existing?.lastSuccessAt ?? null);
    const lastFailureAt =
      input.status === "ok" ? (existing?.lastFailureAt ?? null) : checkedAt;

    const rows = await db
      .insert(integrationHealth)
      .values({
        subjectType: input.subjectType,
        subjectId: input.subjectId,
        status: input.status,
        source: input.source,
        checkedAt,
        lastSuccessAt,
        lastFailureAt,
        consecutiveFailures,
        detail,
      })
      .onConflictDoUpdate({
        target: [integrationHealth.subjectType, integrationHealth.subjectId],
        set: {
          status: input.status,
          source: input.source,
          checkedAt,
          lastSuccessAt,
          lastFailureAt,
          consecutiveFailures,
          detail,
          updatedAt: new Date(),
        },
      })
      .returning();
    const row = rows[0];
    if (row === undefined) {
      throw new Error("integration_health upsert returned no row");
    }
    return toHealthRow(row);
  }

  async function getHealth(
    subjectType: HealthSubjectType,
    subjectId: string,
  ): Promise<HealthRow | null> {
    const row = await findExisting(subjectType, subjectId);
    return row === undefined ? null : toHealthRow(row);
  }

  async function listHealth(filter?: HealthListFilter): Promise<HealthRow[]> {
    const rows = await db.query.integrationHealth.findMany({
      where: (table, { and, eq }) => {
        const clauses = [];
        if (filter?.subjectType !== undefined) {
          clauses.push(eq(table.subjectType, filter.subjectType));
        }
        if (filter?.status !== undefined) {
          clauses.push(eq(table.status, filter.status));
        }
        return clauses.length === 0 ? undefined : and(...clauses);
      },
      orderBy: (table, { asc }) => [asc(table.subjectType), asc(table.subjectId)],
    });
    return rows.map(toHealthRow);
  }

  async function clearHealthForSubject(
    subjectType: HealthSubjectType,
    subjectId: string,
  ): Promise<void> {
    if (!HEALTH_SUBJECT_TYPES.includes(subjectType)) {
      throw new DomainValidationError(
        `invalid health subject_type "${subjectType}"`,
      );
    }
    // db.execute + validated literals, not the query builder's `.delete()`:
    // this package takes no direct drizzle-orm dependency (see sql.ts).
    await db.execute(
      `delete from integration_health
        where subject_type = '${subjectType}'
          and subject_id = ${uuidLiteral(subjectId)}`,
    );
  }

  return { upsertHealth, getHealth, listHealth, clearHealthForSubject };
}

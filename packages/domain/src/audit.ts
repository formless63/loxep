/**
 * Redacted audit pipeline over `audit_events` (foundation-schema "Audit
 * events", ADR-0016, ADR-0020).
 *
 * `before`/`after` snapshots and `metadata` are passed through recursive
 * secret redaction before serialization. `actor_user_id` is an intentional
 * non-FK historical identity reference and is stored verbatim.
 *
 * ## Why the reader is a SEPARATE service (loxep-161)
 *
 * `AuditExecutor` (below) is deliberately typed `Pick<LoxepDb, "insert">` —
 * every one of the ~165 call sites across settings/entities/connections/
 * secrets/inventory/counterparties/accounting/infrastructure that appends an
 * audit event holds a value that CANNOT read `audit_events` back, by
 * construction, not by convention. Widening that type to add a `list`
 * verb would quietly hand every one of those 165 call sites read access
 * they never asked for and were never reviewed for. `createAuditReader`
 * is a second factory over its OWN `AuditReaderExecutor` (`Pick<LoxepDb,
 * "query">`) so the two capabilities stay structurally separate: nothing
 * about `createAuditService`'s type changes, and the compile-time proof in
 * `test/audit.test.ts` (a `@ts-expect-error` on treating `AuditExecutor` as
 * readable) keeps it that way. The reader is wired into `/settings/audit`
 * as an admin-only surface (`apps/web/src/server/audit-functions.ts`) —
 * nothing else in the app is meant to call it.
 */
import { auditEvents } from "@loxep/db/schema";
import type { LoxepDb } from "@loxep/db";
import { redactJson } from "./redact.ts";

/**
 * Resource types whose audit snapshots additionally redact `payload` keys:
 * for these resources a payload is secret material by definition.
 */
const SECRET_RESOURCE_TYPES = new Set([
  "application_secret",
  "connection_credential",
]);

/**
 * Minimal executor interface so the service works with both a database
 * handle and an open transaction.
 */
export type AuditExecutor = Pick<LoxepDb, "insert">;

export interface AuditAppendInput {
  actorUserId?: string | null;
  action: string;
  resourceType: string;
  resourceId?: string | null;
  before?: unknown;
  after?: unknown;
  requestId?: string | null;
  metadata?: Record<string, unknown>;
}

export interface AuditService {
  /**
   * Appends one audit event. `before`/`after`/`metadata` are redacted
   * recursively before insertion; callers should still pass metadata-only
   * snapshots for secret resources (defense in depth, not permission).
   */
  append: (input: AuditAppendInput) => Promise<{ id: string }>;
}

export function createAuditService(options: {
  db: AuditExecutor;
}): AuditService {
  const { db } = options;

  async function append(input: AuditAppendInput): Promise<{ id: string }> {
    const redactPayloadKey = SECRET_RESOURCE_TYPES.has(input.resourceType);
    const redact = (value: unknown): unknown =>
      value === undefined ? null : redactJson(value, { redactPayloadKey });

    const rows = await db
      .insert(auditEvents)
      .values({
        occurredAt: new Date(),
        actorUserId: input.actorUserId ?? null,
        action: input.action,
        resourceType: input.resourceType,
        resourceId: input.resourceId ?? null,
        before: redact(input.before),
        after: redact(input.after),
        requestId: input.requestId ?? null,
        metadata: (redactJson(input.metadata ?? {}, {
          redactPayloadKey,
        }) ?? {}) as Record<string, unknown>,
      })
      .returning({ id: auditEvents.id });
    const row = rows[0];
    if (row === undefined) {
      throw new Error("audit append returned no row");
    }
    return row;
  }

  return { append };
}

// -----------------------------------------------------------------------
// Reader (loxep-161) — see the module doc above for why this is a SEPARATE
// service over its own read-only executor type rather than an added verb on
// AuditService.
// -----------------------------------------------------------------------

/** Minimal read-only executor — a database handle or open transaction. */
export type AuditReaderExecutor = Pick<LoxepDb, "query">;

export interface AuditListFilter {
  /** Exact match. `undefined` (the default) applies no actor filter. */
  actorUserId?: string;
  /**
   * Case-insensitive substring match against `resource_type` (e.g.
   * `"secret"` matches both `application_secret` and `connection_credential`)
   * — the vocabulary is ~20 distinct strings across every writer package and
   * genuinely open-ended (a new package can introduce a new resource type
   * without this reader changing), so this is a search, not an enum filter.
   */
  resourceType?: string;
  /** Exact match against `resource_id`. */
  resourceId?: string;
  /** Case-insensitive substring match against `action` (e.g. `"secret"` matches `secret.create`/`secret.rotate`). */
  action?: string;
  /** Inclusive lower bound on `occurred_at`. */
  from?: Date;
  /** Inclusive upper bound on `occurred_at`. */
  to?: Date;
}

export interface AuditListOptions extends AuditListFilter {
  /** Zero-based page index. Defaults to 0. */
  page?: number;
  /** Defaults to {@link DEFAULT_AUDIT_PAGE_SIZE}, capped at {@link MAX_AUDIT_PAGE_SIZE}. */
  pageSize?: number;
}

export interface AuditEventRow {
  id: string;
  occurredAt: Date;
  actorUserId: string | null;
  action: string;
  resourceType: string;
  resourceId: string | null;
  /** Already redacted at write time (see `append` above) — never re-redacted here. */
  before: unknown;
  /** Already redacted at write time (see `append` above) — never re-redacted here. */
  after: unknown;
  requestId: string | null;
  metadata: Record<string, unknown>;
}

export interface AuditListResult {
  events: AuditEventRow[];
  /** Total matching rows across every page, not just the ones returned. */
  total: number;
}

export interface AuditReader {
  /**
   * Newest-first (`occurred_at desc`) paged, filtered read of `audit_events`.
   * Total is a plain count of matching row ids — the same two-pass shape
   * `@loxep/market`'s `listItemEventsPage` already uses at Phase-scale
   * volumes, not a `count(*)` this package's no-direct-drizzle-orm
   * convention (`sql.ts`'s module doc) would otherwise need raw SQL for.
   */
  list: (options?: AuditListOptions) => Promise<AuditListResult>;
}

export const DEFAULT_AUDIT_PAGE_SIZE = 25;
export const MAX_AUDIT_PAGE_SIZE = 200;

function toAuditEventRow(row: typeof auditEvents.$inferSelect): AuditEventRow {
  return {
    id: row.id,
    occurredAt: row.occurredAt,
    actorUserId: row.actorUserId,
    action: row.action,
    resourceType: row.resourceType,
    resourceId: row.resourceId,
    before: row.before ?? null,
    after: row.after ?? null,
    requestId: row.requestId,
    metadata: (row.metadata ?? {}) as Record<string, unknown>,
  };
}

export function createAuditReader(options: {
  db: AuditReaderExecutor;
}): AuditReader {
  const { db } = options;

  async function list(input?: AuditListOptions): Promise<AuditListResult> {
    const page = Math.max(0, Math.trunc(input?.page ?? 0));
    const pageSize = Math.min(
      MAX_AUDIT_PAGE_SIZE,
      Math.max(1, Math.trunc(input?.pageSize ?? DEFAULT_AUDIT_PAGE_SIZE)),
    );
    const actorUserId = input?.actorUserId;
    const resourceType = input?.resourceType;
    const resourceId = input?.resourceId;
    const action = input?.action;
    const from = input?.from;
    const to = input?.to;

    // Duplicated (rather than shared) between the id-count pass and the
    // page pass below — each `findMany` call resolves its own `where`
    // callback's operator types from ITS OWN column selection, and this
    // package takes no direct `drizzle-orm` dependency to type a shared
    // helper against (`@loxep/market`'s `listItemEventsPage` is the same
    // shape for the same reason).
    const idRows = await db.query.auditEvents.findMany({
      where: (table, { and, eq, ilike, gte, lte }) => {
        const clauses = [];
        if (actorUserId !== undefined) clauses.push(eq(table.actorUserId, actorUserId));
        if (resourceType !== undefined) clauses.push(ilike(table.resourceType, `%${resourceType}%`));
        if (resourceId !== undefined) clauses.push(eq(table.resourceId, resourceId));
        if (action !== undefined) clauses.push(ilike(table.action, `%${action}%`));
        if (from !== undefined) clauses.push(gte(table.occurredAt, from));
        if (to !== undefined) clauses.push(lte(table.occurredAt, to));
        return clauses.length === 0 ? undefined : and(...clauses);
      },
      columns: { id: true },
    });
    const total = idRows.length;
    if (total === 0) {
      return { events: [], total };
    }

    const rows = await db.query.auditEvents.findMany({
      where: (table, { and, eq, ilike, gte, lte }) => {
        const clauses = [];
        if (actorUserId !== undefined) clauses.push(eq(table.actorUserId, actorUserId));
        if (resourceType !== undefined) clauses.push(ilike(table.resourceType, `%${resourceType}%`));
        if (resourceId !== undefined) clauses.push(eq(table.resourceId, resourceId));
        if (action !== undefined) clauses.push(ilike(table.action, `%${action}%`));
        if (from !== undefined) clauses.push(gte(table.occurredAt, from));
        if (to !== undefined) clauses.push(lte(table.occurredAt, to));
        return clauses.length === 0 ? undefined : and(...clauses);
      },
      orderBy: (table, { desc }) => [desc(table.occurredAt)],
      limit: pageSize,
      offset: page * pageSize,
    });
    return { events: rows.map(toAuditEventRow), total };
  }

  return { list };
}

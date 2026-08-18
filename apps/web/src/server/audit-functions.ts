/**
 * Server functions for `/settings/audit` (loxep-161) — the first reader over
 * `audit_events`. Every one of the ~165 write call-sites across settings,
 * entities, connections, secrets, inventory, counterparties, accounting, and
 * infrastructure has been append-only until now (see `@loxep/domain`'s
 * `audit.ts` module doc for why the reader is a SEPARATE service from every
 * one of those writers' `AuditExecutor`). This file is the only caller of
 * `getAuditReader()` in the app.
 *
 * Admin-only (ADR-0017): an audit trail is exactly the kind of record a
 * member should not get to browse, so this calls `requireAdmin` even though
 * it only reads.
 *
 * `before`/`after`/`metadata` are already redacted at WRITE time
 * (`createAuditService.append`, `@loxep/domain/redact.ts`) — this handler
 * passes them through unchanged rather than redacting a second time.
 * Verified against the two writers that touch genuinely secret material:
 * `secrets.ts`'s `setSecret` and `connection-credentials.ts`'s equivalent
 * both audit `{ currentVersion, keyVersion }` only — the encrypted
 * ciphertext/nonce/authTag never leave the version row — and additionally
 * fall under `SECRET_RESOURCE_TYPES`, so even an accidental `payload` key
 * would be stripped to `"[REDACTED]"` before the row is ever written.
 */
import { createServerFn } from '@tanstack/react-start';
import { z } from 'zod';

/**
 * JSON-serializable value — matches `admin-functions.ts`'s own `JsonValue`
 * (re-declared rather than imported so this file, per its own module doc,
 * stays the only caller of `getAuditReader()` without also pulling in
 * `admin-functions.ts`'s much larger surface). `AuditReader.list` types
 * `before`/`after` as `unknown` because `@loxep/domain` has no reason to
 * assume a serializable-typed caller — this is where that gets narrowed back
 * down, since a `createServerFn` handler's return type must be provably
 * JSON-serializable.
 */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

/** One page of the audit trail, newest-first. */
export interface AuditEventDto {
  id: string;
  occurredAt: string;
  actorUserId: string | null;
  /**
   * Never blank: the actor's own chosen display name, else their account
   * name, else — when the user row is gone but the historical id survives
   * (ADR-0020 form 2, `actor_user_id` is a deliberate non-FK reference) —
   * the raw id itself, else `"System"` for actions with no actor at all.
   */
  actorDisplayName: string;
  action: string;
  resourceType: string;
  resourceId: string | null;
  /** Already redacted at write time — see this module's doc. */
  before: JsonValue | null;
  /** Already redacted at write time — see this module's doc. */
  after: JsonValue | null;
  requestId: string | null;
  metadata: Record<string, JsonValue>;
}

export interface AuditEventsPageDto {
  events: AuditEventDto[];
  total: number;
  page: number;
  pageSize: number;
}

/** Matches `@loxep/domain`'s `DEFAULT_AUDIT_PAGE_SIZE` — kept as a literal here so this file needs no value import from `@loxep/domain` beyond the dynamic `getAuditReader()` access. */
export const AUDIT_EVENTS_PAGE_SIZE = 25;

const auditEventsFilterInput = z.strictObject({
  actorUserId: z.string().min(1).optional(),
  resourceType: z.string().min(1).optional(),
  resourceId: z.string().min(1).optional(),
  action: z.string().min(1).optional(),
  from: z.iso.datetime().optional(),
  to: z.iso.datetime().optional(),
  page: z.number().int().nonnegative().optional(),
  pageSize: z.number().int().positive().max(200).optional()
});

/**
 * Never blank (loxep-161's own requirement): see {@link AuditEventDto.actorDisplayName}'s doc.
 */
function resolveActorDisplayName(
  actorUserId: string | null,
  user: { name: string; displayName: string | null } | undefined
): string {
  if (user !== undefined) {
    return user.displayName && user.displayName.trim().length > 0 ? user.displayName : user.name;
  }
  return actorUserId ?? 'System';
}

/**
 * Paged, filtered `audit_events` read. Filters are exact (`actorUserId`,
 * `resourceId`) or case-insensitive substring (`resourceType`, `action`) —
 * see `@loxep/domain`'s `AuditListFilter` doc for why each is which — and a
 * `from`/`to` date range, all pushed into `AuditReader.list` server-side
 * (never a client-side filter over an unbounded fetch, per Frontend
 * Standards: this ledger grows forever, unlike the Phase-1-scale tables that
 * fetch everything and filter in the browser).
 */
export const fetchAuditEvents = createServerFn({ method: 'GET' })
  .inputValidator(auditEventsFilterInput)
  .handler(async ({ data }): Promise<AuditEventsPageDto> => {
    const { requireAdmin, getAuditReader, getAdminServices } = await import('@/server/admin');
    await requireAdmin();

    const page = data.page ?? 0;
    const pageSize = data.pageSize ?? AUDIT_EVENTS_PAGE_SIZE;

    const result = await getAuditReader().list({
      actorUserId: data.actorUserId,
      resourceType: data.resourceType,
      resourceId: data.resourceId,
      action: data.action,
      from: data.from ? new Date(data.from) : undefined,
      to: data.to ? new Date(data.to) : undefined,
      page,
      pageSize
    });

    if (result.events.length === 0) {
      return { events: [], total: result.total, page, pageSize };
    }

    // Batch-resolve actor display names for this page's distinct actors —
    // the same `handle.db.query.user` join `infrastructure-functions.ts`'s
    // `lastRuleLifecycleChange` already uses for one id at a time
    // (`findFirst`), batched here across the page (`findMany` + `inArray`)
    // rather than one query per row.
    const actorIds = Array.from(
      new Set(
        result.events.map((event) => event.actorUserId).filter((id): id is string => id !== null)
      )
    );
    const { handle } = getAdminServices();
    const actors =
      actorIds.length === 0
        ? []
        : await handle.db.query.user.findMany({
            where: (table, { inArray }) => inArray(table.id, actorIds),
            columns: { id: true, name: true, displayName: true }
          });
    const actorById = new Map(actors.map((actor) => [actor.id, actor]));

    const events: AuditEventDto[] = result.events.map((event) => ({
      id: event.id,
      occurredAt: event.occurredAt.toISOString(),
      actorUserId: event.actorUserId,
      actorDisplayName: resolveActorDisplayName(
        event.actorUserId,
        event.actorUserId === null ? undefined : actorById.get(event.actorUserId)
      ),
      action: event.action,
      resourceType: event.resourceType,
      resourceId: event.resourceId,
      // `AuditReader.list` types before/after `unknown` on principle
      // (`@loxep/domain` has no serializability contract to prove) — these
      // came out of a `jsonb` column via `createAuditService.append`'s own
      // `redactJson`, so they are JSON-safe by construction.
      before: event.before as JsonValue | null,
      after: event.after as JsonValue | null,
      requestId: event.requestId,
      metadata: event.metadata as Record<string, JsonValue>
    }));

    return { events, total: result.total, page, pageSize };
  });

/**
 * Redacted audit pipeline over `audit_events` (foundation-schema "Audit
 * events", ADR-0016, ADR-0020).
 *
 * `before`/`after` snapshots and `metadata` are passed through recursive
 * secret redaction before serialization. `actor_user_id` is an intentional
 * non-FK historical identity reference and is stored verbatim.
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

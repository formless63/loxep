/**
 * `notification_events` — the detection-side ledger of notifiable facts
 * (ADR-0023, weave audit 2026-08 finding 5), designed in full at
 * apps/docs/src/content/docs/architecture/notifications-design.md.
 *
 * ## Why this lives in `@loxep/domain`
 *
 * `@loxep/inventory`, `@loxep/commerce`, and `@loxep/documents` cannot import
 * `@loxep/notifications` — it depends on `@loxep/domain`, and the reverse edge
 * would be a cycle. All of them already depend on this package. So the ledger,
 * the event-class registry, and the routing predicate live here, while
 * endpoints, rules CRUD, transports, renderers, and the `notifications.deliver`
 * task stay in `@loxep/notifications`. It is the same call that put
 * `integration_health` here rather than in the phase that introduced it: a
 * shared foundation table written by many domains belongs with connections,
 * settings, and secrets.
 *
 * ## Detection and delivery stay separate concepts
 *
 * Nothing in event derivation, in `upsertHealth`, or in a domain service sends
 * anything. {@link recordNotificationEvent} writes a fact.
 * {@link routeNotificationEvent} answers "which endpoints, if any, asked about
 * facts like this". {@link publishNotificationEvent} is the one explicit
 * bridge that does both and then enqueues — and its caller supplies the
 * enqueue seam, so a composition that runs without a worker simply passes a
 * recorder.
 *
 * ## At-least-once safety
 *
 * Every emitter supplies a `deduplicationKey`; the insert is `ON CONFLICT DO
 * NOTHING` on the table's UNIQUE constraint. A re-run of an at-least-once
 * handler records nothing, routes nothing, and enqueues nothing, so it cannot
 * notify twice — the same property `market_events.deduplication_key` gives
 * event derivation.
 *
 * ## Transactional enqueue
 *
 * {@link createTransactionalNotificationEnqueue} issues
 * `graphile_worker.add_job` through whatever executor it is given, so passing
 * a `tx` really does make the enqueue part of that transaction and a rollback
 * takes the job with it. `@loxep/jobs`' own `addJob` takes a POOL and opens
 * its own connection, which is precisely the shape that silently loses
 * atomicity — the same reasoning, and the same seam shape, as
 * `@loxep/infrastructure`'s `createTransactionalEnqueue`.
 */
import {
  MARKET_EVENT_TYPES,
  NOTIFICATION_EVENT_CLASSES,
  NOTIFICATION_SUBJECT_TYPES,
  notificationEvents,
} from "@loxep/db/schema";
import type { LoxepDb } from "@loxep/db";
import type {
  NotificationEventClass,
  NotificationSubjectType,
} from "@loxep/db/schema";
import { DomainValidationError } from "./errors.ts";
import { jsonbLiteral, textLiteral, uuidLiteral } from "./sql.ts";

export {
  MARKET_EVENT_TYPES,
  NOTIFICATION_EVENT_CLASSES,
  NOTIFICATION_SUBJECT_TYPES,
};
export type { NotificationEventClass, NotificationSubjectType };

export type NotificationEventRow = typeof notificationEvents.$inferSelect;

/**
 * Works against a database handle or an open transaction. Reads go through
 * `execute` rather than the relational query API precisely so a `tx` can be
 * passed (the same reason `AuditExecutor` narrows to `insert`).
 */
export type NotificationEventExecutor = Pick<LoxepDb, "execute">;

/**
 * The `notifications.deliver` task name, re-declared here rather than
 * depending on `@loxep/notifications` (or on `@loxep/jobs`) just to build a
 * string — `@loxep/infrastructure`'s `domainJobKey` sets the precedent.
 * `@loxep/notifications` imports this constant instead of writing its own, so
 * the two cannot drift.
 */
export const NOTIFICATION_DELIVER_TASK = "notifications.deliver";

/** `jobKeyFor("notifications.deliver", "<event>:<endpoint>")`, re-declared. */
export function notificationDeliverJobKey(
  notificationEventId: string,
  endpointId: string,
): string {
  return `${NOTIFICATION_DELIVER_TASK}:${notificationEventId}:${endpointId}`;
}

/**
 * Health subjects whose transitions may become notifications: Loxep's OWN
 * integration subjects, and only those.
 *
 * The fleet subjects (`external_resource`, `hosting_target`,
 * `managed_domain`) are excluded on purpose — the fleet observability design's
 * open question 1 resolved against routing companion-tool alerts through
 * Loxep (Beszel and Gatus already alert their operators through ntfy; Loxep
 * relaying them adds a hop, a failure mode, and a dependency on the machine
 * being reported on). This constant is the structural form of that ruling:
 * the fleet design's standing assertion that no fleet probe writes a
 * `notification_deliveries` row now holds by construction.
 */
export const NOTIFIABLE_HEALTH_SUBJECT_TYPES = [
  "connection",
  "notification_endpoint",
  "storage_backend",
] as const;
export type NotifiableHealthSubjectType =
  (typeof NOTIFIABLE_HEALTH_SUBJECT_TYPES)[number];

/** Health transition event types. See the registry note on `unknown`. */
export const HEALTH_EVENT_TYPES = [
  "health_degraded",
  "health_recovered",
] as const;

export const PURCHASE_EVENT_TYPES = ["purchase_ingested"] as const;
export const DOCUMENT_EVENT_TYPES = ["document_confirmed"] as const;
export const SALE_EVENT_TYPES = ["manual_sale_recorded"] as const;

/** One registered event class: what it is about, and what it may say. */
export interface NotificationEventClassDefinition {
  readonly eventClass: NotificationEventClass;
  readonly label: string;
  readonly description: string;
  /** Subject tables a row of this class may point at. */
  readonly subjectTypes: readonly NotificationSubjectType[];
  /** The `(class, type)` pairs this class permits. */
  readonly eventTypes: readonly string[];
  /** False while a class is seeded in the CHECK but nothing emits it yet. */
  readonly wired: boolean;
}

/**
 * The registered event classes: closed union plus per-class config, the same
 * shape monitor-target registration uses. This — not a database CHECK — is
 * what makes `(class, type, subject_type)` a valid triple, so adding a type to
 * a shipped class is a registry entry rather than a migration, while the
 * coarse dimensions a rule filters on stay database-enforced.
 *
 * `/settings/notifications` renders its class and type pickers from this
 * registry, so the UI cannot offer a combination {@link recordNotificationEvent}
 * would reject.
 */
export const notificationEventClasses: Record<
  NotificationEventClass,
  NotificationEventClassDefinition
> = {
  market: {
    eventClass: "market",
    label: "Market",
    description:
      "Price, quantity, availability, and discovery changes derived from marketplace observations.",
    subjectTypes: ["market_event"],
    eventTypes: MARKET_EVENT_TYPES,
    wired: true,
  },
  purchase: {
    eventClass: "purchase",
    label: "Purchases",
    description:
      "Marketplace purchases ingested as draft acquisitions awaiting intake.",
    subjectTypes: ["acquisition"],
    eventTypes: PURCHASE_EVENT_TYPES,
    wired: true,
  },
  document: {
    eventClass: "document",
    label: "Documents",
    description: "Uploaded documents reaching a confirmed state.",
    subjectTypes: ["document"],
    eventTypes: DOCUMENT_EVENT_TYPES,
    wired: true,
  },
  sale: {
    eventClass: "sale",
    label: "Sales",
    description: "Sales recorded against a listing.",
    subjectTypes: ["order"],
    eventTypes: SALE_EVENT_TYPES,
    wired: true,
  },
  health: {
    eventClass: "health",
    label: "Integration health",
    description:
      "Loxep's own connections, notification endpoints, and storage backends changing health status. Companion-tool (fleet) subjects are deliberately excluded — their own alerting already reaches the operator.",
    subjectTypes: NOTIFIABLE_HEALTH_SUBJECT_TYPES,
    eventTypes: HEALTH_EVENT_TYPES,
    wired: true,
  },
  infrastructure: {
    eventClass: "infrastructure",
    label: "Infrastructure",
    description:
      "DNS drift and reconciler outcomes. Seeded in the schema CHECK ahead of the phase that emits it; nothing writes this class yet.",
    subjectTypes: ["managed_domain", "reconcile_run", "hosting_target"],
    eventTypes: [],
    wired: false,
  },
};

/** Class/type options for a picker, in registry order. */
export function notificationEventTypeOptions(
  eventClass: NotificationEventClass,
): readonly string[] {
  return notificationEventClasses[eventClass].eventTypes;
}

export interface RecordNotificationEventInput {
  eventClass: NotificationEventClass;
  eventType: string;
  subjectType: NotificationSubjectType;
  subjectId: string;
  /** Market only; the one narrowing dimension a rule can filter on. */
  monitorTargetId?: string | null;
  occurredAt: Date;
  /**
   * The render input: a small, Loxep-owned set of facts. Never a provider
   * response body, a header, or credential material.
   */
  payload?: Record<string, unknown>;
  /** Mandatory. See the module doc's at-least-once section. */
  deduplicationKey: string;
}

/**
 * The enqueue seam. The implementation MUST issue its insert through the same
 * executor it is given; production wires
 * {@link createTransactionalNotificationEnqueue} and tests wire
 * {@link createRecordingNotificationEnqueue}.
 */
export type NotificationEnqueue = (
  executor: NotificationEventExecutor,
  taskName: string,
  payload: Record<string, unknown>,
  options?: { jobKey?: string; jobKeyMode?: "replace" | "preserve_run_at" },
) => Promise<void>;

/** See the module doc: enqueue through the caller's executor, not a pool. */
export function createTransactionalNotificationEnqueue(): NotificationEnqueue {
  return async (executor, taskName, payload, options) => {
    const jobKey =
      options?.jobKey === undefined ? "null" : textLiteral(options.jobKey);
    const jobKeyMode = textLiteral(options?.jobKeyMode ?? "replace");
    await executor.execute(
      `select graphile_worker.add_job(
         ${textLiteral(taskName)},
         payload => ${jsonbLiteral(payload)}::json,
         job_key => ${jobKey},
         job_key_mode => ${jobKeyMode}
       )`,
    );
  };
}

/**
 * An enqueue that records instead of enqueueing — for tests and for any
 * composition that deliberately runs without a worker schema.
 */
export function createRecordingNotificationEnqueue(): NotificationEnqueue & {
  readonly calls: Array<{
    taskName: string;
    payload: Record<string, unknown>;
    jobKey: string | undefined;
  }>;
} {
  const calls: Array<{
    taskName: string;
    payload: Record<string, unknown>;
    jobKey: string | undefined;
  }> = [];
  const enqueue = (async (_executor, taskName, payload, options) => {
    calls.push({ taskName, payload, jobKey: options?.jobKey });
  }) as NotificationEnqueue & { calls: typeof calls };
  Object.defineProperty(enqueue, "calls", { value: calls, enumerable: true });
  return enqueue;
}

function validate(input: RecordNotificationEventInput): void {
  const definition = notificationEventClasses[input.eventClass] as
    | NotificationEventClassDefinition
    | undefined;
  if (definition === undefined) {
    throw new DomainValidationError(
      `unknown notification event class "${input.eventClass}" (registered: ${NOTIFICATION_EVENT_CLASSES.join(", ")})`,
    );
  }
  if (!definition.eventTypes.includes(input.eventType)) {
    throw new DomainValidationError(
      `event type "${input.eventType}" is not registered for notification class "${input.eventClass}" (registered: ${definition.eventTypes.join(", ") || "none"})`,
    );
  }
  if (!definition.subjectTypes.includes(input.subjectType)) {
    throw new DomainValidationError(
      `subject type "${input.subjectType}" is not valid for notification class "${input.eventClass}" (valid: ${definition.subjectTypes.join(", ")})`,
    );
  }
  if (input.deduplicationKey.trim().length === 0) {
    throw new DomainValidationError(
      "notification events require a non-empty deduplication key",
    );
  }
}

function timestampLiteral(value: Date): string {
  if (Number.isNaN(value.getTime())) {
    throw new DomainValidationError("invalid notification event timestamp");
  }
  return `${textLiteral(value.toISOString())}::timestamptz`;
}

/**
 * Record one notifiable fact. Returns the row plus whether THIS call created
 * it — `created: false` means a duplicate key already recorded the same fact,
 * which is the at-least-once no-op path, not an error.
 */
export async function recordNotificationEvent(
  executor: NotificationEventExecutor,
  input: RecordNotificationEventInput,
): Promise<{ event: NotificationEventRow; created: boolean }> {
  validate(input);
  const monitorTargetId =
    input.monitorTargetId == null ? "null" : uuidLiteral(input.monitorTargetId);
  const inserted = await executor.execute<NotificationEventRow>(
    `insert into notification_events (
       event_class, event_type, subject_type, subject_id, monitor_target_id,
       occurred_at, payload, deduplication_key
     ) values (
       ${textLiteral(input.eventClass)},
       ${textLiteral(input.eventType)},
       ${textLiteral(input.subjectType)},
       ${uuidLiteral(input.subjectId)},
       ${monitorTargetId},
       ${timestampLiteral(input.occurredAt)},
       ${jsonbLiteral(input.payload ?? {})},
       ${textLiteral(input.deduplicationKey)}
     )
     on conflict (deduplication_key) do nothing
     returning *`,
  );
  const created = inserted.rows[0];
  if (created !== undefined) {
    return { event: normalizeRow(created), created: true };
  }
  const existing = await executor.execute<NotificationEventRow>(
    `select * from notification_events
      where deduplication_key = ${textLiteral(input.deduplicationKey)}`,
  );
  const row = existing.rows[0];
  if (row === undefined) {
    throw new DomainValidationError(
      `notification event "${input.deduplicationKey}" vanished between insert and read`,
    );
  }
  return { event: normalizeRow(row), created: false };
}

/**
 * `execute` returns raw driver rows (snake_case, string timestamps). Normalize
 * to the Drizzle row shape so callers see one type regardless of path.
 */
function normalizeRow(row: Record<string, unknown>): NotificationEventRow {
  const raw = row as unknown as Record<string, unknown>;
  const pick = (camel: string, snake: string): unknown =>
    raw[camel] !== undefined ? raw[camel] : raw[snake];
  const date = (value: unknown): Date =>
    value instanceof Date ? value : new Date(String(value));
  return {
    id: String(pick("id", "id")),
    eventClass: String(pick("eventClass", "event_class")),
    eventType: String(pick("eventType", "event_type")),
    subjectType: String(pick("subjectType", "subject_type")),
    subjectId: String(pick("subjectId", "subject_id")),
    monitorTargetId:
      pick("monitorTargetId", "monitor_target_id") == null
        ? null
        : String(pick("monitorTargetId", "monitor_target_id")),
    occurredAt: date(pick("occurredAt", "occurred_at")),
    payload: pick("payload", "payload") ?? {},
    deduplicationKey: String(pick("deduplicationKey", "deduplication_key")),
    createdAt: date(pick("createdAt", "created_at")),
  } as NotificationEventRow;
}

/** The facts routing needs — a {@link NotificationEventRow} satisfies it. */
export interface RoutableNotificationEvent {
  eventClass: string;
  eventType: string;
  monitorTargetId: string | null;
}

/**
 * Enabled rules matching an event, and the distinct endpoints they name.
 *
 * The predicate is the shipped one, generalized by exactly one column: the
 * class must match (there is no "any class" wildcard), `event_type` matches or
 * is NULL (any type in the class), and `monitor_target_id` matches or is NULL
 * (any target) — with an event that has no monitor target matching only
 * monitor-agnostic rules, unchanged. Rules ordered by creation, as before.
 */
export async function routeNotificationEvent(
  executor: NotificationEventExecutor,
  event: RoutableNotificationEvent,
): Promise<{ ruleIds: string[]; endpointIds: string[] }> {
  const monitorClause =
    event.monitorTargetId === null
      ? "monitor_target_id is null"
      : `(monitor_target_id is null or monitor_target_id = ${uuidLiteral(event.monitorTargetId)})`;
  const result = await executor.execute<{
    id: string;
    endpoint_id: string;
  }>(
    `select id, endpoint_id
       from notification_rules
      where enabled = true
        and event_class = ${textLiteral(event.eventClass)}
        and (event_type is null or event_type = ${textLiteral(event.eventType)})
        and ${monitorClause}
      order by created_at asc, id asc`,
  );
  const ruleIds: string[] = [];
  const endpointIds: string[] = [];
  for (const row of result.rows) {
    const id = String(row["id" as keyof typeof row]);
    const endpointId = String(row["endpoint_id" as keyof typeof row]);
    ruleIds.push(id);
    if (!endpointIds.includes(endpointId)) endpointIds.push(endpointId);
  }
  return { ruleIds, endpointIds };
}

export interface PublishNotificationEventOptions {
  executor: NotificationEventExecutor;
  event: RecordNotificationEventInput;
  /**
   * Omit to record without routing (detection only). Supply the seam to make
   * this the explicit detection→delivery bridge.
   */
  enqueue?: NotificationEnqueue;
}

/**
 * The explicit bridge: record the fact, then — only if this call created it —
 * route it and enqueue one `notifications.deliver` job per matched endpoint.
 *
 * Routing is short-circuited before the seam is touched, so an installation
 * with no matching enabled rule performs no enqueue at all (which is also why
 * a service running against a database with no `graphile_worker` schema
 * records its event and does nothing else).
 */
export async function publishNotificationEvent(
  options: PublishNotificationEventOptions,
): Promise<{
  event: NotificationEventRow;
  created: boolean;
  endpointIds: string[];
}> {
  const { executor, enqueue } = options;
  const { event, created } = await recordNotificationEvent(
    executor,
    options.event,
  );
  if (!created || enqueue === undefined) {
    return { event, created, endpointIds: [] };
  }
  const { endpointIds } = await routeNotificationEvent(executor, event);
  for (const endpointId of endpointIds) {
    await enqueue(
      executor,
      NOTIFICATION_DELIVER_TASK,
      { notificationEventId: event.id, endpointId },
      { jobKey: notificationDeliverJobKey(event.id, endpointId) },
    );
  }
  return { event, created, endpointIds };
}

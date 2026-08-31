/**
 * Fleet alert evidence ingestion — the composition root (Phase 8 milestone
 * 7, loxep-ovj.7). Full design: apps/docs/src/content/docs/architecture/
 * fleet-observability-design.md, "Evidence ingestion, if it ships"; open
 * question 4 (owner-approved).
 *
 * ```text
 * POST /api/v1/hooks/fleet/:connectionId          apps/web route (thin)
 *      -> verifyFleetIngestToken                  uniform result, normalized work
 *      -> receiveFleetEvidence                    THIS module
 *           -> provider dispatch (never in the receiver — see below)
 *           -> ONE source_events row               (existing table, no new schema)
 *           -> enqueue integration-health.project-ingest-evidence, IN THE
 *              SAME TRANSACTION as the source_events insert
 *      -> 202 (always) / 401 (auth) / 413 (size) / 429 (rate) / 400 (not JSON)
 *
 * integration-health.project-ingest-evidence       Graphile Worker task, THIS module
 *      -> health.upsertHealth({subjectType:'connection', source:'ingest'})
 *      -> marks the source_events row processed/failed
 * ```
 *
 * ## Why the normalizer dispatch lives here, not in `@loxep/domain`
 *
 * `@loxep/domain` takes no integration-package dependency (the same rule
 * `health-probes.ts`'s module doc states for the sweep). Gatus's and
 * Beszel's normalizers live at their own integration boundary
 * (`@loxep/integration-gatus`/`@loxep/integration-beszel`'s `webhook.ts`),
 * per the design's explicit rule: "one small normalizer per provider, at the
 * integration boundary, never in the receiver." `@loxep/app` already depends
 * on every integration package (it is where every other fleet adapter is
 * dispatched from — see `fleet-health.ts`), so it is the correct, and only
 * possible, place to route a connection's `provider` to the right one.
 * `databasus`/`generic` route to `@loxep/domain`'s own
 * `normalizeGenericEvidenceWebhook` — the one normalizer that genuinely has
 * no provider-specific shape to own.
 *
 * ## `notification_deliveries` is never touched — checked structurally
 *
 * Nothing below imports `@loxep/notifications` or calls
 * `publishNotificationEvent`/`recordNotificationEvent`. This is the design's
 * hardest rule (open question 1: Loxep never becomes the delivery path for
 * infrastructure alerts) made true by construction, the same way
 * `fleet-health.ts`'s module doc states its OWN "no fleet probe writes a
 * notification_deliveries row" rule and `notification-events.ts`'s
 * `NOTIFIABLE_HEALTH_SUBJECT_TYPES` enforces it for `health.sweep`'s
 * transitions. `test/fleet-evidence.test.ts` asserts this by inspecting the
 * module's own import graph is unnecessary discipline — asserting the
 * DATABASE effect (no row in `notification_deliveries` after a full ingest
 * round-trip) is the honest, harder-to-drift test.
 *
 * ## Idempotency
 *
 * The projection task's job key is `<task>:<sourceEventId>` with
 * `job_key_mode: 'replace'` — a redelivered job re-runs the SAME
 * `upsertHealth` call (itself idempotent by `(subject_type, subject_id)`)
 * and re-marks the same `source_events` row, never duplicating anything.
 */
import { createHash, timingSafeEqual } from "node:crypto";
import { sourceEvents } from "@loxep/db/schema";
import type { LoxepDb } from "@loxep/db";
import {
  ConnectionNotFoundError,
  createHealthService,
  EVIDENCE_INGEST_CONNECTION_KIND,
  gatusPushSetting,
  guardHealthDetail,
  isFleetEvidenceProvider,
  normalizeGenericEvidenceWebhook,
} from "@loxep/domain";
import type {
  Connection,
  ConnectionCredentialsService,
  ConnectionsService,
  HealthStatus,
  NotificationEnqueue,
  SettingsService,
} from "@loxep/domain";
import { normalizeBeszelAlertWebhook } from "@loxep/integration-beszel";
import { normalizeGatusAlertWebhook } from "@loxep/integration-gatus";
import { defineTask } from "@loxep/jobs";
import type { LoxepTask } from "@loxep/jobs";
import { z } from "zod";
import type { AppServices } from "./services.ts";

export const FLEET_EVIDENCE_INGEST_TASK =
  "integration-health.project-ingest-evidence";

/** `graphile_worker.add_job`'s `job_key`: idempotent per source event. */
export function fleetEvidenceIngestJobKey(sourceEventId: string): string {
  return `${FLEET_EVIDENCE_INGEST_TASK}:${sourceEventId}`;
}

// ---------------------------------------------------------------------------
// Token verification — uniform failure result, normalized dependency work
// ---------------------------------------------------------------------------

/**
 * Fixed substitutes used when an untrusted request cannot supply a usable
 * lookup id or stored token. A malformed id is never sent to PostgreSQL as a
 * UUID, but still performs both service lookups against a value the normal
 * connection API cannot create. Every authentication attempt also performs
 * the hash comparison below.
 *
 * This is work-shape normalization, not a claim of identical wall-clock
 * timing: a real credential lookup necessarily includes version lookup and
 * decryption, while a missing row cannot. Persisting a dummy encrypted
 * credential just to erase that distinction would add mutable security state
 * and another lifecycle invariant. Callers must therefore expose only the
 * uniform `{ ok: false }` result and must not describe its cause.
 */
const DUMMY_INGEST_TOKEN = "loxep-fleet-evidence-dummy-comparison-token";
const DUMMY_CONNECTION_ID = "00000000-0000-0000-0000-000000000000";
const connectionIdSchema = z.uuid();

export interface VerifyFleetIngestTokenOptions {
  connections: ConnectionsService;
  connectionCredentials: ConnectionCredentialsService;
  connectionId: string;
  presentedToken: string;
}

export type VerifyFleetIngestTokenResult =
  | { ok: true; connection: Connection }
  | { ok: false };

/**
 * Verify a presented bearer token against `connectionId`'s
 * `fleet_ingest_token` credential. A malformed id, bad token, unknown
 * connection, missing credential, and connection of the wrong kind all
 * return `{ ok: false }` with no further detail. Both dependency lookups and
 * the fixed-length digest comparison run for every one of those classes; the
 * caller must render the identical HTTP response for every `ok: false`.
 */
export async function verifyFleetIngestToken(
  options: VerifyFleetIngestTokenOptions,
): Promise<VerifyFleetIngestTokenResult> {
  const parsedConnectionId = connectionIdSchema.safeParse(options.connectionId);
  const lookupConnectionId = parsedConnectionId.success
    ? parsedConnectionId.data
    : DUMMY_CONNECTION_ID;

  let connection: Connection | null = null;
  try {
    connection = await options.connections.getConnection(lookupConnectionId);
  } catch (error) {
    // Matched by name as well as identity: in the built app the web bundle
    // constructs the connections service against its own bundled copy of
    // @loxep/domain while this dynamically-imported module compares against
    // the node_modules copy, so `instanceof` alone fails exactly and only in
    // production. DomainError stamps `name` from `new.target`, which survives
    // duplication.
    const isNotFound =
      error instanceof ConnectionNotFoundError ||
      (error instanceof Error && error.name === "ConnectionNotFoundError");
    if (!isNotFound) throw error;
    connection = null;
  }

  let storedToken: string | null = null;
  try {
    const credential = await options.connectionCredentials.getCredentialPayload(
      lookupConnectionId,
      "fleet_ingest_token",
    );
    storedToken = credential.payload.token;
  } catch {
    storedToken = null;
  }

  const expected = createHash("sha256")
    .update(storedToken ?? DUMMY_INGEST_TOKEN, "utf8")
    .digest();
  const actual = createHash("sha256")
    .update(options.presentedToken, "utf8")
    .digest();
  const tokenMatches = timingSafeEqual(expected, actual);

  if (
    !tokenMatches ||
    storedToken === null ||
    !parsedConnectionId.success ||
    connection === null ||
    connection.kind !== EVIDENCE_INGEST_CONNECTION_KIND
  ) {
    return { ok: false };
  }
  return { ok: true, connection };
}

// ---------------------------------------------------------------------------
// Provider dispatch — never in the receiver route
// ---------------------------------------------------------------------------

interface NormalizedAccepted {
  drop: false;
  eventType: string;
  externalEventId: string | null;
  occurredAt: Date;
  status: HealthStatus;
  detail: Record<string, unknown>;
}
interface NormalizedDropped {
  drop: true;
  reason: "invalid_payload" | "feedback_latch" | "unrecognized_provider";
  detailMessage: string;
}
type Normalized = NormalizedAccepted | NormalizedDropped;

async function normalizeForProvider(options: {
  settings: SettingsService;
  provider: string;
  payload: unknown;
  receivedAt: Date;
}): Promise<Normalized> {
  const { provider, payload, receivedAt } = options;

  if (provider === "gatus") {
    const push = await options.settings.get(gatusPushSetting);
    return normalizeGatusAlertWebhook(payload, {
      heartbeatEndpointKey: push.endpointKey,
      receivedAt,
    }) as Normalized;
  }
  if (provider === "beszel") {
    return normalizeBeszelAlertWebhook(payload, { receivedAt }) as Normalized;
  }
  if (isFleetEvidenceProvider(provider)) {
    // 'databasus' | 'generic' — the one shape with no provider-specific
    // schema of its own.
    return normalizeGenericEvidenceWebhook(payload, {
      receivedAt,
    }) as Normalized;
  }
  return {
    drop: true,
    reason: "unrecognized_provider",
    detailMessage: `connection provider "${provider}" has no registered evidence normalizer`,
  };
}

// ---------------------------------------------------------------------------
// receiveFleetEvidence — the write path
// ---------------------------------------------------------------------------

export interface ReceiveFleetEvidenceOptions {
  db: LoxepDb;
  settings: SettingsService;
  connection: Connection;
  /** The exact bytes received, already rate-limited and size-capped by the caller. */
  rawBody: string;
  /** Production wires `createTransactionalNotificationEnqueue()`; tests wire a recorder. */
  enqueue: NotificationEnqueue;
  /** Sweep clock; defaults to now. Tests pin it. */
  now?: Date;
}

export type ReceiveFleetEvidenceResult =
  | {
      /** `null` only when the body was not valid JSON at all — no row was written. */
      sourceEventId: string;
      dropped: boolean;
      reason?: "invalid_payload" | "feedback_latch" | "unrecognized_provider";
    }
  | { sourceEventId: null; dropped: true; reason: "invalid_payload" };

/**
 * Receive one authenticated webhook body: dispatch it to the right
 * normalizer, write ONE `source_events` row (the existing inbound
 * provenance envelope — see the module doc), and — only when the normalizer
 * did not drop it — enqueue the health projection in the SAME transaction.
 *
 * The caller (the `apps/web` route) has already verified the bearer token
 * and enforced the rate limit and size cap; this function assumes `rawBody`
 * is trusted-to-be-bounded but NOT trusted to be valid JSON or to match any
 * provider's schema — that is exactly what it is here to determine.
 */
export async function receiveFleetEvidence(
  options: ReceiveFleetEvidenceOptions,
): Promise<ReceiveFleetEvidenceResult> {
  const { db, connection, rawBody, enqueue } = options;
  const now = options.now ?? new Date();

  let payload: unknown;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    // Not valid JSON at all: nothing structural to record (the `payload`
    // column is `jsonb not null`) and nothing a provider-specific normalizer
    // could ever have accepted. The route handler answers 400.
    return { sourceEventId: null, dropped: true, reason: "invalid_payload" };
  }

  const normalized = await normalizeForProvider({
    settings: options.settings,
    provider: connection.provider,
    payload,
    receivedAt: now,
  });

  const payloadHash = createHash("sha256").update(rawBody, "utf8").digest("hex");

  return db.transaction(async (tx) => {
    const inserted = await tx
      .insert(sourceEvents)
      .values({
        connectionId: connection.id,
        provider: connection.provider,
        eventType: normalized.drop ? "evidence_dropped" : normalized.eventType,
        externalEventId: normalized.drop ? null : normalized.externalEventId,
        occurredAt: normalized.drop ? null : normalized.occurredAt,
        receivedAt: now,
        payload: payload as object,
        payloadHash,
        processingStatus: normalized.drop ? "dropped" : "received",
        lastError: normalized.drop
          ? `${normalized.reason}: ${normalized.detailMessage}`
          : null,
      })
      .returning({ id: sourceEvents.id });
    const row = inserted[0];
    if (row === undefined) {
      throw new Error("fleet evidence source_events insert returned no row");
    }

    if (!normalized.drop) {
      const detail = guardHealthDetail(normalized.detail);
      await enqueue(
        tx,
        FLEET_EVIDENCE_INGEST_TASK,
        {
          sourceEventId: row.id,
          connectionId: connection.id,
          status: normalized.status,
          detail,
        },
        {
          jobKey: fleetEvidenceIngestJobKey(row.id),
          jobKeyMode: "replace",
        },
      );
    }

    return normalized.drop
      ? { sourceEventId: row.id, dropped: true, reason: normalized.reason }
      : { sourceEventId: row.id, dropped: false };
  });
}

// ---------------------------------------------------------------------------
// The projection task
// ---------------------------------------------------------------------------

const projectIngestEvidencePayloadSchema = z.object({
  sourceEventId: z.uuid(),
  connectionId: z.uuid(),
  status: z.enum(["ok", "degraded", "failing"]),
  detail: z.record(z.string(), z.unknown()),
});

/** Small, local `db.execute` literal helpers — see `@loxep/domain`'s `sql.ts` doc for why this is redeclared rather than shared across packages. */
function textLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

export interface FleetEvidenceTasks {
  projectIngestEvidenceTask: LoxepTask<typeof projectIngestEvidencePayloadSchema>;
  tasks: readonly LoxepTask<typeof projectIngestEvidencePayloadSchema>[];
}

/**
 * Composition-root wrapper: on-demand only, enqueued transactionally by
 * {@link receiveFleetEvidence} — no cron item, matching
 * `infrastructure.sync-token-policy`'s shape.
 */
export function createFleetEvidenceTasks(options: {
  services: AppServices;
}): FleetEvidenceTasks {
  const { services } = options;
  const health = createHealthService({ db: services.db });

  const projectIngestEvidenceTask = defineTask({
    name: FLEET_EVIDENCE_INGEST_TASK,
    payloadSchema: projectIngestEvidencePayloadSchema,
    handler: async (payload, { logger }) => {
      // Left uncaught deliberately: the source_events row stays 'received'
      // (not 'failed') so a retry re-attempts the SAME projection — the
      // health row failing to write is either a transient DB error worth
      // Graphile's ordinary retry, or a `DomainValidationError` from
      // `guardHealthDetail`'s own guard, which is a bug in a normalizer this
      // task did not itself construct the payload from unsafely (the
      // enqueue side already ran it through the same guard).
      await health.upsertHealth({
        subjectType: "connection",
        subjectId: payload.connectionId,
        status: payload.status,
        source: "ingest",
        detail: payload.detail,
      });

      try {
        await services.db.execute(
          `update source_events
              set processing_status = 'processed', processed_at = now()
            where id = ${textLiteral(payload.sourceEventId)}`,
        );
      } catch (error) {
        // The health row IS written and correct at this point — a failure to
        // mark the source_events row processed is a bookkeeping problem, not
        // a reason to re-run the (already-succeeded, non-idempotent-looking
        // but actually-idempotent) projection. Logged, not thrown.
        logger.warn(
          {
            sourceEventId: payload.sourceEventId,
            error: error instanceof Error ? error.message : String(error),
          },
          "fleet evidence source_events row could not be marked processed",
        );
      }

      logger.info(
        { connectionId: payload.connectionId, status: payload.status },
        "fleet evidence projected into integration_health",
      );
    },
  });

  return { projectIngestEvidenceTask, tasks: [projectIngestEvidenceTask] };
}

/**
 * Fleet alert evidence ingestion (Phase 8 milestone 7, loxep-ovj.7). Full
 * design: apps/docs/src/content/docs/architecture/
 * fleet-observability-design.md, "Evidence ingestion, if it ships"; open
 * question 4 (owner-approved).
 *
 * This module owns the two facts `@loxep/domain` can own without taking an
 * integration-package dependency: the `connections.kind` sentinel that marks
 * a connection as an evidence-only inbound source, and the GENERIC evidence
 * contract Loxep publishes for senders with no provider-specific shape of
 * their own (Databasus-class backup-health webhooks, or any tool an operator
 * points a raw JSON POST at). Provider-SPECIFIC normalizers (Gatus's alerting
 * `custom` provider, Beszel's Shoutrrr generic webhook) live at their own
 * integration boundary — `@loxep/integration-gatus`/`@loxep/integration-
 * beszel` — never here and never in the receiver route, per the design's own
 * rule. `@loxep/app`'s `fleet-evidence.ts` is the composition root that
 * dispatches a connection's `provider` to the right normalizer (this
 * module's generic one, or an integration package's), writes the
 * `source_events` row, and enqueues the `integration_health` projection.
 *
 * ## Why an ingest-only connection needs its own `kind`
 *
 * `POST /api/v1/hooks/fleet/:connectionId` verifies its bearer token against
 * ONE `connections` row's `fleet_ingest_token` credential and, on success,
 * projects `subject_type='connection', subject_id=:connectionId` into
 * `integration_health` with `source='ingest'`. That is the SAME subject key
 * `@loxep/domain`'s own default `connection` health probe already writes
 * (`source='probe'`, derived from `connections.last_success_at`/
 * `last_error_at`) on every `health.sweep` tick for every non-archived
 * connection — a race the design's own "two writers of one subject"
 * discipline (Beszel/Tailscale/Gatus nulling `fleet-tool-registry.ts`'s
 * `healthPath` once a richer adapter projection exists) already establishes
 * a precedent for resolving by EXCLUSION rather than by racing.
 *
 * An evidence-ingest connection has no adapter and never sets
 * `last_success_at`/`last_error_at` at all, so the default probe would
 * report it `unknown` (`kind: 'never_succeeded'`) on every sweep tick,
 * silently overwriting whatever the last webhook actually reported within
 * five minutes. {@link EVIDENCE_INGEST_CONNECTION_KIND} is the marker
 * `health-probes.ts`'s `listConnectionCandidates` filters out so the sweep
 * never lists these rows as candidates at all — the ingest write path is the
 * ONLY writer of their `integration_health` row, matching the design's "one
 * row per subject, one honest writer" discipline. This is a deliberate scope
 * boundary, not an oversight: it means an evidence-ingest connection's
 * status never DECAYS to `unknown` on its own when a sender goes quiet
 * (staleness detection is aspirational future work — see [Companion
 * Services](../../product/companion-services/#databasus)'s "ntfy alert if
 * stale" sketch — not built by this milestone).
 *
 * A tier-3 read connection (Gatus, Beszel) and an evidence-ingest connection
 * for the same external tool are always SEPARATE `connections` rows in this
 * design — never the same row wearing two hats. Reusing one row would
 * reintroduce exactly the race this kind exists to avoid, between the
 * adapter probe's `source='adapter'` write and the webhook's `source='ingest'`
 * write.
 */
import { z } from "zod";

/** `connections.kind` for a connection that exists only to receive evidence. */
export const EVIDENCE_INGEST_CONNECTION_KIND = "evidence_ingest";

export function isEvidenceIngestConnectionKind(kind: string): boolean {
  return kind === EVIDENCE_INGEST_CONNECTION_KIND;
}

/**
 * Recognized `connections.provider` values for an evidence-ingest
 * connection. `gatus`/`beszel` route to their own integration package's
 * normalizer; `databasus` and `generic` both route to
 * {@link normalizeGenericEvidenceWebhook} below — `databasus` is kept as its
 * own catalog-facing label (Companion Services names it explicitly) even
 * though its wire contract is identical to `generic`'s, so a settings picker
 * can say "Databasus" rather than asking an operator to recognize their own
 * tool under a generic label.
 */
export const FLEET_EVIDENCE_PROVIDERS = [
  "gatus",
  "beszel",
  "databasus",
  "generic",
] as const;
export type FleetEvidenceProvider = (typeof FLEET_EVIDENCE_PROVIDERS)[number];

export function isFleetEvidenceProvider(
  value: string,
): value is FleetEvidenceProvider {
  return (FLEET_EVIDENCE_PROVIDERS as readonly string[]).includes(value);
}

/** What every normalizer — generic or provider-specific — resolves a payload to. */
export interface FleetEvidenceAccepted {
  drop: false;
  eventType: string;
  externalEventId: string | null;
  occurredAt: Date;
  status: "ok" | "degraded" | "failing";
  /** Small, credential-free — passed through `guardHealthDetail` before it is ever persisted. */
  detail: Record<string, unknown>;
}

/**
 * A payload that authenticated successfully but is not projected into
 * health — either because it failed the provider's own shape (an honestly
 * recorded, undeliverable evidence row) or because it named Loxep's own
 * Gatus heartbeat endpoint (the feedback-latch this design calls out by
 * name). `reason` is a short, stable taxonomy kind, never a raw error
 * message or the offending payload.
 */
export interface FleetEvidenceDropped {
  drop: true;
  reason: "invalid_payload" | "feedback_latch";
  /** A short, credential-free detail — issue paths/codes, never values. */
  detailMessage: string;
}

export type FleetEvidenceNormalization =
  | FleetEvidenceAccepted
  | FleetEvidenceDropped;

/**
 * The generic contract Loxep publishes for a sender with no shape of its
 * own — the Databasus-class case Companion Services sketches ("Databasus
 * success/failure webhook -> Loxep integration endpoint -> backup status").
 * Loxep dictates this JSON body the same way it dictates Gatus's `custom`
 * provider template, rather than reverse-engineering one tool's undocumented
 * webhook format.
 */
export const genericEvidenceWebhookSchema = z.strictObject({
  status: z.enum(["ok", "degraded", "failing"]),
  /** A short human label — "nightly backup", "restore verification" — never a raw log line. */
  message: z.string().trim().min(1).max(500).optional(),
  /** When the sender's own event happened; defaults to receipt time when omitted. */
  occurredAt: z.iso.datetime().optional(),
});
export type GenericEvidenceWebhookPayload = z.infer<
  typeof genericEvidenceWebhookSchema
>;

const MESSAGE_DETAIL_MAX_LENGTH = 500;

/**
 * Normalize a generic (Databasus-class) evidence payload. Never throws —
 * schema failures become an honest {@link FleetEvidenceDropped}, matching
 * every provider-specific normalizer's contract.
 */
export function normalizeGenericEvidenceWebhook(
  payload: unknown,
  options?: { receivedAt?: Date },
): FleetEvidenceNormalization {
  const parsed = genericEvidenceWebhookSchema.safeParse(payload);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.code}`)
      .join("; ");
    return {
      drop: true,
      reason: "invalid_payload",
      detailMessage: `generic evidence payload failed validation: ${issues}`,
    };
  }
  const { data } = parsed;
  return {
    drop: false,
    eventType: "evidence_reported",
    externalEventId: null,
    occurredAt:
      data.occurredAt !== undefined
        ? new Date(data.occurredAt)
        : (options?.receivedAt ?? new Date()),
    status: data.status,
    detail: {
      kind: "evidence_reported",
      ...(data.message === undefined
        ? {}
        : { message: data.message.slice(0, MESSAGE_DETAIL_MAX_LENGTH) }),
    },
  };
}
